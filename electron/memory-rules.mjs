import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MARKER_NAMESPACE = 'codex-desk:memory-rules';
const END_MARKER = `<!-- ${MARKER_NAMESPACE}:v1:end -->`;
const START_PATTERN = /<!-- codex-desk:memory-rules:v1:start prefix=([012]) eol=(lf|crlf) -->/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function providerName(provider) {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('Неизвестный агент правил памяти.');
  return provider;
}
function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value) || !path.isAbsolute(value)) {
    throw new Error(`${label} должен содержать абсолютный путь к каталогу.`);
  }
  return path.resolve(value);
}
function statKey(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
}
function fileError(filePath, error) {
  if (error.memoryRulesMessage) return error.memoryRulesMessage;
  return `Не удалось проверить файл ${filePath} (${error.code || 'ошибка чтения'}).`;
}
function invalidFile(message) {
  return Object.assign(new Error(message), { memoryRulesMessage: message });
}

async function storageLocation(io, filePath) {
  let parent = path.dirname(filePath);
  const tail = [path.basename(filePath)];
  for (;;) {
    try {
      const stat = await io.stat(parent);
      if (!stat.isDirectory()) throw invalidFile(`Родительский путь не является каталогом: ${parent}`);
      return path.join(await io.realpath(parent), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      tail.unshift(path.basename(parent));
      parent = next;
    }
  }
}

// Bound every read, including a file that grows between lstat and read.
async function readFileState(io, filePath) {
  const location = await storageLocation(io, filePath);
  let stat;
  try { stat = await io.lstat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return { path: filePath, location, exists: false, bytes: Buffer.alloc(0), text: '', signature: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw invalidFile(`Ожидался обычный файл без символической ссылки: ${filePath}`);
  if (stat.size > MAX_FILE_BYTES) throw invalidFile(`Файл превышает ограничение 2 МБ: ${filePath}`);
  const handle = await io.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || statKey(opened) !== statKey(stat)) throw invalidFile(`Файл изменился во время чтения: ${filePath}`);
    const chunks = [];
    let length = 0;
    while (length <= MAX_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - length));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    if (length > MAX_FILE_BYTES) throw invalidFile(`Файл превышает ограничение 2 МБ: ${filePath}`);
    const after = await handle.stat();
    const current = await io.lstat(filePath);
    if (current.isSymbolicLink() || statKey(after) !== statKey(stat) || statKey(current) !== statKey(stat)) {
      throw invalidFile(`Файл изменился во время чтения: ${filePath}`);
    }
    const bytes = Buffer.concat(chunks);
    let decoded;
    try { decoded = utf8.decode(bytes); }
    catch { throw invalidFile(`Файл должен быть в кодировке UTF-8: ${filePath}`); }
    return { path: filePath, location, exists: true, bytes, text: decoded, signature: `${statKey(stat)}:${hash(bytes)}` };
  } finally { await handle.close(); }
}

function separatorFor(text, eol) {
  if (!text || text === '\uFEFF' || text.endsWith(eol + eol)) return 0;
  return text.endsWith(eol) ? 1 : 2;
}
function makeBlock(body, prefix, eol) {
  const label = eol === '\r\n' ? 'crlf' : 'lf';
  return eol.repeat(prefix) + `<!-- ${MARKER_NAMESPACE}:v1:start prefix=${prefix} eol=${label} -->` + eol
    + body.replace(/\r?\n/g, eol) + eol + END_MARKER + eol;
}
function inspectBlock(text, body) {
  const markers = text.match(/codex-desk:memory-rule/gi) || [];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!markers.length) return { enabled: false, conflict: null, block: makeBlock(body, separatorFor(text, eol), eol), start: -1, end: -1 };
  const start = START_PATTERN.exec(text);
  if (markers.length !== 2 || !start) return { enabled: true, conflict: 'Служебные метки правил памяти изменены или повторяются. Файл сохранён без изменений.' };
  const expected = makeBlock(body, Number(start[1]), start[2] === 'crlf' ? '\r\n' : '\n');
  const offset = start.index - Number(start[1]) * (start[2] === 'crlf' ? 2 : 1);
  if (offset < 0 || text.slice(offset, offset + expected.length) !== expected) {
    return { enabled: true, conflict: 'Блок правил памяти был изменён вручную. Автоматическая замена и удаление отключены; файл сохранён.' };
  }
  return { enabled: true, conflict: null, block: expected, start: offset, end: offset + expected.length };
}

/** Writes only its own marked instruction block; no agent config, auth or database access. */
export class MemoryRulesService {
  constructor({ env = process.env, home, fs: io = fs } = {}) {
    this.env = env;
    this.home = home;
    this.io = io;
    this.assets = null;
  }

  async _assets() {
    if (!this.assets) {
      this.assets = Promise.all([
        fs.readFile(new URL('./instructions/memory-rules.md', import.meta.url), 'utf8'),
        fs.readFile(new URL('./instructions/memory-compact.md', import.meta.url), 'utf8'),
      ]).then(([template, procedureText]) => {
        if (!template.includes('{{PROCEDURE_PATH}}') || !procedureText.trim()) throw new Error('Повреждена поставка правил памяти.');
        return { template: template.trimEnd(), procedureText };
      }).catch(error => { this.assets = null; throw error; });
    }
    return this.assets;
  }

  _paths(provider) {
    providerName(provider);
    const key = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const configured = this.env[key];
    const home = absoluteDirectory(this.home ?? this.env.USERPROFILE ?? os.homedir(), 'Домашний каталог');
    const agentHome = configured === undefined || configured === ''
      ? path.join(home, provider === 'codex' ? '.codex' : '.claude')
      : absoluteDirectory(configured, key);
    return {
      provider, agentHome,
      defaultPath: path.join(agentHome, provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'),
      overridePath: provider === 'codex' ? path.join(agentHome, 'AGENTS.override.md') : null,
      procedurePath: path.join(agentHome, 'codex-desk', 'memory-compact.md'),
    };
  }

  async _read(filePath) {
    try { return await readFileState(this.io, filePath); }
    catch (error) { return { path: filePath, error: fileError(filePath, error), signature: `error:${fileError(filePath, error)}` }; }
  }

  async _snapshot(provider) {
    const paths = this._paths(provider);
    const assets = await this._assets();
    const [override, procedure, primary] = await Promise.all([
      paths.overridePath ? this._read(paths.overridePath) : Promise.resolve(null),
      this._read(paths.procedurePath),
      this._read(paths.defaultPath),
    ]);
    const instruction = override && (override.error || override.text.trim()) ? override : primary;
    const body = assets.template.replace('{{PROCEDURE_PATH}}', JSON.stringify(paths.procedurePath.replaceAll('\\', '/')));
    const block = instruction.error ? { enabled: false, conflict: instruction.error } : inspectBlock(instruction.text, body);
    const procedureConflict = procedure.error || (procedure.exists && !procedure.bytes.equals(Buffer.from(assets.procedureText))
      ? 'Файл полной процедуры уже существует и отличается от поставки. Он сохранён; выберите другое расположение профиля или проверьте файл вручную.' : null);
    const maskedConflict = instruction === override && (primary.error || /codex-desk:memory-rule/i.test(primary.text))
      ? `В ${paths.defaultPath} есть недоступный или перекрытый блок правил памяти. Сейчас Codex использует AGENTS.override.md; сначала проверьте прежний файл вручную.` : null;
    const conflict = override?.error || block.conflict || maskedConflict || procedureConflict || null;
    const fingerprint = JSON.stringify({
      paths, instruction: [instruction.signature, instruction.location], override: override && [override.signature, override.location],
      primary: [primary.signature, primary.location],
      procedure: [procedure.signature, procedure.location], template: hash(assets.template), procedureText: hash(assets.procedureText),
    });
    const revision = hash(fingerprint);
    return {
      paths, assets, instruction, override, primary, procedure, block,
      preview: {
        provider, enabled: block.enabled, conflict, instructionPath: instruction.path,
        procedurePath: paths.procedurePath, rulesText: block.block || makeBlock(body, 0, '\n'),
        procedureText: assets.procedureText, revision,
      },
    };
  }

  async preview(provider) { return (await this._snapshot(provider)).preview; }

  async _assertUnchanged(snapshot, { procedureCreated = false } = {}) {
    const current = await this._snapshot(snapshot.preview.provider);
    if (!procedureCreated && current.preview.revision === snapshot.preview.revision) return current;
    if (procedureCreated && !current.preview.conflict
      && JSON.stringify(current.paths) === JSON.stringify(snapshot.paths)
      && current.instruction.path === snapshot.instruction.path
      && current.instruction.location === snapshot.instruction.location
      && current.instruction.signature === snapshot.instruction.signature
      && current.override?.signature === snapshot.override?.signature
      && current.override?.location === snapshot.override?.location
      && current.primary.signature === snapshot.primary.signature
      && current.primary.location === snapshot.primary.location
      && current.procedure.location === snapshot.procedure.location
      && current.procedure.bytes.equals(Buffer.from(snapshot.assets.procedureText))) return current;
    throw new Error('Файлы или расположение профиля изменились после просмотра. Обновите просмотр правил памяти.');
  }

  async _stage(filePath, bytes) {
    const temporary = `${filePath}.codex-desk-${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      return temporary;
    } catch (error) {
      if (error.code !== 'EEXIST') await this.io.unlink(temporary).catch(() => {});
      throw new Error(`Не удалось подготовить правила памяти (${error.code || 'ошибка записи'}).`);
    }
  }

  async apply(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректные параметры правил памяти.');
    const { provider, enabled, revision } = input;
    providerName(provider);
    if (typeof enabled !== 'boolean' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new Error('Для изменения правил памяти нужен актуальный просмотр и выбор включения.');
    }
    const snapshot = await this._snapshot(provider);
    if (snapshot.preview.revision !== revision) throw new Error('Просмотр правил памяти устарел. Обновите его перед сохранением.');
    if (snapshot.preview.conflict) throw new Error(snapshot.preview.conflict);
    const { instruction, procedure, block, paths, assets } = snapshot;
    let nextText = instruction.text;
    if (enabled && !block.enabled) nextText += block.block;
    if (!enabled && block.enabled) nextText = nextText.slice(0, block.start) + nextText.slice(block.end);
    const nextBytes = Buffer.from(nextText);
    if (nextBytes.length > MAX_FILE_BYTES) throw new Error('После добавления правил файл превысит ограничение 2 МБ.');
    const instructionChanged = !instruction.bytes.equals(nextBytes);
    const procedureNeeded = enabled && !procedure.exists;
    if (!instructionChanged && !procedureNeeded) return { ...snapshot.preview, changed: false, backupPaths: [] };

    // The lock serializes other Codex Desk windows/processes. External editors are
    // checked again immediately before each commit; rename is not a filesystem CAS.
    await this.io.mkdir(path.dirname(paths.procedurePath), { recursive: true });
    await this.io.mkdir(path.dirname(instruction.path), { recursive: true });
    await this._assertUnchanged(snapshot);
    const lockPath = path.join(paths.agentHome, 'codex-desk', '.memory-rules.lock');
    let lock;
    try { lock = await this.io.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Правила памяти уже изменяются другим окном. Если приложение было аварийно закрыто, проверьте файл блокировки: ${lockPath}`);
      throw new Error(`Не удалось заблокировать запись правил памяти (${error.code || 'ошибка доступа'}).`);
    }
    const temporary = [];
    const backupPaths = [];
    try {
      await this._assertUnchanged(snapshot);
      if (instructionChanged && instruction.exists) {
        const backup = `${instruction.path}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
        try { await this.io.writeFile(backup, instruction.bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) { throw new Error(`Не удалось создать резервную копию инструкций; исходный файл не изменён (${error.code || 'ошибка записи'}).`); }
        backupPaths.push(backup);
      }
      const procedureTemp = procedureNeeded ? await this._stage(paths.procedurePath, Buffer.from(assets.procedureText)) : null;
      if (procedureTemp) temporary.push(procedureTemp);
      const instructionTemp = instructionChanged ? await this._stage(instruction.path, nextBytes) : null;
      if (instructionTemp) temporary.push(instructionTemp);
      await this._assertUnchanged(snapshot);
      if (procedureTemp) await this.io.link(procedureTemp, paths.procedurePath);
      if (instructionTemp) {
        await this._assertUnchanged(snapshot, { procedureCreated: Boolean(procedureTemp) });
        if (instruction.exists) await this.io.rename(instructionTemp, instruction.path);
        else await this.io.link(instructionTemp, instruction.path);
      }
    } finally {
      await Promise.all(temporary.map(filePath => this.io.unlink(filePath).catch(() => {})));
      await lock.close();
      await this.io.unlink(lockPath).catch(() => {});
    }
    return { ...(await this.preview(provider)), changed: true, backupPaths };
  }
}
