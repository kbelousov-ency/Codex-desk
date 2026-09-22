import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_BOOKMARKS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queues = new Map();
const directoryKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function field(value, max, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value) || value.length > max || /[\0\r\n]/u.test(value)) throw new Error(`Некорректное поле закладки: ${label}.`);
  return value;
}
function directory(value) {
  field(value, 4096, 'папка');
  if (!path.isAbsolute(value)) throw new Error('Укажите абсолютную папку закладки.');
  return path.resolve(value);
}
function fields(value) {
  if (!object(value) || !['codex', 'claude'].includes(value.provider)) throw new Error('Некорректный агент закладки.');
  const threadId = field(value.threadId, 512, 'диалог');
  if (!UUID.test(value.provider === 'claude' ? threadId.replace(/^claude:/, '') : threadId)
    || (value.provider === 'claude' && !threadId.startsWith('claude:'))) throw new Error('Некорректный диалог закладки.');
  if (typeof value.excerpt !== 'string' || value.excerpt.length > 2_000_000 || value.excerpt.includes('\0')) throw new Error('Некорректный фрагмент сообщения закладки.');
  if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new Error('Некорректная область закладки.');
  return { provider: value.provider, cwd: directory(value.cwd), threadId,
    itemId: field(value.itemId, 512, 'сообщение'),
    ...(value.turnId !== undefined ? { turnId: field(value.turnId, 512, 'запрос') } : {}),
    ...(value.archived !== undefined ? { archived: value.archived } : {}),
    threadName: field(value.threadName, 500, 'название диалога', true),
    excerpt: value.excerpt.slice(0, 4000), label: field(value.label, 200, 'подпись', true).trim() };
}
function bookmark(value) {
  if (!UUID.test(value?.id ?? '') || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) || value.excerpt?.length > 4000) {
    throw new Error('Некорректная сохранённая закладка.');
  }
  return { ...fields(value), id: value.id, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
const identity = value => JSON.stringify([value.provider, value.threadId, value.itemId]);

/** One small durable app-owned store; never modifies either agent's history. */
export class BookmarkStore {
  constructor(userData) {
    this.userData = path.resolve(userData);
    this.filename = path.join(this.userData, 'bookmarks.json');
    this.queueKey = directoryKey(this.filename);
  }
  serial(work) {
    const result = (queues.get(this.queueKey) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.queueKey, result);
    void result.finally(() => { if (queues.get(this.queueKey) === result) queues.delete(this.queueKey); }).catch(() => {});
    return result;
  }
  async read() {
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid bookmarks file');
      const value = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!object(value) || value.version !== 1 || !Array.isArray(value.bookmarks) || value.bookmarks.length > MAX_BOOKMARKS) throw new Error('Invalid bookmarks schema');
      const result = value.bookmarks.map(bookmark);
      if (new Set(result.map(item => item.id)).size !== result.length || new Set(result.map(identity)).size !== result.length) throw new Error('Duplicate bookmarks');
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Не удалось прочитать bookmarks.json. Файл сохранён без изменений; восстановите его перед редактированием закладок.');
    }
  }
  async write(items) {
    const serialized = JSON.stringify({ version: 1, bookmarks: items });
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Закладки превышают допустимый размер 32 МиБ.');
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filename);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  list(options = {}) {
    if (!object(options)) return Promise.reject(new Error('Некорректный фильтр закладок.'));
    const cwd = options.cwd === undefined ? undefined : directory(options.cwd);
    if (options.provider !== undefined && !['all', 'codex', 'claude'].includes(options.provider)) throw new Error('Неизвестный агент закладок.');
    const provider = options.provider;
    return this.serial(async () => (await this.read()).filter(item => (!cwd || directoryKey(item.cwd) === directoryKey(cwd))
      && (!provider || provider === 'all' || item.provider === provider)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  save(value) {
    const data = fields(value), id = value.id, preserveLabel = value.label === undefined;
    if (id !== undefined && !UUID.test(id)) throw new Error('Некорректный идентификатор закладки.');
    return this.serial(async () => {
      const items = await this.read(), duplicate = items.find(item => identity(item) === identity(data));
      const previous = id === undefined ? duplicate : items.find(item => item.id === id);
      if (id !== undefined && !previous) throw new Error('Закладка уже удалена. Обновите список.');
      if (previous && (identity(previous) !== identity(data) || directoryKey(previous.cwd) !== directoryKey(data.cwd))) throw new Error('Нельзя перенести закладку на другое сообщение.');
      if (duplicate && previous && duplicate.id !== previous.id) throw new Error('Для сообщения уже есть другая закладка.');
      if (!previous && items.length >= MAX_BOOKMARKS) throw new Error('Достигнут предел 5000 закладок.');
      const now = new Date().toISOString();
      const saved = { ...data, ...(preserveLabel && previous ? { label: previous.label } : {}),
        id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now };
      if (previous) items[items.indexOf(previous)] = saved; else items.push(saved);
      await this.write(items);
      return saved;
    });
  }
  remove(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Некорректный идентификатор закладки.');
    return this.serial(async () => {
      const items = await this.read(), retained = items.filter(item => item.id !== id);
      if (retained.length === items.length) return { removed: false };
      await this.write(retained);
      return { removed: true };
    });
  }
  async flush() {
    let current;
    do { current = queues.get(this.queueKey); await current?.catch(() => {}); }
    while (queues.get(this.queueKey) && queues.get(this.queueKey) !== current);
  }
}
