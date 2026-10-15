import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiError, fail, isRecord, opaqueToken, RateLimiter, stringField } from './security.ts';
import { Store, type TabDto } from './store.ts';
import { publicKeyObject, verifyDeviceProof } from './device-auth.ts';
import type { CommandInput, CommandResult } from './commands.ts';
import { normalizeCommandResult, normalizeReadPayload } from './command-wire.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_32 = /^[A-Za-z0-9_-]{43}$/;
const iso = (now: number) => new Date(now).toISOString();
export const frame = (type: string, data: Record<string, unknown> = {}, now = Date.now()) => ({ protocol: 2, type, frameId: randomUUID(), sentAt: iso(now), ...data });
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(400, 'invalid_sequence');
  return Number(value);
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'invalid_date');
  return value;
}
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) fail(400, 'invalid_frame'); return value; }
function id(value: unknown): string { const text = stringField(value, 128); if (!/^[A-Za-z0-9_-]+$/.test(text)) fail(400, 'invalid_id'); return text; }
function installation(value: unknown): string { return stringField(record(value).label, 64); }
function client(value: unknown): void {
  const item = record(value);
  if (item.app !== 'kuzmich' || typeof item.bridge !== 'string' || !Array.isArray(item.features)) fail(400, 'invalid_client');
  if (!/^2\.[1-9]\d*$/.test(item.bridge)) fail(426, 'unsupported_protocol');
  stringField(item.appVersion, 64); stringField(item.channel, 32);
}
export function normalizeTab(value: unknown): TabDto {
  const tab = record(value);
  const project = typeof tab.project === 'string' && tab.project === '' ? '' : stringField(tab.project, 80);
  if (/[\\/:]/.test(project)) fail(400, 'invalid_project');
  if (tab.agent !== 'codex' && tab.agent !== 'claude') fail(400, 'invalid_agent');
  if (!['idle', 'running', 'blocked', 'unavailable', 'ambiguous'].includes(String(tab.status))) fail(400, 'invalid_status');
  if (!Number.isInteger(tab.queueLength) || Number(tab.queueLength) < 0 || Number(tab.queueLength) > 50) fail(400, 'invalid_queue_length');
  if (typeof tab.queuePaused !== 'boolean') fail(400, 'invalid_queue_paused');
  const updatedAt = date(tab.updatedAt);
  return { tab_id: id(tab.tabId), title: stringField(tab.title, 120), agent: tab.agent, project, status: String(tab.status),
    queueLength: Number(tab.queueLength), updatedAt, queuePaused: tab.queuePaused };
}
function validProof(expected: Buffer, actual: unknown): boolean {
  return typeof actual === 'string' && BASE64_32.test(actual) && timingSafeEqual(expected, Buffer.from(actual, 'base64url'));
}

interface Connection {
  socket: WebSocket; connectionId: string; replayStarted: boolean; challenge: string; authDeadline: number; minor: number; installationId?: string; pairingId?: string;
  pairedInstallationId?: string; synced: boolean; pingNonce?: string; pingAt?: number;
  lastPing: number; lastResync: number; authTimer: ReturnType<typeof setTimeout>;
}
interface PairClaim { connection: Connection; expires: number }

export class BridgeHub {
  onCommandResult: (installationId: string, result: CommandResult, directResult: boolean) => void = () => {};
  onDisconnected: (installationId: string) => void = () => {};
  onConnected: (installationId: string) => void = () => {};
  onNotice: (installationId: string, notice: { tabId: string; noticeKind: 'turn_completed' | 'action_required'; turnId?: string; occurredAt: string }, frameKey: string) => void = () => {};
  onReadyForReplay: (installationId: string, connectionId: string, stillCurrent: () => boolean) => void = () => {};
  readonly wss: WebSocketServer;
  readonly store: Store;
  readonly changed: (user: string) => void;
  readonly heartbeatMs: number;
  readonly offlineGraceMs: number;
  readonly botUsername: string;
  private connections = new Set<Connection>();
  private installations = new Map<string, Connection>();
  private pairings = new Map<string, PairClaim>();
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private limits = new RateLimiter();
  private timer: ReturnType<typeof setInterval>;
  constructor(store: Store, changed: (user: string) => void,
    heartbeatMs = 25000, offlineGraceMs = 45000, botUsername = 'kuzmich_fixture_bot') {
    this.store = store; this.changed = changed;
    this.heartbeatMs = heartbeatMs; this.offlineGraceMs = offlineGraceMs;
    this.botUsername = botUsername;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false,
      handleProtocols: protocols => protocols.has('kuzmich-bridge.v2') ? 'kuzmich-bridge.v2' : false });
    this.wss.on('connection', (socket, request) => this.connect(socket, request));
    this.timer = setInterval(() => this.tick(), Math.min(1000, heartbeatMs));
    this.timer.unref();
  }
  private send(connection: Connection, type: string, fields: Record<string, unknown> = {}): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 512 * 1024) { connection.socket.close(4006, 'backpressure'); return; }
    connection.socket.send(JSON.stringify(frame(type, fields, this.store.now())));
  }
  private error(connection: Connection, code: string, closeCode = 4003): void {
    this.send(connection, 'error', { code, message: code, fatal: true, retryAfterMs: closeCode === 4006 ? 60000 : 0 });
    connection.socket.close(closeCode, code.slice(0, 80));
  }
  private connect(socket: WebSocket, request: IncomingMessage): void {
    const connection: Connection = { socket, connectionId: randomUUID(), replayStarted: false, challenge: opaqueToken(), authDeadline: this.store.now() + 30000, minor: 1, synced: false, lastPing: this.store.now(), lastResync: -Infinity,
      authTimer: setTimeout(() => this.error(connection, 'authentication_timeout', 4001), 30000) };
    connection.authTimer.unref();
    this.connections.add(connection);
    this.send(connection, 'challenge', { nonce: connection.challenge, expiresInMs: 30000, serverProtocol: '2.3' });
    const rateKey = `frame:${randomUUID()}`;
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        this.limits.consume(rateKey, 10, 1000, this.store.now());
        if (binary) fail(400, 'binary_frame');
        const value = record(JSON.parse(data.toString()));
        if (value.protocol !== 2) { this.error(connection, 'unsupported_protocol', 4004); return; }
        if (!UUID.test(String(value.frameId))) fail(400, 'invalid_frame_id');
        date(value.sentAt); stringField(value.type, 64);
        this.receive(connection, value);
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'invalid_frame';
        this.error(connection, code, error instanceof ApiError && error.status === 429 ? 4006 : error instanceof ApiError && error.status === 426 ? 4004 : 4003);
      }
    });
    socket.on('error', () => { /* No raw frame, URL, secret or exception logging. */ });
    socket.on('close', () => {
      clearTimeout(connection.authTimer);
      this.connections.delete(connection);
      if (connection.pairingId) {
        this.pairings.delete(connection.pairingId);
        this.store.cancelWirePairing(connection.pairingId);
      }
      const id = connection.installationId;
      if (id && this.installations.get(id) === connection) {
        this.installations.delete(id);
        this.onDisconnected(id);
        const timer = setTimeout(() => {
          this.offlineTimers.delete(id);
          if (!this.installations.has(id)) {
            this.store.presence(id, false);
            try { this.changed(this.store.installation(id).telegram_id); } catch { /* revoked */ }
          }
        }, this.offlineGraceMs);
        timer.unref(); this.offlineTimers.set(id, timer);
      }
    });
    void request;
  }
  private receive(connection: Connection, value: Record<string, unknown>): void {
    const type = value.type;
    if (!connection.installationId && !connection.pairingId && !connection.pairedInstallationId) {
      clearTimeout(connection.authTimer);
      const nonce = connection.challenge;
      connection.challenge = ''; // Burn before the first attempt, including an invalid proof.
      if (!nonce || this.store.now() >= connection.authDeadline) { this.error(connection, 'authentication_timeout', 4001); return; }
      if (type === 'pair_start') {
        client(value.client);
        publicKeyObject(value.publicKey);
        if (!this.botUsername) { this.error(connection, 'bot_username_required'); return; }
        const pairingId = String(value.pairingId);
        if (!UUID.test(pairingId) || !BASE64_32.test(String(value.nonceHash))) fail(400, 'invalid_pairing');
        const row = this.store.beginWirePairing(pairingId, String(value.nonceHash), installation(value.installation), String(value.publicKey));
        connection.pairingId = pairingId;
        this.pairings.set(pairingId, { connection, expires: row.expires_at });
        this.send(connection, 'pair_pending', { pairingId, expiresAt: iso(row.expires_at), attemptLimit: 5, botUsername: this.botUsername });
        return;
      }
      if (type !== 'hello') fail(400, 'expected_hello_or_pair_start');
      client(value.client); installation(value.installation);
      connection.minor = Number(String(record(value.client).bridge).split('.')[1]);
      const id = String(value.installationId);
      if (!UUID.test(id)) fail(400, 'invalid_installation');
      let row;
      try { row = this.store.installation(id); } catch { this.error(connection, 'device_unauthorized', 4001); return; }
      if (!row.public_key || !verifyDeviceProof(row.public_key, id, nonce, value.proof)) {
        this.error(connection, 'device_unauthorized', 4001); return;
      }
      connection.installationId = id;
      const old = this.installations.get(id);
      this.installations.set(id, connection);
      if (old) this.onDisconnected(id);
      old?.socket.close(4005, 'connection_replaced');
      clearTimeout(this.offlineTimers.get(id)); this.offlineTimers.delete(id);
      this.store.presence(id, true); this.onConnected(id); this.changed(row.telegram_id);
      this.send(connection, 'welcome', { sessionId: connection.connectionId, serverTime: iso(this.store.now()), heartbeatIntervalMs: this.heartbeatMs,
        serverProtocol: '2.3', features: [], resync: 'full' });
      return;
    }
    if (type === 'unpair' && (connection.installationId || connection.pairedInstallationId)) {
      if (!['owner', 'storage_failed', 'relay_changed'].includes(String(value.reason))) fail(400, 'invalid_reason');
      const id = connection.installationId ?? connection.pairedInstallationId!;
      const owner = this.store.installation(id).telegram_id;
      this.store.revoke(id, owner); this.changed(owner);
      this.send(connection, 'unpaired'); connection.socket.close(4002, 'unpaired'); return;
    }
    if (connection.pairingId) {
      const pairingId = connection.pairingId;
      if (type !== 'pair_cancel' && type !== 'pair_confirm') return;
      if (value.pairingId !== pairingId) fail(400, 'invalid_pairing');
      if (type === 'pair_cancel') {
        if (!['declined', 'timeout', 'local'].includes(String(value.reason))) fail(400, 'invalid_reason');
        this.store.cancelWirePairing(pairingId); connection.socket.close(1000, 'pair_cancelled'); return;
      }
      if (type === 'pair_confirm') {
        const claim = this.pairings.get(pairingId);
        const pending = this.store.wirePairing(pairingId);
        if (!claim || !pending.telegram_id || value.claimantUserId !== pending.telegram_id || typeof value.nonce !== 'string' ||
          !BASE64_32.test(value.nonce) || !validProof(createHash('sha256').update(value.nonce, 'utf8').digest(), pending.nonce_hash)) {
          fail(401, 'pairing_confirmation_invalid');
        }
        const paired = this.store.completeWirePairing(pairingId);
        connection.pairedInstallationId = paired.installation_id;
        connection.pairingId = undefined; this.pairings.delete(pairingId);
        this.send(connection, 'pair_complete', { pairingId, installationId: paired.installation_id,
          owner: { displayName: paired.display_name, telegramUserId: paired.telegram_id }, issuedAt: iso(this.store.now()) });
        this.changed(paired.telegram_id);
        // Bridge closes after durable save, or sends unpair/storage_failed before close.
        const timer = setTimeout(() => connection.socket.close(1000, 'pair_complete'), 10000); timer.unref();
        return;
      }
      return; // Unknown minor-version frame kinds are ignored.
    }
    if (!connection.installationId) return;
    const id = connection.installationId;
    if (this.installations.get(id) !== connection) return;
    if (type === 'pong') {
      if (!connection.pingNonce || value.nonce !== connection.pingNonce) fail(400, 'invalid_pong');
      connection.pingNonce = undefined; connection.pingAt = undefined; this.store.presence(id, true); return;
    }
    if (type === 'command_result') {
      if (!connection.synced || connection.minor < 2) return;
      const command = typeof value.commandId === 'string' ? this.store.commands.get(id, value.commandId) : undefined;
      if (!command || command.tab_id !== value.tabId) return;
      const result = normalizeCommandResult(value);
      if (result.status === 'executed' && result.outcome === 'succeeded' && this.commandReady(id) && this.store.tabs(id).some(tab => tab.tab_id === command.tab_id)) {
        result.payload = normalizeReadPayload(command.action, value.payload, command.tab_id);
      }
      this.onCommandResult(id, result, true); return;
    }
    if (type !== 'snapshot' && type !== 'event') return;
    const epoch = integer(value.epoch), revision = integer(value.revision), current = this.store.installation(id);
    if (epoch < current.epoch || (epoch === current.epoch && revision < current.revision)) return;
    if (type === 'snapshot') {
      if (!Array.isArray(value.tabs) || value.tabs.length > 200 || typeof value.truncated !== 'boolean') fail(400, 'invalid_snapshot');
      const tabs = value.tabs.map(normalizeTab);
      if (new Set(tabs.map(tab => tab.tab_id)).size !== tabs.length) fail(400, 'duplicate_tab');
      const result = this.store.applyWireSnapshot(id, epoch, revision, installation(value.installation), tabs);
      if (result === 'applied') {
        connection.synced = true;
        this.changed(current.telegram_id);
        if (!connection.replayStarted && connection.minor >= 2) {
          connection.replayStarted = true;
          this.onReadyForReplay(id, connection.connectionId, () => this.installations.get(id) === connection && connection.socket.readyState === WebSocket.OPEN);
        }
      }
      return;
    }
    if (epoch === current.epoch && revision <= current.revision) return;
    if (!connection.synced || epoch !== current.epoch || revision !== current.revision + 1) {
      connection.synced = false;
      if (this.store.now() - connection.lastResync >= 5000) {
        connection.lastResync = this.store.now(); this.send(connection, 'resync_request', { reason: epoch !== current.epoch ? 'restart' : 'gap' });
      }
      return;
    }
    const event = record(value.event);
    if (event.kind === 'tab_updated') this.store.applyWireEvent(id, epoch, revision, { kind: event.kind, tab: normalizeTab(event.tab) });
    else if (event.kind === 'tab_removed') this.store.applyWireEvent(id, epoch, revision, { kind: event.kind, tabId: idString(event.tabId) });
    else if (event.kind === 'installation_updated') this.store.applyWireEvent(id, epoch, revision, { kind: event.kind, label: installation(event.installation) });
    else if (event.kind === 'notice') {
      const notice = event;
      const noticeKind = notice.noticeKind;
      if (noticeKind !== 'turn_completed' && noticeKind !== 'action_required') {
        this.store.applyWireEvent(id, epoch, revision, { kind: 'notice' });
        return;
      }
      const noticeValue = { tabId: idString(notice.tabId), noticeKind, ...(notice.turnId === undefined || notice.turnId === null ? {} : { turnId: idString(notice.turnId) }), occurredAt: date(notice.occurredAt) } as { tabId: string; noticeKind: 'turn_completed' | 'action_required'; turnId?: string; occurredAt: string };
      this.store.applyWireEvent(id, epoch, revision, { kind: 'notice' });
      this.onNotice(id, noticeValue, String(value.frameId));
    } else if (event.kind === 'command_updated') {
      if (connection.minor < 2) return;
      const command = typeof event.commandId === 'string' ? this.store.commands.get(id, event.commandId) : undefined;
      const result = command && command.tab_id === event.tabId ? normalizeCommandResult(event) : undefined;
      this.store.applyWireEvent(id, epoch, revision, { kind: 'command_updated' });
      if (result) this.onCommandResult(id, result, false);
    } else return; // Future event payloads never enter persistence.
    this.changed(current.telegram_id);
  }
  claim(nonce: string, user: string): Record<string, unknown> {
    if (!BASE64_32.test(nonce)) fail(400, 'invalid_nonce');
    const row = this.store.claimNonce(nonce, user);
    const claim = this.pairings.get(row.pairing_id);
    if (!claim || claim.connection.socket.readyState !== WebSocket.OPEN) fail(409, 'pairing_desktop_unavailable');
    this.send(claim.connection, 'pair_claimed', { pairingId: row.pairing_id, claimant: this.store.claimant(user),
      claimedAt: iso(this.store.now()), confirmExpiresAt: iso(row.expires_at) });
    return { pairing_id: row.pairing_id, label: row.label, status: 'phone_confirmed', expires_at: row.expires_at };
  }
  commandReady(id: string): boolean {
    const connection = this.installations.get(id);
    return !!connection && connection.socket.readyState === WebSocket.OPEN && connection.synced && connection.minor >= 2;
  }
  assertCommandReady(id: string): void {
    const connection = this.installations.get(id);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || !connection.synced) fail(409, 'not_connected');
    if (connection.minor < 2) fail(409, 'commands_unsupported');
    if (connection.socket.bufferedAmount > 512 * 1024) fail(429, 'bridge_backpressure');
  }
  dispatchCommand(id: string, userRef: string, input: CommandInput, completed: (known: boolean) => void): void {
    this.assertCommandReady(id);
    const connection = this.installations.get(id)!;
    const body = { commandId: input.commandId, installationId: id, tabId: input.tabId, userRef, action: input.action,
      ...(input.action === 'send' ? { text: input.text } : {}), ...(input.action === 'stop' ? { expectedTurnId: input.expectedTurnId } : {}) };
    connection.socket.send(JSON.stringify(frame('command', body, this.store.now())), error => completed(!error && this.installations.get(id) === connection && connection.socket.readyState === WebSocket.OPEN));
  }
  revoke(id: string): void {
    const connection = this.installations.get(id);
    if (connection) { this.send(connection, 'revoked', { reason: 'owner' }); connection.socket.close(4002, 'revoked'); }
  }
  private tick(): void {
    for (const connection of this.connections) {
      if (!connection.installationId) continue;
      if (connection.pingAt !== undefined && this.store.now() - connection.pingAt > 10000) { connection.socket.close(4003, 'heartbeat_timeout'); continue; }
      if (!connection.pingNonce && this.store.now() - connection.lastPing >= this.heartbeatMs) {
        connection.pingNonce = opaqueToken(); connection.lastPing = this.store.now(); connection.pingAt = this.store.now();
        this.send(connection, 'ping', { nonce: connection.pingNonce });
      }
    }
    for (const [id, claim] of this.pairings) if (claim.expires <= this.store.now()) {
      this.store.cancelWirePairing(id); this.pairings.delete(id); this.error(claim.connection, 'pairing_expired');
    }
  }
  close(): void {
    clearInterval(this.timer);
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
    for (const connection of this.connections) {
      clearTimeout(connection.authTimer);
      if (connection.installationId) this.store.presence(connection.installationId, false);
      connection.socket.removeAllListeners('close'); connection.socket.terminate();
    }
    this.connections.clear(); this.installations.clear(); this.pairings.clear(); this.wss.close();
  }
}
const idString = id;
