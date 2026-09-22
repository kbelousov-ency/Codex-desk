import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC with an isolated profile and a local JSONL CLI.
// Online metadata/download validation is covered by the service unit tests.
// This test never contacts GitHub, opens a browser, or requests a model turn.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'app-updates-host-'));
const project = path.join(runDir, 'PROJECT_APP_UPDATES');
const dataDir = path.join(runDir, 'profile');
await Promise.all([project, dataDir].map(directory => mkdir(directory)));
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));
const settingsPath = path.join(dataDir, 'settings.json');
const preferencesPath = path.join(dataDir, 'updates.json');
const originalSettings = { provider: 'codex', executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
const originalSettingsText = JSON.stringify({ ...originalSettings, providers: { codex: { cwd: project, model: originalSettings.model, effort: originalSettings.effort, access: originalSettings.access, executable: originalSettings.executable } } }, null, 2);
await writeFile(settingsPath, originalSettingsText);
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [], results = [], networkAttempts = [], browserAttempts = [];
const readJson = file => readFile(file, 'utf8').then(JSON.parse);
const logs = async () => (await readFile(path.join(project, 'server.jsonl'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const ipcMethods = ['getAppUpdateStatus', 'checkAppUpdates', 'setAppUpdatePreferences', 'openAppUpdateDownload'];

async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}

async function launch() {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  await app.evaluate(({ session, shell }) => {
    globalThis.__appUpdatesNetworkAttempts = [];
    globalThis.__appUpdatesBrowserAttempts = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.__appUpdatesNetworkAttempts.push(details.url);
      callback({ cancel: true });
    });
    // A regression must never open a real browser while this host test runs.
    shell.openExternal = async url => { globalThis.__appUpdatesBrowserAttempts.push(url); };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'fixture bootstrap');
  return (await page.evaluate(() => window.codex.getWorkspace())).sessions[0].id;
}

async function closeWindow() {
  const attempts = await app.evaluate(() => ({ network: globalThis.__appUpdatesNetworkAttempts, browser: globalThis.__appUpdatesBrowserAttempts }));
  networkAttempts.push(...attempts.network);
  browserAttempts.push(...attempts.browser);
  const exited = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited;
  app = null;
}

async function expectRejection(method, value, label) {
  const result = await page.evaluate(async ({ method, value }) => {
    try { await window.codex[method](value); return { accepted: true }; }
    catch (error) { return { accepted: false, message: error.message }; }
  }, { method, value });
  assert.equal(result.accepted, false, label);
  assert.ok(result.message, 'IPC rejection includes a useful error');
}

function assertDisabled(status, info) {
  assert.equal(status.currentVersion, info.version, 'Updater and build badge report the same version');
  assert.equal(status.channel, info.channel, 'Updater and build badge report the same channel');
  assert.equal(status.supported, false, 'Test profiles cannot check online, including packaged stable');
  assert.equal(status.phase, 'disabled', 'Unsupported/test profile is explicitly disabled');
  assert.equal(status.downloadUrl, undefined, 'No unvalidated installer URL is exposed');
}

try {
  const sessionId = await launch();
  const info = await page.evaluate(() => window.codex.getBuildInfo());
  const defaults = await page.evaluate(() => window.codex.getAppUpdateStatus());
  assertDisabled(defaults, info);
  assert.equal(defaults.enabled, true, 'Automatic checking is enabled by default for supported releases');
  const runtimeVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(info.version, runtimeVersion, 'Update version agrees with Electron package version');
  assert.deepEqual(await page.evaluate(id => window.codex.forSession(id).getSettings(), sessionId), originalSettings);
  assertDisabled(await page.evaluate(() => window.codex.checkAppUpdates()), info);
  await expectRejection('openAppUpdateDownload', undefined, 'Download requires a validated available release');
  await expectRejection('openAppUpdateDownload', 'https://invalid.example/foreign.exe', 'Renderer cannot supply an installer URL');
  results.push('real preload/IPC reports the build version and disables online checks in the isolated profile');

  await page.evaluate(() => {
    window.__appUpdateEvents = [];
    window.__stopAppUpdateEvents = window.codex.onAppUpdateStatus(status => window.__appUpdateEvents.push(status));
  });
  const skippedVersion = '999.0.0';
  const changed = await page.evaluate(skippedVersion => window.codex.setAppUpdatePreferences({ enabled: false, skippedVersion }), skippedVersion);
  assertDisabled(changed, info);
  assert.equal(changed.enabled, false);
  assert.equal(changed.skippedVersion, skippedVersion);
  assert.deepEqual(await readJson(preferencesPath), { enabled: false, skippedVersion });
  await waitUntil(async () => (await page.evaluate(() => window.__appUpdateEvents.at(-1)))?.skippedVersion === skippedVersion, 'saved preferences broadcast through preload');
  assert.deepEqual(await page.evaluate(() => window.__appUpdateEvents.at(-1)), changed);
  const preferencesBeforeInvalid = await readFile(preferencesPath, 'utf8');
  for (const [value, label] of [
    [null, 'Null preference patch rejected'],
    [[], 'Array preference patch rejected'],
    [{ enabled: 'yes' }, 'Nonboolean enabled rejected'],
    [{ skippedVersion: 2 }, 'Nonstring skipped version rejected'],
    [{ skippedVersion: 'not-a-version' }, 'Malformed skipped version rejected'],
    [{ model: 'must-not-change' }, 'CLI settings cannot be written through updater IPC'],
    [{ downloadUrl: 'https://invalid.example/foreign.exe' }, 'Renderer cannot inject an installer URL'],
    [{ supported: true }, 'Renderer cannot enable unsupported updates'],
  ]) await expectRejection('setAppUpdatePreferences', value, label);
  assert.deepEqual(await page.evaluate(() => window.codex.getAppUpdateStatus()), changed, 'Rejected changes leave current preferences intact');
  assert.equal(await readFile(preferencesPath, 'utf8'), preferencesBeforeInvalid, 'Rejected changes leave persisted preferences intact');
  assert.equal(await readFile(settingsPath, 'utf8'), originalSettingsText, 'Update preferences do not rewrite CLI settings');
  results.push('preferences validate and persist in updates.json; malformed input cannot alter state or CLI defaults');

  const unauthorized = await app.evaluate(async ({ app, BrowserWindow }, methods) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: {
      preload: `${app.getAppPath()}/electron/preload.cjs`,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    try {
      await foreign.loadURL('data:text/html,<title>Unregistered updater test caller</title>');
      return await foreign.webContents.executeJavaScript(`(async () => {
        const methods = ${JSON.stringify(methods)};
        return Promise.all(methods.map(async method => {
          try {
            await window.codex[method](method === 'setAppUpdatePreferences' ? { enabled: true } : undefined);
            return { method, accepted: true };
          } catch (error) { return { method, accepted: false, message: error.message }; }
        }));
      })()`);
    } finally { foreign.destroy(); }
  }, ipcMethods);
  assert.equal(unauthorized.length, ipcMethods.length);
  for (const result of unauthorized) {
    assert.equal(result.accepted, false, `Unregistered renderer cannot call ${result.method}`);
    assert.match(result.message, /Недопустимый источник запроса/, `${result.method} rejects at the ownership guard`);
  }
  // Exercise the actual registered handlers: a renderer subframe must be denied
  // before a disabled-service response or argument validation can hide a leak.
  const subframe = await app.evaluate(async ({ ipcMain, BrowserWindow }, methods) => {
    const owner = BrowserWindow.getAllWindows()[0];
    return Promise.all(methods.map(async method => {
      const handler = ipcMain._invokeHandlers.get(`host:${method}`);
      if (!handler) throw new Error(`Missing IPC handler: ${method}`);
      try {
        await handler({ sender: owner.webContents, senderFrame: {} }, method === 'setAppUpdatePreferences' ? { enabled: true } : undefined);
        return { method, accepted: true };
      } catch (error) { return { method, accepted: false, message: error.message }; }
    }));
  }, ipcMethods);
  for (const result of subframe) {
    assert.equal(result.accepted, false, `Subframe cannot call ${result.method}`);
    assert.match(result.message, /Недопустимый источник запроса/, `${result.method} rejects at the frame guard`);
  }
  assert.deepEqual(await page.evaluate(() => window.codex.getAppUpdateStatus()), changed);
  results.push('every update IPC checks registered window ownership and the main-frame boundary');

  const eventCount = await page.evaluate(() => { window.__stopAppUpdateEvents(); return window.__appUpdateEvents.length; });
  const cleared = await page.evaluate(() => window.codex.setAppUpdatePreferences({ enabled: true, skippedVersion: null }));
  assertDisabled(cleared, info);
  assert.equal(cleared.enabled, true);
  assert.ok(cleared.skippedVersion == null, 'Explicit null clears the skipped version');
  await page.evaluate(() => window.codex.getAppUpdateStatus());
  assert.equal(await page.evaluate(() => window.__appUpdateEvents.length), eventCount, 'Preload unsubscribe removes the listener');
  const persisted = await page.evaluate(skippedVersion => window.codex.setAppUpdatePreferences({ enabled: false, skippedVersion }), skippedVersion);
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.skippedVersion, skippedVersion);
  assertDisabled(await page.evaluate(() => window.codex.checkAppUpdates()), info);
  results.push('preference events cross preload; unsubscribe cleans up; explicit null clears a skipped version');

  await closeWindow();
  const restoredSessionId = await launch();
  const restored = await page.evaluate(() => window.codex.getAppUpdateStatus());
  assertDisabled(restored, info);
  assert.equal(restored.enabled, false, 'Disabled preference survives ordinary restart');
  assert.equal(restored.skippedVersion, skippedVersion, 'Skipped version survives ordinary restart');
  assert.deepEqual(await readJson(preferencesPath), { enabled: false, skippedVersion });
  assert.deepEqual(await page.evaluate(id => window.codex.forSession(id).getSettings(), restoredSessionId), originalSettings);
  assert.equal(await readFile(settingsPath, 'utf8'), originalSettingsText);
  assertDisabled(await page.evaluate(() => window.codex.checkAppUpdates()), info);
  await expectRejection('openAppUpdateDownload', undefined, 'Restart cannot create a validated installer URL');
  await closeWindow();
  const requests = await logs();
  assert.ok(requests.some(entry => entry.method === 'initialize'), 'Actual fixture App Server bootstrapped');
  assert.equal(requests.filter(entry => ['turn/start', 'turn/steer', 'config/batchWrite', 'config/value/write'].includes(entry.method)).length, 0, 'No model requests or Codex config writes');
  assert.deepEqual(networkAttempts, [], 'Disabled update service makes no online requests');
  assert.deepEqual(browserAttempts, [], 'Unvalidated update never opens a browser');
  assert.deepEqual(errors, []);
  results.push('normal restart restores preferences; CLI defaults stay intact; no network, browser, model calls or Codex config writes');
  const report = { runDir, results, build: info, packaged: Boolean(process.env.CODEX_DESK_PACKAGED), modelCalls: 0, networkAttempts, browserAttempts };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`App update host artifacts: ${runDir}`);
  throw error;
} finally {
  if (app) await closeWindow().catch(() => app?.close().catch(() => {}));
}
