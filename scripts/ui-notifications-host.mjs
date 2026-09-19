import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC and an isolated JSONL fixture. CODEX_DESK_TEST disables
// native notification delivery; the service unit tests cover native show/click.
// This script never opens a user window, the installed CLI, or a model turn.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'notifications-host-'));
const project = path.join(runDir, 'PROJECT_NOTIFICATIONS');
const dataDir = path.join(runDir, 'profile');
await Promise.all([project, dataDir].map(directory => mkdir(directory)));
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));
const settingsPath = path.join(dataDir, 'settings.json');
const preferencesPath = path.join(dataDir, 'notifications.json');
const originalSettings = { executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
await writeFile(settingsPath, JSON.stringify(originalSettings));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [], results = [];
const readJson = file => readFile(file, 'utf8').then(JSON.parse);
const logs = async () => (await readFile(path.join(project, 'server.jsonl'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}

async function launch() {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'fixture bootstrap');
  return (await page.evaluate(() => window.codex.getWorkspace())).sessions[0].id;
}

async function closeWindow() {
  const exited = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited;
  app = null;
}

async function expectRejection(method, value, message) {
  const result = await page.evaluate(async ({ method, value }) => {
    try { await window.codex[method](value); return { accepted: true }; }
    catch (error) { return { accepted: false, message: error.message }; }
  }, { method, value });
  assert.equal(result.accepted, false, message);
  assert.ok(result.message, 'IPC rejection includes a useful error');
}

async function focus(focused, minimized = false) {
  await app.evaluate(({ BrowserWindow }, state) => {
    const win = BrowserWindow.getAllWindows()[0];
    // Do not steal desktop focus from the user. Exercise real main event listeners
    // while controlling the two native readbacks they use.
    win.__notificationsFocusOriginal ??= { isFocused: win.isFocused, isMinimized: win.isMinimized };
    win.isFocused = () => state.focused;
    win.isMinimized = () => state.minimized;
    win.emit(state.minimized ? 'minimize' : state.focused ? 'focus' : 'blur');
  }, { focused, minimized });
}

try {
  const sessionId = await launch();
  const defaults = await page.evaluate(() => window.codex.getNotificationSettings());
  assert.equal(defaults.supported, false, 'Native OS notifications are disabled in this test profile');
  assert.deepEqual(defaults.settings, { enabled: true, sound: false, completed: true, question: true, approval: true, error: true });
  assert.deepEqual(await page.evaluate(id => window.codex.forSession(id).getSettings(), sessionId), originalSettings);

  const changed = await page.evaluate(() => window.codex.setNotificationSettings({ sound: true, completed: false, question: false }));
  assert.deepEqual(changed, { supported: false, settings: { ...defaults.settings, sound: true, completed: false, question: false } });
  assert.deepEqual(await readJson(preferencesPath), changed.settings);
  await expectRejection('setNotificationSettings', { sound: 'yes' }, 'Nonboolean preference rejected');
  await expectRejection('setNotificationSettings', { model: 'must-not-change' }, 'CLI settings cannot be written through notification IPC');
  await expectRejection('setNotificationSettings', null, 'Null preference patch rejected');
  assert.deepEqual(await page.evaluate(() => window.codex.getNotificationSettings()), changed);
  assert.deepEqual(await readJson(settingsPath), originalSettings, 'Notification settings leave CLI shell defaults unchanged');
  results.push('real IPC validates and persists notification settings separately from Codex settings');

  await page.evaluate(id => window.codex.setNotificationContext({ activeSessionId: id }), sessionId);
  await page.evaluate(() => window.codex.setNotificationContext({}));
  await expectRejection('setNotificationContext', { activeSessionId: 'not-owned-by-this-window' }, 'Unknown session context rejected');
  await expectRejection('setNotificationContext', { activeSessionId: sessionId, focused: true }, 'Renderer cannot forge the native focus state');
  await expectRejection('setNotificationContext', [], 'Array context rejected');
  const payload = { sessionId, kind: 'completed', eventId: 'completed-1', title: 'Тестовый диалог' };
  for (const kind of ['completed', 'question', 'approval', 'error']) {
    await page.evaluate(event => window.codex.notifySession(event), { ...payload, kind, eventId: `valid-${kind}` });
  }
  await page.evaluate(event => window.codex.notifySession(event), { ...payload, eventId: 'valid-completed' });
  for (const [patch, message] of [
    [{ sessionId: 'not-owned-by-this-window' }, 'Unknown session cannot send a notification'],
    [{ kind: 'unknown' }, 'Unknown notification kind rejected'],
    [{ eventId: '' }, 'Empty event ID rejected'],
    [{ title: 'x'.repeat(161) }, 'Oversized title rejected'],
    [{ title: 'hidden\nline' }, 'Control characters in title rejected'],
    [{ body: 'Arbitrary conversation content' }, 'Only bounded event metadata crosses notification IPC'],
  ]) await expectRejection('notifySession', { ...payload, ...patch }, message);
  results.push('owned session metadata accepted; malformed and foreign session notification/context rejected');

  // A BrowserWindow with the actual production preload but no host registration
  // must not access another window's settings/session, even with its valid UUID.
  const unauthorized = await app.evaluate(async ({ BrowserWindow }, event) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const foreign = new BrowserWindow({ show: false, webPreferences: {
      preload: owner.webContents.getLastWebPreferences().preload,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    try {
      await foreign.loadURL('data:text/html,<title>Unregistered test caller</title>');
      return await foreign.webContents.executeJavaScript(`(async () => {
        const payload = ${JSON.stringify(event)};
        const attempts = [
          () => window.codex.getNotificationSettings(),
          () => window.codex.setNotificationSettings({ sound: false }),
          () => window.codex.getWindowFocus(),
          () => window.codex.setNotificationContext({ activeSessionId: payload.sessionId }),
          () => window.codex.notifySession(payload),
        ];
        return Promise.all(attempts.map(async attempt => {
          try { await attempt(); return { accepted: true }; }
          catch (error) { return { accepted: false, message: error.message }; }
        }));
      })()`);
    } finally { foreign.destroy(); }
  }, payload);
  assert.equal(unauthorized.length, 5);
  assert.ok(unauthorized.every(result => result.accepted === false && result.message), 'Every notification IPC checks window ownership');
  assert.deepEqual(await page.evaluate(() => window.codex.getNotificationSettings()), changed);
  results.push('unregistered renderer cannot use notification IPC even with a valid session UUID');

  await page.evaluate(() => {
    window.__notificationFocusEvents = [];
    window.__notificationActivations = [];
    window.__stopNotificationFocus = window.codex.onWindowFocus(value => window.__notificationFocusEvents.push(value));
    window.__stopNotificationActivation = window.codex.onNotificationActivated(value => window.__notificationActivations.push(value));
  });
  for (const [focused, minimized, expected] of [[false, false, false], [true, false, true], [true, true, false]]) {
    const before = await page.evaluate(() => window.__notificationFocusEvents.length);
    await focus(focused, minimized);
    await waitUntil(async () => (await page.evaluate(() => window.__notificationFocusEvents.length)) > before, 'native focus event through preload');
    assert.equal(await page.evaluate(() => window.__notificationFocusEvents.at(-1)), expected);
    assert.equal(await page.evaluate(() => window.codex.getWindowFocus()), expected);
  }
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('host:notificationActivated', { sessionId: id }), sessionId);
  await waitUntil(async () => (await page.evaluate(() => window.__notificationActivations.length)) === 1, 'activation payload through preload');
  assert.deepEqual(await page.evaluate(() => window.__notificationActivations), [{ sessionId }]);
  const counters = await page.evaluate(() => {
    window.__stopNotificationFocus(); window.__stopNotificationActivation();
    return [window.__notificationFocusEvents.length, window.__notificationActivations.length];
  });
  await focus(false);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('host:notificationActivated', { sessionId: id }), sessionId);
  await page.evaluate(() => window.codex.getWindowFocus());
  assert.deepEqual(await page.evaluate(() => [window.__notificationFocusEvents.length, window.__notificationActivations.length]), counters, 'Preload unsubscribe removes both listeners');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    Object.assign(win, win.__notificationsFocusOriginal);
    delete win.__notificationsFocusOriginal;
    win.emit('focus');
  });
  results.push('native focus/minimize events and activation metadata cross preload; subscriptions clean up');

  // An auxiliary host-owned session is never mounted in React or bootstrapped.
  // Closing it cannot affect the visible tab or start a model request.
  const auxiliary = await page.evaluate(cwd => window.codex.createSession({ cwd }), project);
  await page.evaluate(id => window.codex.setNotificationContext({ activeSessionId: id }), auxiliary.id);
  await page.evaluate(event => window.codex.notifySession(event), { ...payload, sessionId: auxiliary.id, eventId: 'auxiliary' });
  await page.evaluate(id => window.codex.closeSession(id), auxiliary.id);
  await expectRejection('notifySession', { ...payload, sessionId: auxiliary.id }, 'Closed session cannot trigger a notification');
  await expectRejection('setNotificationContext', { activeSessionId: auxiliary.id }, 'Closed session cannot become active');
  await page.evaluate(id => window.codex.setNotificationContext({ activeSessionId: id }), sessionId);
  assert.deepEqual((await page.evaluate(() => window.codex.getWorkspace())).sessions.map(session => session.id), [sessionId]);
  results.push('closing an auxiliary session invalidates its notification/context access and keeps the real tab');

  await closeWindow();
  const restoredSessionId = await launch();
  assert.deepEqual(await page.evaluate(() => window.codex.getNotificationSettings()), changed, 'Preference patch survives ordinary app restart');
  assert.deepEqual(await page.evaluate(id => window.codex.forSession(id).getSettings(), restoredSessionId), originalSettings);
  assert.deepEqual(await readJson(settingsPath), originalSettings);
  await closeWindow();
  const requests = await logs();
  assert.ok(requests.some(entry => entry.method === 'initialize'), 'Actual fixture App Server bootstrapped');
  assert.equal(requests.filter(entry => ['turn/start', 'turn/steer', 'config/batchWrite', 'config/value/write'].includes(entry.method)).length, 0, 'No model requests or Codex config writes');
  assert.deepEqual(errors, []);
  results.push('preferences survive normal restart; CLI defaults preserved; no model calls or Codex config writes');
  const report = { runDir, results, modelCalls: 0, nativeNotifications: false };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`Notification host artifacts: ${runDir}`);
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
