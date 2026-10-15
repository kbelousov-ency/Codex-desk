import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { digest, fail, opaqueToken, stringField, type TelegramIdentity } from './security.ts';
import { publicKeyObject } from './device-auth.ts';
import { CommandLedger } from './commands.ts';

export interface TabDto {
  tab_id: string; title: string; agent: string; project: string; status: string;
  queueLength: number; updatedAt: string; queuePaused: boolean;
}
export interface InstallationDto {
  installation_id: string; label: string; online: boolean; last_seen: number | null; revision: number; tabs: TabDto[];
}
export interface InstallationRow {
  installation_id: string; telegram_id: string; label: string; public_key: string | null; user_ref: string;
  revision: number; epoch: number; last_seen: number | null; online: number; revoked_at: number | null;
}
export interface PairingRow {
  pairing_id: string; nonce_hash: string; public_key: string | null; label: string; expires_at: number;
  attempts: number; telegram_id: string | null; state: string; installation_id: string | null;
}
export interface NotificationSettings {
  turnCompleted: boolean;
  actionRequired: boolean;
  commandFailed: boolean;
  presence: boolean;
}

/** All persisted columns are explicit. Plaintext requests, raw frames and conversation content never reach SQLite. */
export class Store {
  readonly db: DatabaseSync;
  readonly now: () => number;
  readonly commands: CommandLedger;
  constructor(path: string, now = Date.now, commandPayloadKey?: string) {
    this.now = now;
    this.db = new DatabaseSync(path);
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 5) {
      this.db.close(); throw new Error('unsupported_database_version');
    }
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, username TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_settings (
        telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        turn_completed INTEGER NOT NULL DEFAULT 1,
        action_required INTEGER NOT NULL DEFAULT 1,
        command_failed INTEGER NOT NULL DEFAULT 1,
        presence INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS notification_dedup (
        dedup_key TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS view_revisions (
        telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id), revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installations (
        installation_id TEXT PRIMARY KEY, telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
        label TEXT NOT NULL, public_key TEXT, user_ref TEXT, revision INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, online INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS tabs (
        installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
        tab_id TEXT NOT NULL, title TEXT NOT NULL, agent TEXT NOT NULL, project TEXT NOT NULL,
        status TEXT NOT NULL, queue_length INTEGER NOT NULL,
        updated_at TEXT NOT NULL, queue_paused INTEGER NOT NULL,
        PRIMARY KEY(installation_id, tab_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, telegram_id TEXT NOT NULL REFERENCES users(telegram_id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        pairing_id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, public_key TEXT,
        label TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        telegram_id TEXT REFERENCES users(telegram_id), state TEXT NOT NULL DEFAULT 'pending', installation_id TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        audit_id INTEGER PRIMARY KEY, event TEXT NOT NULL, telegram_id TEXT, installation_id TEXT, pairing_id TEXT, command_id TEXT, created_at INTEGER NOT NULL
      );
    `);
    this.migrate();
    try {
      this.commands = new CommandLedger(this.db, this.now, commandPayloadKey ?? (path === ':memory:' ? randomBytes(32).toString('base64url') : undefined));
    } catch (error) { this.db.close(); throw error; }
    // A process restart must never leave a previously connected installation marked online.
    this.db.prepare('UPDATE installations SET online = 0').run();
    this.db.exec('INSERT INTO view_revisions SELECT telegram_id,1 FROM users WHERE true ON CONFLICT(telegram_id) DO UPDATE SET revision=view_revisions.revision+1');
  }
  close(): void { this.commands.close(); this.db.close(); }
  private migrate(): void {
    this.transaction(() => {
      const has = (table: string, column: string) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
      if (!has('installations', 'public_key')) this.db.exec('ALTER TABLE installations ADD COLUMN public_key TEXT');
      if (!has('installations', 'user_ref')) this.db.exec('ALTER TABLE installations ADD COLUMN user_ref TEXT');
      if (!has('pairings', 'public_key')) this.db.exec('ALTER TABLE pairings ADD COLUMN public_key TEXT');
      if (!has('audit', 'command_id')) this.db.exec('ALTER TABLE audit ADD COLUMN command_id TEXT');
      // Preserve the old cache without inventing activity or queue values. A PC snapshot fills these fields.
      if (!has('tabs', 'queue_length')) this.db.exec('ALTER TABLE tabs ADD COLUMN queue_length INTEGER');
      if (!has('tabs', 'updated_at')) this.db.exec('ALTER TABLE tabs ADD COLUMN updated_at TEXT');
      if (!has('tabs', 'queue_paused')) this.db.exec('ALTER TABLE tabs ADD COLUMN queue_paused INTEGER');
      for (const row of this.db.prepare('SELECT installation_id FROM installations WHERE user_ref IS NULL').all()) {
        this.db.prepare('UPDATE installations SET user_ref=? WHERE installation_id=?').run(`u_${opaqueToken()}`, row.installation_id);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS installation_user_ref ON installations(user_ref) WHERE user_ref IS NOT NULL');
      // Legacy fields stay untouched. No authentication path reads a shared-secret hash in 2.1.
      if (this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='commands'").get()) {
        if (this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='legacy_commands_v3'").get()) throw new Error('legacy_commands_archive_conflict');
        this.db.exec('ALTER TABLE commands RENAME TO legacy_commands_v3');
      }
      this.db.exec('PRAGMA user_version = 5');
    });
  }
  installationUserRef(installationId: string, user: string): string {
    const value = this.ownedInstallation(installationId, user).user_ref;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail(404, 'installation_not_found');
    return value;
  }
  viewRevision(user: string): number {
    return Number(this.db.prepare('SELECT revision FROM view_revisions WHERE telegram_id=?').get(user)?.revision ?? 0);
  }
  bumpViewRevision(user: string): void {
    this.db.prepare('INSERT INTO view_revisions VALUES (?,1) ON CONFLICT(telegram_id) DO UPDATE SET revision=revision+1').run(user);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(event: string, user: string | null = null, installation: string | null = null, pairing: string | null = null, command: string | null = null): void {
    this.db.prepare('INSERT INTO audit(event,telegram_id,installation_id,pairing_id,command_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(event, user, installation, pairing, command, this.now());
  }
  createSession(identity: TelegramIdentity, ttl = 15 * 60_000): { session_token: string; expires_at: number } {
    const token = opaqueToken(), expires = this.now() + ttl;
    this.transaction(() => {
      this.db.prepare('INSERT INTO users(telegram_id,display_name,username) VALUES (?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username')
        .run(identity.telegram_id, identity.display_name, identity.username ?? null);
      this.db.prepare('INSERT OR IGNORE INTO notification_settings(telegram_id) VALUES (?)').run(identity.telegram_id);
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
      // Bound sessions per account; every newly authenticated page gets its own short-lived token.
      this.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE telegram_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)').run(identity.telegram_id);
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), identity.telegram_id, expires);
    });
    return { session_token: token, expires_at: expires };
  }
  notificationSettings(user: string): NotificationSettings {
    this.db.prepare('INSERT OR IGNORE INTO notification_settings(telegram_id) VALUES (?)').run(user);
    const row = this.db.prepare('SELECT turn_completed,action_required,command_failed,presence FROM notification_settings WHERE telegram_id=?')
      .get(user) as { turn_completed: number; action_required: number; command_failed: number; presence: number };
    return { turnCompleted: !!row.turn_completed, actionRequired: !!row.action_required,
      commandFailed: !!row.command_failed, presence: !!row.presence };
  }
  updateNotificationSettings(user: string, value: Partial<NotificationSettings>): NotificationSettings {
    this.notificationSettings(user);
    const current = this.notificationSettings(user);
    const next = { ...current, ...value };
    this.db.prepare('UPDATE notification_settings SET turn_completed=?,action_required=?,command_failed=?,presence=? WHERE telegram_id=?')
      .run(Number(next.turnCompleted), Number(next.actionRequired), Number(next.commandFailed), Number(next.presence), user);
    return next;
  }
  claimNotification(user: string, key: string): boolean {
    try { this.db.prepare('INSERT INTO notification_dedup(dedup_key,telegram_id,created_at) VALUES (?,?,?)').run(key, user, this.now()); return true; }
    catch { return false; }
  }
  notificationClaimed(user: string, key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM notification_dedup WHERE dedup_key=? AND telegram_id=?').get(key, user);
  }
  session(token: string): { telegram_id: string; expires_at: number } {
    const row = this.db.prepare('SELECT telegram_id,expires_at FROM sessions WHERE token_hash=? AND expires_at>?')
      .get(digest(token), this.now()) as { telegram_id: string; expires_at: number } | undefined;
    if (!row) fail(401, 'session_expired');
    return row;
  }
  beginWirePairing(pairingId: string, nonceHash: string, label: string, publicKey: string): PairingRow {
    publicKeyObject(publicKey);
    const existing = this.db.prepare('SELECT pairing_id FROM pairings WHERE pairing_id=? OR nonce_hash=?').get(pairingId, nonceHash);
    if (existing) fail(409, 'pairing_exists');
    const legacyDesktopSecret = this.db.prepare('PRAGMA table_info(pairings)').all().some(column => column.name === 'desktop_secret_hash');
    const columns = legacyDesktopSecret ? 'pairing_id,nonce_hash,label,expires_at,public_key,desktop_secret_hash' : 'pairing_id,nonce_hash,label,expires_at,public_key';
    const values = [pairingId, nonceHash, stringField(label, 64), this.now() + 600_000, publicKey];
    if (legacyDesktopSecret) values.push('');
    this.db.prepare(`INSERT INTO pairings(${columns}) VALUES (${values.map(() => '?').join(',')})`).run(...values);
    this.audit('pairing_started', null, null, pairingId);
    return this.wirePairing(pairingId);
  }
  claimNonce(nonce: string, user: string): PairingRow {
    const hash = createHash('sha256').update(nonce).digest('base64url');
    const found = this.db.prepare('SELECT pairing_id FROM pairings WHERE nonce_hash=?').get(hash) as { pairing_id: string } | undefined;
    if (!found) fail(404, 'pairing_not_found');
    const row = this.wirePairing(found.pairing_id);
    if (row.attempts >= 5) {
      this.db.prepare('DELETE FROM pairings WHERE pairing_id=?').run(row.pairing_id);
      this.audit('pairing_locked', user, null, row.pairing_id);
      fail(429, 'pairing_locked');
    }
    this.db.prepare('UPDATE pairings SET attempts=attempts+1 WHERE pairing_id=?').run(row.pairing_id);
    if (row.telegram_id && row.telegram_id !== user) fail(409, 'pairing_claimed');
    if (!row.telegram_id) {
      this.db.prepare("UPDATE pairings SET telegram_id=?,state='phone_confirmed' WHERE pairing_id=?").run(user, row.pairing_id);
      this.audit('pairing_phone_confirmed', user, null, row.pairing_id);
    }
    return this.wirePairing(row.pairing_id);
  }
  wirePairing(id: string): PairingRow {
    const row = this.db.prepare('SELECT * FROM pairings WHERE pairing_id=?').get(id) as PairingRow | undefined;
    if (!row) fail(404, 'pairing_not_found');
    if (row.expires_at <= this.now()) fail(410, 'pairing_expired');
    if (!['pending', 'phone_confirmed'].includes(row.state)) fail(409, 'pairing_used');
    return row;
  }
  completeWirePairing(id: string): { installation_id: string; telegram_id: string; display_name: string } {
    const row = this.wirePairing(id);
    if (!row.telegram_id || row.state !== 'phone_confirmed') fail(409, 'pairing_not_confirmed');
    if (!row.public_key) fail(409, 'pairing_key_required');
    publicKeyObject(row.public_key);
    const installation_id = randomUUID();
    const user = this.db.prepare('SELECT display_name FROM users WHERE telegram_id=?').get(row.telegram_id) as { display_name: string };
    this.transaction(() => {
      this.db.prepare('INSERT INTO installations(installation_id,telegram_id,label,public_key,user_ref) VALUES (?,?,?,?,?)')
        .run(installation_id, row.telegram_id, row.label, row.public_key, `u_${opaqueToken()}`);
      this.db.prepare("UPDATE pairings SET state='completed',installation_id=?,nonce_hash='' WHERE pairing_id=?").run(installation_id, id);
      this.audit('pairing_completed', row.telegram_id, installation_id, id);
    });
    return { installation_id, telegram_id: row.telegram_id, display_name: user.display_name };
  }
  cancelWirePairing(id: string): void {
    this.db.prepare("UPDATE pairings SET state='cancelled',nonce_hash='' WHERE pairing_id=? AND state IN ('pending','phone_confirmed')").run(id);
    this.audit('pairing_cancelled', null, null, id);
  }
  displayName(user: string): string {
    return (this.db.prepare('SELECT display_name FROM users WHERE telegram_id=?').get(user) as { display_name: string }).display_name;
  }
  claimant(user: string): { displayName: string; username: string | null; telegramUserId: string } {
    const row = this.db.prepare('SELECT display_name,username FROM users WHERE telegram_id=?').get(user) as { display_name: string; username: string | null };
    return { displayName: row.display_name, username: row.username, telegramUserId: user };
  }
  installation(id: string): InstallationRow {
    const row = this.db.prepare('SELECT * FROM installations WHERE installation_id=? AND revoked_at IS NULL').get(id) as InstallationRow | undefined;
    if (!row) fail(404, 'installation_not_found');
    return row;
  }
  ownedInstallation(id: string, user: string): InstallationRow {
    const row = this.installation(id);
    if (row.telegram_id !== user) fail(404, 'installation_not_found');
    return row;
  }
  installations(user: string): InstallationDto[] {
    const rows = this.db.prepare('SELECT installation_id,label,online,last_seen,revision FROM installations WHERE telegram_id=? AND revoked_at IS NULL ORDER BY installation_id')
      .all(user) as unknown as (Omit<InstallationDto, 'tabs' | 'online'> & { online: number })[];
    return rows.map(row => ({ installation_id: row.installation_id, label: row.label, online: !!row.online,
      last_seen: row.last_seen, revision: row.revision, tabs: this.tabs(row.installation_id) }));
  }
  tabs(id: string): TabDto[] {
    const rows = this.db.prepare('SELECT tab_id,title,agent,project,status,queue_length AS queueLength,updated_at AS updatedAt,queue_paused AS queuePaused FROM tabs WHERE installation_id=? AND queue_length IS NOT NULL AND updated_at IS NOT NULL AND queue_paused IS NOT NULL ORDER BY tab_id')
      .all(id) as unknown as (Omit<TabDto, 'queuePaused'> & { queuePaused: number })[];
    return rows.map(row => ({ ...row, queuePaused: !!row.queuePaused }));
  }
  revoke(id: string, user: string): void {
    this.ownedInstallation(id, user);
    this.transaction(() => {
      this.db.prepare('UPDATE installations SET revoked_at=?,public_key=NULL,online=0 WHERE installation_id=?').run(this.now(), id);
      this.db.prepare('DELETE FROM tabs WHERE installation_id=?').run(id);
      this.commands.discardInstallation(id);
      this.audit('installation_revoked', user, id);
    });
  }
  presence(id: string, online: boolean): void {
    if (online) this.db.prepare('UPDATE installations SET online=1,last_seen=? WHERE installation_id=? AND revoked_at IS NULL').run(this.now(), id);
    else this.db.prepare('UPDATE installations SET online=0 WHERE installation_id=?').run(id);
  }
  installationOnline(id: string): boolean {
    try { return !!this.installation(id).online; } catch { return false; }
  }
  applyWireSnapshot(id: string, epoch: number, revision: number, label: string, tabs: TabDto[]): 'applied' | 'stale' {
    const current = this.installation(id);
    if (epoch < current.epoch || (epoch === current.epoch && revision <= current.revision)) return 'stale';
    this.transaction(() => {
      this.db.prepare('DELETE FROM tabs WHERE installation_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO tabs(installation_id,tab_id,title,agent,project,status,queue_length,updated_at,queue_paused) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const tab of tabs) insert.run(id, tab.tab_id, tab.title, tab.agent, tab.project, tab.status, tab.queueLength, tab.updatedAt, Number(tab.queuePaused));
      this.db.prepare('UPDATE installations SET epoch=?,revision=?,label=? WHERE installation_id=?').run(epoch, revision, label, id);
    });
    return 'applied';
  }
  applyWireEvent(id: string, epoch: number, revision: number, event: { kind: string; tab?: TabDto; tabId?: string; label?: string }): void {
    this.transaction(() => {
      if (event.kind === 'tab_updated' && event.tab) {
        const tab = event.tab;
        this.db.prepare('INSERT INTO tabs(installation_id,tab_id,title,agent,project,status,queue_length,updated_at,queue_paused) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,tab_id) DO UPDATE SET title=excluded.title,agent=excluded.agent,project=excluded.project,status=excluded.status,queue_length=excluded.queue_length,updated_at=excluded.updated_at,queue_paused=excluded.queue_paused')
          .run(id, tab.tab_id, tab.title, tab.agent, tab.project, tab.status, tab.queueLength, tab.updatedAt, Number(tab.queuePaused));
      } else if (event.kind === 'tab_removed') this.db.prepare('DELETE FROM tabs WHERE installation_id=? AND tab_id=?').run(id, event.tabId!);
      else if (event.kind === 'installation_updated') this.db.prepare('UPDATE installations SET label=? WHERE installation_id=?').run(event.label!, id);
      this.db.prepare('UPDATE installations SET epoch=?,revision=? WHERE installation_id=?').run(epoch, revision, id);
    });
  }
  maintenance(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM pairings WHERE expires_at<=?').run(this.now() - 86_400_000);
    this.db.prepare('DELETE FROM audit WHERE created_at<?').run(this.now() - 30 * 86_400_000);
    this.db.prepare('DELETE FROM notification_dedup WHERE created_at<?').run(this.now() - 30 * 86_400_000);
    // Idempotency metadata is retained for the installation lifetime; no timer changes wire status or permits ID reuse.
  }
}
