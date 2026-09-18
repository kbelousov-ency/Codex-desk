import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_FRAME_CHARS = 32 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 4_000;
const DIAGNOSTIC_WINDOW_MS = 5_000;
const REQUEST_METHODS = new Set([
  'initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/list', 'thread/items/list',
  'thread/turns/list', 'thread/name/set', 'thread/compact/start', 'thread/archive', 'thread/unarchive',
  'thread/delete', 'turn/start', 'turn/interrupt', 'turn/steer', 'model/list', 'account/read',
  'config/read', 'config/batchWrite', 'config/mcpServer/reload', 'mcpServerStatus/list',
]);
const SERVER_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput',
  'mcpServer/elicitation/request', 'item/permissions/requestApproval', 'item/tool/call',
  'account/chatgptAuthTokens/refresh', 'attestation/generate', 'applyPatchApproval', 'execCommandApproval',
]);
const LIFECYCLE_METHODS = new Set([
  'turn/started', 'turn/completed', 'error', 'thread/started', 'thread/compacted',
  'thread/status/changed', 'serverRequest/resolved', 'mcpServer/startupStatus/updated',
]);
const LIFECYCLE_STATUSES = new Set([
  'notLoaded', 'idle', 'systemError', 'active', 'inProgress', 'completed', 'interrupted',
  'failed', 'starting', 'ready', 'cancelled',
]);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGBREAK']);

function diagnosticText(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/** JSONL transport for the locally installed Codex app-server. */
export class CodexClient extends EventEmitter {
  constructor({ executable = 'codex', cwd, spawnImpl = spawn, requestTimeoutMs = 120_000, diagnostics, diagnosticContext = {} } = {}) {
    super();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be a positive finite number.');
    }
    this.executable = executable;
    this.cwd = cwd;
    this._spawn = spawnImpl;
    this._timeout = requestTimeoutMs;
    this._sequence = 0;
    this._session = null;
    this._startPromise = null;
    this._diagnostics = diagnostics;
    // Copy only opaque host-generated IDs. Context never follows subsequent tab changes.
    this._diagnosticContext = Object.freeze({
      sessionId: /^[a-f0-9]{16}$/.test(diagnosticContext?.sessionId ?? '') ? diagnosticContext.sessionId : undefined,
      projectId: /^[a-f0-9]{16}$/.test(diagnosticContext?.projectId ?? '') ? diagnosticContext.projectId : undefined,
      clientId: this._diagnosticId(randomUUID()),
    });
    this.state = 'stopped';
  }

  _diagnosticId(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      const id = this._diagnostics?.id(value);
      return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id) ? id : undefined;
    } catch { return undefined; }
  }

  _record(level, event, data = {}) {
    try { this._diagnostics?.record(level, event, { ...this._diagnosticContext, ...data }); } catch { /* Logging must not affect Codex. */ }
  }

  _recordError(event, error, data = {}, level = 'error') {
    try { this._diagnostics?.error(event, error, { ...this._diagnosticContext, ...data }, level); } catch { /* Logging must not affect Codex. */ }
  }

  _requestDiagnostic(pending, error) {
    const data = { ...pending.diagnostic, durationMs: Math.max(0, Math.round(performance.now() - pending.startedAt)) };
    if (error) this._recordError('rpc.failed', error, data);
    else this._record('info', 'rpc.complete', data);
  }

  _allowDiagnostic(session, bucket, key, maximum) {
    const now = performance.now();
    let limit = session.diagnosticLimits.get(bucket);
    if (!limit || now - limit.startedAt >= DIAGNOSTIC_WINDOW_MS) {
      limit = { startedAt: now, keys: new Set(), warned: false };
      session.diagnosticLimits.set(bucket, limit);
    }
    if (limit.keys.has(key)) return false;
    if (limit.keys.size >= maximum) {
      if (!limit.warned) this._record('warn', 'transport.diagnostic', { reason: 'throttled' });
      limit.warned = true;
      return false;
    }
    limit.keys.add(key);
    return true;
  }

  _notificationDiagnostic(session, method, params) {
    if (!this._diagnostics || !LIFECYCLE_METHODS.has(method)) return;
    const data = {
      method,
      threadId: this._diagnosticId(params?.threadId ?? params?.thread?.id),
      turnId: this._diagnosticId(params?.turnId ?? params?.turn?.id),
    };
    const status = params?.turn?.status ?? params?.status?.type ?? params?.status;
    if (LIFECYCLE_STATUSES.has(status)) data.status = status;
    if (typeof params?.willRetry === 'boolean') data.retry = params.willRetry;
    const error = params?.error ?? params?.turn?.error;
    if (error) {
      // Error notifications can repeat on reconnect loops. Include a private hash
      // in the deduplication key, never the serialized error in persisted data.
      const fingerprint = this._diagnosticId(typeof error === 'string' ? error : error.message);
      if (this._allowDiagnostic(session, 'notificationError', `${JSON.stringify(data)}:${fingerprint}`, 20)) {
        this._recordError('rpc.notification', error, data);
      }
    }
    else if (this._allowDiagnostic(session, 'notification', JSON.stringify(data), 100)) {
      this._record('info', 'rpc.notification', data);
    }
  }

  _stderrDiagnostic(session, line) {
    if (!this._diagnostics) return;
    // Stderr can contain arbitrary command/config data. Only the logger's error
    // classifier sees it; neither raw nor redacted message text is persisted.
    const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, MAX_DIAGNOSTIC_CHARS);
    if (!/\b(?:WARN(?:ING)?|ERROR|FATAL|panic|panicked)\b/i.test(plain)) return;
    if (!this._allowDiagnostic(session, 'stderr', this._diagnosticId(plain) ?? 'unknown', 10)) return;
    this._recordError('transport.diagnostic', new Error(plain), { reason: 'stderr' }, /\b(?:ERROR|FATAL|panic|panicked)\b/i.test(plain) ? 'error' : 'warn');
  }

  start() {
    if (this._startPromise) return this._startPromise;
    // Defer startup so even calls made from a status listener share one startup.
    const startup = Promise.resolve().then(() => {
      if (this._startPromise !== startup) throw new Error('Codex startup was stopped.');
      return this._start();
    });
    this._startPromise = startup;
    startup.catch(() => {
      if (this._startPromise === startup) this._startPromise = null;
    });
    return startup;
  }

  async _start() {
    const session = {
      child: null,
      pending: new Map(),
      writes: new Set(),
      serverRequests: new Set(),
      outputDecoder: new StringDecoder('utf8'),
      errorDecoder: new StringDecoder('utf8'),
      output: '',
      stderr: '',
      discardingStderr: false,
      ended: false,
      diagnosticLimits: new Map(),
    };
    this._session = session;
    this._record('info', 'transport.start');
    this._status('starting');
    try {
      if (session.ended) throw new Error('Codex startup was stopped.');
      const child = this._spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
        cwd: this.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      session.child = child;
      child.on('error', (error) => this._end(session, asError(error), 'error', 'spawn'));
      child.on('exit', (code, signal) => {
        this._record('info', 'transport.exit', { exitCode: Number.isInteger(code) ? code : undefined, signal: SIGNALS.has(signal) ? signal : undefined });
        this._flushStderr(session);
        this._end(session, new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'}).`), 'stopped', 'exit');
      });
      child.stdin.on('error', (error) => this._end(session, asError(error), 'error'));
      child.stdout.on('error', (error) => this._end(session, asError(error), 'error'));
      child.stderr.on('error', (error) => {
        this._recordError('transport.diagnostic', error, { reason: 'stderr_read' });
        this.emit('diagnostic', 'Could not read Codex diagnostic output.');
      });
      child.stdout.on('data', (chunk) => this._receive(session, session.outputDecoder.write(chunk)));
      child.stdout.on('end', () => {
        this._receive(session, session.outputDecoder.end());
        if (session.output.trim()) this._frame(session, session.output);
        session.output = '';
        this._end(session, new Error('Codex output stream closed.'), 'stopped', 'stream');
      });
      child.stderr.on('data', (chunk) => this._stderr(session, session.errorDecoder.write(chunk)));
      child.stderr.on('end', () => {
        this._stderr(session, session.errorDecoder.end());
        this._flushStderr(session);
      });

      const result = await this.request('initialize', {
        clientInfo: { name: 'codex_desk', title: 'Codex Desk', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      await this._write(session, { method: 'initialized' });
      if (session.ended || this._session !== session) throw new Error('Codex startup was interrupted.');
      const version = typeof result?.userAgent === 'string'
        ? /(?:^|\s)codex(?:-cli|_cli_rs|_desk)\/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){0,4})?)(?=\s|$|\()/.exec(result.userAgent)?.[1]
        : undefined;
      if (version) this._record('info', 'codex.version', { codexVersion: version });
      this._record('info', 'transport.ready');
      this._status('ready');
      return result;
    } catch (error) {
      this._end(session, asError(error), 'error', session.child ? 'stream' : 'spawn');
      throw error;
    }
  }

  request(method, params = {}) {
    const session = this._session;
    if (!session || session.ended || !session.child) return Promise.reject(new Error('Codex is not running.'));
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('A request method is required.'));
    const id = ++this._sequence;
    const diagnostic = {
      requestId: id,
      method: REQUEST_METHODS.has(method) ? method : 'unknown',
      threadId: this._diagnosticId(params?.threadId),
      turnId: this._diagnosticId(params?.turnId),
    };
    const startedAt = performance.now();
    this._record('info', 'rpc.start', diagnostic);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pending.get(id);
        if (!session.pending.delete(id)) return;
        const error = new Error(`Codex request timed out: ${method}`);
        this._requestDiagnostic(pending, error);
        reject(error);
      }, this._timeout);
      session.pending.set(id, { resolve, reject, timer, diagnostic, startedAt });
      this._write(session, { id, method, params }).catch((error) => {
        const pending = session.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.pending.delete(id);
        this._requestDiagnostic(pending, error);
        pending.reject(error);
      });
    });
  }

  respond(id, result) {
    const session = this._session;
    if (!session || session.ended || !session.serverRequests.has(id)) {
      return Promise.reject(new Error('This Codex permission request is no longer pending.'));
    }
    // Claim the response before writing so repeated clicks cannot send it twice.
    session.serverRequests.delete(id);
    return this._write(session, { id, result });
  }

  stop() {
    const session = this._session;
    this._startPromise = null;
    if (session && !session.ended) this._end(session, new Error('Codex was stopped.'), 'stopped', 'stop');
    else if (this.state !== 'stopped') this._status('stopped');
  }

  _write(session, message) {
    return new Promise((resolve, reject) => {
      if (session.ended || this._session !== session || !session.child?.stdin?.writable) {
        reject(new Error('Codex connection is closed.'));
        return;
      }
      let line;
      try {
        line = `${JSON.stringify(message)}\n`;
      } catch (error) {
        reject(asError(error));
        return;
      }
      const settle = (error) => {
        if (!session.writes.delete(settle)) return;
        if (error) reject(error);
        else resolve();
      };
      session.writes.add(settle);
      try {
        // Node's Writable queues complete frames and honors their write order.
        session.child.stdin.write(line, 'utf8', (error) => {
          settle(error);
          if (error) this._end(session, asError(error), 'error');
        });
      } catch (error) {
        settle(asError(error));
        this._end(session, asError(error), 'error');
      }
    });
  }

  _receive(session, text) {
    if (session.ended) return;
    session.output += text;
    let newline;
    while ((newline = session.output.indexOf('\n')) !== -1) {
      if (newline > MAX_FRAME_CHARS) {
        this._end(session, new Error('Codex sent an oversized protocol message.'), 'error', 'protocol');
        return;
      }
      const line = session.output.slice(0, newline);
      session.output = session.output.slice(newline + 1);
      if (line.trim()) this._frame(session, line);
      if (session.ended) return;
    }
    if (session.output.length > MAX_FRAME_CHARS) {
      this._end(session, new Error('Codex sent an oversized protocol message.'), 'error', 'protocol');
    }
  }

  _frame(session, line) {
    if (session.ended) return;
    let message;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid frame');
    } catch {
      // Never echo malformed protocol content: it may contain credentials.
      if (this._allowDiagnostic(session, 'protocol', 'malformed_frame', 10)) this._record('warn', 'transport.diagnostic', { reason: 'malformed_frame' });
      this.emit('diagnostic', 'Ignored malformed Codex protocol output.');
      return;
    }
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    if (typeof message.method === 'string') {
      if (hasId) {
        if (session.serverRequests.has(message.id)) {
          if (this._allowDiagnostic(session, 'protocol', 'duplicate_request', 10)) this._record('warn', 'transport.diagnostic', { reason: 'duplicate_request' });
          this.emit('diagnostic', 'Ignored a duplicate Codex server request.');
          return;
        }
        session.serverRequests.add(message.id);
        this._record('info', 'rpc.serverRequest', { method: SERVER_METHODS.has(message.method) ? message.method : 'unknown' });
        this.emit('serverRequest', { id: message.id, method: message.method, params: message.params ?? {} });
      } else {
        if (message.method === 'serverRequest/resolved') session.serverRequests.delete(message.params?.requestId);
        this._notificationDiagnostic(session, message.method, message.params);
        this.emit('notification', { method: message.method, params: message.params ?? {} });
      }
      return;
    }
    if (!hasId) return;
    const pending = session.pending.get(message.id);
    if (!pending) return; // Responses can arrive after a local timeout.
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'Codex request failed.');
      error.code = message.error.code;
      error.data = message.error.data;
      this._requestDiagnostic(pending, error);
      pending.reject(error);
    } else if (Object.hasOwn(message, 'result')) {
      this._requestDiagnostic(pending);
      pending.resolve(message.result);
    } else {
      const error = new Error('Codex returned a response without a result.');
      this._requestDiagnostic(pending, error);
      pending.reject(error);
    }
  }

  _stderr(session, text) {
    if (session.ended) return;
    session.stderr += text;
    let newline;
    while ((newline = session.stderr.indexOf('\n')) !== -1) {
      const line = session.stderr.slice(0, newline);
      session.stderr = session.stderr.slice(newline + 1);
      if (!session.discardingStderr && line.trim()) {
        this._stderrDiagnostic(session, line);
        this.emit('diagnostic', diagnosticText(line));
      }
      session.discardingStderr = false;
    }
    // Discard excessive unterminated diagnostics, avoiding partial-token leaks.
    if (session.stderr.length > 64 * 1024) {
      session.stderr = '';
      if (!session.discardingStderr) {
        if (this._allowDiagnostic(session, 'protocol', 'oversized_diagnostic', 10)) this._record('warn', 'transport.diagnostic', { reason: 'oversized_diagnostic' });
        this.emit('diagnostic', 'Discarded an oversized Codex diagnostic line.');
      }
      session.discardingStderr = true;
    }
  }

  _flushStderr(session) {
    if (session.discardingStderr || !session.stderr.trim()) return;
    this._stderrDiagnostic(session, session.stderr);
    this.emit('diagnostic', diagnosticText(session.stderr));
    session.stderr = '';
  }

  _status(state, message) {
    this.state = state;
    this.emit('status', message ? { state, message: diagnosticText(message) } : { state });
  }

  _end(session, error, state, reason = 'stream') {
    if (session.ended) return;
    session.ended = true;
    if (state === 'error') this._recordError('transport.end', error, { state, reason });
    else this._record('info', 'transport.end', { state, reason });
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      this._requestDiagnostic(pending, error);
      pending.reject(error);
    }
    session.pending.clear();
    for (const settle of session.writes) settle(error);
    session.serverRequests.clear();
    session.output = '';
    session.stderr = '';
    if (this._session === session) {
      this._startPromise = null;
      this._status(state, state === 'error' ? error.message : undefined);
    }
    // kill() is harmless after exit and prevents a transport error leaving a worker behind.
    try { session.child?.kill(); } catch { /* Already exited. */ }
  }
}
