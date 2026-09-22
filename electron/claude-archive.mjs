import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeThreadId } from './claude-history.mjs';

/** Only a namespaced Claude id may enter the archive: a bare UUID could be a Codex thread. */
const threadId = value => {
  if (typeof value !== 'string' || !value.startsWith('claude:')) throw new Error('Некорректный идентификатор диалога Claude.');
  return claudeThreadId(value);
};

const MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_ENTRIES = 5000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const directoryKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const text = (value, max) => typeof value === 'string' && !value.includes('\0') ? value.slice(0, max) : '';
const moment = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Native Claude history has no archived state, so the shell keeps its own list of
 * archived session ids. Transcripts, the SQLite store and the CLI config stay untouched:
 * an archived dialog is only hidden from the project history and shown in the archive
 * panel. `claude --resume` in a terminal still sees an ordinary session — deliberately,
 * because the shell must not rewrite the agent's own data. */
export class ClaudeArchiveStore {
  constructor(userData) {
    this.userData = path.resolve(userData);
    this.filename = path.join(this.userData, 'claude-archive.json');
    this.queue = Promise.resolve();
    this.cache = null;
  }
  serial(work) {
    const result = this.queue.catch(() => {}).then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  entry(value) {
    const id = threadId(value?.id);
    if (typeof value.cwd !== 'string' || !value.cwd || value.cwd.length >= 4096 || !path.isAbsolute(value.cwd)) throw new Error('Некорректная папка архивного диалога Claude.');
    return { id, cwd: path.resolve(value.cwd),
      name: text(value.name, 500), preview: text(value.preview, 1000),
      ...(moment(value.updatedAt) !== undefined ? { updatedAt: moment(value.updatedAt) } : {}),
      ...(moment(value.createdAt) !== undefined ? { createdAt: moment(value.createdAt) } : {}),
      archivedAt: moment(value.archivedAt) ?? Math.floor(Date.now() / 1000) };
  }
  async load() {
    if (this.cache) return this.cache;
    let entries = [];
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid claude archive file');
      const value = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!object(value) || value.version !== 1 || !Array.isArray(value.threads) || value.threads.length > MAX_ENTRIES) throw new Error('Invalid claude archive schema');
      entries = value.threads.map(item => this.entry(item));
      if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('Duplicate archived threads');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Не удалось прочитать claude-archive.json. Восстановите или удалите файл, чтобы пользоваться архивом Claude.');
    }
    this.cache = entries;
    return entries;
  }
  async save(entries) {
    const serialized = JSON.stringify({ version: 1, threads: entries });
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Архив Claude превышает допустимый размер.');
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filename);
    } finally { await unlink(temporary).catch(() => {}); }
    this.cache = entries;
  }
  list() { return this.serial(async () => [...await this.load()].sort((a, b) => (b.updatedAt || b.archivedAt) - (a.updatedAt || a.archivedAt))); }
  /** Ids archived in one project folder; used to hide them from the ordinary history list. */
  ids(cwd) {
    return this.serial(async () => {
      const entries = await this.load();
      const key = cwd === undefined ? null : directoryKey(cwd);
      return new Set(entries.filter(item => key === null || directoryKey(item.cwd) === key).map(item => item.id));
    });
  }
  has(value) {
    return this.serial(async () => {
      const id = threadId(value);
      return (await this.load()).some(item => item.id === id);
    });
  }
  find(value) {
    return this.serial(async () => {
      const id = threadId(value);
      return (await this.load()).find(item => item.id === id) || null;
    });
  }
  add(value) {
    return this.serial(async () => {
      const entry = this.entry(value);
      const entries = (await this.load()).filter(item => item.id !== entry.id);
      if (entries.length >= MAX_ENTRIES) throw new Error('В архиве Claude уже 5000 диалогов. Удалите ненужные.');
      await this.save([...entries, entry]);
      return entry;
    });
  }
  remove(value) {
    return this.serial(async () => {
      const id = threadId(value);
      const entries = await this.load();
      const kept = entries.filter(item => item.id !== id);
      if (kept.length !== entries.length) await this.save(kept);
      return entries.length - kept.length > 0;
    });
  }
}
