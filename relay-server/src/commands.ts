import type { DatabaseSync } from 'node:sqlite';
import { ApiError, bodyRecord, digest, fail, stringField } from './security.ts';
import { CommandPayloadVault } from './command-payload.ts';

export type CommandAction = 'send' | 'stop' | 'get_state' | 'get_last_answer';
export type CommandStatus = 'queued' | 'accepted' | 'executed' | 'uncertain' | 'rejected';
export type CommandOutcome = 'succeeded' | 'interrupted' | 'failed' | null;
export interface CommandInput { commandId: string; tabId: string; action: CommandAction; text?: string; expectedTurnId?: string }
export interface CommandRow {
  installation_id: string; telegram_id: string; command_id: string; tab_id: string; action: CommandAction;
  fingerprint: string; status: CommandStatus | null; outcome: CommandOutcome;
  dispatch_state: 'sent' | 'delivery_unknown'; detail_code: string | null; requires_computer: number;
  created_at: number; updated_at: number;
  user_ref: string; payload_ciphertext: string | null; payload_nonce: string | null; payload_tag: string | null;
  replay_unavailable: string | null;
}
export interface CommandDto {
  commandId: string; tabId: string; action: CommandAction; status: CommandStatus | null; outcome: CommandOutcome;
  dispatchState: CommandRow['dispatch_state']; detail: { code: string; message: string; requiresComputer: boolean } | null;
  createdAt: string; updatedAt: string;
  replayUnavailable: string | null;
}
export interface CommandResult {
  commandId: string; tabId: string; status: CommandStatus; outcome: CommandOutcome;
  detailCode: string | null; requiresComputer: boolean; payload?: unknown;
}
export const terminalStatus = (status: CommandStatus | null) => status === 'executed' || status === 'rejected';
export const readWaiterComplete = (status: CommandStatus | null) => terminalStatus(status) || status === 'uncertain';

export function parseCommand(input: unknown): CommandInput {
  const value = bodyRecord(input, ['commandId', 'tabId', 'action', 'text', 'expectedTurnId']);
  const commandId = stringField(value.commandId, 64), tabId = stringField(value.tabId, 128);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(commandId) || !/^[A-Za-z0-9_-]{1,128}$/.test(tabId)) fail(400, 'invalid_command');
  if (!['send', 'stop', 'get_state', 'get_last_answer'].includes(String(value.action))) fail(400, 'invalid_command');
  const action = value.action as CommandAction;
  if (action === 'send') {
    if (typeof value.text !== 'string' || value.text.length > 32000 || !value.text.trim() || value.text.trim().startsWith('/') || value.text.includes('\u0000') || value.expectedTurnId !== undefined) fail(400, 'invalid_command');
    return { commandId, tabId, action, text: value.text }; // Preserve whitespace and multiline content exactly.
  }
  if (value.text !== undefined) fail(400, 'invalid_command');
  if (action === 'stop') return { commandId, tabId, action, expectedTurnId: stringField(value.expectedTurnId, 256) };
  if (value.expectedTurnId !== undefined) fail(400, 'invalid_command');
  return { commandId, tabId, action };
}

export function commandFingerprint(input: CommandInput): string {
  return digest(JSON.stringify({ tabId: input.tabId, action: input.action, text: input.text ?? null, expectedTurnId: input.expectedTurnId ?? null }));
}

/** Durable metadata and encrypted original requests. Plaintext and read responses never enter SQLite. */
export class CommandLedger {
  readonly db: DatabaseSync;
  readonly now: () => number;
  readonly vault: CommandPayloadVault;
  constructor(db: DatabaseSync, now: () => number, payloadKey?: string) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS command_ledger (
      installation_id TEXT NOT NULL REFERENCES installations(installation_id), telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
      command_id TEXT NOT NULL, tab_id TEXT NOT NULL, action TEXT NOT NULL,
      fingerprint TEXT NOT NULL, status TEXT CHECK(status IS NULL OR status IN ('queued','accepted','executed','uncertain','rejected')),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded','interrupted','failed')),
      dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('sent','delivery_unknown')),
      detail_code TEXT, requires_computer INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      user_ref TEXT NOT NULL, payload_ciphertext TEXT, payload_nonce TEXT, payload_tag TEXT, replay_unavailable TEXT,
      PRIMARY KEY(installation_id,command_id)
    )`);
    this.vault = new CommandPayloadVault(db, payloadKey);
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(command_ledger)').all().map(row => row.name));
      for (const column of ['user_ref', 'payload_ciphertext', 'payload_nonce', 'payload_tag', 'replay_unavailable']) {
        if (!columns.has(column)) db.exec(`ALTER TABLE command_ledger ADD COLUMN ${column} TEXT`);
      }
      db.exec('UPDATE command_ledger SET user_ref=(SELECT user_ref FROM installations WHERE installations.installation_id=command_ledger.installation_id) WHERE user_ref IS NULL');
      db.exec("UPDATE command_ledger SET replay_unavailable='legacy_payload_missing' WHERE (status IS NULL OR status NOT IN ('executed','rejected')) AND action IN ('send','stop') AND payload_ciphertext IS NULL AND replay_unavailable IS NULL");
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); this.vault.close(); throw error; }
    db.prepare("UPDATE command_ledger SET dispatch_state='delivery_unknown' WHERE status IS NULL OR status NOT IN ('executed','rejected')").run();
    db.exec("UPDATE command_ledger SET payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,replay_unavailable=NULL WHERE status IN ('executed','rejected')");
  }
  get(installationId: string, commandId: string): CommandRow | undefined {
    return this.db.prepare('SELECT * FROM command_ledger WHERE installation_id=? AND command_id=?').get(installationId, commandId) as CommandRow | undefined;
  }
  duplicate(user: string, installationId: string, input: CommandInput): CommandRow | undefined {
    const row = this.get(installationId, input.commandId);
    if (!row) return;
    if (row.telegram_id !== user) fail(404, 'command_not_found');
    if (row.fingerprint !== commandFingerprint(input)) fail(409, 'command_conflict');
    return row;
  }
  pending(installationId: string): CommandRow[] {
    return this.db.prepare("SELECT * FROM command_ledger WHERE installation_id=? AND (status IS NULL OR status NOT IN ('executed','rejected')) ORDER BY created_at,rowid")
      .all(installationId) as unknown as CommandRow[];
  }
  replayUnavailable(row: CommandRow, code: string): void {
    this.db.prepare("UPDATE command_ledger SET replay_unavailable=?,dispatch_state='delivery_unknown',updated_at=? WHERE installation_id=? AND command_id=? AND (status IS NULL OR status NOT IN ('executed','rejected'))")
      .run(code, this.now(), row.installation_id, row.command_id);
  }
  restore(row: CommandRow): CommandInput | undefined {
    const current = this.get(row.installation_id, row.command_id);
    if (!current || terminalStatus(current.status) || terminalStatus(row.status) || row.replay_unavailable === 'installation_revoked') return;
    try {
      if (!row.user_ref || !/^[A-Za-z0-9_-]{1,64}$/.test(row.user_ref)) throw new Error('identity');
      let input: CommandInput;
      if (row.payload_ciphertext === null && row.payload_nonce === null && row.payload_tag === null) {
        if (row.action === 'send' || row.action === 'stop') { this.replayUnavailable(row, 'legacy_payload_missing'); return; }
        input = parseCommand({ commandId: row.command_id, tabId: row.tab_id, action: row.action });
      } else {
        if (!row.payload_ciphertext || !row.payload_nonce || !row.payload_tag) throw new Error('ciphertext');
        input = parseCommand(this.vault.open(row, { payload_ciphertext: row.payload_ciphertext, payload_nonce: row.payload_nonce, payload_tag: row.payload_tag }));
      }
      if (input.commandId !== row.command_id || input.tabId !== row.tab_id || input.action !== row.action || commandFingerprint(input) !== row.fingerprint) throw new Error('immutable_payload');
      this.db.prepare('UPDATE command_ledger SET replay_unavailable=NULL WHERE installation_id=? AND command_id=?').run(row.installation_id, row.command_id);
      return input;
    } catch (error) {
      this.replayUnavailable(row, error instanceof ApiError && error.code === 'command_payload_key_required' ? 'command_payload_key_required' : 'command_payload_corrupt');
      return;
    }
  }
  hydrateDuplicate(row: CommandRow, input: CommandInput): CommandRow {
    const current = this.get(row.installation_id, row.command_id);
    if (!current || terminalStatus(current.status)) return current ?? row;
    if (terminalStatus(row.status) || row.payload_ciphertext !== null || row.payload_nonce !== null || row.payload_tag !== null || row.replay_unavailable === 'installation_revoked') return row;
    input = parseCommand(input);
    if (row.fingerprint !== commandFingerprint(input) || row.command_id !== input.commandId || row.tab_id !== input.tabId || row.action !== input.action) fail(409, 'command_conflict');
    const installation = this.db.prepare('SELECT telegram_id,user_ref,revoked_at FROM installations WHERE installation_id=?').get(row.installation_id);
    if (!installation || installation.revoked_at !== null || installation.telegram_id !== row.telegram_id || installation.user_ref !== row.user_ref) return row;
    if (!this.vault.configured) { this.replayUnavailable(row, 'command_payload_key_required'); return this.get(row.installation_id, row.command_id)!; }
    const sealed = this.vault.seal(row, input);
    this.db.prepare("UPDATE command_ledger SET payload_ciphertext=?,payload_nonce=?,payload_tag=?,replay_unavailable=NULL WHERE installation_id=? AND command_id=? AND (status IS NULL OR status NOT IN ('executed','rejected'))")
      .run(sealed.payload_ciphertext, sealed.payload_nonce, sealed.payload_tag, row.installation_id, row.command_id);
    return this.get(row.installation_id, row.command_id)!;
  }
  discardInstallation(installationId: string): void {
    this.db.prepare("UPDATE command_ledger SET payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,replay_unavailable=CASE WHEN status IS NULL OR status NOT IN ('executed','rejected') THEN 'installation_revoked' ELSE NULL END WHERE installation_id=?")
      .run(installationId);
  }
  create(user: string, installationId: string, input: CommandInput): CommandRow {
    input = parseCommand(input);
    const userRef = this.db.prepare('SELECT user_ref FROM installations WHERE installation_id=? AND telegram_id=?').get(installationId, user)?.user_ref;
    if (typeof userRef !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(userRef)) fail(409, 'replay_identity_unavailable');
    const fingerprint = commandFingerprint(input);
    const encrypted = this.vault.seal({ installation_id: installationId, telegram_id: user, command_id: input.commandId, user_ref: userRef, fingerprint }, input);
    this.db.prepare("INSERT INTO command_ledger(installation_id,telegram_id,command_id,tab_id,action,fingerprint,status,outcome,dispatch_state,created_at,updated_at,user_ref,payload_ciphertext,payload_nonce,payload_tag) VALUES (?,?,?,?,?,?,NULL,NULL,'delivery_unknown',?,?,?,?,?,?)")
      .run(installationId, user, input.commandId, input.tabId, input.action, fingerprint, this.now(), this.now(), userRef, encrypted.payload_ciphertext, encrypted.payload_nonce, encrypted.payload_tag);
    return this.get(installationId, input.commandId)!;
  }
  dispatched(installationId: string, commandId: string, known: boolean): void {
    this.db.prepare("UPDATE command_ledger SET dispatch_state=?,updated_at=? WHERE installation_id=? AND command_id=? AND (status IS NULL OR status NOT IN ('executed','rejected'))")
      .run(known ? 'sent' : 'delivery_unknown', this.now(), installationId, commandId);
  }
  disconnected(installationId: string): CommandRow[] {
    const rows = this.db.prepare("SELECT * FROM command_ledger WHERE installation_id=? AND (status IS NULL OR status NOT IN ('executed','rejected')) AND dispatch_state!='delivery_unknown'").all(installationId) as unknown as CommandRow[];
    this.db.prepare("UPDATE command_ledger SET dispatch_state='delivery_unknown',updated_at=? WHERE installation_id=? AND (status IS NULL OR status NOT IN ('executed','rejected'))").run(this.now(), installationId);
    return rows.map(row => this.get(installationId, row.command_id)!);
  }
  applyResult(installationId: string, result: CommandResult): CommandRow | undefined {
    const row = this.get(installationId, result.commandId);
    if (!row || row.tab_id !== result.tabId) return;
    // A reordered acknowledgement cannot roll a completed operation backwards.
    if (row.status === 'executed' || row.status === 'rejected') return;
    if (row.status === 'accepted' && result.status === 'queued') return;
    if (row.status === result.status && row.outcome === result.outcome && row.detail_code === result.detailCode && !!row.requires_computer === result.requiresComputer) return;
    const terminal = Number(terminalStatus(result.status));
    this.db.prepare("UPDATE command_ledger SET status=?,outcome=?,dispatch_state='sent',detail_code=?,requires_computer=?,updated_at=?,payload_ciphertext=CASE WHEN ? THEN NULL ELSE payload_ciphertext END,payload_nonce=CASE WHEN ? THEN NULL ELSE payload_nonce END,payload_tag=CASE WHEN ? THEN NULL ELSE payload_tag END,replay_unavailable=CASE WHEN ? THEN NULL ELSE replay_unavailable END WHERE installation_id=? AND command_id=?")
      .run(result.status, result.outcome, result.detailCode, Number(result.requiresComputer), this.now(), terminal, terminal, terminal, terminal, installationId, result.commandId);
    return this.get(installationId, result.commandId);
  }
  dto(row: CommandRow): CommandDto {
    return { commandId: row.command_id, tabId: row.tab_id, action: row.action, status: row.status, outcome: row.outcome,
      dispatchState: row.dispatch_state, detail: row.detail_code ? { code: row.detail_code, message: row.detail_code, requiresComputer: !!row.requires_computer } : null,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), replayUnavailable: row.replay_unavailable };
  }
  close(): void { this.vault.close(); }
}
