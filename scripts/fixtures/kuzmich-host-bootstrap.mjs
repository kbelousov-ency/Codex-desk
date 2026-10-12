import assert from 'node:assert/strict';
import path from 'node:path';
import { app, session, shell } from 'electron';

const root = process.env.SETUP_FIXTURE_ROOT;
assert.ok(root && path.isAbsolute(root));
for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_DESK_DATA_DIR', 'TEMP', 'TMP']) {
  const relative = path.relative(root, process.env[name] || '');
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), name);
}
app.setPath('home', process.env.USERPROFILE);
app.setPath('appData', process.env.APPDATA);
app.setPath('temp', process.env.TEMP);
globalThis.kuzmichSmoke = { requests: [], network: [], violations: [], rendererErrors: [], windows: 0 };
app.on('browser-window-created', () => globalThis.kuzmichSmoke.windows++);
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, details) => {
    if (details.level === 'error') globalThis.kuzmichSmoke.rendererErrors.push(details.message);
  });
  contents.on('render-process-gone', () => globalThis.kuzmichSmoke.rendererErrors.push('Renderer process gone'));
});
shell.openExternal = async () => {
  globalThis.kuzmichSmoke.violations.push('openExternal');
  throw new Error('External navigation forbidden in signed-out smoke');
};
function allowed(url, method) {
  const target = new URL(url);
  if (['file:', 'data:', 'devtools:', 'chrome-extension:'].includes(target.protocol)) return true;
  return method === 'GET' && target.origin === 'https://coder-portal.encycam.com'
    && ['/api/me', '/api/key'].includes(target.pathname) && !target.search && !target.username && !target.password;
}
const guarded = new WeakSet();
function guard(ses) {
  if (guarded.has(ses)) return;
  guarded.add(ses);
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!allowed(details.url, details.method)) {
      globalThis.kuzmichSmoke.violations.push('Forbidden network destination or method');
      callback({ cancel: true });
    } else callback({});
  });
  ses.webRequest.onCompleted(details => {
    if (/^https?:/.test(details.url)) globalThis.kuzmichSmoke.network.push({ path: new URL(details.url).pathname, method: details.method, status: details.statusCode });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (/^https?:/.test(details.url) && details.statusCode !== 401) {
      globalThis.kuzmichSmoke.violations.push('Unexpected Portal HTTP status: ' + details.statusCode);
      callback({ cancel: true });
    } else callback({});
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const sensitive = Object.keys(details.requestHeaders).some(name => /^(cookie|authorization)$/i.test(name));
    const external = /^https?:/.test(details.url);
    if (!allowed(details.url, details.method) || (external && sensitive)) {
      globalThis.kuzmichSmoke.violations.push('Forbidden network request');
      callback({ cancel: true });
    } else callback({ requestHeaders: details.requestHeaders });
  });
  const original = ses.fetch.bind(ses);
  ses.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (!allowed(String(url), method)) {
      globalThis.kuzmichSmoke.violations.push('Forbidden session.fetch');
      throw new Error('Unexpected session.fetch');
    }
    assert.equal(options.redirect, 'error');
    const row = { path: new URL(url).pathname, method };
    globalThis.kuzmichSmoke.requests.push(row);
    try {
      const response = await original(url, options);
      row.status = response.status;
      return response;
    } catch (error) {
      row.networkFailure = true;
      throw error;
    }
  };
}
app.on('session-created', guard);
app.whenReady().then(() => guard(session.defaultSession));
await import('./electron/main.mjs');
