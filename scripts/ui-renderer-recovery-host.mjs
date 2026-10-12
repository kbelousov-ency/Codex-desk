import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// A crashed renderer leaves a black window the relaunched app only refocuses, because the
// main process still holds the single-instance lock. Real Electron/preload/IPC, no model calls.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'renderer-recovery-host-'));
const project = path.join(runDir, 'PROJECT');
const dataDir = path.join(runDir, 'profile');
await Promise.all([project, dataDir].map(directory => mkdir(directory)));
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
const statePath = path.join(dataDir, 'workspace-state.json');
const logPath = path.join(dataDir, 'logs');
let app, page;
const errors = [], results = [];
const view = () => page.locator('.session-view:visible');
const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
const disk = () => readFile(statePath, 'utf8').then(JSON.parse);
async function waitUntil(check, label) {
  const deadline = Date.now() + 20000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Timed out: ' + label); await delay(50); }
}
function bind(target) {
  page = target; page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
}
async function ready() {
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor({ state: 'attached' });
  await waitUntil(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'active connection ready');
}
/** Answer the recovery prompt without a human, and keep what it said for assertions. */
async function answerRecoveryWith(response) {
  await app.evaluate(({ dialog }, choice) => {
    globalThis.__recoveryPrompts = [];
    dialog.showMessageBox = async (_parent, options) => {
      globalThis.__recoveryPrompts.push({ message: options.message, buttons: options.buttons });
      return { response: choice };
    };
  }, response);
}
const prompts = () => app.evaluate(() => globalThis.__recoveryPrompts ?? []);
const crashRenderer = () => app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
}).catch(() => {});
async function recoveryEvents() {
  const names = (await readdir(logPath).catch(() => [])).filter(name => name.endsWith('.jsonl'));
  const lines = await Promise.all(names.map(name => readFile(path.join(logPath, name), 'utf8').catch(() => '')));
  return lines.flatMap(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    .filter(entry => ['window.rendererGone', 'window.recovery'].includes(entry.event));
}

try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  bind(await app.firstWindow());
  await ready();

  await input().fill('Draft that must survive the crash');
  await waitUntil(async () => (await disk().catch(() => null))?.tabs[0]?.draft === 'Draft that must survive the crash', 'draft autosaved before the crash');

  // "Перезагрузить" must rebuild the workspace in place of the dead window.
  await answerRecoveryWith(0);
  const rebuilt = app.waitForEvent('window');
  await crashRenderer();
  bind(await rebuilt);
  await ready();
  assert.equal(await input().inputValue(), 'Draft that must survive the crash');
  const asked = await prompts();
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /не хватило памяти|аварийно завершился/);
  assert.deepEqual(asked[0].buttons, ['Перезагрузить', 'Закрыть']);
  results.push('crashed renderer is replaced by a live window restored from the last autosave');

  await waitUntil(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'dead window destroyed after the rebuild');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()), false);
  results.push('the corpse window is dropped, so a relaunch can no longer focus it');

  // The rebuilt window owns a working session: the app is usable, not just painted.
  await input().fill('Typed into the rebuilt window');
  await waitUntil(async () => (await disk().catch(() => null))?.tabs[0]?.draft === 'Typed into the rebuilt window', 'rebuilt window autosaves again');
  results.push('rebuilt window has live IPC and resumes autosaving');

  // "Закрыть" must end the app rather than strand a black window.
  await answerRecoveryWith(1);
  const closed = app.waitForEvent('close');
  await crashRenderer();
  await closed;
  const events = await recoveryEvents();
  app = null;
  assert.deepEqual(events.filter(entry => entry.event === 'window.recovery').map(entry => entry.data.action), ['reload', 'close']);
  assert.equal(events.filter(entry => entry.event === 'window.rendererGone').length, 2);
  results.push('declining the prompt quits instead of leaving a dead window behind');

  assert.deepEqual(errors, []);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify({ runDir, results }, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
}
