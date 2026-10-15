import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Executor agents («Агенты-исполнители») in the production renderer with a fake scoped bridge.
// An executor is a plain empty conversation of the same folder, linked to its parent for
// navigation only: this run asserts that no thread/fork is ever requested, that the parent's
// context is never carried over, that a working parent does not block creation, that depth
// stays at one, and that the row is rebuilt from the app-owned links after a reload.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
let page;
await mkdir('artifacts', { recursive: true });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/EXECUTORS';
    let serial = 0;
    let threads = 0;
    const sessions = {};
    const models = ['fixture-alpha', 'fixture-beta'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    // The app-owned navigation store, kept in localStorage so a reload restores the row the
    // same way `thread-child-links.json` does after a restart.
    const links = () => JSON.parse(localStorage.getItem('child-links') || '[]');
    const titles = () => JSON.parse(localStorage.getItem('titles') || '{}');
    const known = () => JSON.parse(localStorage.getItem('threads') || '[]');
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings }, requests: [], responses: [], listeners: new Set(), closed: false, threadId: null, turnId: null, turnSerial: 0 };
      const emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.emit = emit;
      state.bridge = {
        async start() { return { initialize: {}, models, cwd, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: state.settings.model, model_reasoning_effort: state.settings.effort } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: known().map(thread => ({ ...thread, name: titles()[thread.id] || thread.name })), nextCursor: null };
          if (method === 'thread/start') {
            const thread = { id: `thread-${++threads}`, cwd, historyMode: 'legacy', turns: [] };
            state.threadId = thread.id;
            localStorage.setItem('threads', JSON.stringify([...known(), { id: thread.id, cwd, name: 'Новый диалог', historyMode: 'legacy' }]));
            return { thread, model: params.model };
          }
          if (method === 'thread/resume') {
            const thread = known().find(item => item.id === params.threadId) || { id: params.threadId, cwd, historyMode: 'legacy' };
            state.threadId = thread.id;
            return { thread: { ...thread, name: titles()[thread.id] || thread.name, status: { type: 'idle' }, turns: [{ id: `${thread.id}-turn`, status: 'completed', items: [{ id: `${thread.id}-item`, type: 'agentMessage', text: `Сохранённый ответ ${thread.id}` }] }] }, model: state.settings.model, reasoningEffort: state.settings.effort };
          }
          if (method === 'turn/start') { state.turnId = `${state.threadId}-turn-${++state.turnSerial}`; return { turn: { id: state.turnId, status: 'inProgress', items: [] } }; }
          if (method === 'turn/interrupt') return {};
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond(id, result) { state.responses.push({ id, result }); }, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async openTerminal() { return { opened: true }; },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    create(cwd);
    window.__executors = { sessions, get links() { return links(); }, get titles() { return titles(); } };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: known().map(thread => ({ ...thread, name: titles()[thread.id] || thread.name })), nextCursor: null }; },
      async listThreadChildLinks() { return links(); },
      async createThreadChildLink(options) {
        const link = { id: `link-${links().length + 1}`, createdAt: new Date().toISOString(), ...options };
        localStorage.setItem('child-links', JSON.stringify([...links(), link]));
        return { link };
      },
      async manageThreadChildLink(options) {
        const before = links();
        const next = options.action === 'unlink' ? before.filter(link => link.childThreadId !== options.childThreadId)
          : before.map(link => link.childThreadId === options.childThreadId ? { ...link, label: options.label } : link);
        localStorage.setItem('child-links', JSON.stringify(next));
        return { changed: true, link: next.find(link => link.childThreadId === options.childThreadId) || null };
      },
      async manageThread(options) {
        if (options.action !== 'rename') throw new Error(`Unexpected fixture action ${options.action}`);
        localStorage.setItem('titles', JSON.stringify({ ...titles(), [options.threadId]: options.name }));
        return { thread: { id: options.threadId, cwd: options.cwd, name: options.name }, affectedThreadIds: [] };
      },
      async createSession({ cwd: folder, fromSessionId, settings } = {}) { return create(folder || cwd, { ...sessions[fromSessionId]?.settings, ...settings, cwd: folder || cwd }); },
      async closeSession(id) {
        if (window.__executors.failClose) throw new Error('Fixture closeSession отказ: повторите закрытие');
        if (window.__executors.holdClose) await new Promise(resolve => { sessions[id].releaseClose = resolve; });
        sessions[id].closed = true; sessions[id].listeners.clear();
      },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const stop = () => view().getByRole('button', { name: 'Остановить выполнение', exact: true });
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]')?.dataset.sessionId || '');
  const notify = (id, method, params) => page.evaluate(({ id, method, params }) => window.__executors.sessions[id].emit('notification', { method, params }), { id, method, params });
  const row = () => view().locator('.child-tabs-row');
  const rowTabs = () => row().locator('.child-tab:not(.child-tab-create)');
  const createOnTab = id => page.locator(`.session-tab[data-session-id="${id}"] .session-tab-child`);
  const threadOf = id => page.evaluate(id => window.__executors.sessions[id].threadId, id);
  const turnOf = id => page.evaluate(id => window.__executors.sessions[id].turnId, id);
  const requests = id => page.evaluate(id => window.__executors.sessions[id].requests.map(request => request.method), id);
  /** Sends one message and runs the turn to completion, so the conversation gets its id and goes idle. */
  const turn = async (id, text) => {
    await input().fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await stop().waitFor();
    const threadId = await threadOf(id);
    const turnId = await turnOf(id);
    await notify(id, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    await notify(id, 'item/agentMessage/delta', { threadId, turnId, itemId: `${turnId}-answer`, delta: `Ответ ${threadId}\n\n` });
    await notify(id, 'turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } });
    await stop().waitFor({ state: 'hidden' });
    return threadId;
  };

  await ready();
  const parentId = await activeId();
  assert.equal(await row().count(), 0, 'without executors the row is not drawn at all');
  assert.equal(await createOnTab(parentId).count(), 0, 'the action appears only once the parent has a conversation');
  const parentThread = await turn(parentId, 'Задача родителя');

  // (а) The button on the active parent tab. A clean executor does not touch the parent, so a
  // working parent must not disable it: start a turn and leave it running.
  await input().fill('Долгая задача родителя');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await stop().waitFor();
  await notify(parentId, 'turn/started', { threadId: parentThread, turn: { id: await turnOf(parentId), status: 'inProgress', items: [] } });
  const tabAction = createOnTab(parentId);
  await tabAction.waitFor();
  assert.equal(await tabAction.getAttribute('aria-label'), 'Новый агент-исполнитель');
  assert.equal(await tabAction.isEnabled(), true, 'a busy parent does not block a clean executor');
  assert.ok(await tabAction.locator('svg').evaluate(node => Number(node.getAttribute('width')) >= 14), 'the icon is at least 14px');
  await tabAction.click();
  await ready();
  const agentA = await activeId();
  assert.notEqual(agentA, parentId);

  // The executor is a new empty dialog, not a fork, and it carries no parent context.
  assert.deepEqual((await requests(agentA)).filter(method => method !== 'thread/list'), [], 'no thread/fork and no thread/resume for an executor');
  assert.equal(await input().inputValue(), '');
  assert.equal(await view().getByText(`Ответ ${parentThread}`, { exact: false }).count(), 0, 'the parent transcript is not copied');
  assert.equal(await page.locator('.session-tab').count(), 1, 'executors stay out of the root tab row');
  assert.equal(await row().getByText('Исполнители', { exact: true }).count(), 1);
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A']);
  assert.equal(await rowTabs().first().getAttribute('aria-selected'), 'true', 'the open executor is highlighted');
  // (6) Depth is exactly one.
  assert.equal(await row().locator('.child-tab-create').count(), 0, 'an executor offers no creation of its own');
  assert.ok(await row().locator('.child-tabs-caption').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 11));
  assert.ok(await rowTabs().first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 11));

  // The default name becomes the real dialog title once the executor has a conversation id.
  const threadA = await turn(agentA, 'Задача исполнителя A');
  await page.waitForFunction(() => window.__executors.titles['thread-2'] === 'Агент A');
  assert.deepEqual(await page.evaluate(() => window.__executors.links.map(link => [link.parentThreadId, link.childThreadId, link.label])), [[parentThread, threadA, 'Агент A']]);

  // (б) The «+» at the end of the row, shown at the parent only.
  await page.locator(`.session-tab[data-session-id="${parentId}"] [role="tab"]`).click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  await row().locator('.child-tab-create').click();
  await ready();
  const agentB = await activeId();
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B'], 'the next free Latin letter is used');
  assert.deepEqual((await requests(agentB)).filter(method => method !== 'thread/list'), [], 'the «+» opens an empty dialog too');
  const threadB = await turn(agentB, 'Задача исполнителя B');
  await page.waitForFunction(() => window.__executors.titles['thread-3'] === 'Агент B');

  // Switching back to an open executor activates its tab instead of resuming a second copy.
  await rowTabs().first().click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, agentA);
  assert.equal(await activeId(), agentA);
  assert.deepEqual((await requests(agentA)).filter(method => method !== 'thread/list'), ['thread/start', 'turn/start'], 'the executor is never resumed or forked a second time');

  // (в) The Ctrl+K command, offered at the parent and refused at depth one.
  const palette = () => page.getByRole('dialog', { name: 'Палитра команд', exact: true });
  const command = () => palette().locator('[data-command-id="executor"]');
  const openPalette = async () => { await page.keyboard.press('Control+KeyK'); await palette().waitFor(); };
  await openPalette();
  assert.equal(await command().getAttribute('aria-disabled'), 'true', 'an executor cannot create an executor');
  await page.keyboard.press('Escape'); await palette().waitFor({ state: 'hidden' });
  await page.locator(`.session-tab[data-session-id="${parentId}"] [role="tab"]`).click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  // The parent view: the roster plus the «+» at the end of the row.
  await page.screenshot({ path: 'artifacts/executor-tabs.png' });
  await openPalette();
  assert.equal(await command().getAttribute('aria-disabled'), null);
  await command().click(); await palette().waitFor({ state: 'hidden' }); await ready();
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B', 'Агент C']);
  // The executor view: the same row, the open executor highlighted, no creation of its own.
  await page.screenshot({ path: 'artifacts/executor-tabs-child.png' });

  // A linked executor is kept as a named, removable history entry after its session closes.
  // Every event below belongs to this isolated fixture, never to a real CLI or user dialog.
  const agentC = await activeId();
  const parentTab = () => page.locator(`.session-tab[data-session-id="${parentId}"]`);
  const closeModal = () => page.getByRole('alertdialog').filter({ has: page.locator('#close-session-title') });
  const entry = threadId => row().locator(`.child-tab-wrap:has(.child-tab[data-thread-id="${threadId}"])`);
  const sessionEntry = async id => entry(await threadOf(id) || `session:${id}`);
  const selectParent = async () => {
    await parentTab().getByRole('tab').click();
    await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  };
  const selectChild = async id => {
    await (await sessionEntry(id)).locator('.child-tab').click();
    await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, id);
  };
  const begin = async (id, text = 'Длительная задача исполнителя') => {
    await input().fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await stop().waitFor();
    const threadId = await threadOf(id), turnId = await turnOf(id);
    await notify(id, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    await (await sessionEntry(id)).locator('.spin').waitFor();
    return threadId;
  };
  const complete = async (id, status = 'completed') => notify(id, 'turn/completed', {
    threadId: await threadOf(id), turn: { id: await turnOf(id), status, items: [], error: status === 'failed' ? { message: 'Fixture failure' } : null },
  });
  const closed = id => page.waitForFunction(id => window.__executors.sessions[id].closed && !document.querySelector(`.session-view[data-session-id="${id}"]`), id);
  const createExecutor = async () => { await selectParent(); await row().locator('.child-tab-create').click(); await ready(); return activeId(); };
  const clickClose = async id => (await sessionEntry(id)).locator('.child-tab-close').click();
  const deferClose = async id => {
    await clickClose(id); await closeModal().waitFor();
    assert.equal(await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).isEnabled(), true);
    await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).click();
    await closeModal().waitFor({ state: 'hidden' });
    await (await sessionEntry(id)).locator('.child-tab-close.close-when-complete').waitFor();
  };
  const unlinkClosed = async threadId => {
    await selectParent();
    const saved = entry(threadId);
    await saved.locator('.child-tab-state.closed').waitFor();
    assert.match(await saved.locator('.child-tab').getAttribute('data-tooltip'), /Вкладка закрыта/);
    // A closed record must not read as an open idle tab: own icon, dashed outline, muted text.
    assert.equal(await saved.locator('svg.lucide-bot-off').count(), 1, 'a closed record carries the closed-agent icon');
    assert.equal(await saved.locator('svg.lucide-bot').count(), 0, 'the live agent icon is gone once the tab is closed');
    const look = await saved.evaluate(node => {
      const live = document.querySelector('.session-view:not([hidden]) .child-tab-wrap:not(.closed)');
      const style = getComputedStyle(node);
      return { outline: style.outlineStyle, color: style.color, live: live ? getComputedStyle(live).color : '' };
    });
    assert.equal(look.outline, 'dashed', 'a closed record is outlined instead of being drawn as a tab');
    if (look.live) assert.notEqual(look.color, look.live, 'a closed record is muted next to a live entry');
    for (const theme of [null, 'kuzmich']) {
      await setTheme(theme);
      await row().screenshot({ path: `artifacts/executor-closed-record-${theme || 'default'}.png` });
    }
    await setTheme(null);
    const cross = saved.locator('.child-tab-close');
    assert.equal(await cross.getAttribute('data-tooltip'), 'Убрать из ряда (диалог останется в папке)');
    assert.equal(await cross.isEnabled(), true, 'a saved entry never becomes a ghost without a working cross');
    await cross.click(); await saved.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(threadId => JSON.parse(localStorage.getItem('threads')).some(thread => thread.id === threadId), threadId), true, 'unlink preserves the dialog in folder history');
  };
  const setTheme = theme => page.evaluate(theme => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }, theme);

  // Exactly one root is highlighted while a child is active, and its accessible name names
  // that child. The two visual states differ in both supported palettes.
  assert.equal(await page.locator('.session-tab.active, .session-tab.child-active').count(), 1);
  assert.equal(await parentTab().locator('.session-executor-badge[aria-hidden="true"]').innerText(), 'C');
  assert.match(await parentTab().getByRole('tab').getAttribute('aria-label'), /открыт исполнитель Агент C/);
  for (const theme of ['', 'kuzmich']) {
    await setTheme(theme);
    const childStyle = await parentTab().evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow }));
    await page.screenshot({ path: `artifacts/executor-parent-child-active-${theme || 'default'}.png` });
    await selectParent();
    const activeStyle = await parentTab().evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow }));
    assert.equal(childStyle.bg, activeStyle.bg, 'the parent uses the active tab surface');
    assert.notEqual(childStyle.shadow, activeStyle.shadow, 'the parent has a softer accent than the active tab');
    assert.equal(await parentTab().locator('.session-executor-badge').count(), 0);
    await page.screenshot({ path: `artifacts/executor-parent-active-${theme || 'default'}.png` });
    await selectChild(agentC);
  }
  await setTheme('');

  // Regression: first send → Stop (interrupt acknowledged, completion not yet emitted) →
  // cross → explicit stop-and-close. These are exactly two clicks after the separate Stop.
  const threadC = await begin(agentC);
  assert.match(await (await sessionEntry(agentC)).locator('.child-tab').getAttribute('data-tooltip'), /Работает/);
  assert.equal(await (await sessionEntry(agentC)).locator('.child-tab-state.running').count(), 1);
  for (const theme of ['', 'kuzmich']) {
    await setTheme(theme); await page.screenshot({ path: `artifacts/executor-running-indicators-${theme || 'default'}.png` });
  }
  // The row of executors is drawn inside the parent's view, so work has to be visible on the
  // root tab from everywhere: with the executor open the badge keeps its name and spins, from
  // the parent itself and from an unrelated dialog it counts the working ones.
  await parentTab().locator('.session-executor-badge.running .spin').waitFor();
  assert.equal(await parentTab().locator('.session-executor-badge').innerText(), 'C');
  await selectParent();
  await parentTab().locator('.session-executor-badge.running').waitFor();
  assert.equal(await parentTab().locator('.session-executor-badge').innerText(), '1', 'an active parent counts its working executors');
  assert.match(await parentTab().getByRole('tab').getAttribute('data-tooltip'), /Агент C работает/);
  for (const theme of ['', 'kuzmich']) {
    await setTheme(theme); await page.screenshot({ path: `artifacts/executor-parent-running-${theme || 'default'}.png` });
  }
  await setTheme('');
  await page.getByRole('button', { name: 'Открыть новый диалог', exact: true }).click(); await ready();
  const workingWatcher = await activeId();
  assert.equal(await parentTab().locator('.session-executor-badge.running').count(), 1, 'an inactive parent still signals a working executor from an unrelated tab');
  await page.locator(`.session-tab[data-session-id="${workingWatcher}"] .session-tab-close`).click(); await closed(workingWatcher);
  await selectChild(agentC);
  await page.setViewportSize({ width: 960, height: 800 });
  await page.screenshot({ path: 'artifacts/executor-child-active-narrow.png' });
  const rowBounds = await row().boundingBox();
  assert.ok(rowBounds && rowBounds.x >= 0 && rowBounds.x + rowBounds.width <= 960, 'the executor row stays inside a narrow window');
  await page.setViewportSize({ width: 1440, height: 900 }); await setTheme('');
  await stop().click();
  assert.ok((await requests(agentC)).includes('turn/interrupt'));
  await clickClose(agentC); await closeModal().waitFor();
  assert.equal(await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).isEnabled(), true);
  await page.screenshot({ path: 'artifacts/executor-close-actions.png' });
  await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await closed(agentC); await selectParent();
  await page.getByRole('button', { name: 'Открыть новый диалог', exact: true }).click(); await ready();
  const unrelatedId = await activeId();
  assert.equal(await parentTab().getAttribute('class').then(value => value.includes('child-active')), false, 'a saved child without sessionId cannot pretend to be the active executor');
  assert.equal(await parentTab().locator('.session-executor-badge').count(), 0);
  assert.equal(await page.locator('.session-tab.active, .session-tab.child-active').count(), 1);
  await page.locator(`.session-tab[data-session-id="${unrelatedId}"] .session-tab-close`).click(); await closed(unrelatedId);
  await unlinkClosed(threadC);

  // Deferred closure follows an accepted turn/completed, including failure/interruption;
  // unrelated completion and the mere passage of UI frames cannot close a running session.
  for (const outcome of ['completed', 'failed', 'interrupted']) {
    const id = await createExecutor(), threadId = await begin(id);
    if (outcome === 'completed') {
      await input().fill('Очередь не должна стартовать перед закрытием');
      await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click();
      await view().locator('.message-queue [data-queue-id]').waitFor();
    }
    await deferClose(id);
    if (outcome === 'completed') {
      await view().locator('.message-queue.paused').waitFor();
      assert.equal(await view().getByRole('button', { name: 'Продолжить очередь', exact: true }).isDisabled(), true);
    }
    await notify(id, 'turn/completed', { threadId: 'unrelated-thread', turn: { id: 'unrelated-turn', status: 'completed', items: [] } });
    assert.equal(await page.evaluate(id => window.__executors.sessions[id].closed, id), false);
    await complete(id, outcome); await closed(id);
    assert.equal((await requests(id)).filter(method => method === 'turn/start').length, 1, 'completion must close before any queued follow-up can start');
    await unlinkClosed(threadId);
  }

  // Repeating the cross offers a deliberate cancellation. A subsequently completed turn
  // stays open and the ordinary idle cross still works.
  const cancelId = await createExecutor(), cancelThread = await begin(cancelId);
  await deferClose(cancelId); await clickClose(cancelId); await closeModal().waitFor();
  await page.setViewportSize({ width: 960, height: 800 });
  await page.screenshot({ path: 'artifacts/executor-close-cancel-narrow.png' });
  assert.equal(await closeModal().evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom; });
  }), true, 'all repeated-close actions fit within the narrow-window dialog');
  await page.setViewportSize({ width: 1440, height: 900 });
  await closeModal().getByRole('button', { name: 'Отменить отложенное закрытие', exact: true }).click();
  await closeModal().waitFor({ state: 'hidden' });
  assert.equal(await (await sessionEntry(cancelId)).locator('.close-when-complete').count(), 0);
  await complete(cancelId); await stop().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(id => window.__executors.sessions[id].closed, cancelId), false);
  await clickClose(cancelId); await closed(cancelId); await unlinkClosed(cancelThread);

  // A question or approval cancels the mark immediately. Even if completion follows in the
  // same event batch, the unanswered request must survive in its tab and in the bell.
  for (const kind of ['question', 'approval']) {
    const id = await createExecutor(), threadId = await begin(id);
    await deferClose(id); await selectParent();
    const method = kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval';
    const params = kind === 'question' ? { questions: [{ id: 'format', question: 'Какой формат сохранить?', options: [{ label: 'Прежний', description: 'Сохранить совместимость' }] }] } : { command: 'fixture command', reason: 'Fixture permission' };
    await page.evaluate(({ id, threadId, method, params }) => {
      const state = window.__executors.sessions[id];
      state.emit('serverRequest', { id: `pending-${id}`, method, params: { ...params, threadId, turnId: state.turnId } });
      state.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: state.turnId, status: 'completed', items: [], error: null } } });
    }, { id, threadId, method, params });
    const saved = entry(threadId);
    await saved.locator('.child-tab-state.waiting').waitFor();
    assert.equal(await saved.locator('.child-tab-state.question').count(), kind === 'question' ? 1 : 0);
    if (kind === 'question') assert.equal(await saved.locator('.child-tab-state.question').innerText(), '?');
    assert.equal(await saved.locator('.close-when-complete').count(), 0);
    assert.equal(await saved.locator('.child-tab-unread').count(), 1);
    assert.match(await saved.locator('.child-tab').getAttribute('data-tooltip'), /Ждёт вашего ответа/);
    await parentTab().locator('.session-executor-badge.waiting').waitFor();
    assert.match(await parentTab().getByRole('tab').getAttribute('data-tooltip'), /Агент C ждёт ответа/);
    await page.getByRole('button', { name: 'Требуют внимания', exact: true }).click();
    assert.equal(await page.locator('.attention-item.waiting').count(), 1);
    await page.keyboard.press('Escape');
    if (kind === 'question') {
      await page.getByRole('button', { name: 'Открыть новый диалог', exact: true }).click(); await ready();
      const otherId = await activeId();
      assert.equal(await parentTab().locator('.session-executor-badge.waiting').count(), 1, 'an inactive parent still signals its executor question from an unrelated tab');
      assert.equal(await parentTab().getAttribute('class').then(value => value.includes('child-active')), false);
      await page.screenshot({ path: 'artifacts/executor-question-from-other-dialog.png' });
      await page.locator(`.session-tab[data-session-id="${otherId}"] .session-tab-close`).click(); await closed(otherId);
      await selectParent();
    }
    for (const theme of ['', 'kuzmich']) {
      await setTheme(theme); await page.screenshot({ path: `artifacts/executor-${kind}-indicators-${theme || 'default'}.png` });
    }
    await setTheme('');
    await selectChild(id);
    assert.equal(await saved.locator('.child-tab-unread').count(), 0, 'activation reads attention but does not erase the pending question');
    assert.equal(await saved.locator('.child-tab-state.question').count(), kind === 'question' ? 1 : 0, 'the live request retains its kind after attention has been read');
    await clickClose(id); await closeModal().waitFor();
    assert.equal(await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).isDisabled(), true, 'unanswered requests cannot arm an automatic close');
    await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
    await closed(id); await unlinkClosed(threadId);
  }

  // Ordinary background completion leaves an unread dot. A connection loss is an error,
  // not turn/completed, and therefore does not satisfy a deferred-close request.
  await selectChild(agentB); await begin(agentB); await selectParent(); await complete(agentB);
  await entry(threadB).locator('.child-tab-unread').waitFor();
  assert.match(await entry(threadB).locator('.child-tab').getAttribute('data-tooltip'), /Готов/);
  // A result finished in the background keeps its dot on the root tab, not only in the bell.
  await parentTab().locator('.session-executor-badge .tab-unread').waitFor();
  assert.match(await parentTab().getByRole('tab').getAttribute('data-tooltip'), /Агент B: новый результат/);
  await selectChild(agentB);
  assert.equal(await parentTab().locator('.session-executor-badge .tab-unread').count(), 0, 'opening the executor reads its result');
  await selectParent();
  const disconnectedId = await createExecutor(), disconnectedThread = await begin(disconnectedId);
  await deferClose(disconnectedId);
  await page.evaluate(id => window.__executors.sessions[id].emit('status', { state: 'disconnected' }), disconnectedId);
  await (await sessionEntry(disconnectedId)).locator('.child-tab-state.error').waitFor();
  assert.equal(await page.evaluate(id => window.__executors.sessions[id].closed, disconnectedId), false);
  assert.match(await (await sessionEntry(disconnectedId)).locator('.child-tab').getAttribute('data-tooltip'), /Ошибка подключения/);
  await clickClose(disconnectedId); await closeModal().waitFor();
  await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await closed(disconnectedId); await unlinkClosed(disconnectedThread);

  // A host failure is reported inside the open confirmation, where the user can see it and
  // retry. The original session and its running state are kept after the failed close.
  const failedCloseId = await createExecutor(), failedCloseThread = await begin(failedCloseId);
  await clickClose(failedCloseId); await closeModal().waitFor();
  await page.evaluate(() => { window.__executors.failClose = true; });
  await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await closeModal().getByRole('alert').filter({ hasText: 'Fixture closeSession отказ' }).waitFor();
  assert.equal(await page.evaluate(id => window.__executors.sessions[id].closed, failedCloseId), false);
  assert.equal(await (await sessionEntry(failedCloseId)).locator('.spin').count(), 1);
  await page.evaluate(() => { window.__executors.failClose = false; });
  await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await closed(failedCloseId); await unlinkClosed(failedCloseThread);

  // Terminal ownership and an in-flight close disable the same child/root cross with an
  // explanation; no enabled cross is allowed to end as a silent no-op.
  await selectChild(agentA);
  await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).click();
  const terminalCross = (await sessionEntry(agentA)).locator('.child-tab-close');
  await page.waitForFunction(threadId => document.querySelector(`.session-view:not([hidden]) .child-tab-wrap:has(.child-tab[data-thread-id="${threadId}"]) .child-tab-close`)?.disabled, threadA);
  assert.equal(await terminalCross.getAttribute('data-tooltip'), 'Сначала закройте терминал этого диалога');
  await page.evaluate(({ id, threadId }) => window.__executors.sessions[id].emit('terminal', { threadId, state: 'closed' }), { id: agentA, threadId: threadA });
  await ready();
  const closingId = await createExecutor();
  await page.evaluate(() => { window.__executors.holdClose = true; });
  await clickClose(closingId);
  await page.waitForFunction(id => Boolean(window.__executors.sessions[id].releaseClose), closingId);
  assert.equal(await (await sessionEntry(agentA)).locator('.child-tab-close').isDisabled(), true);
  assert.match(await (await sessionEntry(agentA)).locator('.child-tab-close').getAttribute('data-tooltip'), /закры|Закры/);
  assert.equal(await parentTab().locator('.session-tab-close').isDisabled(), true);
  await page.evaluate(id => { window.__executors.holdClose = false; window.__executors.sessions[id].releaseClose(); }, closingId);
  await closed(closingId);
  await selectParent();
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B']);

  // Closing a parent closes its executors with it: a child tab is never left behind without the
  // conversation whose row lists it. Everything is idle here, so no confirmation is asked.
  await complete(parentId); await stop().waitFor({ state: 'hidden' });
  await selectChild(agentA);
  await parentTab().locator('.session-tab-close').click();
  await closed(agentA); await closed(agentB); await closed(parentId);
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'an idle group closes without a confirmation');
  assert.equal(await page.locator('.session-tab').count(), 0, 'no orphan executor and no navigation placeholder are left');
  await page.screenshot({ path: 'artifacts/executor-cascade-closed.png' });

  // (7) After a restart the row is rebuilt from app-owned links alone. The temporary agents
  // were explicitly removed from the row, while both original saved links remain.
  await page.reload(); await ready();
  assert.equal(await page.locator('.session-tab').count(), 1, 'only the restored session is a root tab');
  assert.equal(await row().count(), 0, 'the row belongs to an open conversation');
  await view().locator(`.folder-thread[data-thread-id="${parentThread}"]`).click();
  await ready();
  await page.waitForFunction(() => document.querySelectorAll('.session-view:not([hidden]) .child-tab:not(.child-tab-create)').length === 2);
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B']);
  assert.deepEqual(await page.evaluate(() => window.__executors.links.map(link => link.label)), ['Агент A', 'Агент B']);
  assert.equal(await row().locator('.child-tab-create').count(), 1, 'the parent keeps the «+» after a restart');
  // The counter badge is the tree disclosure, so it sits next to the row button, not inside it.
  assert.equal(await view().locator(`.folder-thread-row:has(.folder-thread[data-thread-id="${parentThread}"]) > .child-count-badge`).innerText(), '2');

  // (8) Opening an executor from the project tree. The parent is closed first, so the click has
  // to bring it back: the executor must never become a second, independent root tab.
  const rootTab = id => page.locator(`.session-tab[data-session-id="${id}"]`);
  const rootTabs = () => page.locator('.session-tab[data-session-id]');
  const treeExecutor = id => view().locator(`.folder-thread-children .folder-thread[data-thread-id="${id}"]`);
  const liveSession = thread => page.evaluate(thread => Object.values(window.__executors.sessions).find(state => !state.closed && state.threadId === thread)?.id || '', thread);
  const sessionCount = () => page.evaluate(() => Object.keys(window.__executors.sessions).length);
  const treeParentTab = await activeId();
  await rootTab(treeParentTab).locator('.session-tab-close').click(); await closed(treeParentTab);
  assert.equal(await rootTabs().count(), 1, 'only the session restored by the fixture is left');
  await view().locator(`.folder-thread-row:has(.folder-thread[data-thread-id="${parentThread}"]) > .child-count-badge`).click();
  await treeExecutor(threadA).click(); await ready();
  const treeAgentA = await activeId();
  await page.waitForFunction(() => document.querySelectorAll('.session-tab[data-session-id]').length === 2);
  const treeParent = await liveSession(parentThread);
  assert.ok(treeParent, 'the parent conversation was opened by the click');
  assert.equal(await rootTab(treeAgentA).count(), 0, 'the executor never becomes a root tab of its own');
  assert.ok((await rootTab(treeParent).getAttribute('class')).includes('child-active'), 'the parent is visible and semi-active, the focus stays on the agent');
  assert.equal(await page.locator('.session-tab[data-parent-thread-id]').count(), 0, 'an open parent needs no navigation placeholder');
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B'], 'no duplicate entry appears in the row');
  assert.equal(await rowTabs().first().getAttribute('aria-selected'), 'true', 'the opened agent is the selected one');
  await page.screenshot({ path: 'artifacts/executor-open-from-tree.png' });

  // A repeated click activates the existing tab instead of opening a second copy.
  await rootTab(treeParent).getByRole('tab').click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, treeParent);
  const sessionsBeforeRepeat = await sessionCount();
  await treeExecutor(threadA).click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, treeAgentA);
  assert.equal(await activeId(), treeAgentA);
  assert.equal(await sessionCount(), sessionsBeforeRepeat, 'the second click starts no CLI session');
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B']);

  // (9) «Закрыть остальные» closes executor tabs too, so no parentless child is left.
  await rootTab(treeParent).getByRole('tab').click({ button: 'right' });
  await page.getByRole('menu', { name: /^Вкладка: / }).getByRole('menuitem', { name: 'Закрыть остальные', exact: true }).click();
  await closed(treeAgentA);
  await page.waitForFunction(() => document.querySelectorAll('.session-tab[data-session-id]').length === 1);
  assert.equal(await page.locator('.session-tab[data-parent-thread-id]').count(), 0);

  // (10) A working executor: one shared dialog with three actions for the whole group.
  await rowTabs().first().click(); await ready();
  const waitAgent = await activeId();
  assert.equal(await rootTabs().count(), 1, 'the row reopens the executor under the same parent');
  // An executor terminal blocks the parent cross with its own visible reason.
  await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.session-tab[data-session-id="${id}"] .session-tab-close`)?.disabled, treeParent);
  assert.match(await rootTab(treeParent).locator('.session-tab-close').getAttribute('data-tooltip'), /терминал исполнителя «Агент A»/);
  await page.evaluate(({ id, threadId }) => window.__executors.sessions[id].emit('terminal', { threadId, state: 'closed' }), { id: waitAgent, threadId: threadA });
  await page.waitForFunction(id => !document.querySelector(`.session-tab[data-session-id="${id}"] .session-tab-close`)?.disabled, treeParent);
  await ready();
  await begin(waitAgent, 'Долгая задача исполнителя для каскада');
  await rootTab(treeParent).getByRole('tab').click();
  await rootTab(treeParent).locator('.session-tab-close').click();
  await closeModal().waitFor();
  assert.match(await closeModal().locator('#close-session-title').innerText(), /^Закрыть диалог вместе с исполнителями\?$/);
  assert.match(await closeModal().innerText(), /Агент A/);
  assert.deepEqual(await closeModal().locator('.confirm-actions button').allInnerTexts(), ['Отмена', 'Дождаться и закрыть', 'Остановить и закрыть']);
  await page.screenshot({ path: 'artifacts/executor-cascade-close.png' });
  await closeModal().getByRole('button', { name: 'Отмена', exact: true }).click();
  await closeModal().waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(ids => ids.map(id => window.__executors.sessions[id].closed), [treeParent, waitAgent]), [false, false], 'cancelling keeps the whole group');

  // «Дождаться и закрыть» marks the group and waits for the accepted turn/completed.
  await rootTab(treeParent).locator('.session-tab-close').click(); await closeModal().waitFor();
  await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).click();
  await closeModal().waitFor({ state: 'hidden' });
  await rootTab(treeParent).locator('.session-tab-close.close-when-complete').waitFor();
  assert.equal(await rootTab(treeParent).locator('.session-tab-close').getAttribute('data-tooltip'), 'Закроется по завершении');
  assert.equal(await entry(threadA).locator('.child-tab-close.close-when-complete').count(), 1, 'the executor shows the same timer');
  await complete(waitAgent);
  await closed(waitAgent); await closed(treeParent);
  assert.equal(await page.locator('.session-tab').count(), 0, 'the waiting group closed together');

  // (11) Restoring brings the parent back first and the executor back into its row.
  await page.keyboard.press('Control+Shift+KeyT'); await ready();
  const parentBack = await activeId();
  assert.equal(await threadOf(parentBack), parentThread, 'the parent is the first restored tab');
  assert.equal(await rootTab(parentBack).count(), 1);
  await page.keyboard.press('Control+Shift+KeyT'); await ready();
  const childBack = await activeId();
  assert.equal(await threadOf(childBack), threadA, 'the executor follows its parent');
  assert.equal(await rootTab(childBack).count(), 0, 'a restored executor stays in the row of its parent');
  assert.equal(await rowTabs().first().getAttribute('aria-selected'), 'true');

  // (12) A question of an executor cancels the whole cascade: the tabs stay open.
  await begin(childBack, 'Задача, которая задаст вопрос');
  await rootTab(parentBack).getByRole('tab').click();
  await rootTab(parentBack).locator('.session-tab-close').click(); await closeModal().waitFor();
  await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).click();
  await rootTab(parentBack).locator('.session-tab-close.close-when-complete').waitFor();
  await page.evaluate(({ id, threadId }) => {
    const state = window.__executors.sessions[id];
    state.emit('serverRequest', { id: `cascade-${id}`, method: 'item/tool/requestUserInput', params: { threadId, turnId: state.turnId, questions: [{ id: 'format', question: 'Какой формат сохранить?', options: [{ label: 'Прежний', description: 'Сохранить совместимость' }] }] } });
    state.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: state.turnId, status: 'completed', items: [], error: null } } });
  }, { id: childBack, threadId: threadA });
  await page.waitForFunction(id => !document.querySelector(`.session-tab[data-session-id="${id}"] .session-tab-close.close-when-complete`), parentBack);
  assert.deepEqual(await page.evaluate(ids => ids.map(id => window.__executors.sessions[id].closed), [parentBack, childBack]), [false, false], 'the unanswered question keeps both tabs');
  assert.equal(await entry(threadA).locator('.child-tab-close.close-when-complete').count(), 0, 'the executor timer is cleared as well');
  await entry(threadA).locator('.child-tab-state.waiting').waitFor();
  await rootTab(parentBack).locator('.session-tab-close').click(); await closeModal().waitFor();
  assert.equal(await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).isDisabled(), true, 'an unanswered question cannot arm the cascade again');
  assert.match(await closeModal().getByRole('button', { name: 'Дождаться и закрыть', exact: true }).getAttribute('data-tooltip'), /вопрос исполнителя «Агент A»/);
  await closeModal().getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await closed(childBack); await closed(parentBack);
  assert.equal(await page.locator('.session-tab').count(), 0);

  // «Сабдиалог» is gone from every user-facing string of the renderer.
  assert.equal(await page.evaluate(() => /сабдиалог/i.test(document.body.innerHTML)), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: executor agents — clean empty dialog without thread/fork (${threadA}/${threadB}), depth one and saved names; started Stop→close, both close choices, completion/failure/interruption, cancellation, batched question/approval safety, disconnect safety, status/question/unread indicators, terminal/closing locks with reasons, saved-entry unlink, parent normal/child-active in both themes, inactive-parent waiting, narrow layout and reload; cascade close of a parent with idle and working executors (all three dialog actions, question cancels the wait), «Закрыть остальные» without orphans, restore order parent→executor, and opening an executor from the tree without a duplicate. Fake bridge only; no Electron IPC or model requests.`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/executor-tabs-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
