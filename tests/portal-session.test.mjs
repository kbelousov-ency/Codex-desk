import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PortalSessionService, PORTAL_PARTITION } from '../electron/portal-session.mjs';
import { PortalAuthWindow } from '../electron/portal-auth-window.mjs';

const origin = 'https://coder-portal.encycam.com';
const secret = 'router-secret-value';
const cookie = 'cookie-secret-value';
const me = { email: 'person@encycam.com', name: 'Person', has_key: true, key_approved: true,
  entitlements: { codex: { enabled: true }, claude: { enabled: false, configured_enabled: true } }, api_key: secret, cookie };
const approved = { has_key: true, approved: true, api_key: secret };
const unauthorized = { detail: { type: 'error', error: { type: 'not_authenticated', message: cookie } } };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function safe(snapshot) {
  assert.doesNotMatch(JSON.stringify(snapshot), /api_key|router-secret-value|cookie-secret-value/);
  assert.deepEqual(Object.keys(snapshot).filter(key => !['state', 'email', 'name', 'keyState', 'heldBy', 'products', 'message'].includes(key)), []);
  return snapshot;
}

function fixture(handler = (_url, options) => reply(options.method === 'POST' ? { approved: false, api_key: secret } : _url.endsWith('/api/me') ? me : approved), options = {}) {
  const calls = [];
  const windows = [];
  const session = new EventEmitter();
  session.setPermissionRequestHandler = handler => { session.permissionHandler = handler; };
  session.setPermissionCheckHandler = handler => { session.permissionCheck = handler; };
  session.clearStorageData = async () => { session.cleared = (session.cleared || 0) + 1; };
  session.fetch = async (url, request) => {
    assert.equal(request.credentials, 'include');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Accept, 'application/json');
    assert.equal('Cookie' in request.headers, false);
    if (request.method === 'GET') assert.equal(request.headers['X-Requested-With'], undefined);
    else assert.ok(request.headers['X-Requested-With']);
    calls.push({ url, ...request });
    return handler(url, request);
  };
  const authWindow = new PortalAuthWindow({ partition: PORTAL_PARTITION, createWindow: config => {
    assert.equal(config.webPreferences.partition, 'persist:kuzmich-portal');
    assert.equal(config.webPreferences.nodeIntegration, false);
    assert.equal(config.webPreferences.sandbox, true);
    const window = new EventEmitter();
    window.destroyed = false;
    window.isDestroyed = () => window.destroyed;
    window.destroy = () => { if (!window.destroyed) { window.destroyed = true; window.emit('closed'); } };
    window.focus = () => { window.focused = true; };
    window.show = () => {};
    const contents = new EventEmitter();
    contents.session = session;
    contents.setWindowOpenHandler = handler => { contents.popup = handler; };
    contents.loadURL = async url => { contents.url = url; };
    window.webContents = contents;
    windows.push(window);
    return window;
  } });
  const service = new PortalSessionService({ session, authWindow, ...options });
  return { service, calls, windows, session, authWindow };
}

test('login uses the persistent partition, checks me once on return, and exposes no secrets', async () => {
  const { service, windows, calls, session } = fixture();
  const login = service.login();
  assert.equal(safe(await service.status()).state, 'signing-in');
  assert.equal(windows[0].webContents.url, origin + '/auth/login?next=%2F');
  assert.equal(service.focusLogin(), true);
  assert.equal(service.login(), login);
  windows[0].webContents.emit('did-navigate', {}, 'https://sso.encycam.com/login');
  windows[0].webContents.emit('did-navigate', {}, origin + '/auth/callback?code=hidden');
  assert.equal(calls.length, 0);
  windows[0].webContents.emit('did-navigate', {}, origin + '/');
  windows[0].webContents.emit('did-navigate', {}, origin + '/');
  const status = safe(await login);
  assert.deepEqual(status, { state: 'signed-in', email: me.email, name: me.name, keyState: 'approved', products: { codex: true, claude: false } });
  assert.equal(calls.filter(call => call.url.endsWith('/api/me')).length, 1);
  assert.equal(await service.routerKey(), secret);
  assert.equal(service.focusLogin(), false);
  assert.equal(session.listenerCount('will-download'), 0);
  assert.equal(service.controllers.size, 0);
});

test('user closing login performs one final check and resolves cancelled without polling timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, windows, calls, session } = fixture(() => reply(unauthorized, 401));
  const login = service.login();
  windows[0].destroy();
  const status = safe(await login);
  assert.equal(status.state, 'signed-out');
  assert.match(status.message, /отменён/);
  assert.equal(calls.length, 1);
  assert.equal(service.controllers.size, 0);
  assert.equal(session.listenerCount('will-download'), 0);
  context.mock.timers.tick(120_000);
  assert.equal(calls.length, 1);
});

test('closing after successful authentication still resolves signed-in', async () => {
  const { service, windows, calls } = fixture();
  const login = service.login();
  windows[0].destroy();
  assert.equal(safe(await login).state, 'signed-in');
  assert.equal(calls.filter(call => call.url.endsWith('/api/me')).length, 1);
});

test('status coalesces concurrent requests, caches for 60 seconds and never polls', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const { service, calls } = fixture(undefined, { now: () => now });
  const snapshots = await Promise.all([service.status(), service.status()]);
  snapshots.forEach(safe);
  safe(await service.status());
  assert.equal(calls.filter(call => call.url.endsWith('/api/me')).length, 1);
  context.mock.timers.tick(120_000);
  assert.equal(calls.length, 2);
  now = 60_001;
  safe(await service.status());
  assert.equal(calls.filter(call => call.url.endsWith('/api/me')).length, 2);
  snapshots[0].products.codex = false;
  assert.equal((await service.status()).products.codex, true);
});

test('401 mid-session signs out and forgets the host-only key', async () => {
  let expired = false;
  const { service } = fixture(url => expired ? reply(unauthorized, 401) : reply(url.endsWith('/api/me') ? me : approved));
  assert.equal(safe(await service.status()).state, 'signed-in');
  expired = true;
  const status = safe(await service.status({ refresh: true }));
  assert.equal(status.state, 'signed-out');
  assert.match(status.message, /Сессия Portal истекла/);
  assert.equal(await service.routerKey(), null);
});

test('401 from key also signs out', async () => {
  const { service } = fixture(url => reply(url.endsWith('/api/me') ? me : unauthorized, url.endsWith('/api/me') ? 200 : 401));
  assert.equal(safe(await service.status()).state, 'signed-out');
});

test('401 for a never-signed-in user returns a clean signed-out snapshot', async () => {
  const { service } = fixture(() => reply(unauthorized, 401));
  assert.deepEqual(safe(await service.status()), { state: 'signed-out', keyState: 'none', products: { codex: false, claude: false } });
  assert.equal((await service.status({ refresh: true })).message, undefined);
});

for (const [key, state, heldBy] of [
  [approved, 'approved'],
  [{ has_key: true, approved: false, api_key: secret }, 'pending'],
  [{ has_key: false, held_by: null }, 'none'],
  [{ has_key: false, held_by: 'other@encycam.com' }, 'held-elsewhere', 'other@encycam.com'],
]) {
  test('GET key state: ' + state, async () => {
    const { service, calls } = fixture(url => reply(url.endsWith('/api/me') ? me : key));
    const status = safe(await service.status());
    assert.equal(status.keyState, state);
    assert.equal(status.heldBy, heldBy);
    assert.equal(await service.routerKey(), state === 'approved' ? secret : null);
    assert.ok(calls.every(call => call.method === 'GET'));
  });
}

test('requestKey is explicit, includes CSRF header and reports pending', async () => {
  const { service, calls } = fixture();
  safe(await service.status());
  assert.equal(calls.some(call => call.method === 'POST'), false);
  const status = safe(await service.requestKey());
  assert.equal(status.keyState, 'pending');
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.url, origin + '/api/key');
  assert.ok(post.headers['X-Requested-With']);
  assert.equal(post.body, undefined);
});

test('409 key_on_other_email exposes only the documented email', async () => {
  const { service } = fixture((url, options) => options.method === 'POST'
    ? reply({ detail: { type: 'error', error: { type: 'key_on_other_email', email: 'other@encycam.com', message: secret, api_key: secret } } }, 409)
    : reply(url.endsWith('/api/me') ? me : { has_key: false, held_by: null }));
  const status = safe(await service.requestKey());
  assert.equal(status.keyState, 'held-elsewhere');
  assert.equal(status.heldBy, 'other@encycam.com');
});

for (const [body, pattern] of [
  [{ type: 'error', error: { type: 'csrf', message: secret } }, /CSRF/],
  [{ detail: { type: 'error', error: { type: 'product_disabled', message: cookie } } }, /Продукт отключён/],
]) {
  test('403 error mapping: ' + pattern, async () => {
    const { service } = fixture((url, options) => options.method === 'POST' ? reply(body, 403) : reply(url.endsWith('/api/me') ? me : approved));
    assert.match(safe(await service.requestKey()).message, pattern);
  });
}

test('network and invalid JSON failures are messages, never raw errors or secrets', async () => {
  for (const handler of [() => { throw new Error(secret + cookie); }, () => new Response(secret)]) {
    const { service } = fixture(handler);
    assert.match(safe(await service.status()).message, /Portal/);
  }
});

test('response size is bounded at 64 KiB', async () => {
  const { service } = fixture(() => new Response(JSON.stringify({ padding: 'x'.repeat(65 * 1024) })));
  assert.match(safe(await service.status()).message, /64 КиБ/);
});

test('local logout clears partition storage and does not call SSO logout', async () => {
  const { service, session, calls } = fixture();
  safe(await service.status());
  const before = calls.length;
  assert.equal(safe(await service.logout()).state, 'signed-out');
  assert.equal(session.cleared, 1);
  assert.equal(calls.length, before);
  assert.ok(calls.every(call => !call.url.includes('/auth/logout')));
});

test('host cancellation resolves login and cleans window listeners without a final API request', async () => {
  const { service, session, calls } = fixture();
  const login = service.login();
  service.cancelLogin();
  assert.equal(safe(await login).state, 'signed-out');
  assert.equal(calls.length, 0);
  assert.equal(session.listenerCount('will-download'), 0);
});

test('OAuthError redirect loop is bounded without API polling', async () => {
  const { service, windows, calls } = fixture();
  const login = service.login();
  let prevented = 0;
  for (let attempt = 0; attempt < 4; attempt++) windows[0].webContents.emit('will-redirect', { preventDefault() { prevented++; } }, origin + '/auth/login');
  assert.match(safe(await login).message, /повторяет вход/);
  assert.equal(prevented, 1);
  assert.equal(calls.length, 0);
  assert.equal(service.controllers.size, 0);
});

test('late API response after logout cannot restore the session', async () => {
  let release;
  const { service } = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = service.status();
  safe(await service.logout());
  release(reply(me));
  assert.equal(safe(await pending).state, 'signed-out');
});

test('logout during key lookup cannot leak or restore a late router key', async () => {
  let release;
  let keyStarted;
  const started = new Promise(resolve => { keyStarted = resolve; });
  const { service } = fixture(url => url.endsWith('/api/me') ? reply(me) : new Promise(resolve => { release = resolve; keyStarted(); }));
  const pending = service.status();
  await started;
  safe(await service.logout());
  release(reply(approved));
  assert.equal(safe(await pending).state, 'signed-out');
});

test('host cancellation during final check aborts fetch and leaves no request timers', async () => {
  let signal;
  const { service, windows } = fixture((_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
  }));
  const login = service.login();
  windows[0].webContents.emit('did-navigate', {}, origin + '/');
  service.cancelLogin();
  assert.equal(safe(await login).state, 'signed-out');
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.controllers.size, 0);
});

test('request timeout is a safe message and aborts the partition fetch', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const { service } = fixture((_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error(cookie)), { once: true });
  }));
  const pending = service.status();
  context.mock.timers.tick(15_001);
  assert.match(safe(await pending).message, /Не удалось связаться/);
  assert.equal(signal.aborted, true);
  assert.equal(service.controllers.size, 0);
});

test('closing while navigation check is in flight does not duplicate me', async () => {
  let release;
  const { service, windows, calls } = fixture(url => url.endsWith('/api/me') ? new Promise(resolve => { release = resolve; }) : reply(approved));
  const login = service.login();
  windows[0].webContents.emit('did-navigate', {}, origin + '/');
  windows[0].destroy();
  release(reply(me));
  assert.equal(safe(await login).state, 'signed-in');
  assert.equal(calls.filter(call => call.url.endsWith('/api/me')).length, 1);
});

test('new host instance reuses partition session without exporting cookies and preload has no raw key', async () => {
  const { service, session, authWindow } = fixture();
  safe(await service.status());
  const restarted = new PortalSessionService({ session, authWindow });
  assert.equal(safe(await restarted.status()).state, 'signed-in');
  const preload = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(preload, /api_key|routerKey/);
  for (const method of ['portalSession', 'portalLogin', 'portalLogout', 'portalRequestKey', 'focusPortalLogin']) assert.ok(preload.includes('setup:' + method));
});
