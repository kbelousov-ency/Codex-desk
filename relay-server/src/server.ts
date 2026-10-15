import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiError, bodyRecord, fail, isRecord, RateLimiter, stringField, validateInitData } from './security.ts';
import { Store } from './store.ts';
import { BridgeHub } from './bridge.ts';
import { FIXTURE_BOT_TOKEN, fixtureInitData } from './fixtures.ts';
import { CommandService } from './command-service.ts';
import { parseCommand, type CommandRow } from './commands.ts';
import { NotificationService } from './notifications.ts';

export interface RelayOptions {
  database?: string; botToken: string; botUsername?: string; fixtureMode?: boolean; allowedOrigins?: string[];
  now?: () => number; tls?: { key: string; cert: string }; trustLoopbackProxy?: boolean;
  staticDirectory?: string; heartbeatMs?: number; offlineGraceMs?: number; sessionTtlMs?: number;
  readWaitMs?: number;
  commandPayloadKey?: string; replayIntervalMs?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}
const loopback = (peer: string | undefined) => peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
function forwarded(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded') || ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'via'].includes(key));
}
function localhostHost(host: string | undefined): boolean {
  if (!host) return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
}
export function isLocalFixtureRequest(request: IncomingMessage): boolean {
  if (!loopback(request.socket.remoteAddress) || !localhostHost(request.headers.host) || forwarded(request)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && localhostHost(url.host); } catch { return false; }
}
async function readJson(request: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) fail(415, 'json_required');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail(413, 'request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
}
function token(request: IncomingMessage): string {
  const auth = request.headers.authorization;
  if (!auth || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) fail(401, 'authentication_required');
  return auth.slice(7);
}
const iso = (value: number) => new Date(value).toISOString();

export function createRelay(options: RelayOptions) {
  if (!options.botToken) throw new Error('TELEGRAM_BOT_TOKEN must be supplied through the server environment');
  if (options.fixtureMode && options.botToken !== FIXTURE_BOT_TOKEN) throw new Error('Fixture mode accepts only the synthetic fixture token');
  if (options.botUsername && !/^[A-Za-z0-9_]{5,32}$/.test(options.botUsername)) throw new Error('Invalid TELEGRAM_BOT_USERNAME');
  const now = options.now ?? Date.now;
  const store = new Store(options.database ?? ':memory:', now, options.commandPayloadKey);
  const origins = new Set(options.allowedOrigins ?? ['http://localhost:4174', 'http://127.0.0.1:4174', 'http://localhost:5173', 'http://127.0.0.1:5173']);
  const limits = new RateLimiter();
  const subscribers = new Map<WebSocket, { user: string; token: string; expires: number }>();
  let commands: CommandService | undefined;
  const snapshot = (user: string) => ({ revision: store.viewRevision(user), installations: store.installations(user).map(item => ({ ...item,
    last_seen: item.last_seen === null ? null : iso(item.last_seen) })) });
  const sendSnapshot = (socket: WebSocket, user: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) { socket.close(4006, 'backpressure'); return; }
    socket.send(JSON.stringify({ type: 'snapshot', ...snapshot(user) }));
  };
  const changed = (user: string) => {
    commands?.invalidateUnavailable();
    store.bumpViewRevision(user);
    for (const [socket, session] of subscribers) if (session.user === user) {
      try { store.session(session.token); }
      catch { socket.close(4001, 'session_expired'); continue; }
      sendSnapshot(socket, user);
    }
  };
  const bridge = new BridgeHub(store, changed, options.heartbeatMs, options.offlineGraceMs,
    options.botUsername ?? (options.fixtureMode ? 'kuzmich_fixture_bot' : ''));
  const notifications = new NotificationService(store, options.botToken, options.fetchImpl, !options.fixtureMode || !!options.fetchImpl);
  bridge.onConnected = id => notifications.connected(id);
  bridge.onNotice = (id, notice, frameKey) => notifications.notice(id, notice, frameKey);
  const commandUpdated = (row: CommandRow) => {
    for (const [socket, session] of subscribers) if (session.user === row.telegram_id && socket.readyState === WebSocket.OPEN) {
      try { store.session(session.token); store.ownedInstallation(row.installation_id, session.user); }
      catch { continue; }
      if (socket.bufferedAmount > 512 * 1024) { socket.close(4006, 'backpressure'); continue; }
      socket.send(JSON.stringify({ type: 'command_updated', installationId: row.installation_id, command: store.commands.dto(row) }));
    }
  };
  commands = new CommandService(store, {
    ready: id => bridge.commandReady(id), assertReady: id => bridge.assertCommandReady(id),
    dispatch: (id, userRef, input, completed) => bridge.dispatchCommand(id, userRef, input, completed),
  }, row => { commandUpdated(row); notifications.command(row); }, options.readWaitMs, options.replayIntervalMs);
  bridge.onCommandResult = (id, result, direct) => commands!.result(id, result, direct);
  bridge.onDisconnected = id => { commands!.disconnected(id); notifications.disconnected(id); };
  bridge.onReadyForReplay = (id, connectionId, stillCurrent) => { void commands!.reconnected(id, connectionId, stillCurrent); };
  const events = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const secure = (request: IncomingMessage) => !!options.tls ||
    (loopback(request.socket.remoteAddress) && localhostHost(request.headers.host) && !forwarded(request)) ||
    (!!options.trustLoopbackProxy && loopback(request.socket.remoteAddress) && request.headers['x-forwarded-proto'] === 'https');
  function guard(request: IncomingMessage): void {
    if (!secure(request)) fail(400, 'https_required');
    if (options.fixtureMode && !isLocalFixtureRequest(request)) fail(403, 'fixture_local_only');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) fail(403, 'origin_not_allowed');
  }
  function headers(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.headers.origin && origins.has(request.headers.origin)) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
  }
  function json(response: ServerResponse, status: number, data: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
  }
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    headers(request, response);
    try {
      guard(request);
      limits.consume(`ip:${request.socket.remoteAddress ?? ''}`, 120, 60000, now());
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url ?? '/', 'http://relay.invalid');
      const path = url.pathname;
      if (url.search && (path.startsWith('/api/') || path === '/health')) fail(400, 'query_not_supported');
      if (path === '/health' && request.method === 'GET') { json(response, 200, { ok: true, bridge_ready: true, server_protocol: '2.3' }); return; }
      if (path === '/api/dev/init-data' && request.method === 'GET') {
        if (!options.fixtureMode || !isLocalFixtureRequest(request)) fail(404, 'not_found');
        json(response, 200, { initData: fixtureInitData(now()) }); return;
      }
      if (path === '/api/auth' && request.method === 'POST') {
        limits.consume(`auth:${request.socket.remoteAddress ?? ''}`, 10, 60000, now());
        const body = bodyRecord(await readJson(request), ['initData']);
        const identity = validateInitData(stringField(body.initData, 16384), options.botToken, now());
        const session = store.createSession(identity, options.sessionTtlMs);
        json(response, 200, { ...session, expires_at: iso(session.expires_at) }); return;
      }
      if (path.startsWith('/api/')) {
        const sessionToken = token(request), session = store.session(sessionToken);
        limits.consume(`user:${session.telegram_id}`, 120, 60000, now());
        if (path === '/api/installations' && request.method === 'GET') { json(response, 200, snapshot(session.telegram_id)); return; }
        if (path === '/api/notifications' && request.method === 'GET') { json(response, 200, notifications.settings(session.telegram_id)); return; }
        if (path === '/api/notifications' && request.method === 'PUT') {
          const body = bodyRecord(await readJson(request), ['turnCompleted', 'actionRequired', 'commandFailed', 'presence']);
          const value: Partial<import('./store.ts').NotificationSettings> = {};
          for (const key of ['turnCompleted', 'actionRequired', 'commandFailed', 'presence'] as const) {
            if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') fail(400, 'invalid_notification_setting'); value[key] = body[key]; }
          }
          json(response, 200, notifications.updateSettings(session.telegram_id, value)); return;
        }
        const commandPath = /^\/api\/installations\/([A-Za-z0-9_-]{1,128})\/commands(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(path);
        if (commandPath && request.method === 'GET' && commandPath[2]) {
          json(response, 200, { command: commands!.read(session.telegram_id, commandPath[1], commandPath[2]) }); return;
        }
        if (commandPath && request.method === 'POST' && !commandPath[2]) {
          const input = parseCommand(await readJson(request, 256 * 1024)), controller = new AbortController();
          const abort = () => controller.abort(); response.once('close', abort); request.once('aborted', abort);
          try {
            const receipt = await commands!.submit(session.telegram_id, sessionToken, commandPath[1], input, controller.signal);
            if (response.destroyed || controller.signal.aborted) return;
            store.session(sessionToken); store.ownedInstallation(commandPath[1], session.telegram_id);
            if (receipt.payload !== undefined && (!bridge.commandReady(commandPath[1]) || !store.tabs(commandPath[1]).some(tab => tab.tab_id === input.tabId))) fail(404, 'unknown_tab');
            json(response, receipt.duplicate || receipt.payload !== undefined ? 200 : 202, receipt); return;
          } finally { response.off('close', abort); request.off('aborted', abort); }
        }
        const match = /^\/api\/installations\/([A-Za-z0-9_-]{1,128})$/.exec(path);
        if (match && request.method === 'GET') {
          store.ownedInstallation(match[1], session.telegram_id);
          json(response, 200, snapshot(session.telegram_id).installations.find(item => item.installation_id === match[1])); return;
        }
        if (match && request.method === 'DELETE') {
          store.revoke(match[1], session.telegram_id); bridge.revoke(match[1]); changed(session.telegram_id);
          json(response, 200, { ok: true }); return;
        }
        if (path === '/api/pairings/claim' && request.method === 'POST') {
          limits.consume(`claim:${session.telegram_id}`, 10, 600000, now());
          const body = bodyRecord(await readJson(request), ['nonce', 'confirm']);
          if (body.confirm !== true) fail(400, 'confirmation_required');
          const result = bridge.claim(stringField(body.nonce, 43), session.telegram_id);
          json(response, 200, { ...result, expires_at: iso(Number(result.expires_at)) }); return;
        }
        fail(404, 'not_found');
      }
      if (options.staticDirectory && request.method === 'GET' && (path === '/' || path === '/index.html' || path.startsWith('/assets/'))) {
        const root = await realpath(options.staticDirectory);
        const resolved = await realpath(resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path)));
        if (!resolved.startsWith(root + sep)) fail(404, 'not_found');
        const content = await readFile(resolved);
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
        response.writeHead(200, { 'Content-Type': types[extname(resolved)] ?? 'application/octet-stream' }); response.end(content); return;
      }
      fail(404, 'not_found');
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      // Never reflect raw input, exception messages, token values, file paths, or stack traces.
      json(response, error instanceof ApiError ? error.status : 500,
        { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.code : 'internal_error' } });
    }
  }
  const handler = (request: IncomingMessage, response: ServerResponse) => { void route(request, response); };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 30000;
  server.on('upgrade', (request, socket, head) => {
    try {
      guard(request);
      limits.consume(`upgrade:${request.socket.remoteAddress ?? ''}`, 30, 60000, now());
      const url = new URL(request.url ?? '/', 'http://relay.invalid');
      if (url.search) fail(400, 'query_not_supported');
      if (url.pathname === '/bridge/v2') {
        if (request.headers['sec-websocket-protocol'] !== 'kuzmich-bridge.v2') fail(400, 'subprotocol_required');
        bridge.wss.handleUpgrade(request, socket, head, client => bridge.wss.emit('connection', client, request)); return;
      }
      if (url.pathname === '/api/events') {
        events.handleUpgrade(request, socket, head, client => events.emit('connection', client, request)); return;
      }
      fail(404, 'not_found');
    } catch (error) {
      socket.write(`HTTP/1.1 ${error instanceof ApiError ? error.status : 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    }
  });
  events.on('connection', socket => {
    const key = `events:${Math.random()}`;
    const timeout = setTimeout(() => socket.close(4001, 'authentication_timeout'), 5000); timeout.unref();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    socket.on('message', (raw, binary) => {
      try {
        limits.consume(key, 10, 1000, now());
        if (binary) fail(400, 'binary_frame');
        const message = JSON.parse(raw.toString());
        if (!isRecord(message)) fail(400, 'invalid_frame');
        const session = subscribers.get(socket);
        if (!session) {
          bodyRecord(message, ['type', 'session_token']);
          if (message.type !== 'authenticate') fail(401, 'authentication_required');
          const sessionToken = stringField(message.session_token, 43), auth = store.session(sessionToken);
          subscribers.set(socket, { user: auth.telegram_id, token: sessionToken, expires: auth.expires_at });
          clearTimeout(timeout); expiry = setTimeout(() => socket.close(4001, 'session_expired'), Math.max(1, auth.expires_at - now())); expiry.unref();
          sendSnapshot(socket, auth.telegram_id); return;
        }
        store.session(session.token);
        bodyRecord(message, ['type']);
        if (message.type !== 'resync') fail(400, 'read_only');
        sendSnapshot(socket, session.user);
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'invalid_frame';
        socket.send(JSON.stringify({ type: 'error', error: { code, message: code } }));
        socket.close(error instanceof ApiError && error.status === 429 ? 4006 : 4001, code);
      }
    });
    socket.on('close', () => { clearTimeout(timeout); clearTimeout(expiry); subscribers.delete(socket); });
    socket.on('error', () => {});
  });
  const maintenance = setInterval(() => store.maintenance(), 60000); maintenance.unref();
  return {
    server, store, bridge, snapshot,
    async listen(port = 8787, host = '127.0.0.1'): Promise<number> {
      if (options.fixtureMode && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Fixture mode must bind loopback');
      if (!options.tls && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Public listeners require TLS');
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      return (server.address() as { port: number }).port;
    },
    async close(): Promise<void> {
      clearInterval(maintenance); commands?.close(); notifications.close(); bridge.close();
      for (const socket of events.clients) socket.terminate(); events.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
