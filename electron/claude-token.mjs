import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Long-lived Claude Code OAuth tokens from `claude setup-token`. Only the documented prefix is accepted. */
const tokenPattern = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{40,600}$/;
const unavailable = 'Шифрование токена недоступно в этой системе. Токен не сохранён.';
const corrupted = 'Сохранённый токен Claude Code не читается. Удалите его и сохраните заново.';

export function validateClaudeToken(value) {
  if (typeof value !== 'string') throw new Error('Вставьте токен из команды claude setup-token.');
  const token = value.trim();
  if (!tokenPattern.test(token)) throw new Error('Токен не похож на результат claude setup-token (ожидается строка, начинающаяся с sk-ant-oat).');
  return token;
}

/**
 * The token lives outside settings.json and workspace snapshots, encrypted at rest by Electron
 * safeStorage (DPAPI on Windows). It reaches only Claude CLI process environments, never the renderer.
 */
export class ClaudeTokenStore {
  constructor({ filename, encrypt, decrypt, available = () => true, onChange = () => {} }) {
    this.filename = filename;
    this.encrypt = encrypt; this.decrypt = decrypt; this.available = available; this.onChange = onChange;
    this.queue = Promise.resolve();
    this.cache = undefined;
  }

  _job(fn) {
    const job = this.queue.catch(() => {}).then(fn);
    this.queue = job;
    return job;
  }

  async _read() {
    if (this.cache !== undefined) return this.cache;
    let raw;
    try { raw = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { this.cache = null; return null; }
      throw new Error(corrupted);
    }
    if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.token !== 'string' || typeof raw.savedAt !== 'string') throw new Error(corrupted);
    if (!this.available()) throw new Error(unavailable);
    let token;
    try { token = this.decrypt(Buffer.from(raw.token, 'base64')); } catch { throw new Error(corrupted); }
    if (!tokenPattern.test(token)) throw new Error(corrupted);
    this.cache = { token, savedAt: raw.savedAt };
    return this.cache;
  }

  /** Public description for the renderer: never the token itself. */
  info() {
    return this._job(async () => {
      try {
        const entry = await this._read();
        return { configured: Boolean(entry), ...(entry ? { savedAt: entry.savedAt } : {}), encryptionAvailable: this.available() };
      } catch (error) {
        return { configured: false, encryptionAvailable: this.available(), error: error.message };
      }
    });
  }

  /** Environment additions for every Claude CLI process the app owns. Unreadable storage yields none. */
  environment() {
    return this._job(async () => {
      try {
        const entry = await this._read();
        return entry ? { CLAUDE_CODE_OAUTH_TOKEN: entry.token } : {};
      } catch { return {}; }
    });
  }

  async set(value) {
    const token = validateClaudeToken(value);
    return this._job(async () => {
      if (!this.available()) throw new Error(unavailable);
      const savedAt = new Date().toISOString();
      const payload = JSON.stringify({ version: 1, token: this.encrypt(token).toString('base64'), savedAt });
      await mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filename);
      } catch { throw new Error('Не удалось сохранить токен Claude Code.'); }
      finally { await unlink(temporary).catch(() => {}); }
      this.cache = { token, savedAt };
      this.onChange('saved');
      return { configured: true, savedAt, encryptionAvailable: true };
    });
  }

  clear() {
    return this._job(async () => {
      try { await unlink(this.filename); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось удалить токен Claude Code.'); }
      this.cache = null;
      this.onChange('cleared');
      return { configured: false, encryptionAvailable: this.available() };
    });
  }

  async flush() {
    let pending;
    do { pending = this.queue; await pending.catch(() => {}); } while (pending !== this.queue);
  }
}

/**
 * Claude CLI processes that share one credentials file must not refresh the single-use OAuth token
 * at the same moment: the loser gets invalid_grant and blanks the file. Starts and usage reads run
 * one at a time; a stalled predecessor is waited for only up to `maxWaitMs`.
 */
export class ClaudeLaunchGate {
  constructor({ maxWaitMs = 30_000 } = {}) {
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new TypeError('maxWaitMs must be positive.');
    this.maxWaitMs = maxWaitMs;
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  run(fn) {
    const previous = this.tail;
    let release;
    const done = new Promise(resolve => { release = resolve; });
    this.tail = done;
    this.pending++;
    return (async () => {
      let timer;
      try {
        await Promise.race([previous, new Promise(resolve => { timer = setTimeout(resolve, this.maxWaitMs); })]);
        clearTimeout(timer);
        return await fn();
      } finally {
        clearTimeout(timer);
        this.pending--;
        release();
      }
    })();
  }
}
