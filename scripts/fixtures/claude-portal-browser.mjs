import { app, BrowserWindow } from 'electron';
import { ClaudePortalBrowser } from '../../electron/claude-portal-browser.mjs';
import { downloadClaudeInstallerConfig } from '../../electron/claude-portal-import.mjs';
import { PORTAL_ORIGIN } from '../../electron/router-portal.mjs';

// Standalone, hidden Electron host. All HTTPS is answered in memory; no portal login or model.
app.setPath('userData', process.env.CLAUDE_PORTAL_BROWSER_PROFILE);
app.on('window-all-closed', () => {});
void app.whenReady().then(() => {

const token = 'z'.repeat(43);
const installerUrl = `${PORTAL_ORIGIN}/api/connect/claude/${token}.exe`;
const filename = `claude-connect-${token}.exe`;
const state = globalThis.portalBrowserFixture = { windows: [], requests: [], downloads: [], scripts: [], result: undefined, error: null };
const browser = new ClaudePortalBrowser({
  createWindow: options => {
    const window = new BrowserWindow({ ...options, show: false });
    state.windows.push(window);
    const session = window.webContents.session;
    session.protocol.handle('https', request => {
      state.requests.push(request.url);
      const url = new URL(request.url);
      if (url.href === installerUrl) return new Response('MZ-fixture-never-launched', {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
      if (url.origin === PORTAL_ORIGIN || url.origin === 'https://sso.example.test') {
        return new Response(`<!doctype html><html><body><h1>Local portal fixture</h1>
          <a id="sso" target="_blank" href="https://sso.example.test/login">SSO</a>
          <a id="download" href="${installerUrl}">Connect Claude</a>
          </body></html>`, { headers: { 'Content-Type': 'text/html' } });
      }
      return new Response('Fixture blocked unexpected URL', { status: 403 });
    });
    session.on('will-download', (event, item) => {
      const entry = { filename: item.getFilename(), url: item.getURL() };
      state.downloads.push(entry);
      queueMicrotask(() => { entry.prevented = event.defaultPrevented; });
    });
    return window;
  },
  readDownload: ({ url }) => downloadClaudeInstallerConfig(url, { fetchImpl: async (target, options) => {
    state.scripts.push({ url: target, redirect: options.redirect, credentials: options.credentials });
    if (target !== installerUrl.replace(/\.exe$/, '.ps1')) throw new Error('Unexpected script URL');
    const env = { ANTHROPIC_BASE_URL: 'https://router.example.test/claude', ANTHROPIC_AUTH_TOKEN: 'synthetic-portal-key',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-fixture', NODE_OPTIONS: '--require never-applied.js' };
    return new Response(`$envJson = @'\n${JSON.stringify(env)}\n'@\nthrow 'never executed'`, { headers: { 'Content-Type': 'text/plain' } });
  } }),
});
state.browser = browser;
state.start = () => {
  state.result = undefined; state.error = null;
  state.promise = browser.open(null).then(result => { state.result = result; }, error => { state.error = error.message; });
};
state.start();
});
