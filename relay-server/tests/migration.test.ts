import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { opaqueToken } from '../src/security.ts';
import { generateFixtureKeys } from '../scripts/fake-bridge.ts';

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'kuzmich-relay-migration-'));
  return { file: join(directory, 'old.sqlite'), cleanup() {
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('kuzmich-relay-migration-'));
    rmSync(target, { recursive: true, force: true });
  } };
}

test('legacy SQLite upgrades without invented tab metadata and assigns stable opaque userRef', () => {
  const temp = temporary(); const old = new DatabaseSync(temp.file);
  old.exec(`
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, username TEXT);
    INSERT INTO users VALUES ('10001','Old user',NULL);
    CREATE TABLE installations (installation_id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, label TEXT NOT NULL,
      credential_hash TEXT, revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER, online INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
    INSERT INTO installations VALUES ('old-installation','10001','Old PC','old-hash',7,2,1700000000000,1,NULL);
    CREATE TABLE tabs (installation_id TEXT NOT NULL,tab_id TEXT NOT NULL,title TEXT NOT NULL,agent TEXT NOT NULL,
      project TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(installation_id,tab_id));
    INSERT INTO tabs VALUES ('old-installation','t_old','Preserved title','codex','Project','idle');
    CREATE TABLE pairings (pairing_id TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL,desktop_secret_hash TEXT NOT NULL,
      label TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,telegram_id TEXT,state TEXT NOT NULL DEFAULT 'pending',installation_id TEXT);
    CREATE TABLE commands (telegram_id TEXT NOT NULL,installation_id TEXT NOT NULL,command_id TEXT NOT NULL,tab_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','executed','failed','uncertain')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(telegram_id,installation_id,command_id));
    INSERT INTO commands VALUES ('10001','old-installation','old-command','t_old','failed',1,2);
  `); old.close();
  let store: Store | undefined;
  try {
    store = new Store(temp.file);
    const reference = store.installationUserRef('old-installation', '10001'); assert.match(reference, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(reference, '10001');
    assert.equal(store.db.prepare('SELECT title FROM tabs').get()?.title, 'Preserved title');
    assert.equal(store.db.prepare('SELECT updated_at FROM tabs').get()?.updated_at, null);
    assert.deepEqual(store.tabs('old-installation'), []);
    assert.equal(store.db.prepare('SELECT status FROM legacy_commands_v3').get()?.status, 'failed');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM command_ledger').get()?.n, 0);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='commands'").get(), undefined);
    store.createSession({ telegram_id: '10001', display_name: 'Updated user' }); assert.equal(store.installationUserRef('old-installation', '10001'), reference);
    store.createSession({ telegram_id: '10002', display_name: 'Other user' });
    assert.throws(() => store!.installationUserRef('old-installation', '10002'), { code: 'installation_not_found' });
    const nonce = opaqueToken(), pairingId = randomUUID(), keys = generateFixtureKeys();
    store.beginWirePairing(pairingId, createHash('sha256').update(nonce).digest('base64url'), 'New pairing', keys.publicKey);
    store.claimNonce(nonce, '10001'); const paired = store.completeWirePairing(pairingId);
    assert.notEqual(store.installationUserRef(paired.installation_id, '10001'), reference);
    assert.equal(store.installation(paired.installation_id).public_key, keys.publicKey);
    assert.equal(store.db.prepare('SELECT credential_hash FROM installations WHERE installation_id=?').get('old-installation')?.credential_hash, 'old-hash');
    assert.equal(store.installation('old-installation').public_key, null);
    store.close(); store = new Store(temp.file); assert.equal(store.installationUserRef('old-installation', '10001'), reference);
    assert.equal(store.db.prepare('SELECT title FROM tabs').get()?.title, 'Preserved title');
  } finally { store?.close(); temp.cleanup(); }
});

test('newer SQLite schema is rejected without silently downgrading its version', () => {
  const temp = temporary(), db = new DatabaseSync(temp.file); db.exec('PRAGMA user_version=999'); db.close();
  try {
    assert.throws(() => new Store(temp.file), /unsupported_database_version/);
    const check = new DatabaseSync(temp.file); assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 999); check.close();
  } finally { temp.cleanup(); }
});
