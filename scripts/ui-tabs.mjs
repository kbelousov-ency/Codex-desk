import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron main/preload/IPC and one JSONL child process per dialogue.
// The native folder picker and the Codex executable are the only substitutes;
// no model/provider requests are made, and the user's profile is never opened.
const root = process.cwd();
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const runDir = await mkdtemp(path.join(artifacts, 'tabs-'));
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
const launch = () => electron.launch({
  ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
  cwd: root, env, timeout: 30_000,
});
let app;
let page;
const errors = [];
const fixturePids = new Set();
const logFor = async directory => (await readFile(path.join(directory, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const requests = (log, method, pid) => log.filter(entry => entry.method === method && (pid === undefined || entry.pid === pid));
const view = () => page.locator('.session-view:visible');
const modelSelect = () => view().getByRole('combobox', { name: 'Модель', exact: true });
const effortSelect = () => view().getByRole('combobox', { name: 'Глубина размышлений', exact: true });
const accessSelect = () => view().getByRole('combobox', { name: 'Режим доступа', exact: true });
const selectValue = async (trigger, value) => { await trigger.click(); await page.getByRole('listbox', { name: await trigger.getAttribute('aria-label'), exact: true }).locator(`[role="option"][data-value="${value}"]`).click(); };
const stopButton = () => view().getByRole('button', { name: 'Остановить выполнение', exact: true });
const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
const addFolder = () => view().getByRole('button', { name: 'Новый проект', exact: true }).first();
const newChat = () => page.getByRole('button', { name: 'Открыть новый диалог', exact: true });
const projectCard = directory => view().locator('.project-tree').getByTitle(directory, { exact: true });
const projectRow = directory => projectCard(directory).locator('xpath=../..');
const tab = id => page.locator(`.session-tab[data-session-id="${id}"]`);
const activeId = () => page.getByRole('tab', { selected: true }).evaluate(element => element.closest('[data-session-id]').dataset.sessionId);
const workspace = () => page.evaluate(() => window.codex.getWorkspace());
const streamCount = id => page.evaluate(id => (window.__tabEvents[id] || []).filter(event => event.type === 'notification' && event.data.method === 'item/agentMessage/delta').length, id);
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function waitUntil(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(80);
  }
}

async function installPage(nextPage) {
  page = nextPage;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(async () => await view().count() === 1 && await modelSelect().isEnabled(), 'initial tab ready');
  assert.equal(app.windows().length, 1, 'All sessions share one Electron window');
}

async function ready(id, directory) {
  await waitUntil(async () => await activeId() === id && await modelSelect().isEnabled(), `ready tab ${id}`);
  assert.equal(await projectCard(directory).getAttribute('title'), directory);
  assert.ok((await projectRow(directory).getAttribute('class')).split(' ').includes('active-folder'));
  const bootstrap = await page.evaluate(async id => {
    window.__tabEvents ||= {};
    if (!window.__tabEvents[id]) {
      window.__tabEvents[id] = [];
      window.codex.forSession(id).onEvent(event => window.__tabEvents[id].push(event));
    }
    return window.codex.forSession(id).start();
  }, id);
  assert.equal(bootstrap.cwd, directory);
  assert.equal(bootstrap.initialize.fixtureCwd, directory);
  fixturePids.add(bootstrap.initialize.fixturePid);
  return bootstrap.initialize.fixturePid;
}

async function activate(id) {
  await tab(id).getByRole('tab').click();
  await waitUntil(async () => await activeId() === id && await view().count() === 1, `activate ${id}`);
}

async function send(id, text, marker) {
  assert.equal(await activeId(), id);
  const before = await streamCount(id);
  await composer().fill(text);
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await stopButton().waitFor({ state: 'visible' });
  await view().getByText(`Разрешение только для ${marker}`, { exact: true }).waitFor({ state: 'visible' });
  await waitUntil(async () => await streamCount(id) > before, `${marker} starts streaming`);
}

async function assertSettings(id, expected) {
  const settings = await page.evaluate(id => window.codex.forSession(id).getSettings(), id);
  for (const [key, value] of Object.entries(expected)) assert.equal(settings[key], value, `Session ${id} setting ${key}`);
  assert.equal(await projectCard(expected.cwd).getAttribute('title'), expected.cwd);
  assert.equal(await modelSelect().getAttribute('data-value'), expected.model);
  assert.equal(await effortSelect().getAttribute('data-value'), expected.effort);
  assert.equal(await accessSelect().getAttribute('data-value'), expected.access);
}

async function closeTab(id) {
  await tab(id).getByRole('button', { name: /^Закрыть вкладку / }).click();
}

async function assertLayout() {
  const geometry = await page.evaluate(() => {
    const rect = selector => {
      const element = [...document.querySelectorAll(selector)].find(element => element.getClientRects().length);
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return { height: innerHeight, width: innerWidth, bodyHeight: document.documentElement.scrollHeight,
      tabs: rect('.session-tabs'), composer: rect('.composer-area'), chat: rect('.chat-scroll') };
  });
  assert.ok(geometry.bodyHeight <= geometry.height + 1, 'Multiple tabs must not expand the page beyond the window');
  assert.ok(geometry.composer.bottom <= geometry.height + 1, 'Composer stays inside the window');
  assert.ok(geometry.chat.top >= geometry.tabs.bottom - 1, 'Chat stays below the tab strip');
}

try {
  app = await launch();
  await installPage(await app.firstWindow());
  const idA = await activeId();
  const pidA = await ready(idA, projectA);
  await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).waitFor();
  await send(idA, 'Разработка проекта PROJECT_A', 'PROJECT_A');
  await composer().fill('Черновик только PROJECT_A');
  const clipboardPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await composer().evaluate((element, dataUrl) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0))], 'draft-a.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, clipboardPng);
  await view().locator('.attachments').getByRole('img', { name: 'draft-a.png', exact: true }).waitFor();
  assert.equal(await addFolder().isEnabled(), true, 'A working dialogue does not lock adding a folder');
  assert.equal(await newChat().isEnabled(), true, 'A working dialogue does not lock opening another dialogue');

  // A cancelled picker must leave the active turn and workspace intact.
  await app.evaluate(({ dialog }) => {
    globalThis.__tabDialogs = [];
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__tabDialogs.push({ owner: owner.id, defaultPath: options.defaultPath });
      return { canceled: true, filePaths: [] };
    };
  });
  await addFolder().click();
  await waitUntil(async () => await app.evaluate(() => globalThis.__tabDialogs.length) === 1 && await addFolder().isEnabled(), 'cancelled folder picker');
  assert.equal((await workspace()).sessions.length, 1);
  assert.equal(await activeId(), idA);
  assert.equal(await stopButton().isVisible(), true);

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__tabDialogs.push({ owner: owner.id, defaultPath: options.defaultPath });
      return { canceled: false, filePaths: [directory] };
    };
  }, projectB);
  const beforeB = await streamCount(idA);
  await addFolder().click();
  await waitUntil(async () => (await workspace()).sessions.length === 2 && await activeId() !== idA, 'second folder tab');
  const idB = await activeId();
  const pidB = await ready(idB, projectB);
  assert.notEqual(pidA, pidB, 'Each dialogue owns a separate App Server process');
  assert.equal(app.windows().length, 1, 'Adding a folder does not create a window');
  assert.equal(await view().locator('.folder-toggle').count(), 2);
  const cards = await view().locator('.folder-toggle').evaluateAll(elements => elements.map(element => element.title));
  assert.deepEqual(cards, [projectA, projectB], 'The second folder appears below the first');
  const dialogs = await app.evaluate(() => globalThis.__tabDialogs);
  assert.equal(dialogs[1].owner, dialogs[0].owner);
  assert.equal(dialogs[1].defaultPath, projectA);
  assert.equal(await composer().inputValue(), '');
  await view().getByRole('button', { name: 'История PROJECT_B', exact: true }).waitFor();
  assert.equal(await projectRow(projectB).getByRole('button', { name: 'История PROJECT_A', exact: true }).count(), 0);
  await waitUntil(async () => await streamCount(idA) > beforeB, 'Hidden A continues streaming');
  await selectValue(modelSelect(), 'fixture-beta');
  await selectValue(effortSelect(), 'medium');
  await accessSelect().click(); await view().getByRole('option', { name: /^Одобрять за меня/ }).click();
  await send(idB, 'Исправление постпроцессора PROJECT_B', 'PROJECT_B');
  await composer().fill('Черновик только PROJECT_B');
  const settingsA = { cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
  const settingsB = { cwd: projectB, model: 'fixture-beta', effort: 'medium', access: 'auto' };
  await assertSettings(idB, settingsB);
  assert.equal(await view().locator('.attachments').count(), 0, 'A draft attachment does not appear in B');
  await addFolder().click();
  await waitUntil(async () => await app.evaluate(() => globalThis.__tabDialogs.length) === 3 && await addFolder().isEnabled(), 'selecting existing folder');
  assert.equal((await workspace()).sessions.length, 2, 'Adding the same folder focuses its tab without leaving a spare session');
  assert.equal(await activeId(), idB);
  assert.deepEqual((await workspace()).projects, [projectA, projectB]);

  // New dialogue while B is busy must preserve B and inherit its actual settings.
  const beforeNewChat = await streamCount(idB);
  await newChat().click();
  await waitUntil(async () => (await workspace()).sessions.length === 3 && await activeId() !== idB, 'new dialogue alongside busy B');
  const idDraft = await activeId();
  const pidDraft = await ready(idDraft, projectB);
  assert.notEqual(pidDraft, pidB);
  await assertSettings(idDraft, settingsB);
  assert.equal(await composer().inputValue(), '');
  assert.equal(await stopButton().count(), 0);
  await activate(idB);
  assert.equal(await composer().inputValue(), 'Черновик только PROJECT_B');
  await closeTab(idDraft);
  await waitUntil(async () => (await workspace()).sessions.length === 2 && !isAlive(pidDraft), 'close inactive empty tab');
  assert.equal(await activeId(), idB, 'Closing an inactive tab does not switch the current dialogue');
  await waitUntil(async () => await streamCount(idB) > beforeNewChat, 'B streams through creating/closing a dialogue');

  // Browser tabs activate dialogues; both matching protocol IDs stay isolated.
  await activate(idA);
  await assertSettings(idA, settingsA);
  assert.equal(await composer().inputValue(), 'Черновик только PROJECT_A');
  assert.equal(await view().locator('.attachments').getByRole('img', { name: 'draft-a.png', exact: true }).isVisible(), true, 'A retains its draft attachment while hidden');
  assert.equal(await stopButton().isVisible(), true);
  assert.equal(await view().locator('.assistant-message').filter({ hasText: 'PROJECT_B' }).count(), 0);
  assert.equal(await projectRow(projectA).getByRole('button', { name: 'История PROJECT_B', exact: true }).count(), 0);
  const events = await page.evaluate(() => window.__tabEvents);
  for (const [id, otherMarker] of [[idA, 'PROJECT_B'], [idB, 'PROJECT_A']]) {
    assert.ok(events[id].some(event => event.type === 'serverRequest' && event.data.id === 'shared-approval'));
    assert.equal(JSON.stringify(events[id]).includes(otherMarker), false, 'Scoped bridge events must not leak between sessions with colliding IDs');
  }
  await view().getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await view().getByText('Разрешение только для PROJECT_A', { exact: true }).waitFor({ state: 'hidden' });
  await activate(idB);
  assert.equal(await view().getByText('Разрешение только для PROJECT_B', { exact: true }).isVisible(), true);
  await view().getByRole('button', { name: 'Отклонить', exact: true }).click();
  await view().getByText('Разрешение только для PROJECT_B', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await view().locator('.assistant-message').filter({ hasText: 'PROJECT_A' }).count(), 0);
  await waitUntil(async () => (await logFor(projectA)).some(entry => entry.pid === pidA && entry.id === 'shared-approval' && entry.result), 'A approval recorded');
  await waitUntil(async () => (await logFor(projectB)).some(entry => entry.pid === pidB && entry.id === 'shared-approval' && entry.result), 'B approval recorded');
  const logA = await logFor(projectA);
  const logB = await logFor(projectB);
  assert.deepEqual(logA.filter(entry => entry.pid === pidA && entry.id === 'shared-approval').map(entry => entry.result), [{ decision: 'accept' }]);
  assert.deepEqual(logB.filter(entry => entry.pid === pidB && entry.id === 'shared-approval').map(entry => entry.result), [{ decision: 'decline' }]);
  for (const [log, pid, settings, reviewer] of [[logA, pidA, settingsA, 'user'], [logB, pidB, settingsB, 'auto_review']]) {
    const started = requests(log, 'turn/start', pid)[0].params;
    assert.equal(started.cwd, settings.cwd);
    assert.equal(started.model, settings.model);
    assert.equal(started.effort, settings.effort);
    assert.equal(started.approvalsReviewer, reviewer);
    assert.deepEqual(started.sandboxPolicy.writableRoots, [settings.cwd]);
    assert.equal(requests(log, 'thread/start', pid)[0].params.cwd, settings.cwd);
    assert.ok(requests(log, 'thread/list', pid).every(entry => [projectA, projectB].includes(entry.params.cwd)), 'Shared history reads stay within registered workspace folders');
  }

  // History opens another tab while B keeps running; opening it again focuses it.
  const beforeHistory = await streamCount(idB);
  await view().getByRole('button', { name: 'История PROJECT_B', exact: true }).click();
  await waitUntil(async () => (await workspace()).sessions.length === 3 && await activeId() !== idB, 'history opens a tab');
  const idHistory = await activeId();
  const pidHistory = await ready(idHistory, projectB);
  await waitUntil(async () => requests(await logFor(projectB), 'thread/resume', pidHistory).some(entry => entry.params.threadId === 'shared-history'), 'history resumed');
  await activate(idB);
  await view().getByRole('button', { name: 'История PROJECT_B', exact: true }).click();
  await waitUntil(async () => await activeId() === idHistory, 'existing history tab focused');
  assert.equal((await workspace()).sessions.length, 3, 'A historical dialogue is not opened twice');
  await activate(idA);
  await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).click();
  await waitUntil(async () => (await workspace()).sessions.length === 4 && ![idA, idB, idHistory].includes(await activeId()), 'same history ID in another folder gets its own tab');
  const idHistoryA = await activeId();
  const pidHistoryA = await ready(idHistoryA, projectA);
  assert.notEqual(pidHistoryA, pidHistory);
  await closeTab(idHistoryA);
  await waitUntil(async () => (await workspace()).sessions.length === 3 && !isAlive(pidHistoryA), 'A history tab closed');
  await activate(idB);
  await closeTab(idHistory);
  await waitUntil(async () => (await workspace()).sessions.length === 2 && !isAlive(pidHistory), 'history tab closed');
  await waitUntil(async () => await streamCount(idB) > beforeHistory, 'B remains active through history switching');

  // Stop/reconnect A without touching B's turn or changing either set of settings.
  await activate(idA);
  await stopButton().click();
  await stopButton().waitFor({ state: 'hidden' });
  const beforeReconnect = await streamCount(idB);
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await view().getByRole('button', { name: 'Переподключить', exact: true }).click();
  await waitUntil(async () => await modelSelect().isEnabled(), 'A reconnect ready');
  await view().getByRole('button', { name: 'Готово', exact: false }).click();
  await assertSettings(idA, settingsA);
  await waitUntil(async () => await streamCount(idB) > beforeReconnect, 'B continues through A reconnect');
  assert.equal(requests(await logFor(projectB), 'turn/interrupt', pidB).length, 0);
  await send(idA, 'Второй запрос PROJECT_A', 'PROJECT_A');
  await assertLayout();
  await page.screenshot({ path: path.join(runDir, 'tabs-project-a.png') });
  await activate(idB);
  await assertSettings(idB, settingsB);
  assert.equal(await composer().inputValue(), 'Черновик только PROJECT_B');
  await page.screenshot({ path: path.join(runDir, 'tabs-project-b.png') });

  // Closing an inactive busy tab requires a concrete confirmation. Cancelling
  // keeps the process alive; accepting terminates only that tab's process.
  const beforeClose = await streamCount(idB);
  await closeTab(idA);
  const confirmation = page.getByRole('alertdialog', { name: 'Закрыть работающий диалог?', exact: true });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal((await workspace()).sessions.length, 2);
  assert.ok(isAlive(pidA));
  await closeTab(idA);
  await confirmation.getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await waitUntil(async () => (await workspace()).sessions.length === 1 && !isAlive(pidA), 'A process closes with its tab');
  assert.equal(await activeId(), idB);
  assert.ok(isAlive(pidB));
  assert.equal(await stopButton().isVisible(), true);
  await waitUntil(async () => await streamCount(idB) > beforeClose, 'B streams after closing active A');
  assert.equal(requests(await logFor(projectB), 'turn/interrupt', pidB).length, 0);
  assert.equal(await view().locator('.folder-toggle').count(), 2, 'Closing a tab keeps its folder available');
  await stopButton().click();
  await stopButton().waitFor({ state: 'hidden' });
  assert.equal(requests(await logFor(projectB), 'turn/interrupt', pidB).length, 1);
  await view().getByText('Выполнение остановлено. Можно продолжить диалог.', { exact: true }).waitFor();
  assert.equal(app.windows().length, 1);

  // Persist folders independently from open dialogues, including a folder whose
  // only tab was closed. Check renderer reload and a genuine host restart.
  const saved = JSON.parse(await readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.deepEqual(saved.projects, [projectA, projectB]);
  await page.reload();
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(async () => await view().count() === 1 && await modelSelect().isEnabled(), 'renderer reload ready');
  assert.deepEqual(await view().locator('.folder-toggle').evaluateAll(elements => elements.map(element => element.title)), [projectA, projectB]);
  await app.close();
  app = undefined;
  await waitUntil(() => [...fixturePids].every(pid => !isAlive(pid)), 'first host fixture cleanup');
  app = await launch();
  await installPage(await app.firstWindow());
  const restarted = await workspace();
  assert.deepEqual(restarted.projects, [projectA, projectB]);
  assert.deepEqual(await view().locator('.folder-toggle').evaluateAll(elements => elements.map(element => element.title)), [projectA, projectB]);
  const restartId = await activeId();
  const restartCwd = restarted.sessions.find(session => session.id === restartId).cwd;
  await ready(restartId, restartCwd);
  if (await projectCard(projectA).getAttribute('aria-expanded') !== 'true') await projectCard(projectA).click();
  await projectRow(projectA).getByRole('button', { name: 'История PROJECT_A', exact: true }).click();
  await waitUntil(async () => {
    const selected = await activeId();
    return await modelSelect().isEnabled() && (await workspace()).sessions.some(session => session.id === selected && session.cwd === projectA);
  }, 'reopen persisted A folder');
  await ready(await activeId(), projectA);
  await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).waitFor();
  await assertLayout();
  assert.deepEqual(errors, []);
  console.log(`PASS: one Electron window, per-folder history and ordered persisted folders, concurrent dialogue tabs/processes, background streaming, drafts/model/effort/access, colliding IDs and scoped approvals, history deduplication, stop/reconnect isolation, confirmed tab closing, renderer reload and host restart. No model requests. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
    console.error('UI diagnostics:', await page.locator('body').innerText().catch(() => '(page unavailable)'));
  }
  console.error(`Tabs test artifacts: ${runDir}`);
  throw error;
} finally {
  if (app) await app.close();
  await waitUntil(() => [...fixturePids].every(pid => !isAlive(pid)), 'test App Server cleanup');
}
