import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '../src/security.ts';
import { normalizeTab } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import { generateFixtureKeys } from '../scripts/fake-bridge.ts';

const errorCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const user = (telegram_id: string) => ({ telegram_id, display_name: `Fixture ${telegram_id}`, username: null });
function start(store: Store) {
  const id = randomUUID(), nonce = randomBytes(32).toString('base64url'), keys = generateFixtureKeys();
  store.beginWirePairing(id, createHash('sha256').update(nonce).digest('base64url'), 'Fixture PC', keys.publicKey);
  return { id, nonce, ...keys };
}
function pair(store: Store, owner = '10001') {
  store.createSession(user(owner));
  const pairing = start(store); store.claimNonce(pairing.nonce, owner);
  return { ...store.completeWirePairing(pairing.id), ...pairing };
}
function wireTab(tabId = 't_fixture') {
  return { tabId, title: 'Fixture tab', agent: 'codex', project: 'CodexDesk', status: 'running',
    queueLength: 2, updatedAt: '2026-01-01T00:00:00.000Z', queuePaused: true, cwd: 'PRIVATE_PATH', text: 'PRIVATE_CHAT', model: 'PRIVATE_MODEL' };
}

test('pairing expires after ten minutes and cannot finalize before phone confirmation', () => {
  let now = 1_700_000_000_000;
  const store = new Store(':memory:', () => now);
  try {
    store.createSession(user('10001'));
    const pairing = start(store);
    assert.throws(() => store.completeWirePairing(pairing.id), errorCode('pairing_not_confirmed'));
    now += 599_999; assert.equal(store.wirePairing(pairing.id).state, 'pending');
    now += 1; assert.throws(() => store.claimNonce(pairing.nonce, '10001'), errorCode('pairing_expired'));
    assert.throws(() => store.completeWirePairing(pairing.id), errorCode('pairing_expired'));
    assert.equal(store.installations('10001').length, 0);
  } finally { store.close(); }
});

test('every reached pairing claim counts, sixth claim removes session, and claimant cannot be replaced', () => {
  const store = new Store(':memory:');
  try {
    store.createSession(user('10001')); store.createSession(user('10002'));
    const pairing = start(store);
    store.claimNonce(pairing.nonce, '10001');
    for (let i = 0; i < 4; i++) assert.throws(() => store.claimNonce(pairing.nonce, '10002'), errorCode('pairing_claimed'));
    assert.equal(store.wirePairing(pairing.id).telegram_id, '10001');
    assert.equal(store.wirePairing(pairing.id).attempts, 5);
    assert.throws(() => store.claimNonce(pairing.nonce, '10001'), errorCode('pairing_locked'));
    assert.throws(() => store.wirePairing(pairing.id), errorCode('pairing_not_found'));
    assert.equal(store.installations('10001').length, 0);
  } finally { store.close(); }
});

test('pairing is single-use and SQLite stores only public device key, with nonce and Mini App tokens hashed', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession(user('10001'));
    const pairing = start(store);
    const waiting = JSON.stringify(store.db.prepare('SELECT * FROM pairings').all());
    assert.ok(!waiting.includes(pairing.nonce));
    store.claimNonce(pairing.nonce, '10001');
    const result = store.completeWirePairing(pairing.id);
    assert.equal(store.installation(result.installation_id).public_key, pairing.publicKey);
    assert.throws(() => store.completeWirePairing(pairing.id), errorCode('pairing_used'));
    const rows = ['users', 'installations', 'tabs', 'sessions', 'pairings', 'audit', 'command_ledger']
      .map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
    const persisted = JSON.stringify(rows);
    const privateKey = pairing.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    for (const secret of [privateKey, pairing.nonce, session.session_token]) assert.ok(!persisted.includes(secret));
    assert.equal(store.db.prepare('PRAGMA table_info(installations)').all().some(row => /secret|private|credential_hash/.test(String(row.name))), false);
    assert.deepEqual(store.installations('10001')[0].tabs, []);
    assert.deepEqual(store.db.prepare('SELECT event FROM audit').all().map(row => row.event),
      ['pairing_started', 'pairing_phone_confirmed', 'pairing_completed']);
  } finally { store.close(); }
});

test('owner ACL hides foreign installations, supports multiple devices and revokes only the requested installation', () => {
  const store = new Store(':memory:');
  try {
    const first = pair(store), second = pair(store); store.createSession(user('10002'));
    assert.equal(store.installations('10001').length, 2); assert.deepEqual(store.installations('10002'), []);
    assert.throws(() => store.ownedInstallation(first.installation_id, '10002'), errorCode('installation_not_found'));
    assert.throws(() => store.revoke(first.installation_id, '10002'), errorCode('installation_not_found'));
    store.applyWireSnapshot(first.installation_id, 1, 1, 'Fixture PC', [normalizeTab(wireTab())]);
    store.revoke(first.installation_id, '10001');
    assert.throws(() => store.installation(first.installation_id), errorCode('installation_not_found'));
    assert.deepEqual(store.tabs(first.installation_id), []);
    assert.equal(store.installations('10001')[0].installation_id, second.installation_id);
    assert.equal(store.db.prepare('SELECT public_key FROM installations WHERE installation_id=?').get(first.installation_id)?.public_key, null);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM audit WHERE event='installation_revoked'").get()?.n, 1);
  } finally { store.close(); }
});

test('wire normalization and SQLite/API tab projection contain exactly eight allowed metadata fields', () => {
  const store = new Store(':memory:');
  try {
    const result = pair(store), tab = normalizeTab(wireTab());
    const fields = ['agent', 'project', 'queueLength', 'queuePaused', 'status', 'tab_id', 'title', 'updatedAt'];
    assert.deepEqual(Object.keys(tab).sort(), fields);
    store.applyWireSnapshot(result.installation_id, 1, 1, 'Fixture PC', [tab]);
    assert.deepEqual(Object.keys(store.tabs(result.installation_id)[0]).sort(), fields);
    assert.deepEqual(store.db.prepare('PRAGMA table_info(tabs)').all().map(row => row.name).sort(), ['installation_id', 'tab_id', 'title', 'agent', 'project', 'status', 'queue_length', 'updated_at', 'queue_paused'].sort());
    assert.deepEqual(store.tabs(result.installation_id)[0], tab);
    const output = JSON.stringify(store.installations('10001'));
    for (const forbidden of ['PRIVATE_CHAT', 'PRIVATE_PATH', 'PRIVATE_MODEL', 'credential', 'nonce']) assert.ok(!output.includes(forbidden));
    assert.throws(() => normalizeTab({ ...wireTab(), project: 'C:/private' }), errorCode('invalid_project'));
    assert.throws(() => normalizeTab({ ...wireTab(), queuePaused: 'true' }), errorCode('invalid_queue_paused'));
  } finally { store.close(); }
});

test('snapshot ordering rejects old epochs and stale revisions; full resync removes old tabs', () => {
  const store = new Store(':memory:');
  try {
    const result = pair(store), id = result.installation_id;
    const reference = store.installationUserRef(id, '10001');
    assert.match(reference, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(reference, '10001');
    const another = pair(store); assert.notEqual(store.installationUserRef(another.installation_id, '10001'), reference);
    store.createSession(user('10001')); assert.equal(store.installationUserRef(id, '10001'), reference);
    assert.equal(store.applyWireSnapshot(id, 7, 10, 'Fixture PC', [normalizeTab(wireTab())]), 'applied');
    assert.equal(store.applyWireSnapshot(id, 6, 999, 'old', []), 'stale');
    assert.equal(store.applyWireSnapshot(id, 7, 9, 'old', []), 'stale');
    assert.equal(store.applyWireSnapshot(id, 7, 10, 'duplicate', []), 'stale');
    assert.equal(store.tabs(id).length, 1);
    assert.equal(store.applyWireSnapshot(id, 8, 1, 'New process', []), 'applied');
    assert.deepEqual(store.tabs(id), []);
    assert.equal(store.installation(id).epoch, 8);
  } finally { store.close(); }
});

test('sessions expire, cap per user and remain isolated', () => {
  let now = 1_700_000_000_000;
  const store = new Store(':memory:', () => now);
  try {
    const first = store.createSession(user('10001'), 1000);
    const other = store.createSession(user('10002'), 1000);
    for (let i = 0; i < 10; i++) { now++; store.createSession(user('10001'), 1000); }
    assert.throws(() => store.session(first.session_token), errorCode('session_expired'));
    assert.equal(store.session(other.session_token).telegram_id, '10002');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sessions WHERE telegram_id='10001'").get()?.n, 10);
    now += 1000; assert.throws(() => store.session(other.session_token), errorCode('session_expired'));
  } finally { store.close(); }
});

test('restart resets presence and advances durable Mini App revision without dropping approved metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuzmich-relay-store-test-'));
  let store = new Store(join(directory, 'fixture.sqlite'));
  try {
    const result = pair(store), id = result.installation_id;
    const reference = store.installationUserRef(id, '10001');
    store.applyWireSnapshot(id, 3, 9, 'Fixture PC', [normalizeTab(wireTab())]); store.presence(id, true);
    store.bumpViewRevision('10001'); store.bumpViewRevision('10001');
    const revision = store.viewRevision('10001'); store.close();
    store = new Store(join(directory, 'fixture.sqlite'));
    assert.equal(store.installation(id).online, 0);
    assert.equal(store.installationUserRef(id, '10001'), reference);
    assert.ok(store.viewRevision('10001') > revision);
    assert.equal(store.installation(id).epoch, 3); assert.equal(store.installation(id).revision, 9);
    assert.equal(store.tabs(id).length, 1);
  } finally {
    store.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('kuzmich-relay-store-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('notification settings and dedup keys survive a relay restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuzmich-relay-notifications-'));
  const path = join(directory, 'fixture.sqlite'), key = randomBytes(32).toString('base64url');
  let store = new Store(path, Date.now, key);
  try {
    store.createSession(user('10001'));
    assert.deepEqual(store.notificationSettings('10001'), { turnCompleted: true, actionRequired: true, commandFailed: true, presence: true });
    store.updateNotificationSettings('10001', { presence: false });
    assert.equal(store.claimNotification('10001', 'notice:one'), true);
    store.close(); store = new Store(path, Date.now, key);
    assert.equal(store.notificationSettings('10001').presence, false);
    assert.equal(store.notificationClaimed('10001', 'notice:one'), true);
    assert.equal(store.claimNotification('10001', 'notice:one'), false);
  } finally {
    store.close(); const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('kuzmich-relay-notifications-'));
    rmSync(target, { recursive: true, force: true });
  }
});
