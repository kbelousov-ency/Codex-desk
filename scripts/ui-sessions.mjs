import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Uses the real Electron main/preload/IPC and separate JSONL child processes.
// Only the native folder picker and Codex executable are replaced by fixtures.
const root = process.cwd();
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const runDir = await mkdtemp(path.join(artifacts, 'sessions-'));
const projectA = path.join(runDir, 'PROJECT_A');
const projectB = path.join(runDir, 'PROJECT_B');
const dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, dataDir].map(directory => mkdir(directory)));
await Promise.all([projectA, projectB].map(async directory => {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
}));
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
  executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write',
}));

const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
delete env.CODEX_DESK_TEST;
const app = await electron.launch({
  ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
  cwd: root, env, timeout: 30_000,
});
const errors = [];
const fixturePids = [];
let secondLaunch;
const logFor = async directory => (await readFile(path.join(directory, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const requests = (log, method) => log.filter(entry => entry.method === method);
const modelSelect = page => page.getByRole('combobox', { name: 'Модель', exact: true });
const effortSelect = page => page.getByRole('combobox', { name: 'Глубина размышлений', exact: true });
const accessSelect = page => page.getByRole('combobox', { name: 'Режим доступа', exact: true });
const stopButton = page => page.getByRole('button', { name: 'Остановить выполнение', exact: true });
const newSession = page => page.getByRole('button', { name: 'Новая сессия в другой папке', exact: true });
const streamCount = page => page.evaluate(() => window.__sessionEvents.filter(event => event.type === 'notification' && event.data.method === 'item/agentMessage/delta').length);
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function waitUntil(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(80);
  }
}

async function ready(page, directory) {
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(directory => {
    const model = document.querySelector('select[aria-label="Модель"]');
    return Boolean(window.codex && model && !model.disabled && document.querySelector('.project-card')?.title === directory);
  }, directory);
  assert.equal(await page.locator('.project-card').getAttribute('title'), directory);
  const bootstrap = await page.evaluate(async () => {
    window.__sessionEvents = [];
    window.codex.onEvent(event => window.__sessionEvents.push(event));
    return window.codex.start();
  });
  assert.equal(bootstrap.cwd, directory);
  assert.equal(bootstrap.initialize.fixtureCwd, directory);
  fixturePids.push(bootstrap.initialize.fixturePid);
  return bootstrap.initialize.fixturePid;
}

async function send(page, text, marker) {
  await page.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await stopButton(page).waitFor({ state: 'visible' });
  await page.getByText(`Разрешение только для ${marker}`, { exact: true }).waitFor({ state: 'visible' });
  await waitUntil(async () => await streamCount(page) > 0, `${marker} stream started`);
}

async function assertSettings(page, expected) {
  const settings = await page.evaluate(() => window.codex.getSettings());
  for (const [key, value] of Object.entries(expected)) assert.equal(settings[key], value, `Window setting ${key}`);
  assert.equal(await page.locator('.project-card').getAttribute('title'), expected.cwd);
  assert.equal(await modelSelect(page).inputValue(), expected.model);
  assert.equal(await effortSelect(page).inputValue(), expected.effort);
  assert.equal(await accessSelect(page).inputValue(), expected.access);
}

try {
  const pageA = await app.firstWindow();
  const pidA = await ready(pageA, projectA);
  await pageA.getByRole('button', { name: 'История PROJECT_A', exact: true }).waitFor();
  await send(pageA, 'Разработка проекта PROJECT_A', 'PROJECT_A');
  assert.equal(await newSession(pageA).isEnabled(), true, 'Creating another session is allowed while working');
  assert.equal(await pageA.getByRole('button', { name: 'Новый диалог', exact: false }).isDisabled(), true);
  await pageA.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Черновик только PROJECT_A');

  // Cancellation must not create an empty window or disturb the active turn.
  await app.evaluate(({ dialog }) => {
    globalThis.__sessionDialogs = [];
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__sessionDialogs.push({ owner: owner.id, defaultPath: options.defaultPath });
      return { canceled: true, filePaths: [] };
    };
  });
  await newSession(pageA).click();
  await waitUntil(async () => await app.evaluate(() => globalThis.__sessionDialogs.length) === 1 && await newSession(pageA).isEnabled(), 'cancelled folder selection');
  assert.equal(app.windows().length, 1);
  assert.equal(await stopButton(pageA).isVisible(), true);

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__sessionDialogs.push({ owner: owner.id, defaultPath: options.defaultPath });
      return { canceled: false, filePaths: [directory] };
    };
  }, projectB);
  const nextWindow = app.waitForEvent('window');
  await newSession(pageA).click();
  const pageB = await nextWindow;
  const pidB = await ready(pageB, projectB);
  assert.notEqual(pidA, pidB, 'Each window must own a different App Server process');
  assert.ok(isAlive(pidA) && isAlive(pidB));
  const dialogs = await app.evaluate(() => globalThis.__sessionDialogs);
  assert.equal(dialogs[1].owner, dialogs[0].owner, 'The native folder picker belongs to the originating window');
  assert.equal(dialogs[1].defaultPath, projectA);
  assert.equal(await pageB.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), '');
  await pageB.getByRole('button', { name: 'История PROJECT_B', exact: true }).waitFor();
  assert.equal(await pageB.getByRole('button', { name: 'История PROJECT_A', exact: true }).count(), 0);
  assert.equal(await pageA.getByRole('button', { name: 'История PROJECT_B', exact: true }).count(), 0);
  await modelSelect(pageB).selectOption('fixture-beta');
  await effortSelect(pageB).selectOption('medium');
  await accessSelect(pageB).selectOption('auto');
  await send(pageB, 'Исправление постпроцессора PROJECT_B', 'PROJECT_B');

  const settingsA = { cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
  const settingsB = { cwd: projectB, model: 'fixture-beta', effort: 'medium', access: 'auto' };
  await assertSettings(pageA, settingsA);
  await assertSettings(pageB, settingsB);
  assert.equal(await pageA.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), 'Черновик только PROJECT_A');
  assert.equal(await stopButton(pageA).isVisible(), true);
  assert.equal(await stopButton(pageB).isVisible(), true);
  assert.equal(await pageA.locator('.assistant-message').filter({ hasText: 'PROJECT_B' }).count(), 0);
  assert.equal(await pageB.locator('.assistant-message').filter({ hasText: 'PROJECT_A' }).count(), 0);
  const eventsA = await pageA.evaluate(() => window.__sessionEvents);
  const eventsB = await pageB.evaluate(() => window.__sessionEvents);
  for (const [events, otherMarker] of [[eventsA, 'PROJECT_B'], [eventsB, 'PROJECT_A']]) {
    assert.ok(events.some(event => event.type === 'serverRequest' && event.data.id === 'shared-approval'));
    assert.equal(JSON.stringify(events).includes(otherMarker), false, 'Bridge events must not leak between windows with identical protocol IDs');
  }

  // Identical request IDs must be routed to the process that owns each window.
  await pageA.getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await pageA.getByText('Разрешение только для PROJECT_A', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await pageB.getByText('Разрешение только для PROJECT_B', { exact: true }).isVisible(), true);
  await pageB.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await pageB.getByText('Разрешение только для PROJECT_B', { exact: true }).waitFor({ state: 'hidden' });
  await waitUntil(async () => (await logFor(projectA)).some(entry => entry.id === 'shared-approval' && entry.result), 'A approval recorded');
  await waitUntil(async () => (await logFor(projectB)).some(entry => entry.id === 'shared-approval' && entry.result), 'B approval recorded');
  const logA = await logFor(projectA);
  const logB = await logFor(projectB);
  assert.deepEqual(logA.filter(entry => entry.id === 'shared-approval').map(entry => entry.result), [{ decision: 'accept' }]);
  assert.deepEqual(logB.filter(entry => entry.id === 'shared-approval').map(entry => entry.result), [{ decision: 'decline' }]);
  for (const [log, settings, reviewer] of [[logA, settingsA, 'user'], [logB, settingsB, 'auto_review']]) {
    const started = requests(log, 'turn/start')[0].params;
    assert.equal(started.cwd, settings.cwd);
    assert.equal(started.model, settings.model);
    assert.equal(started.effort, settings.effort);
    assert.equal(started.approvalsReviewer, reviewer);
    assert.deepEqual(started.sandboxPolicy.writableRoots, [settings.cwd]);
    assert.equal(requests(log, 'thread/start')[0].params.cwd, settings.cwd);
    assert.ok(requests(log, 'thread/list').every(entry => entry.params.cwd === settings.cwd));
  }

  // Stop and reconnect A after B changed its preferences. B must keep streaming.
  await stopButton(pageA).click();
  await stopButton(pageA).waitFor({ state: 'hidden' });
  assert.equal(await stopButton(pageB).isVisible(), true);
  const beforeReconnect = await streamCount(pageB);
  await pageA.getByRole('button', { name: 'Настройки', exact: true }).click();
  await pageA.getByRole('button', { name: 'Переподключить', exact: true }).click();
  await pageA.waitForFunction(() => !document.querySelector('select[aria-label="Модель"]').disabled);
  await pageA.getByRole('button', { name: 'Готово', exact: false }).click();
  await assertSettings(pageA, settingsA);
  await assertSettings(pageB, settingsB);
  await waitUntil(async () => await streamCount(pageB) > beforeReconnect, 'B continues through A reconnect');
  assert.equal(requests(await logFor(projectB), 'turn/interrupt').length, 0);

  await send(pageA, 'Второй запрос PROJECT_A', 'PROJECT_A');
  await pageA.screenshot({ path: path.join(runDir, 'session-a.png') });
  await pageB.screenshot({ path: path.join(runDir, 'session-b.png') });
  const beforeClose = await streamCount(pageB);
  await pageA.close();
  await waitUntil(() => !isAlive(pidA), 'closing A stops only its App Server');
  assert.ok(isAlive(pidB), 'B App Server survives closing A');
  assert.equal(await stopButton(pageB).isVisible(), true);
  await waitUntil(async () => await streamCount(pageB) > beforeClose, 'B keeps streaming after A closes');
  await assertSettings(pageB, settingsB);
  assert.equal(requests(await logFor(projectB), 'turn/interrupt').length, 0);

  // A genuine second application process must hand off to this profile's main
  // process, which opens another independent window instead of focusing B.
  const relaunchSettings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  const relaunchedWindow = app.waitForEvent('window', { timeout: 15_000 });
  const applicationExecutable = await app.evaluate(() => process.execPath);
  secondLaunch = spawn(applicationExecutable, process.env.CODEX_DESK_PACKAGED ? [] : ['.'], {
    cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherOutput = [];
  secondLaunch.stdout.on('data', chunk => launcherOutput.push(String(chunk)));
  secondLaunch.stderr.on('data', chunk => launcherOutput.push(String(chunk)));
  const relaunchedExit = new Promise((resolve, reject) => {
    secondLaunch.once('error', reject);
    secondLaunch.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let pageC;
  try { pageC = await relaunchedWindow; }
  catch (error) {
    console.error('Second launch diagnostics:', { executable: applicationExecutable, exitCode: secondLaunch.exitCode, output: launcherOutput.join('') });
    throw error;
  }
  const pidC = await ready(pageC, relaunchSettings.cwd);
  assert.notEqual(pidC, pidB);
  assert.equal(app.windows().length, 2, 'Second launch adds a window in the existing main process');
  await assertSettings(pageC, relaunchSettings);
  const launchExit = await Promise.race([
    relaunchedExit,
    delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Second application process did not exit after handing off'); }),
  ]);
  assert.equal(launchExit.code, 0);
  assert.equal(await stopButton(pageB).isVisible(), true);
  const beforeRelaunchClose = await streamCount(pageB);
  await pageC.close();
  await waitUntil(() => !isAlive(pidC), 'closing the relaunched window stops its process');
  await waitUntil(async () => await streamCount(pageB) > beforeRelaunchClose, 'B keeps streaming through a real second launch and close');
  await assertSettings(pageB, settingsB);
  assert.equal(requests(await logFor(projectB), 'turn/interrupt').length, 0);

  await stopButton(pageB).click();
  await stopButton(pageB).waitFor({ state: 'hidden' });
  assert.equal(requests(await logFor(projectB), 'turn/interrupt').length, 1);
  await pageB.getByText('Выполнение остановлено. Можно продолжить диалог.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS: independent Electron windows, App Server PIDs ${pidA}/${pidB}/${pidC}, cwd/history/drafts/model/effort/access, concurrent streaming, colliding IDs, approvals, reconnect, interruption, closing one active session, and a real second application launch. No model requests. Artifacts: ${runDir}`);
} finally {
  if (secondLaunch && secondLaunch.exitCode === null && secondLaunch.signalCode === null) secondLaunch.kill();
  await app.close();
  await waitUntil(() => fixturePids.every(pid => !isAlive(pid)), 'test App Server cleanup');
}
