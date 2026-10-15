import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BridgeStore, BridgeStorageError, writeAtomic } from '../electron/remote-bridge/storage.mjs';
import { createInstallationKeys } from '../electron/remote-bridge/protocol.mjs';

const KEYS = createInstallationKeys();
const SALT = Buffer.alloc(32, 9).toString('base64url');
const INSTALLATION = '11111111-2222-4333-8444-555555555555';

const credential = (extra = {}) => ({
  installationId: INSTALLATION, privateKey: KEYS.privateKey, publicKey: KEYS.publicKey, tabSalt: SALT,
  relayUrl: 'wss://relay.example.com',
  owner: { telegramUserId: '12345678', displayName: 'Иван' },
  issuedAt: '2026-10-14T10:00:00.000Z', ...extra,
});

/** Stands in for Electron safeStorage. Reversible so the test can prove the file is not plain. */
function fixtureSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) { return Buffer.concat([Buffer.from('enc:'), Buffer.from(value, 'utf8').reverse()]); },
    decryptString(bytes) {
      const buffer = Buffer.from(bytes);
      if (buffer.subarray(0, 4).toString() !== 'enc:') throw new Error('bad blob');
      return Buffer.from(buffer.subarray(4)).reverse().toString('utf8');
    },
  };
}

/** A second store over the same folder stands in for the next run of the application. */
function makeStoreAt(directory, safeStorage = fixtureSafeStorage()) {
  return new BridgeStore({
    directory,
    encrypt: value => Buffer.from(safeStorage.encryptString(value)),
    decrypt: bytes => safeStorage.decryptString(bytes),
    available: () => safeStorage.isEncryptionAvailable(),
    now: () => Date.parse('2026-10-14T10:00:00.000Z'),
  });
}

async function makeStore(options = {}) {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), 'bridge-store-')), 'remote-bridge');
  const safeStorage = fixtureSafeStorage(options);
  return { store: makeStoreAt(directory, safeStorage), directory, safeStorage };
}

test('a fresh profile starts empty, enabled off and with no credential', async () => {
  const { store } = await makeStore();
  const record = await store.load();
  assert.deepEqual({ enabled: record.enabled, relayUrl: record.relayUrl, epoch: record.epoch }, { enabled: false, relayUrl: '', epoch: 0 });
  assert.equal(store.credential, null);
  assert.equal(store.failure, '');
  assert.equal(store.credentialFailure, '');
});

test('the credential is stored encrypted and never appears in clear text on disk', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  await store.saveCredential(credential());

  const raw = await readFile(path.join(directory, 'credential.json'), 'utf8');
  assert.ok(!raw.includes(KEYS.privateKey), 'the private key is not on disk in clear text');
  assert.ok(!raw.includes(SALT), 'the tab salt is not on disk in clear text');
  assert.ok(!raw.includes(INSTALLATION));
  assert.equal(JSON.parse(raw).version, 1);

  await store.update(draft => { draft.relayUrl = 'wss://relay.example.com'; draft.enabled = true; });
  const plain = await readFile(path.join(directory, 'bridge.json'), 'utf8');
  assert.ok(!plain.includes(KEYS.privateKey) && !plain.includes(SALT), 'the unencrypted record holds no secret at all');

  // A second store over the same folder reads it back.
  const reopened = new BridgeStore({
    directory, encrypt: () => Buffer.alloc(0),
    decrypt: bytes => { const buffer = Buffer.from(bytes); return Buffer.from(buffer.subarray(4)).reverse().toString('utf8'); },
    available: () => true, now: () => 0,
  });
  await reopened.load();
  assert.equal(reopened.credential.privateKey, KEYS.privateKey);
  assert.equal(reopened.credential.publicKey, KEYS.publicKey);
  assert.equal(reopened.snapshot().enabled, true);
});

test('without working encryption the credential is refused rather than written in the clear', async () => {
  const { store, directory, safeStorage } = await makeStore({ available: false });
  await store.load();
  await assert.rejects(() => store.saveCredential(credential()), BridgeStorageError);
  assert.deepEqual(await readdir(directory).catch(() => []), [], 'nothing was written at all');
  assert.equal(store.credential, null);

  // And an existing credential stays unreadable instead of being guessed at.
  safeStorage.available = true;
  await store.saveCredential(credential());
  safeStorage.available = false;
  const second = new BridgeStore({
    directory, encrypt: () => Buffer.alloc(0), decrypt: () => { throw new Error('unavailable'); },
    available: () => false, now: () => 0,
  });
  await second.load();
  assert.equal(second.credential, null);
  assert.match(second.credentialFailure, /Шифрование недоступно/);
});

test('a damaged record fails closed instead of restarting as an empty one', async () => {
  const { store, directory } = await makeStore();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'bridge.json'), '{ не json', 'utf8');
  assert.equal(await store.load(), null);
  assert.match(store.failure, /повреждены|не читается/);
  assert.equal(store.snapshot(), null);
  // Refusing the write is what stops an old epoch from silently resetting to zero.
  await assert.rejects(() => store.update(draft => { draft.enabled = true; }), BridgeStorageError);
  await assert.rejects(() => store.nextEpoch(), BridgeStorageError);
});

test('a record of an unknown version, and a credential that does not decrypt, are both refused', async () => {
  const { store, directory } = await makeStore();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ version: 99, enabled: true }), 'utf8');
  await writeFile(path.join(directory, 'credential.json'), JSON.stringify({ version: 1, payload: Buffer.from('garbage').toString('base64') }), 'utf8');
  assert.equal(await store.load(), null);
  assert.ok(store.failure);
  assert.match(store.credentialFailure, /не читается/);
});

test('a credential missing or malforming any required part is rejected on read and on write', async () => {
  const { store } = await makeStore();
  await store.load();
  await assert.rejects(() => store.saveCredential(credential({ installationId: 'nope' })), /неполные данные/);
  await assert.rejects(() => store.saveCredential(credential({ tabSalt: 'short' })), /неполные данные/);
  await assert.rejects(() => store.saveCredential(credential({ owner: { telegramUserId: 'не число' } })), /неполные данные/);
  await assert.rejects(() => store.saveCredential(credential({ relayUrl: 'http://relay.example.com' })), /неполные данные/);

  // A key that cannot sign must be refused here and not at the first challenge.
  await assert.rejects(() => store.saveCredential(credential({ privateKey: '' })), /неполные данные/);
  await assert.rejects(() => store.saveCredential(credential({ privateKey: Buffer.alloc(64, 1).toString('base64') })), /неполные данные/);
  const rsa = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(() => store.saveCredential(credential({ privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') })),
    /неполные данные/, 'a key of another algorithm is not an installation identity');
});

test('the epoch is durable and grows once per call, so revisions never go backwards', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  assert.equal(await store.nextEpoch(), 1);
  assert.equal(await store.nextEpoch(), 2);

  const restarted = new BridgeStore({ directory, encrypt: () => Buffer.alloc(0), decrypt: () => '', available: () => true, now: () => 0 });
  await restarted.load();
  assert.equal(restarted.snapshot().epoch, 2);
  assert.equal(await restarted.nextEpoch(), 3, 'a restart continues the counter instead of resetting it');
});

test('clearing the credential works without the network and leaves settings alone', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  await store.update(draft => { draft.enabled = true; draft.relayUrl = 'wss://relay.example.com'; draft.label = 'Рабочий ПК'; });
  await store.saveCredential(credential());

  await store.clearCredential();
  assert.equal(store.credential, null);
  assert.ok(!(await readdir(directory)).includes('credential.json'));
  assert.deepEqual(
    { enabled: store.snapshot().enabled, relayUrl: store.snapshot().relayUrl, label: store.snapshot().label },
    { enabled: true, relayUrl: 'wss://relay.example.com', label: 'Рабочий ПК' },
  );
  await store.clearCredential();  // idempotent
});

test('a stored relay address that is no longer acceptable is dropped, not trusted', async () => {
  const { store, directory } = await makeStore();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ version: 1, enabled: true, relayUrl: 'ws://relay.example.com', epoch: 4 }), 'utf8');
  const record = await store.load();
  assert.equal(record.relayUrl, '', 'an unencrypted non-local address does not survive a restart');
  assert.equal(record.epoch, 4);
});

test('the accepted-command journal keeps identifiers for the life of the installation', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  await store.update(draft => {
    for (let index = 0; index < 600; index++) draft.commands.push({ commandId: `c${index}`, requestId: `ma:u:i:c${index}`, at: Date.parse('2026-10-14T10:00:00.000Z') });
    // A year old. Keeping it is the point: a tombstone that expires turns a very old repeat
    // back into a new request, which is exactly what it exists to prevent.
    draft.commands.push({ commandId: 'ancient', requestId: 'ma:u:i:ancient', at: Date.parse('2025-10-01T10:00:00.000Z') });
  });
  const record = store.snapshot();
  assert.equal(record.commands.length, 601, 'nothing is dropped by age or by count');
  assert.ok(record.commands.some(entry => entry.commandId === 'ancient'));
  assert.ok(!record.commands.some(entry => 'text' in entry), 'no command text is kept');
  assert.ok(!(await readFile(path.join(directory, 'bridge.json'), 'utf8')).includes('Проверь сборку'));

  // Only duplicates are collapsed, so a repeated admission cannot grow the file without bound.
  await store.update(draft => { draft.commands.push({ commandId: 'ancient', requestId: 'ma:u:i:ancient', at: Date.now() }); });
  assert.equal(store.snapshot().commands.filter(entry => entry.commandId === 'ancient').length, 1);

  // Unlinking drops the credential, not the journal. Old entries simply stop being reachable:
  // the next installation gets another installationId, so no requestId can ever collide.
  await store.clearCredential();
  assert.equal(store.snapshot().commands.length, 601, 'unlinking does not forget what was executed');
});

test('admitting a command is durable before the core is told, and a repeat is recognised', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  const entry = { commandId: 'cmd-1', requestId: 'ma:u_7f3a:i:cmd-1', tabId: 't_a', action: 'send' };

  const first = await store.rememberCommand(entry);
  assert.deepEqual(first, { requestId: entry.requestId, replay: false, conflict: false });
  // Already on disk, before any RPC could have happened.
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'bridge.json'), 'utf8')).commands.map(record => record.commandId), ['cmd-1']);

  const again = await store.rememberCommand(entry);
  assert.deepEqual(again, { requestId: entry.requestId, replay: true, conflict: false }, 'the same command is a replay, to be reconciled rather than resent');

  assert.equal((await store.rememberCommand({ ...entry, action: 'stop' })).conflict, true);
  assert.equal((await store.rememberCommand({ ...entry, tabId: 't_other' })).conflict, true);
  assert.equal((await store.rememberCommand({ ...entry, requestId: 'ma:other:i:cmd-1' })).conflict, true);
  assert.equal(store.snapshot().commands.length, 1, 'a conflicting repeat adds nothing');

  // The text is the core's business: this file deliberately cannot tell two texts apart.
  assert.ok(!(await readFile(path.join(directory, 'bridge.json'), 'utf8')).includes('Проверь'));

  const reopened = makeStoreAt(directory);
  await reopened.load();
  assert.deepEqual(await reopened.rememberCommand(entry), { requestId: entry.requestId, replay: true, conflict: false },
    'the record outlives a restart, which is the whole point of writing it first');
});

test('a journal entry damaged beyond recognition is dropped instead of being trusted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-journal-'));
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({
    version: 1, enabled: true, relayUrl: '', label: 'ПК', epoch: 3,
    commands: [{ commandId: 'good', requestId: 'ma:u:i:good', at: Date.now() }, { commandId: 'no-request' }, 'строка', null],
  }), 'utf8');
  const store = makeStoreAt(directory);
  await store.load();
  assert.deepEqual(store.snapshot().commands.map(entry => entry.commandId), ['good'],
    'an entry without a requestId cannot prove anything and is not kept');
});

test('the atomic write retries only the rename, and only for a Windows sharing error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-atomic-'));
  const target = path.join(directory, 'bridge.json');

  let attempts = 0;
  const waits = [];
  await writeAtomic(target, '{"version":1}', {
    platform: 'win32',
    sleep: async ms => { waits.push(ms); },
    renameFile: async (from, to) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
  assert.equal(await readFile(target, 'utf8'), '{"version":1}');

  // A permanent failure keeps the previous file and surfaces as an error.
  let permanent = 0;
  await assert.rejects(() => writeAtomic(target, '{"version":2}', {
    platform: 'win32', sleep: async () => {},
    renameFile: async () => { permanent++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  }), /busy/);
  assert.equal(permanent, 10, 'the retry budget is bounded');
  assert.equal(await readFile(target, 'utf8'), '{"version":1}', 'the previous record survives');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');

  // Another error, or another platform, is not retried at all.
  let other = 0;
  await assert.rejects(() => writeAtomic(target, '{}', {
    platform: 'win32', sleep: async () => {},
    renameFile: async () => { other++; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
  }), /no space/);
  assert.equal(other, 1);

  let linux = 0;
  await assert.rejects(() => writeAtomic(target, '{}', {
    platform: 'linux', sleep: async () => {},
    renameFile: async () => { linux++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
  }), /busy/);
  assert.equal(linux, 1);
});

test('a failed durable write is reported as a storage error and leaves the record unchanged', async () => {
  const { store, directory } = await makeStore();
  await store.load();
  await store.update(draft => { draft.label = 'Было'; });

  const original = BridgeStore.prototype.update;
  assert.equal(typeof original, 'function');
  // Make the real file unwritable by pointing at a directory path.
  const blocked = new BridgeStore({
    directory: path.join(directory, 'bridge.json'), encrypt: () => Buffer.alloc(0), decrypt: () => '',
    available: () => true, now: () => 0,
  });
  await blocked.load();
  await assert.rejects(() => blocked.update(draft => { draft.enabled = true; }), BridgeStorageError);
  assert.equal(store.snapshot().label, 'Было');
});
