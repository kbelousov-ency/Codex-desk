import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrivateKey, randomUUID } from 'node:crypto';
import path from 'node:path';
import { cleanLabel, validateRelayUrl } from './protocol.mjs';

/**
 * Durable data of the relay bridge. Two files inside `<userData>/remote-bridge`:
 *
 * - `credential.json` — the whole device credential encrypted as one blob (installation id, the
 *   installation's Ed25519 private key, tab salt, owner). Without working encryption it is not
 *   written at all. The private key is generated here and never leaves this computer.
 * - `bridge.json` — settings and the durable `epoch`, plus accepted `commandId → requestId`.
 *   It holds no secret and no command text, so it can be read without decryption.
 *
 * The split was modelled on the personal bot's `electron/telegram/storage.mjs` and deliberately
 * copied rather than shared — which is why nothing broke when that module left the product at
 * stage 5 of the plan (2026-10-15). The rules it proved are kept here: fail closed without
 * encryption, a corrupted record never starts as an empty one, retry only the atomic rename.
 */

const unavailable = 'Шифрование недоступно в этой системе. Подключение к серверу не сохранено.';
const corrupted = 'Сохранённое подключение к серверу не читается. Отвяжите установку и свяжите заново.';
const damaged = 'Служебные данные подключения к серверу повреждены. Подключение выключено до исправления.';

/** A durable write that did not land. Distinct from a refusal of the input: nothing was persisted. */
export class BridgeStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeStorageError';
  }
}

export async function writeAtomic(filename, payload, { renameFile = rename, sleep = delay, platform = process.platform } = {}) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(payload, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // Windows scanners briefly hold the previous JSON without delete sharing. Retry only the
    // atomic replacement — never the network or the agent operation it was protecting.
    for (let attempt = 0; ; attempt++) {
      try { await renameFile(temporary, filename); break; }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
        await sleep(Math.min(25 * (attempt + 1), 100));
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

const emptyRecord = () => ({
  version: 1,
  enabled: false,
  relayUrl: '',
  label: 'Кузьмич',
  // Durable. Incremented once per bridge start, so a revision never goes backwards across a
  // restart and the server can tell a restarted desktop from a reordered frame.
  epoch: 0,
  // { commandId, requestId, tabId, action, at } — identifiers only, never the command text.
  // No TTL: an entry outlives everything but unlinking the installation.
  commands: [],
});

export class BridgeStore {
  constructor({ directory, encrypt, decrypt, available = () => true, now = () => Date.now() }) {
    this.credentialFile = path.join(directory, 'credential.json');
    this.recordFile = path.join(directory, 'bridge.json');
    this.encrypt = encrypt; this.decrypt = decrypt; this.available = available; this.now = now;
    this.queue = Promise.resolve();
    this.credentialValue = undefined;  // undefined: not read yet; null: absent
    this.credentialError = '';
    this.record = undefined;
    this.loadFailure = '';
  }

  _job(fn) {
    const job = this.queue.catch(() => {}).then(fn);
    this.queue = job;
    return job;
  }

  async flush() {
    let pending;
    do { pending = this.queue; await pending.catch(() => {}); } while (pending !== this.queue);
  }

  async _readCredential() {
    if (this.credentialValue !== undefined) return this.credentialValue;
    let raw;
    try { raw = JSON.parse(await readFile(this.credentialFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { this.credentialValue = null; this.credentialError = ''; return null; }
      this.credentialValue = null; this.credentialError = corrupted; return null;
    }
    if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.payload !== 'string') {
      this.credentialValue = null; this.credentialError = corrupted; return null;
    }
    if (!this.available()) { this.credentialValue = null; this.credentialError = unavailable; return null; }
    let parsed;
    try { parsed = JSON.parse(this.decrypt(Buffer.from(raw.payload, 'base64'))); }
    catch { this.credentialValue = null; this.credentialError = corrupted; return null; }
    const value = normalizeCredential(parsed);
    if (!value) { this.credentialValue = null; this.credentialError = corrupted; return null; }
    this.credentialValue = value; this.credentialError = '';
    return value;
  }

  async _readRecord() {
    if (this.record !== undefined) return this.record;
    let raw;
    try { raw = JSON.parse(await readFile(this.recordFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { this.record = emptyRecord(); return this.record; }
      // Fail closed. Restarting as an empty record would reset the durable epoch, and old
      // revisions could then block the events of the running session.
      this.loadFailure = damaged;
      this.record = null;
      return null;
    }
    if (!raw || typeof raw !== 'object' || raw.version !== 1) { this.loadFailure = damaged; this.record = null; return null; }
    let relayUrl = '';
    try { relayUrl = raw.relayUrl ? validateRelayUrl(raw.relayUrl) : ''; } catch { relayUrl = ''; }
    this.record = {
      ...emptyRecord(),
      enabled: raw.enabled === true,
      relayUrl,
      label: cleanLabel(raw.label),
      epoch: Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0,
      commands: Array.isArray(raw.commands)
        ? raw.commands.filter(entry => entry && typeof entry === 'object' && typeof entry.commandId === 'string' && typeof entry.requestId === 'string')
        : [],
    };
    return this.record;
  }

  load() {
    return this._job(async () => {
      await this._readCredential();
      return this._readRecord();
    });
  }

  /** Synchronous views for guards that must decide before awaiting. */
  snapshot() { return this.record ?? null; }
  get credential() { return this.credentialValue || null; }
  get failure() { return this.loadFailure; }
  get credentialFailure() { return this.credentialError; }
  get encryptionAvailable() { return this.available(); }

  /** Serialized read-modify-write of the plain record. Nothing is committed until the file lands. */
  update(mutator) {
    return this._job(async () => {
      const record = await this._readRecord();
      if (!record) throw new BridgeStorageError(this.loadFailure || damaged);
      const draft = structuredClone(record);
      const result = await mutator(draft);
      draft.version = 1;
      draft.label = cleanLabel(draft.label);
      draft.commands = prune(draft.commands);
      try { await writeAtomic(this.recordFile, JSON.stringify(draft)); }
      catch (cause) {
        const code = ['EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'EROFS'].includes(cause?.code) ? ` (${cause.code})` : '';
        throw new BridgeStorageError(`Не удалось сохранить настройки подключения к серверу${code}.`);
      }
      this.record = draft;
      return result;
    });
  }

  /** One durable step per bridge start. A failure here stops publishing entirely. */
  nextEpoch() { return this.update(draft => { draft.epoch += 1; return draft.epoch; }); }

  /**
   * Admits a command durably **before** the core is touched. If this write does not land, no RPC
   * happens — so the file can never fall behind what was actually executed, only ahead of it, and
   * being ahead is recoverable (the replay path asks the core what really happened).
   *
   * The command text is deliberately absent. Detecting "same id, different text" therefore belongs
   * to the core, which holds the immutable payload and answers `request_conflict`; what is checked
   * here is only what this file is allowed to remember.
   */
  rememberCommand({ commandId, requestId, tabId, action }) {
    return this.update(draft => {
      const existing = draft.commands.find(entry => entry.commandId === commandId);
      if (existing) {
        return {
          requestId: existing.requestId,
          replay: true,
          conflict: existing.requestId !== requestId || existing.tabId !== tabId || existing.action !== action,
        };
      }
      draft.commands.push({ commandId, requestId, tabId, action, at: this.now() });
      return { requestId, replay: false, conflict: false };
    });
  }

  saveCredential(input) {
    return this._job(async () => {
      const value = normalizeCredential(input);
      if (!value) throw new Error('Сервер выдал неполные данные установки.');
      if (!this.available()) throw new BridgeStorageError(unavailable);
      const payload = JSON.stringify({ version: 1, payload: Buffer.from(this.encrypt(JSON.stringify(value))).toString('base64'), savedAt: new Date(this.now()).toISOString() });
      try { await writeAtomic(this.credentialFile, payload); }
      catch { throw new BridgeStorageError('Не удалось сохранить подключение к серверу.'); }
      this.credentialValue = value; this.credentialError = '';
      return value;
    });
  }

  /**
   * Local revocation does not depend on the network: the file goes regardless of whether the
   * relay ever answered. An unreachable server must not stop the owner disconnecting from it.
   */
  clearCredential() {
    return this._job(async () => {
      try { await unlink(this.credentialFile); }
      catch (error) { if (error.code !== 'ENOENT') throw new BridgeStorageError('Не удалось удалить подключение к серверу.'); }
      this.credentialValue = null; this.credentialError = '';
    });
  }
}

function normalizeCredential(value) {
  if (!value || typeof value !== 'object') return null;
  const installationId = String(value.installationId ?? '');
  const privateKey = String(value.privateKey ?? '');
  const publicKey = String(value.publicKey ?? '');
  const tabSalt = String(value.tabSalt ?? '');
  const telegramUserId = String(value.owner?.telegramUserId ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(installationId)) return null;
  // The private key must actually be a usable Ed25519 key, not merely a long string: a credential
  // that cannot sign would otherwise look valid and fail only at the first challenge.
  try {
    const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
  } catch { return null; }
  if (Buffer.from(publicKey, 'base64url').length < 32) return null;
  if (Buffer.from(tabSalt, 'base64url').length < 32) return null;
  if (!/^-?[0-9]{1,20}$/.test(telegramUserId)) return null;
  let relayUrl = '';
  try { relayUrl = value.relayUrl ? validateRelayUrl(value.relayUrl) : ''; } catch { return null; }
  return {
    installationId, privateKey, publicKey, tabSalt, relayUrl,
    owner: { telegramUserId, displayName: String(value.owner?.displayName ?? '').slice(0, 120) },
    issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt.slice(0, 64) : new Date().toISOString(),
  };
}

/**
 * Keeps the journal as long as the installation itself, deduplicating only.
 *
 * It used to drop entries older than a week and cap the list at 500. That was wrong, and the
 * owner's rule for 2.2 says so: an entry that disappears turns a very old repeat back into a new
 * request as far as this computer can tell, which is exactly what a tombstone exists to prevent.
 * The core's ledger has no TTL in v1 either, and the two must not disagree about what was already
 * admitted. Unlinking the installation removes the whole file, and that is the only expiry there is.
 */
export function prune(commands) {
  const seen = new Set();
  const kept = [];
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (seen.has(entry.commandId)) continue;
    seen.add(entry.commandId);
    kept.push(entry);
  }
  return kept;
}
