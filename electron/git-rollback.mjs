import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkedPath, contextFor, git, readStatus, requireSuccess } from './git-reader.mjs';

export const ROLLBACK_FILE_LIMIT = 8 * 1024 * 1024;
export const ROLLBACK_DIFF_LIMIT = 2 * 1024 * 1024;
export const ROLLBACK_PREVIEW_MS = 5 * 60 * 1000;
const STALE = 'Файл, индекс или настройки Git изменились. Откройте предпросмотр заново.';
const idPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contains = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const publicRecord = record => ({ undoId: record.id, path: record.path, createdAt: record.createdAt });
const identity = info => ({ dev: info.dev, ino: info.ino, mode: info.mode & 0o777 });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameSnapshot = (a, b) => a.missing === b.missing && a.parent.dev === b.parent.dev && a.parent.ino === b.parent.ino && (a.missing || (a.hash === b.hash && sameIdentity(a, b)));
const metadata = snapshot => { const { bytes, ...value } = snapshot; return value; };
const quote = (prefix, relative) => JSON.stringify(`${prefix}/${relative}`);

function validatePath(relative) {
  checkedPath(relative);
  if (relative.split('/').some(part => /^\.git(?:[. ]*)$/i.test(part) || (process.platform === 'win32' && /[. ]$/.test(part)))) throw new Error('Служебные пути Git недоступны для отката.');
  return relative;
}

async function context(cwd, assertActive) {
  const result = await contextFor(cwd, assertActive);
  if (result.unavailable) throw new Error('Рабочий репозиторий Git недоступен.');
  return result;
}

// Check every component from the repository root, including a nested selected
// cwd. Do not create missing directories or traverse junctions/symlinks.
async function diskPath(ctx, relative) {
  const target = path.resolve(ctx.selected, ...validatePath(relative).split('/'));
  if (!contains(ctx.selected, target)) throw new Error('Файл находится за пределами рабочей папки.');
  const parts = path.relative(ctx.cwd, target).split(path.sep);
  let current = ctx.cwd;
  let parent = await lstat(current);
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('Папка репозитория изменилась.');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    ctx.assertActive();
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (index !== parts.length - 1) throw new Error('Родительская папка файла отсутствует. Восстановите её перед откатом.');
      return { target, parent: identity(parent), missing: true };
    }
    if (info.isSymbolicLink()) throw new Error('Откат через символические ссылки и junction недоступен.');
    if (await realpath(current) !== current) {
      // Windows realpath can change only drive-letter casing.
      if (process.platform !== 'win32' || (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('Путь файла изменился. Откат отменён.');
    }
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new Error('Путь файла больше не является папкой.');
      parent = info;
    } else {
      if (!info.isFile() || info.nlink !== 1) throw new Error('Откат доступен только для обычного файла без жёстких ссылок.');
      if (info.size > ROLLBACK_FILE_LIMIT) throw new Error('Файл больше 8 МиБ. Откат в приложении недоступен.');
      return { target, info, parent: identity(parent), missing: false };
    }
  }
  throw new Error('Некорректный путь файла.');
}

async function snapshot(ctx, relative) {
  const disk = await diskPath(ctx, relative);
  if (disk.missing) return { missing: true, parent: disk.parent, bytes: Buffer.alloc(0) };
  const file = await open(disk.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(identity(before), identity(disk.info))) throw new Error(STALE);
    const bytes = Buffer.alloc(Math.min(before.size + 1, ROLLBACK_FILE_LIMIT + 1));
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await file.stat();
    const current = await diskPath(ctx, relative);
    ctx.assertActive();
    if (length > ROLLBACK_FILE_LIMIT) throw new Error('Файл больше 8 МиБ. Откат в приложении недоступен.');
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.missing || !sameIdentity(identity(before), identity(current.info))) throw new Error(STALE);
    const data = bytes.subarray(0, length);
    return { missing: false, ...identity(before), hash: hash(data), parent: disk.parent, bytes: data };
  } finally { await file.close(); }
}

async function indexVersion(ctx, relative) {
  const repoPath = ctx.scope ? `${ctx.scope}/${relative}` : relative;
  const entries = requireSuccess(await git(ctx, ['ls-files', '--stage', '-z', '--', repoPath])).stdout.toString('utf8').split('\0').filter(Boolean);
  const match = entries.length === 1 && /^(100644|100755) ([a-f\d]{40,64}) 0\t([\s\S]+)$/.exec(entries[0]);
  if (!match || match[3] !== repoPath) throw new Error('Откат доступен для обычного отслеживаемого файла без конфликтов.');
  const attrs = requireSuccess(await git(ctx, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol', '--', repoPath])).stdout.toString('utf8');
  const fields = attrs.split('\0');
  for (let offset = 0; offset + 2 < fields.length; offset += 3) {
    if (['filter', 'working-tree-encoding'].includes(fields[offset + 1]) && !['unspecified', 'unset'].includes(fields[offset + 2])) throw new Error('Откат файлов с внешними фильтрами Git или working-tree-encoding пока недоступен.');
  }
  const headResult = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
  const head = headResult.code === 0 ? headResult.stdout.toString('utf8').trim() : 'unborn';
  // Built-in eol/ident conversions match checkout. Configured external filters
  // remain disabled in the child and filtered paths have already been refused.
  const bytes = requireSuccess(await git(ctx, ['cat-file', '--filters', `--path=${repoPath}`, `:${repoPath}`], { limit: ROLLBACK_FILE_LIMIT })).stdout;
  return { oid: match[2], mode: match[1], attrs, head, hash: hash(bytes), bytes };
}

const sameIndex = (a, b) => ['oid', 'mode', 'attrs', 'head', 'hash'].every(key => a[key] === b[key]);
const HUNK_CONTEXT = 3;
// Line-level LCS is exact but quadratic; beyond this many changed lines the
// preview falls back to a single hunk, which is always available.
const LCS_CELL_LIMIT = 16_000_000;
const splitLines = text => text ? text.match(/[^\n]*\n|[^\n]+$/g) : [];

/** Edit script between two line arrays: [{ kind: 'equal'|'remove'|'add', line }]. */
function lineEdits(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
  const a = oldLines.slice(prefix, oldLines.length - suffix), b = newLines.slice(prefix, newLines.length - suffix);
  const edits = oldLines.slice(0, prefix).map(line => ({ kind: 'equal', line }));
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_LIMIT) {
    edits.push(...a.map(line => ({ kind: 'remove', line })), ...b.map(line => ({ kind: 'add', line })));
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { edits.push({ kind: 'equal', line: a[i] }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) edits.push({ kind: 'remove', line: a[i++] });
      else edits.push({ kind: 'add', line: b[j++] });
    }
    while (i < a.length) edits.push({ kind: 'remove', line: a[i++] });
    while (j < b.length) edits.push({ kind: 'add', line: b[j++] });
  }
  edits.push(...oldLines.slice(oldLines.length - suffix).map(line => ({ kind: 'equal', line })));
  return edits;
}

/** Groups an edit script into unified-diff hunks with standard context merging. */
function buildHunks(edits, context = HUNK_CONTEXT) {
  const hunks = [];
  let oldLine = 1, newLine = 1, index = 0;
  while (index < edits.length) {
    if (edits[index].kind === 'equal') { oldLine++; newLine++; index++; continue; }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend while the gap of equal lines between changes is short enough to merge.
    for (let cursor = index; cursor < edits.length; cursor++) {
      if (edits[cursor].kind !== 'equal') { end = cursor + 1; continue; }
      let gap = 0;
      while (cursor + gap < edits.length && edits[cursor + gap].kind === 'equal') gap++;
      if (cursor + gap >= edits.length || gap > 2 * context) break;
      cursor += gap - 1;
    }
    const stop = Math.min(edits.length, end + context);
    const lines = edits.slice(start, stop);
    const oldStart = oldLine - (index - start), newStart = newLine - (index - start);
    const oldCount = lines.filter(e => e.kind !== 'add').length, newCount = lines.filter(e => e.kind !== 'remove').length;
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
    for (let cursor = index; cursor < stop; cursor++) { if (edits[cursor].kind !== 'add') oldLine++; if (edits[cursor].kind !== 'remove') newLine++; }
    index = stop;
  }
  return hunks;
}

const hunkHeader = hunk => `@@ -${hunk.oldCount ? hunk.oldStart : Math.max(0, hunk.oldStart - 1)},${hunk.oldCount} +${hunk.newCount ? hunk.newStart : Math.max(0, hunk.newStart - 1)},${hunk.newCount} @@`;
const hunkSummary = hunk => {
  const changed = hunk.lines.find(e => e.kind !== 'equal');
  return { removed: hunk.lines.filter(e => e.kind === 'remove').length, added: hunk.lines.filter(e => e.kind === 'add').length, excerpt: (changed?.line || '').replace(/\r?\n$/, '').trim().slice(0, 120) };
};
const publicHunks = hunks => hunks.map((hunk, index) => ({ index, header: hunkHeader(hunk), oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount, ...hunkSummary(hunk) }));

function decodeText(before, after) {
  if (before.bytes.includes(0) || after.bytes.includes(0)) return null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return { oldText: decoder.decode(before.bytes), newText: decoder.decode(after.bytes) };
  } catch { return null; }
}

/** Unified diff from `before` (current file) to `after` (target). Returns hunks for partial restore when text. */
function diffPreview(relative, before, after) {
  const text = decodeText(before, after);
  if (!text) return { diff: '', binary: true, message: 'Двоичный файл или другая кодировка. Будет восстановлено содержимое целиком; резервная копия сохранится.' };
  if (before.bytes.length + after.bytes.length > ROLLBACK_DIFF_LIMIT) return { diff: '', truncated: true, message: 'Текст больше 2 МиБ. Сравнение недоступно; будет восстановлен весь файл с резервной копией.' };
  const oldLines = splitLines(text.oldText), newLines = splitLines(text.newText);
  const hunks = text.oldText === text.newText ? [] : buildHunks(lineEdits(oldLines, newLines));
  const oldName = before.missing ? '/dev/null' : quote('a', relative);
  const newName = after.missing ? '/dev/null' : quote('b', relative);
  let diff = `diff --git ${quote('a', relative)} ${quote('b', relative)}\n`;
  if (before.missing) diff += 'new file mode 100644\n';
  else if (after.missing) diff += 'deleted file mode 100644\n';
  else if (before.mode !== after.mode) diff += `old mode ${before.mode & 0o111 ? '100755' : '100644'}\nnew mode ${after.mode & 0o111 ? '100755' : '100644'}\n`;
  diff += `--- ${oldName}\n+++ ${newName}\n`;
  const emit = (mark, line) => `${mark}${line}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`;
  for (const hunk of hunks) {
    diff += `${hunkHeader(hunk)}\n`;
    for (const edit of hunk.lines) diff += emit(edit.kind === 'add' ? '+' : edit.kind === 'remove' ? '-' : ' ', edit.line);
  }
  if (Buffer.byteLength(diff) > ROLLBACK_DIFF_LIMIT) return { diff: '', truncated: true, message: 'Сравнение больше 2 МиБ. Будет восстановлен весь файл с резервной копией.' };
  return { diff, hunks, oldLines };
}

/** Applies only the selected hunks of a preview to the current text; other changes stay. */
function partialBytes(preview, selection) {
  const { hunks, oldLines } = preview;
  if (!Array.isArray(hunks) || hunks.length < 2 || !oldLines) throw new Error('Откат отдельных фрагментов недоступен для этого файла: используйте откат целиком.');
  if (!Array.isArray(selection) || !selection.length || selection.length > hunks.length) throw new Error('Выберите хотя бы один фрагмент для отката.');
  const chosen = [...new Set(selection)];
  if (chosen.length !== selection.length || chosen.some(index => !Number.isSafeInteger(index) || index < 0 || index >= hunks.length)) throw new Error('Некорректный выбор фрагментов. Откройте предпросмотр заново.');
  if (chosen.length === hunks.length) return null; // Every hunk: identical to the exact index bytes.
  const lines = [...oldLines];
  for (const index of chosen.sort((a, b) => b - a)) {
    const hunk = hunks[index];
    lines.splice(hunk.oldStart - 1, hunk.oldCount, ...hunk.lines.filter(e => e.kind !== 'remove').map(e => e.line));
  }
  return Buffer.from(lines.join(''), 'utf8');
}

async function durableWrite(filePath, bytes) {
  const handle = await open(filePath, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class GitRollbackService {
  constructor({ directory, now = Date.now }) {
    if (!path.isAbsolute(directory)) throw new Error('Папка резервных копий должна быть абсолютной.');
    this.directory = path.resolve(directory);
    this.now = now;
    this.previews = new Map();
    this.pending = Promise.resolve();
  }

  serial(task) {
    const operation = this.pending.then(task, task);
    this.pending = operation.catch(() => {});
    return operation;
  }

  remember(ctx, relative, operation, source, destination, index, undo) {
    for (const [id, item] of this.previews) if (item.expires <= this.now()) this.previews.delete(id);
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value);
    const previewId = randomUUID(); const expires = this.now() + ROLLBACK_PREVIEW_MS;
    const { hunks, oldLines, ...visible } = diffPreview(relative, source, destination);
    // Partial restore is offered only for a present text file returning to the index.
    const selectable = operation === 'restore' && !source.missing && Array.isArray(hunks) && hunks.length > 1;
    this.previews.set(previewId, { cwd: ctx.selected, root: ctx.cwd, path: relative, operation, source, destination, index, undo, expires, ...(selectable ? { hunks, oldLines } : {}) });
    return { previewId, path: relative, operation, expiresAt: new Date(expires).toISOString(), ...visible, ...(selectable ? { hunks: publicHunks(hunks) } : {}) };
  }

  preview({ cwd, path: relative, assertActive = () => {} }) {
    return this.serial(async () => {
      validatePath(relative);
      const ctx = await context(cwd, assertActive);
      const status = await readStatus(ctx);
      const entry = status.entries.find(item => item.path === relative);
      if (!entry || !entry.unstaged || !['M', 'D'].includes(entry.worktreeStatus) || entry.conflicted || entry.submodule || entry.originalPath || ['R', 'C', 'T'].includes(entry.indexStatus)) throw new Error('Откат доступен только для изменённых или удалённых файлов в разделе «Не подготовлено», без конфликтов и переименований.');
      const source = await snapshot(ctx, relative);
      const index = await indexVersion(ctx, relative);
      const destination = { missing: false, bytes: index.bytes, mode: source.missing ? (index.mode === '100755' ? 0o755 : 0o644) : (source.mode & 0o666) | (index.mode === '100755' ? 0o111 : 0) };
      if (!sameSnapshot(source, await snapshot(ctx, relative)) || !sameIndex(index, await indexVersion(ctx, relative))) throw new Error(STALE);
      assertActive();
      return this.remember(ctx, relative, 'restore', source, destination, index);
    });
  }

  async ensureDirectory(create = true) {
    let current = path.parse(this.directory).root;
    for (const part of path.relative(current, this.directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        try { await mkdir(current); } catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Папка резервных копий недоступна или проходит через ссылку.');
    }
  }

  async journal(record) {
    await this.ensureDirectory();
    const target = path.join(this.directory, `${record.id}.json`);
    const temp = path.join(this.directory, `${record.id}.${randomUUID()}.tmp`);
    await durableWrite(temp, JSON.stringify(record));
    try { await rename(temp, target); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }

  async readRecord(id) {
    if (!idPattern.test(id)) throw new Error('Некорректная резервная копия.');
    const recordBytes = await this.readBackup(`${id}.json`, 65536);
    let record;
    try { record = JSON.parse(recordBytes.toString('utf8')); }
    catch { throw new Error('Описание резервной копии повреждено.'); }
    if (record.version !== 1 || record.id !== id || !path.isAbsolute(record.cwd || '') || !path.isAbsolute(record.root || '') || !['prepared', 'applied', 'undo-prepared', 'undone'].includes(record.state) || !record.before || !record.after || typeof record.createdAt !== 'string') throw new Error('Описание резервной копии повреждено.');
    validatePath(record.path);
    return record;
  }

  async readBackup(name, limit = ROLLBACK_FILE_LIMIT) {
    await this.ensureDirectory(false);
    const filePath = path.join(this.directory, name);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Резервная копия повреждена или недоступна.');
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      if (!sameIdentity(identity(current), identity(info))) throw new Error('Резервная копия изменилась.');
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = await handle.read(bytes, length, bytes.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length !== info.size || length > limit) throw new Error('Резервная копия изменилась.');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async checkedRecord(ctx, id) {
    const record = await this.readRecord(id);
    if (record.cwd !== ctx.selected || record.root !== ctx.cwd) throw new Error('Резервная копия принадлежит другой рабочей папке.');
    if (record.state === 'undone') throw new Error('Этот откат уже отменён.');
    return record;
  }

  list({ cwd, assertActive = () => {} }) {
    return this.serial(async () => {
      const ctx = await context(cwd, assertActive);
      let names;
      try { names = await readdir(this.directory); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const records = [];
      for (const name of names) {
        if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) continue;
        const record = await this.readRecord(name.slice(0, -5));
        assertActive();
        if (record.cwd === ctx.selected && record.root === ctx.cwd && record.state !== 'undone') records.push(publicRecord(record));
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  previewUndo({ cwd, undoId, assertActive = () => {} }) {
    return this.serial(async () => {
      const ctx = await context(cwd, assertActive);
      const record = await this.checkedRecord(ctx, undoId);
      const source = await snapshot(ctx, record.path);
      if (!sameSnapshot(source, record.after)) throw new Error('После отката файл изменился. Автоматическая отмена недоступна; резервная копия сохранена.');
      const bytes = await this.readBackup(`${undoId}.before`);
      if ((!record.before.missing && hash(bytes) !== record.before.hash) || (record.before.missing && bytes.length)) throw new Error('Резервная копия не прошла проверку целостности.');
      const destination = { ...record.before, bytes };
      const index = await indexVersion(ctx, record.path);
      if (!sameIndex(index, record.index)) throw new Error('После отката изменились индекс, ветка или настройки Git. Автоматическая отмена недоступна; резервная копия сохранена.');
      if (!sameSnapshot(source, await snapshot(ctx, record.path))) throw new Error(STALE);
      assertActive();
      return this.remember(ctx, record.path, 'undo', source, destination, index, record);
    });
  }

  async consume(ctx, id, operation) {
    const preview = this.previews.get(id);
    if (!preview || preview.expires <= this.now()) { this.previews.delete(id); throw new Error('Предпросмотр истёк или уже использован. Откройте его заново.'); }
    if (preview.cwd !== ctx.selected || preview.root !== ctx.cwd || preview.operation !== operation) throw new Error('Предпросмотр принадлежит другой рабочей папке или операции.');
    this.previews.delete(id);
    if (!sameSnapshot(preview.source, await snapshot(ctx, preview.path)) || !sameIndex(preview.index, await indexVersion(ctx, preview.path))) throw new Error(STALE);
    return preview;
  }

  async replace(ctx, preview, record) {
    const target = path.resolve(ctx.selected, ...preview.path.split('/'));
    const temp = path.join(path.dirname(target), `.codex-restore-${randomUUID()}.tmp`);
    let prepared = false;
    try {
      if (!sameSnapshot(preview.source, await snapshot(ctx, preview.path))) throw new Error(STALE);
      if (!preview.destination.missing) {
        await durableWrite(temp, preview.destination.bytes);
        prepared = true;
        await chmod(temp, preview.destination.mode);
        const info = await lstat(temp);
        const intended = { missing: false, ...identity(info), parent: preview.source.parent, hash: hash(preview.destination.bytes) };
        if (preview.operation === 'restore') record.after = intended;
        else record.undoResult = intended;
      } else record.undoResult = { missing: true, parent: preview.source.parent };
      record.state = preview.operation === 'restore' ? 'prepared' : 'undo-prepared';
      await this.journal(record);
      // Repeat all optimistic checks after backups and immediately before the
      // atomic filesystem operation. No command writes Git's index or config.
      if (!sameIndex(preview.index, await indexVersion(ctx, preview.path)) || !sameSnapshot(preview.source, await snapshot(ctx, preview.path))) throw new Error(STALE);
      ctx.assertActive();
      if (preview.destination.missing) await unlink(target);
      else { await rename(temp, target); prepared = false; }
      record.state = preview.operation === 'restore' ? 'applied' : 'undone';
      await this.journal(record);
      ctx.assertActive();
    } catch (error) {
      // Journal and original bytes are retained even if the last journal write
      // or session check fails after replacement. Never blindly restore a file
      // here: a concurrent editor may have written newer contents already.
      throw new Error(`${error.message} Резервная копия сохранена: ${path.join(this.directory, `${record.id}.before`)}`, { cause: error });
    } finally { if (prepared) await unlink(temp).catch(() => {}); }
  }

  apply({ cwd, previewId, hunks, assertActive = () => {} }) {
    return this.serial(async () => {
      const ctx = await context(cwd, assertActive);
      const preview = await this.consume(ctx, previewId, 'restore');
      if (hunks !== undefined) {
        const bytes = partialBytes(preview, hunks);
        if (bytes) preview.destination = { ...preview.destination, bytes };
        preview.selectedHunks = [...new Set(hunks)].sort((a, b) => a - b);
      }
      const id = randomUUID();
      await this.ensureDirectory();
      // Back up both sides durably before touching the worktree. These files
      // remain available for manual recovery after interruption or restart.
      await durableWrite(path.join(this.directory, `${id}.before`), preview.source.bytes);
      await durableWrite(path.join(this.directory, `${id}.after`), preview.destination.bytes);
      const record = { version: 1, id, cwd: ctx.selected, root: ctx.cwd, path: preview.path, createdAt: new Date(this.now()).toISOString(), before: metadata(preview.source), index: metadata(preview.index), state: 'prepared', ...(preview.selectedHunks ? { hunks: preview.selectedHunks } : {}) };
      await this.replace(ctx, preview, record);
      return publicRecord(record);
    });
  }

  applyUndo({ cwd, previewId, assertActive = () => {} }) {
    return this.serial(async () => {
      const ctx = await context(cwd, assertActive);
      const preview = await this.consume(ctx, previewId, 'undo');
      const record = await this.checkedRecord(ctx, preview.undo.id);
      if (!sameSnapshot(preview.source, record.after)) throw new Error('Состояние резервной копии изменилось.');
      await this.replace(ctx, preview, record);
      return { path: record.path };
    });
  }
}
