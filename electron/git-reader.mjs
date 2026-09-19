import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const GIT_UNTRACKED_LIMIT = 512 * 1024;
export const GIT_ENTRY_LIMIT = 5000;
const GIT_TIMEOUT = 15000;
const FILTER_NOTE = 'Внешние фильтры Git отключены для просмотра. Файлы с фильтрами (например, Git LFS) могут отличаться от подготовленной версии.';
const baseArgs = [
  '--no-optional-locks', '--literal-pathspecs', '--no-pager',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'core.quotePath=false', '-c', 'status.relativePaths=false',
  '-c', 'diff.autoRefreshIndex=false', '-c', 'diff.ignoreSubmodules=none',
  '-c', 'protocol.allow=never', '-c', 'core.hooksPath=',
];
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const slash = value => value.split(path.sep).join('/');
const withoutFinalNewline = value => value.replace(/\r?\n$/, '');

function gitEnvironment() {
  // Inherited GIT_DIR/WORK_TREE/INDEX_FILE and config injections must never
  // redirect another tab's read or enable a helper. Ordinary user config stays.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

async function git(context, args, { limit = GIT_OUTPUT_LIMIT, allowTruncated = false } = {}) {
  context.assertActive();
  const result = await new Promise((resolve, reject) => {
    const child = spawn('git', [...baseArgs, ...(context.filterArgs || []), ...args], {
      cwd: context.cwd, env: gitEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, GIT_TIMEOUT);
    child.stdout.on('data', chunk => {
      if (size < limit) chunks.push(chunk.subarray(0, limit - size));
      size += chunk.length;
      if (size > limit) { truncated = true; child.kill(); }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Git не ответил за 15 секунд. Повторите обновление.'));
      if (truncated && !allowTruncated) return reject(new Error('Ответ Git слишком большой.'));
      resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated });
    });
  });
  context.assertActive();
  return result;
}

function requireSuccess(result) {
  if (result.code !== 0 && !result.truncated) {
    // Git diagnostics may contain control characters and local file contents;
    // show a bounded plain diagnostic, never shell commands or full dumps.
    const detail = result.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1200);
    throw new Error(`Не удалось прочитать Git.${detail ? ` ${detail}` : ''}`);
  }
  return result;
}

async function contextFor(cwd, assertActive) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Сначала выберите рабочую папку.');
  assertActive();
  let canonical;
  try {
    canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not directory');
  } catch { throw new Error('Рабочая папка недоступна. Выберите существующую папку проекта.'); }
  assertActive();
  const context = { cwd: canonical, selected: canonical, assertActive, filterArgs: [] };
  let probe;
  try { probe = await git(context, ['rev-parse', '--is-bare-repository']); }
  catch (error) { if (error.code === 'ENOENT') return { unavailable: 'git-unavailable' }; throw error; }
  if (probe.code !== 0 && /not a git repository/i.test(probe.stderr)) return { unavailable: 'not-repository' };
  requireSuccess(probe);
  if (probe.stdout.toString('utf8').trim() === 'true') return { unavailable: 'bare' };
  const root = withoutFinalNewline(requireSuccess(await git(context, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).stdout.toString('utf8'));
  context.cwd = await realpath(root);
  context.assertActive();
  if (!contains(context.cwd, canonical)) throw new Error('Рабочая папка находится вне найденного репозитория.');
  context.scope = slash(path.relative(context.cwd, canonical));
  // git diff/status can run clean/process filters even with --no-textconv.
  // Enumerate driver names without running them, and disable every driver for
  // these child processes only. No config/index/worktree file is written.
  const filters = await git(context, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
  if (filters.code !== 1) requireSuccess(filters);
  for (const key of filters.stdout.toString('utf8').split('\0').filter(Boolean)) {
    context.filterArgs.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return context;
}

function relativeInScope(context, repoPath) {
  if (!repoPath || path.posix.isAbsolute(repoPath) || repoPath.split('/').includes('..')) return null;
  const absolute = path.resolve(context.cwd, ...repoPath.split('/'));
  if (!contains(context.selected, absolute)) return null;
  return slash(path.relative(context.selected, absolute));
}

function fields(record, count) {
  const values = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const end = record.indexOf(' ', offset);
    if (end < 0) return null;
    values.push(record.slice(offset, end));
    offset = end + 1;
  }
  values.push(record.slice(offset));
  return values;
}

async function readStatus(context) {
  const result = requireSuccess(await git(context, ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all', '--ignore-submodules=dirty', '--renames', '--', context.scope ? `${context.scope}/` : '.'], { allowTruncated: true }));
  const data = result.stdout.toString('utf8');
  // A killed process can leave an incomplete NUL record: never display it.
  const records = data.slice(0, data.lastIndexOf('\0') + 1).split('\0');
  const status = { available: true, root: context.cwd, entries: [], truncated: result.truncated };
  if (context.filterArgs.length) status.message = FILTER_NOTE;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      status.unborn = oid === '(initial)';
      if (!status.unborn) status.head = oid;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice(14);
      status.detached = branch === '(detached)';
      if (!status.detached) status.branch = branch;
      continue;
    }
    let repoPath;
    let original;
    let xy;
    let submodule = false;
    if (record.startsWith('? ')) { repoPath = record.slice(2); xy = '??'; }
    else if (/^[12u] /.test(record)) {
      const columns = fields(record, record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10);
      if (!columns) continue;
      repoPath = columns.at(-1);
      xy = columns[1];
      submodule = columns[2].startsWith('S');
      if (record[0] === '2') {
        original = records[++index];
        if (!original) { status.truncated = true; break; }
      }
    } else continue;
    const relative = relativeInScope(context, repoPath);
    if (!relative) continue;
    if (status.entries.length >= GIT_ENTRY_LIMIT) { status.truncated = true; break; }
    const conflicted = record[0] === 'u';
    const untracked = record[0] === '?';
    const indexStatus = xy[0];
    const worktreeStatus = xy[1];
    status.entries.push({
      path: relative,
      ...(original && relativeInScope(context, original) ? { originalPath: relativeInScope(context, original) } : {}),
      status: conflicted ? 'U' : untracked ? '?' : worktreeStatus !== '.' ? worktreeStatus : indexStatus,
      indexStatus, worktreeStatus, staged: !untracked && !conflicted && indexStatus !== '.',
      unstaged: !untracked && !conflicted && worktreeStatus !== '.', untracked, conflicted,
      ...(submodule ? { submodule: true } : {}),
    });
  }
  context.assertActive();
  return status;
}

export async function getGitStatus({ cwd, assertActive = () => {} }) {
  const context = await contextFor(cwd, assertActive);
  if (context.unavailable) return { available: false, reason: context.unavailable, entries: [] };
  return readStatus(context);
}

function checkedPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Некорректный путь файла Git.');
  // Backslashes are separators on Windows and valid literal filenames on Unix.
  if (process.platform === 'win32' && (value.includes('\\') || /[<>:"|?*\x01-\x1f]/.test(value))) throw new Error('Некорректный путь файла Git.');
  if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Файл находится за пределами рабочей папки.');
  return value;
}

async function checkedDiskPath(context, relative) {
  let target = context.selected;
  let info;
  for (const part of relative.split('/')) {
    target = path.resolve(target, part);
    if (!contains(context.selected, target)) throw new Error('Файл находится за пределами рабочей папки.');
    try { info = await lstat(target); }
    catch (error) { if (error.code === 'ENOENT') return { target: path.resolve(context.selected, ...relative.split('/')), missing: true }; throw error; }
    context.assertActive();
    if (info.isSymbolicLink()) return { target, link: true };
    const canonical = await realpath(target);
    context.assertActive();
    if (!contains(context.selected, canonical)) throw new Error('Файл находится за пределами рабочей папки.');
  }
  return { target, info };
}

function quotedPath(prefix, relative) {
  const value = `${prefix}/${relative}`;
  return /[\x00-\x20"\\\x7f]/.test(value) ? JSON.stringify(value) : value;
}

async function untrackedDiff(context, relative, disk) {
  if (!disk.info.isFile()) return { diff: '', message: 'Это вложенная папка или репозиторий. Откройте её как отдельную рабочую папку.' };
  const file = await open(disk.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    context.assertActive();
    const info = await file.stat();
    if (info.dev !== disk.info.dev || info.ino !== disk.info.ino) throw new Error('Файл изменился во время чтения. Обновите список изменений.');
    const checkCurrentPath = async () => {
      const current = await checkedDiskPath(context, relative);
      if (current.link || current.missing || current.info.dev !== info.dev || current.info.ino !== info.ino) throw new Error('Файл изменился во время чтения. Обновите список изменений.');
    };
    await checkCurrentPath();
    if (!info.isFile()) return { diff: '', message: 'Просмотр доступен только для обычных файлов.' };
    if (info.size > GIT_UNTRACKED_LIMIT) return { diff: '', truncated: true, message: 'Новый файл больше 512 КиБ. Откройте его в редакторе.' };
    const buffer = Buffer.alloc(GIT_UNTRACKED_LIMIT + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    context.assertActive();
    await checkCurrentPath();
    if (bytesRead > GIT_UNTRACKED_LIMIT) return { diff: '', truncated: true, message: 'Новый файл больше 512 КиБ. Откройте его в редакторе.' };
    const bytes = buffer.subarray(0, bytesRead);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return { diff: '', binary: true, message: 'Двоичный файл или текст в кодировке, отличной от UTF-8. Откройте его в редакторе.' }; }
    if (bytes.includes(0)) return { diff: '', binary: true, message: 'Двоичный файл: текстовое сравнение недоступно.' };
    const before = quotedPath('a', relative);
    const after = quotedPath('b', relative);
    let diff = `diff --git ${before} ${after}\nnew file mode 100644\n--- /dev/null\n+++ ${after}\n`;
    if (text) {
      const hasFinalNewline = text.endsWith('\n');
      const lines = text.split('\n');
      if (hasFinalNewline) lines.pop();
      diff += `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
      if (!hasFinalNewline) diff += '\\ No newline at end of file\n';
    }
    return { diff };
  } finally { await file.close(); }
}

export async function getGitDiff({ cwd, path: relative, area, assertActive = () => {} }) {
  checkedPath(relative);
  if (!['staged', 'unstaged', 'untracked'].includes(area)) throw new Error('Некорректная область изменений Git.');
  const context = await contextFor(cwd, assertActive);
  if (context.unavailable) throw new Error('Репозиторий Git недоступен. Обновите список изменений.');
  const status = await readStatus(context);
  const entry = status.entries.find(item => item.path === relative);
  if (!entry || (!entry[area] && !(entry.conflicted && area === 'unstaged'))) throw new Error('Состояние файла изменилось. Обновите список изменений.');
  const response = { path: relative, area, diff: '' };
  if (entry.conflicted) return { ...response, message: 'В файле конфликт слияния. Откройте файл, чтобы проверить и разрешить конфликт.' };
  if (entry.submodule) return { ...response, message: 'Изменён вложенный репозиторий. Откройте его как отдельную рабочую папку для просмотра файлов.' };
  const disk = await checkedDiskPath(context, relative);
  if (disk.link) return { ...response, message: 'Ссылки на файлы и папки не раскрываются в просмотре Git.' };
  if (area === 'untracked') {
    if (disk.missing) throw new Error('Файл больше не существует. Обновите список изменений.');
    const result = await untrackedDiff(context, relative, disk);
    context.assertActive();
    return { ...response, ...result };
  }
  const scopePath = value => context.scope ? `${context.scope}/${value}` : value;
  const paths = [scopePath(relative)];
  if (area === 'staged' && entry.originalPath) paths.push(scopePath(entry.originalPath));
  const result = requireSuccess(await git(context, ['diff', ...(area === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--ignore-submodules=dirty', `--relative=${context.scope}`, '--', ...paths], { allowTruncated: true }));
  const currentDisk = await checkedDiskPath(context, relative);
  if (currentDisk.link) throw new Error('Файл изменился во время чтения. Обновите список изменений.');
  // Finish at a line boundary if capped, so the renderer can detect an
  // incomplete hunk instead of treating a clipped line as actual file text.
  const raw = result.stdout.toString('utf8');
  const diff = result.truncated ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
  const binary = /^Binary files .+ differ\r?$/m.test(diff) || /^GIT binary patch$/m.test(diff);
  return { ...response, diff, binary, truncated: result.truncated, ...(binary ? { message: 'Двоичный файл: текстовое сравнение недоступно.' } : result.truncated ? { message: 'Сравнение обрезано: показаны первые 2 МиБ.' } : !diff ? { message: 'Текстовых различий нет. Состояние файла могло измениться; обновите список.' } : context.filterArgs.length ? { message: FILTER_NOTE } : {}) };
}
