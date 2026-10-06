import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const profile = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-portal-browser-host-'));
const env = { ...process.env, CLAUDE_PORTAL_BROWSER_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [path.join(root, 'scripts', 'fixtures', 'claude-portal-browser.mjs')], cwd: root, env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.locator('#sso').waitFor();
  const capabilities = await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: typeof window.codex }));
  assert.deepEqual(capabilities, { require: 'undefined', process: 'undefined', bridge: 'undefined' });
  const options = await app.evaluate(() => {
    const contents = globalThis.portalBrowserFixture.windows[0].webContents;
    const preferences = contents.getLastWebPreferences();
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox, webSecurity: preferences.webSecurity, persistent: contents.session.isPersistent() };
  });
  assert.deepEqual(options, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, persistent: false });
  await page.locator('#sso').click();
  await page.waitForURL('https://sso.example.test/login');
  assert.equal(await app.evaluate(() => globalThis.portalBrowserFixture.windows.length), 1);
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  await page.locator('#download').click({ noWaitAfter: true });
  const result = await app.evaluate(async () => {
    const state = globalThis.portalBrowserFixture;
    await state.promise;
    return { config: state.result, error: state.error, downloads: state.downloads, scripts: state.scripts,
      destroyed: state.windows[0].isDestroyed() };
  });
  assert.equal(result.error, null);
  assert.equal(result.config.apiKey, 'synthetic-portal-key');
  assert.deepEqual(result.config.modelAliases, { sonnet: 'cc/claude-sonnet-fixture' });
  assert.equal(Object.hasOwn(result.config, 'NODE_OPTIONS'), false);
  assert.equal(result.downloads.length, 1);
  assert.equal(result.downloads[0].prevented, true, 'actual Electron download was cancelled before saving or executing');
  assert.equal(result.scripts.length, 1);
  assert.equal(result.scripts[0].redirect, 'error');
  assert.equal(result.scripts[0].credentials, 'omit');
  assert.equal(result.destroyed, true);
  console.log('Claude portal browser host: sandbox, HTTPS SSO navigation, intercepted download, static import and cleanup passed.');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
