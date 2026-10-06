import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudePortalBrowser } from '../electron/claude-portal-browser.mjs';
import { PORTAL_ORIGIN } from '../electron/router-portal.mjs';

const token = 'a'.repeat(43);
const source = { url: `${PORTAL_ORIGIN}/api/connect/claude/${token}.exe`, filename: `claude-connect-${token}.exe` };
const connection = { apiKey: 'fixture-key', baseUrl: 'https://router.example.test/claude', authScheme: 'bearer' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ readDownload = async () => connection, loadURL } = {}) {
  const windows = [], requests = [], timers = new Map();
  const parent = { id: 'parent' };
  const browser = new ClaudePortalBrowser({
    readDownload: value => { requests.push(value); return readDownload(value); },
    setTimeoutImpl: (fn, ms) => { const timer = {}; timers.set(timer, { fn, ms }); return timer; },
    clearTimeoutImpl: timer => timers.delete(timer),
    createWindow: options => {
      const window = new EventEmitter(), contents = new EventEmitter(), session = new EventEmitter();
      Object.assign(window, { options, webContents: contents, urls: [], destroyed: false, focusCount: 0,
        loadURL: url => { window.urls.push(url); return loadURL ? loadURL(url) : Promise.resolve(); },
        isDestroyed: () => window.destroyed,
        destroy: () => { window.destroyed = true; window.emit('closed'); },
        focus: () => { window.focusCount++; },
      });
      contents.session = session;
      contents.setWindowOpenHandler = handler => { contents.openWindow = handler; };
      session.setPermissionRequestHandler = handler => { session.permissionRequest = handler; };
      session.setPermissionCheckHandler = handler => { session.permissionCheck = handler; };
      windows.push(window);
      return window;
    },
  });
  const download = (window, overrides = {}, owner = window.webContents) => {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    const item = { getURL: () => overrides.url ?? source.url, getFilename: () => overrides.filename ?? source.filename };
    window.webContents.session.emit('will-download', event, item, owner);
    return () => prevented;
  };
  return { browser, windows, requests, timers, parent, download };
}

test('portal opens in a fresh in-memory sandbox, rejects permissions and reuses only its current window', async () => {
  const f = fixture();
  const opened = f.browser.open(f.parent), window = f.windows[0];
  assert.equal(window.options.parent, f.parent);
  assert.deepEqual(window.options.webPreferences, {
    partition: window.options.webPreferences.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  });
  assert.match(window.options.webPreferences.partition, /^claude-router-/);
  assert.equal(window.options.webPreferences.partition.startsWith('persist:'), false);
  assert.equal(Object.hasOwn(window.options.webPreferences, 'preload'), false);
  assert.deepEqual(window.urls, [`${PORTAL_ORIGIN}/#claude`]);
  assert.equal(f.browser.open(f.parent), opened);
  assert.equal(window.focusCount, 1);
  let granted;
  window.webContents.session.permissionRequest(window.webContents, 'media', value => { granted = value; });
  assert.equal(granted, false);
  assert.equal(window.webContents.session.permissionCheck(), false);
  f.browser.cancel();
  assert.equal(await opened, null);
  assert.equal(window.destroyed, true);
  assert.equal(f.timers.size, 0);
  const again = f.browser.open(f.parent);
  assert.notEqual(f.windows[1].options.webPreferences.partition, window.options.webPreferences.partition);
  f.browser.cancel(); await again;
});

test('only the owning contents and exact portal installer URL can be consumed; every own download is cancelled', async () => {
  const f = fixture(), opened = f.browser.open(f.parent), window = f.windows[0];
  assert.equal(f.download(window, {}, {})(), false, 'a different webContents does not belong to this flow');
  for (const overrides of [
    { url: `https://evil.test/api/connect/claude/${token}.exe` },
    { url: `${PORTAL_ORIGIN}/other/${token}.exe` },
    { url: `${source.url}?ticket=extra` }, { url: `${source.url}#fragment` },
    { url: source.url.replace('https://', 'https://user:pass@') },
    { url: `${PORTAL_ORIGIN}/api/connect/codex/${token}.exe` },
    { url: `${PORTAL_ORIGIN}/api/connect/claude/${token}.ps1` },
    { filename: `claude-connect-${'b'.repeat(43)}.exe` }, { filename: 'unrelated.exe' },
  ]) assert.equal(f.download(window, overrides)(), true);
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.download(window)(), true);
  assert.deepEqual(await opened, connection);
  assert.deepEqual(f.requests, [source]);
  assert.equal(window.destroyed, true);
  assert.equal(window.webContents.session.listenerCount('will-download'), 0);
  assert.equal(f.browser.current, null);
  assert.equal(f.timers.size, 0);
});

test('SSO popups reuse the sandboxed window over HTTPS and deny executable or insecure navigation', async () => {
  const f = fixture(), opened = f.browser.open(f.parent), window = f.windows[0];
  const contents = window.webContents;
  assert.deepEqual(contents.openWindow({ url: 'https://sso.example.test/login' }), { action: 'deny' });
  assert.equal(f.windows.length, 1);
  assert.equal(window.urls.at(-1), 'https://sso.example.test/login');
  for (const url of ['http://sso.example.test', 'javascript:alert(1)', 'file:///secret', 'data:text/html,hi', 'devtools://devtools', 'https://user:pass@sso.example.test']) {
    const count = window.urls.length;
    assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
    assert.equal(window.urls.length, count);
    for (const type of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      contents.emit(type, { preventDefault: () => { prevented = true; } }, url);
      assert.equal(prevented, true);
    }
  }
  for (const type of ['will-navigate', 'will-redirect']) contents.emit(type, { preventDefault: () => assert.fail('HTTPS SSO must be allowed') }, 'https://sso.example.test/callback');
  f.browser.cancel(); await opened;
});

test('duplicate installer events are single flight and closing the user window discards a late response', async () => {
  const pending = deferred();
  const f = fixture({ readDownload: () => pending.promise }), opened = f.browser.open(f.parent), window = f.windows[0];
  f.download(window); f.download(window);
  await tick();
  assert.equal(f.requests.length, 1);
  window.destroy();
  assert.equal(await opened, null);
  const next = f.browser.open(f.parent), newFlow = f.browser.current;
  pending.resolve(connection); await tick();
  assert.equal(f.browser.current, newFlow, 'late data cannot replace or finish the new flow');
  assert.equal(f.windows[1].destroyed, false);
  f.browser.cancel(); await next;
});

test('cancel before a queued read and timeout during a read cannot create stale previews', async () => {
  const pending = deferred(), f = fixture({ readDownload: () => pending.promise });
  const canceled = f.browser.open(f.parent);
  f.download(f.windows[0]);
  f.browser.cancel();
  assert.equal(await canceled, null);
  await tick(); assert.equal(f.requests.length, 0, 'do not consume a one-time ticket after cancellation');
  const timedOut = f.browser.open(f.parent);
  const rejection = assert.rejects(timedOut, /Время подключения истекло/);
  f.download(f.windows[1]); await tick();
  assert.equal(f.requests.length, 1);
  const [timer] = f.timers.values();
  assert.equal(timer.ms, 600000);
  timer.fn(); await rejection;
  pending.resolve(connection); await tick();
  assert.equal(f.browser.current, null);
  assert.equal(f.windows[1].destroyed, true);
});

test('sync and async download errors stay generic and clean up the isolated browser', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture({ readDownload: () => { if (asynchronous) return Promise.reject(new Error(source.url)); throw new Error(source.url); } });
    const opened = f.browser.open(f.parent);
    const rejected = assert.rejects(opened, error => /Не удалось получить/.test(error.message) && !error.message.includes(token));
    f.download(f.windows[0]);
    await rejected;
    assert.equal(f.browser.current, null);
    assert.equal(f.windows[0].destroyed, true);
    assert.equal(f.timers.size, 0);
  }
});
