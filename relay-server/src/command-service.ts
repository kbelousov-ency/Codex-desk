import type { Store } from './store.ts';
import { fail, RateLimiter } from './security.ts';
import { readWaiterComplete, terminalStatus, type CommandDto, type CommandInput, type CommandResult, type CommandRow } from './commands.ts';

export interface CommandTransport {
  ready(installationId: string): boolean;
  assertReady(installationId: string): void;
  dispatch(installationId: string, userRef: string, input: CommandInput, completed: (known: boolean) => void): void;
}
export interface CommandReceipt { command: CommandDto; duplicate: boolean; payload?: unknown }
interface Waiter {
  user: string; sessionToken: string; installationId: string; tabId: string;
  resolve: (payload: unknown) => void; timer: ReturnType<typeof setTimeout>;
}
interface ReplayRun { connectionId: string; cancelled: boolean; unblock?: () => void; promise: Promise<void> }

/** One initiating HTTP waiter per new read command; nothing here survives a response or restart. */
export class CommandService {
  readonly store: Store;
  readonly transport: CommandTransport;
  readonly updated: (row: CommandRow) => void;
  readonly waitMs: number;
  readonly replayIntervalMs: number;
  private waiters = new Map<string, Waiter>();
  private limits = new RateLimiter();
  private closed = false;
  private connections = new Map<string, string>();
  private replayRuns = new Map<string, ReplayRun>();
  constructor(store: Store, transport: CommandTransport, updated: (row: CommandRow) => void, waitMs = 10000, replayIntervalMs = 500) {
    this.store = store; this.transport = transport; this.updated = updated; this.waitMs = waitMs;
    this.replayIntervalMs = Math.max(0, replayIntervalMs);
  }
  private key(installationId: string, commandId: string): string { return `${installationId}:${commandId}`; }
  private authorized(user: string, sessionToken: string, installationId: string, tabId: string, live = false): void {
    if (this.store.session(sessionToken).telegram_id !== user) fail(401, 'session_expired');
    this.store.ownedInstallation(installationId, user);
    if (!this.store.tabs(installationId).some(tab => tab.tab_id === tabId)) fail(404, 'unknown_tab');
    if (live && !this.transport.ready(installationId)) fail(409, 'not_connected');
  }
  read(user: string, installationId: string, commandId: string): CommandDto {
    this.store.ownedInstallation(installationId, user);
    const row = this.store.commands.get(installationId, commandId);
    if (!row || row.telegram_id !== user) fail(404, 'command_not_found');
    return this.store.commands.dto(row);
  }
  async submit(user: string, sessionToken: string, installationId: string, input: CommandInput, signal?: AbortSignal): Promise<CommandReceipt> {
    if (this.closed) fail(503, 'relay_stopping');
    this.store.ownedInstallation(installationId, user);
    const duplicate = this.store.commands.duplicate(user, installationId, input);
    if (duplicate) return { command: this.store.commands.dto(this.store.commands.hydrateDuplicate(duplicate, input)), duplicate: true };
    this.authorized(user, sessionToken, installationId, input.tabId);
    this.transport.assertReady(installationId);
    this.limits.consume(`commands:${user}`, 30, 60000, this.store.now());
    const reading = input.action === 'get_state' || input.action === 'get_last_answer';
    if (reading && [...this.waiters.values()].filter(waiter => waiter.user === user).length >= 5) fail(429, 'too_many_reads');
    if (signal?.aborted) fail(400, 'request_aborted');
    const row = this.store.commands.create(user, installationId, input);
    const connectionId = this.connections.get(installationId);
    this.store.audit('command_dispatched', user, installationId, null, input.commandId);
    const key = this.key(installationId, input.commandId);
    let abort: (() => void) | undefined;
    const pending = reading ? new Promise<unknown>(resolve => {
      const timer = setTimeout(() => this.finish(key), this.waitMs); timer.unref();
      this.waiters.set(key, { user, sessionToken, installationId, tabId: input.tabId, resolve, timer });
      abort = () => this.finish(key); signal?.addEventListener('abort', abort, { once: true });
    }) : undefined;
    try {
      this.transport.dispatch(installationId, row.user_ref, input, known => {
        if (this.closed || (connectionId !== undefined && this.connections.get(installationId) !== connectionId)) return;
        this.store.commands.dispatched(installationId, input.commandId, known);
        const current = this.store.commands.get(installationId, input.commandId)!; this.updated(current);
        if (!known) this.finish(key);
      });
    } catch {
      this.store.commands.dispatched(installationId, input.commandId, false); this.finish(key);
    }
    const payload = pending ? await pending : undefined;
    if (abort) signal?.removeEventListener('abort', abort);
    const current = this.store.commands.get(installationId, input.commandId) ?? row;
    if (payload !== undefined) this.authorized(user, sessionToken, installationId, input.tabId, true);
    return { command: this.store.commands.dto(current), duplicate: false, ...(payload === undefined ? {} : { payload }) };
  }
  result(installationId: string, result: CommandResult, directResult = true): void {
    if (this.closed) return;
    const applied = this.store.commands.applyResult(installationId, result);
    const row = applied ?? this.store.commands.get(installationId, result.commandId);
    if (!row || row.tab_id !== result.tabId || row.status !== result.status || row.outcome !== result.outcome) return;
    if (applied) { this.store.audit(`command_${row.status}`, row.telegram_id, installationId, null, row.command_id); this.updated(row); }
    if (!readWaiterComplete(row.status)) return;
    const key = this.key(installationId, row.command_id), waiter = this.waiters.get(key);
    if (!waiter) return;
    if (!directResult && row.status === 'executed' && row.outcome === 'succeeded') return;
    let payload: unknown;
    if (row.status === 'executed' && row.outcome === 'succeeded' && (row.action === 'get_state' || row.action === 'get_last_answer')) {
      try { this.authorized(waiter.user, waiter.sessionToken, installationId, waiter.tabId, true); payload = result.payload; } catch { /* Never release revoked/expired content. */ }
    }
    this.finish(key, payload);
  }
  invalidateUnavailable(): void {
    for (const [key, waiter] of this.waiters) {
      try { this.authorized(waiter.user, waiter.sessionToken, waiter.installationId, waiter.tabId, true); } catch { this.finish(key); }
    }
  }
  reconnected(installationId: string, connectionId: string, stillCurrent: () => boolean = () => true): Promise<void> {
    if (this.closed || !stillCurrent() || !this.transport.ready(installationId)) return Promise.resolve();
    const previous = this.replayRuns.get(installationId);
    if (previous?.connectionId === connectionId) return previous.promise;
    if (previous) { previous.cancelled = true; previous.unblock?.(); }
    this.connections.set(installationId, connectionId);
    const run: ReplayRun = { connectionId, cancelled: false, promise: Promise.resolve() };
    this.replayRuns.set(installationId, run);
    const alive = () => !this.closed && !run.cancelled && this.connections.get(installationId) === connectionId && stillCurrent();
    const delay = () => new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); run.unblock = undefined; resolve(); };
      const timer = setTimeout(finish, this.replayIntervalMs || 1); run.unblock = finish;
    });
    // Capture only IDs before the first await: newly submitted commands on this connection are not replay candidates.
    const ids = this.store.commands.pending(installationId).map(row => row.command_id);
    run.promise = Promise.resolve().then(async () => {
      let attempted = false;
      for (const commandId of ids) {
        if (attempted && this.replayIntervalMs > 0) await delay();
        if (!alive()) return;
        // A temporary resync/backpressure gap pauses replay; replacement/disconnection cancels it.
        while (alive()) {
          try { this.transport.assertReady(installationId); break; }
          catch { await delay(); }
        }
        if (!alive()) return;
        const row = this.store.commands.get(installationId, commandId);
        if (!row || terminalStatus(row.status)) continue;
        let installation;
        try { installation = this.store.ownedInstallation(installationId, row.telegram_id); }
        catch { this.store.commands.discardInstallation(installationId); return; }
        if (installation.user_ref !== row.user_ref) {
          this.store.commands.replayUnavailable(row, 'replay_identity_changed');
          this.updated(this.store.commands.get(installationId, commandId)!); continue;
        }
        // A tab absent from this fresh snapshot still gets its original admitted command: bridge must resolve unknown_tab.
        const input = this.store.commands.restore(row);
        if (!input) {
          this.store.audit('command_replay_unavailable', row.telegram_id, installationId, null, commandId);
          this.updated(this.store.commands.get(installationId, commandId)!); continue;
        }
        if (!alive()) return;
        attempted = true;
        this.store.audit('command_replayed', row.telegram_id, installationId, null, commandId);
        await new Promise<void>(resolve => {
          let finished = false;
          const finish = () => { if (finished) return; finished = true; run.unblock = undefined; resolve(); };
          run.unblock = finish;
          try {
            this.transport.dispatch(installationId, row.user_ref, input, known => {
              if (alive()) {
                this.store.commands.dispatched(installationId, commandId, known);
                const current = this.store.commands.get(installationId, commandId); if (current) this.updated(current);
              }
              finish();
            });
          } catch {
            if (alive()) this.store.commands.dispatched(installationId, commandId, false);
            finish();
          }
        });
      }
    }).catch(() => {
      // Fail closed on storage/transport faults; never synthesize a wire status or retry within the same connection.
      run.cancelled = true;
    });
    return run.promise;
  }
  disconnected(installationId: string): void {
    if (this.closed) return;
    this.connections.delete(installationId);
    const run = this.replayRuns.get(installationId);
    if (run) { run.cancelled = true; run.unblock?.(); this.replayRuns.delete(installationId); }
    for (const row of this.store.commands.disconnected(installationId)) this.updated(row);
    for (const [key, waiter] of this.waiters) if (waiter.installationId === installationId) this.finish(key);
  }
  private finish(key: string, payload?: unknown): void {
    const waiter = this.waiters.get(key); if (!waiter) return;
    this.waiters.delete(key); clearTimeout(waiter.timer); waiter.resolve(payload);
  }
  close(): void {
    this.closed = true;
    for (const run of this.replayRuns.values()) { run.cancelled = true; run.unblock?.(); }
    this.replayRuns.clear(); this.connections.clear();
    for (const key of this.waiters.keys()) this.finish(key);
  }
}
