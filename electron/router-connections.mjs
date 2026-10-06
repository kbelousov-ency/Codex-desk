import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const AGENTS = new Set(['codex', 'claude']);
const FIELDS = new Set(['apiKey', 'baseUrl', 'authScheme', 'providerId', 'providerName', 'model', 'email', 'defaults', 'modelAliases', 'modelNames']);
const MODEL_ALIASES = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?:\[1m\])?$/;
const DEFAULTS = new Set(['model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary', 'hide_agent_reasoning']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const invalid = 'Некорректные параметры подключения роутера.';
const unavailable = 'Шифрование подключения роутера недоступно в этой системе. Подключение не сохранено.';
const corrupted = 'Сохранённое подключение роутера не читается. Подключите роутер заново.';
const MAX_FILE_BYTES = 128 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

function agentName(agent) {
  if (!AGENTS.has(agent)) throw new Error(invalid);
  return agent;
}

function leaksKey(value, apiKey) {
  if (typeof value !== 'string') return false;
  // Metadata reaches the renderer. Reject both literal keys and URL-escaped keys.
  for (let depth = 0; depth < 3; depth++) {
    if (value.includes(apiKey) || value.includes(encodeURIComponent(apiKey))) return true;
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch { break; }
  }
  return false;
}

/** Validated host-only data, independent of any portal endpoint or response dialect. */
export function validateRouterConnection(agent, value) {
  agentName(agent);
  if (!record(value) || Object.keys(value).some(key => !FIELDS.has(key))
    || !text(value.apiKey, 8192) || !/^[\x21-\x7e]+$/.test(value.apiKey)
    || !['bearer', 'api-key'].includes(value.authScheme)
    || (agent === 'codex' && value.authScheme !== 'bearer')) throw new Error(invalid);
  if (!text(value.baseUrl, 2048) || /\s/.test(value.baseUrl)) throw new Error(invalid);
  try {
    const url = new URL(value.baseUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error(invalid); }
  const result = { apiKey: value.apiKey, baseUrl: value.baseUrl, authScheme: value.authScheme };
  for (const [key, max] of [['providerId', 128], ['providerName', 160], ['model', 128], ['email', 320]]) {
    if (!Object.hasOwn(value, key)) continue;
    if (!text(value[key], max) || leaksKey(value[key], value.apiKey)) throw new Error(invalid);
    if (key === 'providerId' && (!/^[a-zA-Z0-9_-]+$/.test(value[key]) || FORBIDDEN.has(value[key]))) throw new Error(invalid);
    if (key === 'model' && !MODEL_ID.test(value[key])) throw new Error(invalid);
    result[key] = value[key];
  }
  if (leaksKey(value.baseUrl, value.apiKey) || leaksKey(value.authScheme, value.apiKey)) throw new Error(invalid);
  for (const key of ['modelAliases', 'modelNames']) {
    if (!Object.hasOwn(value, key)) continue;
    if (agent !== 'claude' || !record(value[key]) || Object.keys(value[key]).some(alias => !MODEL_ALIASES.has(alias))) throw new Error(invalid);
    result[key] = {};
    for (const [alias, label] of Object.entries(value[key])) {
      if (!text(label, key === 'modelAliases' ? 128 : 160) || leaksKey(label, value.apiKey)
        || (key === 'modelAliases' && !MODEL_ID.test(label))) throw new Error(invalid);
      result[key][alias] = label;
    }
  }
  if (Object.hasOwn(value, 'defaults')) {
    const defaults = value.defaults;
    if (!record(defaults) || Object.keys(defaults).some(key => !DEFAULTS.has(key))
      || (agent === 'claude' && Object.keys(defaults).length)) throw new Error(invalid);
    for (const key of ['model_context_window', 'model_auto_compact_token_limit']) {
      if (Object.hasOwn(defaults, key) && (!Number.isSafeInteger(defaults[key]) || defaults[key] <= 0 || defaults[key] > 100_000_000)) throw new Error(invalid);
    }
    if (Object.hasOwn(defaults, 'model_context_window') && Object.hasOwn(defaults, 'model_auto_compact_token_limit')
      && defaults.model_auto_compact_token_limit > defaults.model_context_window) throw new Error(invalid);
    if (Object.hasOwn(defaults, 'model_reasoning_summary') && !['auto', 'concise', 'detailed', 'none'].includes(defaults.model_reasoning_summary)) throw new Error(invalid);
    if (Object.hasOwn(defaults, 'hide_agent_reasoning') && typeof defaults.hide_agent_reasoning !== 'boolean') throw new Error(invalid);
    if (Object.values(defaults).some(entry => leaksKey(entry, value.apiKey))) throw new Error(invalid);
    result.defaults = { ...defaults };
  }
  return result;
}

function publicInfo(entry, encryptionAvailable) {
  if (!entry) return { configured: false, encryptionAvailable };
  const { connection, savedAt } = entry;
  return {
    configured: true, encryptionAvailable, savedAt,
    ...Object.fromEntries(['baseUrl', 'authScheme', 'providerId', 'providerName', 'model', 'email']
      .filter(key => Object.hasOwn(connection, key)).map(key => [key, connection[key]])),
  };
}

/**
 * Main-process store. Each complete entry is encrypted with Electron safeStorage (Windows DPAPI).
 * Never include get() results in IPC, diagnostics, settings.json, or workspace snapshots.
 * A selected router that cannot be read must fail, rather than fall back to a personal account.
 */
export class RouterConnectionStore {
  constructor({ filename, encrypt, decrypt, available = () => true, onChange = () => {} }) {
    this.filename = filename;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.available = available;
    this.onChange = onChange;
    this.queue = Promise.resolve();
    this.cache = undefined;
  }

  _job(fn) {
    const job = this.queue.catch(() => {}).then(fn);
    this.queue = job;
    return job;
  }

  async _readEnvelope() {
    if (this.cache !== undefined) return this.cache;
    try {
      const bytes = await readFile(this.filename);
      if (bytes.length > MAX_FILE_BYTES) throw new Error();
      const raw = JSON.parse(bytes.toString('utf8'));
      if (!record(raw) || raw.version !== 1 || Object.keys(raw).some(key => !['version', 'entries'].includes(key))
        || !record(raw.entries) || Object.keys(raw.entries).some(key => !AGENTS.has(key))) throw new Error();
      this.cache = { ...raw.entries };
    } catch (error) {
      if (error.code === 'ENOENT') this.cache = {};
      else throw new Error(corrupted);
    }
    return this.cache;
  }

  async _entry(agent) {
    const entries = await this._readEnvelope();
    if (!Object.hasOwn(entries, agent)) return null;
    if (!this.available()) throw new Error(unavailable);
    try {
      const ciphertext = entries[agent];
      if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > MAX_FILE_BYTES
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw new Error();
      const entry = JSON.parse(this.decrypt(Buffer.from(ciphertext, 'base64')));
      if (!record(entry) || Object.keys(entry).some(key => !['connection', 'savedAt'].includes(key))
        || typeof entry.savedAt !== 'string' || new Date(entry.savedAt).toISOString() !== entry.savedAt) throw new Error();
      return { connection: validateRouterConnection(agent, entry.connection), savedAt: entry.savedAt };
    } catch { throw new Error(corrupted); }
  }

  /** Renderer-safe status. Any read error is generic and contains no key or raw file content. */
  info(agent) {
    agentName(agent);
    return this._job(async () => {
      try { return publicInfo(await this._entry(agent), this.available()); }
      catch (error) { return { configured: false, encryptionAvailable: this.available(), error: error.message }; }
    });
  }

  /** Host only. An absent entry returns null; an unreadable configured entry throws. */
  get(agent) {
    agentName(agent);
    return this._job(async () => (await this._entry(agent))?.connection ?? null);
  }

  async _write(entries) {
    const payload = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('Подключение роутера слишком большое.');
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filename);
    } catch { throw new Error('Не удалось сохранить подключение роутера.'); }
    finally { await unlink(temporary).catch(() => {}); }
    this.cache = entries;
  }

  async set(agent, value) {
    const connection = validateRouterConnection(agent, value);
    return this._job(async () => {
      if (!this.available()) throw new Error(unavailable);
      const entries = await this._readEnvelope();
      const entry = { connection, savedAt: new Date().toISOString() };
      let encrypted;
      try {
        const bytes = this.encrypt(JSON.stringify(entry));
        if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error();
        encrypted = bytes.toString('base64');
      } catch { throw new Error('Не удалось зашифровать подключение роутера.'); }
      await this._write({ ...entries, [agent]: encrypted });
      this.onChange('saved', agent);
      return publicInfo(entry, true);
    });
  }

  clear(agent) {
    agentName(agent);
    return this._job(async () => {
      const entries = { ...await this._readEnvelope() };
      if (Object.hasOwn(entries, agent)) {
        delete entries[agent];
        if (Object.keys(entries).length) await this._write(entries);
        else {
          try { await unlink(this.filename); }
          catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось удалить подключение роутера.'); }
          this.cache = {};
        }
      }
      this.onChange('cleared', agent);
      return publicInfo(null, this.available());
    });
  }

  async flush() {
    let pending;
    do { pending = this.queue; await pending.catch(() => {}); } while (pending !== this.queue);
  }
}
