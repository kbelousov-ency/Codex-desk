import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const directoryKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const threadId = value => {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Некорректный идентификатор диалога.');
  const bare = value.startsWith('claude:') ? value.slice('claude:'.length) : value;
  if (!UUID.test(bare)) throw new Error('Некорректный идентификатор диалога.');
  return value;
};
const folder = value => {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.length >= 4096) throw new Error('Некорректная рабочая папка связи диалогов.');
  return path.resolve(value);
};
const text = (value, limit = 200) => typeof value === 'string' && value.length <= limit ? value : null;
// Optional default name of an executor agent («Агент A»). Records written before this field
// existed simply have no label and stay valid; the file version is unchanged.
const label = value => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error('Некорректное имя агента-исполнителя.');
  return value;
};

export class ThreadChildLinkStore {
  constructor(userData, { filename = 'thread-child-links.json' } = {}) {
    this.userData = path.resolve(userData);
    this.filename = path.join(this.userData, filename);
    this.queue = Promise.resolve();
    this.cache = null;
  }
  serial(work) { const result = this.queue.catch(() => {}).then(work); this.queue = result.catch(() => {}); return result; }
  entry(value) {
    if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('Invalid child link id');
    return {
      id: value.id,
      cwd: folder(value.cwd),
      parentThreadId: threadId(value.parentThreadId),
      childThreadId: threadId(value.childThreadId),
      provider: value.provider === 'claude' ? 'claude' : 'codex',
      model: text(value.model), effort: text(value.effort), label: label(value.label),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    };
  }
  async load() {
    if (this.cache) return this.cache;
    let links = [];
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid child link file');
      const value = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!object(value) || value.version !== 1 || !Array.isArray(value.links)) throw new Error('Invalid child link schema');
      links = value.links.map(item => this.entry(item));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Не удалось прочитать thread-child-links.json. Восстановите файл перед продолжением.');
    }
    this.cache = links; return links;
  }
  async save(links) {
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, links }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, this.filename); }
    finally { await unlink(temporary).catch(() => {}); }
    this.cache = links;
  }
  list(cwd) { return this.serial(async () => (await this.load()).filter(link => cwd === undefined || directoryKey(link.cwd) === directoryKey(cwd)).map(link => ({ ...link }))); }
  create(options) {
    return this.serial(async () => {
      const links = await this.load();
      const value = this.entry({ id: randomUUID(), ...options, createdAt: new Date().toISOString() });
      if (value.parentThreadId === value.childThreadId) throw new Error('Диалог не может быть своим собственным родителем.');
      const existing = links.find(link => link.childThreadId === value.childThreadId);
      if (existing) return { link: { ...existing } };
      await this.save([...links, value]); return { link: { ...value } };
    });
  }
  /** `unlink` drops one navigation record, `relabel` rewrites its executor name. Neither touches
   * the conversation itself: an unlinked executor stays as a plain dialog of the same folder. */
  manage(options) {
    return this.serial(async () => {
      if (!object(options)) throw new Error('Некорректная операция со связью диалогов.');
      const child = threadId(options.childThreadId);
      const links = await this.load();
      if (options.action === 'unlink') {
        const rest = links.filter(link => link.childThreadId !== child);
        if (rest.length !== links.length) await this.save(rest);
        return { changed: rest.length !== links.length, link: null };
      }
      if (options.action === 'relabel') {
        const name = label(options.label);
        const changed = links.some(link => link.childThreadId === child && link.label !== name);
        const rest = links.map(link => link.childThreadId === child ? { ...link, label: name } : link);
        if (changed) await this.save(rest);
        const link = rest.find(item => item.childThreadId === child);
        return { changed, link: link ? { ...link } : null };
      }
      throw new Error('Неизвестная операция со связью диалогов.');
    });
  }
  forget(threadIds) {
    return this.serial(async () => {
      const ids = new Set((Array.isArray(threadIds) ? threadIds : [threadIds]).filter(value => typeof value === 'string'));
      const links = await this.load(); const rest = links.filter(link => !ids.has(link.parentThreadId) && !ids.has(link.childThreadId));
      if (rest.length !== links.length) await this.save(rest);
      return true;
    });
  }
}
