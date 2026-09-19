import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with scoped, deterministic bridges. No Codex or model requests.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-09-17T12:00:00Z') });
  await page.addInitScript(() => {
    let serial = 0;
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B', 'C:/Fixtures/EMPTY'];
    const sessions = {};
    const fixture = { projects, sessions, creates: [], lists: [], closes: [], failClose: false, nextFolder: 'C:/Fixtures/PROJECT_C', holdB: true, failB: false, releaseB: null };
    const history = (cwd, second = false) => ({ id: second ? 'second-history' : 'shared-history', name: `${second ? 'Ещё' : 'История'} ${cwd.split('/').at(-1)}`, cwd, historyMode: 'legacy' });
    const listing = (cwd, cursor) => ({ data: /\/(EMPTY|PROJECT_C)$/.test(cwd) ? [] : [history(cwd, !!cursor)], nextCursor: cwd.endsWith('PROJECT_B') && !cursor ? 'page-2' : null });
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, requests: [], closed: false, listeners: new Set(), settings: { model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings, cwd } };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return listing(cwd, params.cursor);
          if (method === 'thread/resume') return { thread: { ...history(cwd), id: params.threadId, status: { type: 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old-message', type: 'agentMessage', text: `Ответ из ${cwd}` }] }] }, model: 'fixture-alpha', reasoningEffort: 'high' };
          if (method === 'thread/start') return { thread: { id: 'new-thread', cwd, turns: [] }, model: params.model };
          if (method === 'turn/start') {
            const turn = { id: 'turn-1', status: 'inProgress', items: [] };
            state.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn } });
            return { turn };
          }
          throw new Error(`Unexpected fixture method: ${method}`);
        },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return fixture.nextFolder; }, async chooseExecutable() { return null; }, async openPath() {},
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    create(projects[0]);
    window.__tree = fixture;
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects: [...projects], sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd, cursor) {
        fixture.lists.push({ cwd, cursor });
        if (cwd.endsWith('PROJECT_B') && fixture.holdB) { fixture.holdB = false; await new Promise(resolve => { fixture.releaseB = resolve; }); }
        if (cwd.endsWith('PROJECT_B') && fixture.failB) { fixture.failB = false; throw new Error('Ошибка истории PROJECT_B'); }
        return listing(cwd, cursor);
      },
      async createSession(options = {}) {
        fixture.creates.push(options);
        const cwd = options.cwd || fixture.nextFolder;
        if (!cwd) return null;
        if (!projects.includes(cwd)) projects.push(cwd);
        return create(cwd, { ...sessions[options.fromSessionId]?.settings, ...options.settings });
      },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      async createWorktreeSession(options = {}) {
        (fixture.worktrees ??= []).push(options);
        if (fixture.failWorktree) { fixture.failWorktree = false; throw new Error('Ветка с таким именем уже занята другой рабочей копией.'); }
        const source = sessions[options.fromSessionId];
        const cwd = `${options.cwd}.worktrees/${options.name}`;
        if (!projects.includes(cwd)) projects.push(cwd);
        return { ...create(cwd, { ...source?.settings }), worktree: { path: cwd, branch: options.name, created: true, root: options.cwd } };
      },
      async closeProject(cwd, options = {}) {
        fixture.closes.push({ cwd, options });
        if (fixture.failClose) { fixture.failClose = false; throw new Error('Ошибка закрытия проекта'); }
        const matching = Object.values(sessions).filter(state => !state.closed && state.cwd === cwd);
        if (matching.length && !options.force) throw new Error('Нужно подтвердить закрытие вкладок');
        matching.forEach(state => { state.closed = true; state.listeners.clear(); });
        const index = projects.indexOf(cwd);
        if (index >= 0) projects.splice(index, 1);
        return { projects: [...projects], closedSessionIds: matching.map(state => state.id) };
      },
      async listArchivedThreads() { return { data: [{ id: 'archived-a', name: 'Архив PROJECT_A', cwd: 'C:/Fixtures/PROJECT_A' }], nextCursor: null }; },
      async readArchivedThread() { return { items: [{ id: 'archived-message', type: 'agentMessage', text: 'Сохранённый архив' }], turns: [], nextCursor: null }; },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const tree = () => page.locator('.project-tree:visible');
  const folder = name => tree().locator(`.folder-tree-entry[data-cwd="C:/Fixtures/${name}"]`);
  const toggle = name => folder(name).getByRole('button', { name: `Диалоги папки ${name}`, exact: true });
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const tabs = count => page.waitForFunction(count => document.querySelectorAll('.session-tab').length === count, count);
  const newProject = () => view().locator('.sidebar').getByRole('button', { name: 'Новый проект', exact: true });
  const newChat = name => folder(name).getByRole('button', { name: `Новый диалог в папке ${name}`, exact: true });
  const historyButton = (name, second = false) => folder(name).locator(`.folder-thread[data-thread-id="${second ? 'second-history' : 'shared-history'}"]`);
  await ready();
  await tree().waitFor();
  assert.equal(await tree().count(), 1);
  assert.deepEqual(await tree().locator('.folder-tree-entry').evaluateAll(nodes => nodes.map(node => node.dataset.cwd)), ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B', 'C:/Fixtures/EMPTY']);
  const projectButtonPosition = await newProject().evaluate(node => ({ top: node.getBoundingClientRect().top, brandBottom: node.closest('.sidebar').querySelector('.brand').getBoundingClientRect().bottom, treeTop: node.closest('.sidebar').querySelector('.project-tree').getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }));
  assert.ok(projectButtonPosition.top >= projectButtonPosition.brandBottom && projectButtonPosition.bottom <= projectButtonPosition.treeTop, 'New project button is below the logo and above the folder tree');
  if (await toggle('PROJECT_A').getAttribute('aria-expanded') !== 'true') await toggle('PROJECT_A').click();
  await historyButton('PROJECT_A').waitFor();
  await toggle('PROJECT_B').click();
  await page.waitForFunction(() => typeof window.__tree.releaseB === 'function');
  assert.equal(await activeId(), 'session-1', 'Expanding another folder preserves the active session');
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal(await historyButton('PROJECT_A').isVisible(), true, 'Another folder remains readable during loading');
  assert.equal(await page.evaluate(() => window.__tree.creates.length), 0);
  assert.equal(await page.evaluate(() => Object.values(window.__tree.sessions).flatMap(state => state.requests).filter(request => request.method === 'turn/start').length), 0);
  await page.evaluate(() => window.__tree.releaseB());
  await historyButton('PROJECT_B').waitFor();
  await folder('PROJECT_B').getByRole('button', { name: 'Загрузить ещё', exact: true }).click();
  await historyButton('PROJECT_B', true).waitFor();
  assert.equal(await folder('PROJECT_B').locator('.folder-thread').count(), 2);
  assert.equal(await folder('PROJECT_A').locator('.folder-thread').count(), 1);
  assert.equal(await folder('PROJECT_B').getByRole('button', { name: 'Загрузить ещё', exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => window.__tree.lists.some(call => call.cwd.endsWith('PROJECT_B') && call.cursor === 'page-2')));
  await page.evaluate(() => { window.__tree.failB = true; });
  await folder('PROJECT_B').getByRole('button', { name: 'Обновить диалоги PROJECT_B', exact: true }).click();
  await folder('PROJECT_B').getByText('Ошибка истории PROJECT_B', { exact: true }).waitFor();
  assert.equal(await folder('PROJECT_A').getByText('Ошибка истории PROJECT_B', { exact: true }).count(), 0);
  await folder('PROJECT_B').getByRole('button', { name: 'Повторить', exact: true }).click();
  await folder('PROJECT_B').getByText('Ошибка истории PROJECT_B', { exact: true }).waitFor({ state: 'hidden' });
  await historyButton('PROJECT_B').click();
  await tabs(2); await ready();
  assert.equal(await activeId(), 'session-2');
  await view().getByText('Ответ из C:/Fixtures/PROJECT_B', { exact: true }).waitFor();
  await historyButton('PROJECT_B').click();
  assert.equal(await page.getByRole('tab').count(), 2, 'Opening the same history reuses its existing tab');
  assert.equal(await page.evaluate(() => window.__tree.creates.length), 1);
  await newProject().click();
  await tabs(3); await ready();
  assert.equal(await activeId(), 'session-3');
  await folder('PROJECT_C').waitFor();
  const created = await page.evaluate(() => window.__tree.creates);
  assert.equal(created[0].cwd, 'C:/Fixtures/PROJECT_B');
  assert.equal(created[1].cwd, undefined, 'Dedicated New project invokes the folder picker');
  assert.equal(created[1].fromSessionId, 'session-2', 'Picker inherits from the active tab');
  assert.equal(await page.evaluate(() => window.__tree.sessions['session-3'].cwd), 'C:/Fixtures/PROJECT_C');
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Тестовое событие для счётчика');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  await page.evaluate(() => {
    const state = window.__tree.sessions['session-3'];
    const context = { threadId: 'new-thread', turnId: 'turn-1' };
    const usage = { totalTokens: 364659, inputTokens: 364650, cachedInputTokens: 350000, cacheWriteInputTokens: 0, outputTokens: 9, reasoningOutputTokens: 0 };
    state.emit('notification', { method: 'item/agentMessage/delta', params: { ...context, itemId: 'answer', delta: 'Готово' } });
    state.emit('notification', { method: 'thread/tokenUsage/updated', params: { ...context, tokenUsage: { last: usage, total: usage, modelContextWindow: 1000000 } } });
    state.emit('notification', { method: 'turn/completed', params: { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } } });
  });
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor({ state: 'hidden' });
  assert.match(await view().locator('.cache-countdown').innerText(), /Кэш ≈ (?:60:00|59:\d\d)/);
  assert.equal(await view().getByText('Настроить', { exact: true }).count(), 0);
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size);
    // Shrinking now closes the panel so right-aligned messages remain visible.
    if (size.width <= 1000) await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) .app-shell')?.classList.contains('panel-hidden'));
    const geometry = await view().locator('.composer-footer').evaluate(footer => {
      const bounds = selector => { const r = footer.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, center: (r.top + r.bottom) / 2 }; };
      return { access: bounds('.access-select'), cache: bounds('.cache-control'), tokens: bounds('.token-usage'), height: footer.getBoundingClientRect().height };
    });
    assert.ok(Math.abs(geometry.access.center - geometry.cache.center) < 2, 'Access and cache share one row');
    assert.ok(Math.abs(geometry.cache.center - geometry.tokens.center) < 2, 'Cache and token counter share one row');
    assert.ok(geometry.access.right <= geometry.cache.left && geometry.cache.right <= geometry.tokens.left, 'Cache follows access and precedes tokens');
    await view().locator('.cache-countdown').click();
    await view().getByRole('textbox', { name: 'Текст пинга', exact: true }).waitFor();
    assert.equal(await view().getByRole('spinbutton', { name: 'Срок кэша, минут', exact: true }).inputValue(), '60');
    const popup = await view().locator('.cache-settings').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }; });
    assert.ok(popup.left >= 0 && popup.right <= popup.width + 1 && popup.top >= 0 && popup.bottom <= popup.height + 1 && popup.scrollWidth <= popup.width + 1, 'Cache settings fit the viewport');
    await view().locator('.cache-countdown').click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
  await page.screenshot({ path: 'artifacts/project-tree-inline-cache.png' });

  // Regression: a remembered empty folder must create its own chat while another folder is busy.
  await page.locator('[data-session-id="session-1"] [role="tab"]').click(); await ready();
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Продолжай работу в PROJECT_A');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  if (await toggle('EMPTY').getAttribute('aria-expanded') !== 'true') await toggle('EMPTY').click();
  await folder('EMPTY').getByText('Пока нет диалогов', { exact: true }).waitFor();
  assert.equal(await activeId(), 'session-1');
  const requestCountA = await page.evaluate(() => window.__tree.sessions['session-1'].requests.length);
  await newChat('EMPTY').click(); await tabs(4); await ready();
  assert.equal(await activeId(), 'session-4');
  const emptySession = await page.evaluate(() => ({ create: window.__tree.creates.at(-1), cwd: window.__tree.sessions['session-4'].cwd, requests: window.__tree.sessions['session-4'].requests, sourceRequests: window.__tree.sessions['session-1'].requests.length, sourceClosed: window.__tree.sessions['session-1'].closed }));
  assert.equal(emptySession.create.cwd, 'C:/Fixtures/EMPTY', 'Folder + passes that exact folder, bypassing the picker');
  assert.equal(emptySession.create.fromSessionId, 'session-1');
  assert.equal(emptySession.cwd, 'C:/Fixtures/EMPTY');
  assert.equal(emptySession.sourceRequests, requestCountA, 'Opening a different folder does not interrupt or restart the busy source');
  assert.equal(emptySession.sourceClosed, false);
  assert.deepEqual(emptySession.requests.filter(call => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), [], 'Blank chat does not start/resume a thread or send a model turn');
  assert.equal(await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), '');
  assert.equal(await view().getByText('Ответ из C:/Fixtures/PROJECT_B', { exact: true }).count(), 0);
  assert.equal(await historyButton('PROJECT_A').count(), 1, 'Existing folder history survives empty-folder creation');
  assert.equal(await historyButton('PROJECT_B').count(), 1);
  assert.equal(await page.locator('[data-session-id="session-1"] .tab-state.running').count(), 1, 'Source task keeps running in its tab');
  await page.screenshot({ path: 'artifacts/new-chat-empty-project.png' });
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Создай первый файл в EMPTY');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  const emptyRequests = await page.evaluate(() => window.__tree.sessions['session-4'].requests);
  assert.equal(emptyRequests.find(call => call.method === 'thread/start')?.params.cwd, 'C:/Fixtures/EMPTY');
  assert.equal(emptyRequests.find(call => call.method === 'turn/start')?.params.cwd, 'C:/Fixtures/EMPTY', 'First message runs in the folder chosen by its +');

  await page.evaluate(() => { window.__tree.nextFolder = null; });
  await newProject().click();
  await page.waitForFunction(() => window.__tree.creates.length === 4);
  assert.equal(await activeId(), 'session-4');
  assert.equal(await page.getByRole('tab').count(), 4, 'Cancelling folder picker preserves all tabs');
  assert.equal(await folder('EMPTY').count(), 1);
  assert.equal(await page.evaluate(() => window.__tree.creates.at(-1).cwd), undefined);

  // Last-tab case uses the same sidebar controls, without an active session to inherit.
  for (const id of ['session-4', 'session-3', 'session-2', 'session-1']) {
    await page.locator(`.session-tab[data-session-id="${id}"] .session-tab-close`).click();
    if (await page.getByRole('alertdialog').isVisible()) await page.getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
    await page.locator(`.session-tab[data-session-id="${id}"]`).waitFor({ state: 'detached' });
  }
  await tabs(0);
  await newProject().waitFor();
  await newProject().click();
  await page.waitForFunction(() => window.__tree.creates.length === 5);
  assert.equal(await page.getByRole('tab').count(), 0, 'Cancelling from the empty workspace does not create a tab');
  await newChat('EMPTY').click(); await tabs(1); await ready();
  assert.equal(await activeId(), 'session-5');
  const fromEmptyWorkspace = await page.evaluate(() => ({ create: window.__tree.creates.at(-1), state: { cwd: window.__tree.sessions['session-5'].cwd, requests: window.__tree.sessions['session-5'].requests } }));
  assert.equal(fromEmptyWorkspace.create.cwd, 'C:/Fixtures/EMPTY');
  assert.equal(fromEmptyWorkspace.create.fromSessionId, undefined);
  assert.equal(fromEmptyWorkspace.state.cwd, 'C:/Fixtures/EMPTY');
  assert.deepEqual(fromEmptyWorkspace.state.requests.filter(call => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), []);

  // Closing removes registration and local tabs, never history or project files.
  const projectMenu = name => folder(name).getByRole('button', { name: `Действия проекта ${name}`, exact: true });
  const closeProjectMenu = async name => {
    await projectMenu(name).click();
    await page.getByRole('menuitem', { name: 'Закрыть проект', exact: true }).click();
  };
  await projectMenu('PROJECT_C').click();
  await page.getByRole('menuitem', { name: 'Закрыть проект', exact: true }).waitFor();
  await page.keyboard.press('Escape');

  assert.equal(await projectMenu('PROJECT_C').getAttribute('aria-expanded'), 'false');
  await toggle('PROJECT_C').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Закрыть проект', exact: true }).click();
  await folder('PROJECT_C').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'Project without open tabs closes immediately');
  assert.deepEqual(await page.evaluate(() => window.__tree.closes.at(-1)), { cwd: 'C:/Fixtures/PROJECT_C', options: { force: false } });
  assert.equal(await activeId(), 'session-5', 'Closing an unused project preserves the active tab');

  await newChat('PROJECT_A').click(); await tabs(2); await ready();
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Важный черновик PROJECT_A');
  await closeProjectMenu('PROJECT_A');
  await page.getByRole('alertdialog').waitFor();
  assert.match(await page.getByRole('alertdialog').innerText(), /Неотправленные сообщения и вложения/);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), 'Важный черновик PROJECT_A');
  assert.equal(await page.evaluate(() => window.__tree.closes.length), 1, 'Cancelling preserves drafts and never contacts closeProject');
  await page.evaluate(() => { window.__tree.failClose = true; });
  await closeProjectMenu('PROJECT_A');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть проект', exact: true }).click();
  await page.getByRole('alertdialog').getByText('Ошибка закрытия проекта', { exact: true }).waitFor();
  assert.equal(await folder('PROJECT_A').count(), 1);
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.evaluate(() => window.__tree.sessions['session-6'].closed), false, 'Host failure retains all local views');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть проект', exact: true }).click();
  await folder('PROJECT_A').waitFor({ state: 'detached' }); await tabs(1);
  assert.equal(await activeId(), 'session-5');
  assert.deepEqual(await page.evaluate(() => window.__tree.closes.at(-1)), { cwd: 'C:/Fixtures/PROJECT_A', options: { force: true } });
  assert.equal(await page.evaluate(() => window.__tree.sessions['session-5'].closed), false, 'Unrelated session remains connected');

  await page.evaluate(() => { window.__tree.nextFolder = 'C:/Fixtures/PROJECT_A'; });
  await newProject().click(); await tabs(2); await ready();
  await historyButton('PROJECT_A').waitFor();
  assert.equal(await historyButton('PROJECT_A').innerText(), 'История PROJECT_A', 'Adding a closed project returns its previous history');
  await view().getByRole('button', { name: 'Архив', exact: true }).click();
  await view().getByRole('button', { name: 'Архив PROJECT_A', exact: true }).click();
  await tabs(3); await view().getByText('Сохранённый архив', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'К проектам', exact: true }).click();
  await closeProjectMenu('PROJECT_A');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть проект', exact: true }).click();
  await tabs(1); await folder('PROJECT_A').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.archive-view').count(), 0, 'Closing a project also closes its archived read-only views');

  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Работай в EMPTY');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  await closeProjectMenu('EMPTY');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).isVisible(), true, 'Cancelling leaves a running project untouched');
  await closeProjectMenu('EMPTY');
  await page.screenshot({ path: 'artifacts/close-project-confirm.png' });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть проект', exact: true }).click();
  await tabs(0); await folder('EMPTY').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__tree.sessions['session-5'].closed), true);
  await closeProjectMenu('PROJECT_B');
  await page.waitForFunction(() => window.__tree.projects.length === 0);
  await tree().getByText('Добавьте проект, чтобы открыть диалог.', { exact: true }).waitFor();
  await newProject().waitFor();
  assert.deepEqual(errors, []);
  // Isolated task: dialog, host error surfaced in place, then a new tab in the sibling worktree folder.
  await page.evaluate(() => { window.__tree.nextFolder = 'C:/Fixtures/PROJECT_A'; });
  await newProject().click(); await tabs(1); await ready();
  const tabsBeforeWorktree = await page.getByRole('tab').count();
  const activeBeforeWorktree = await activeId();
  const modelCalls = () => page.evaluate(() => Object.values(window.__tree.sessions).flatMap(state => state.requests).filter(request => ['thread/start', 'turn/start'].includes(request.method)).length);
  const modelCallsBeforeWorktree = await modelCalls();
  await projectMenu('PROJECT_A').click();
  await page.getByRole('menuitem', { name: 'Новая задача в отдельной ветке…', exact: true }).click();
  const worktreeDialog = page.getByRole('dialog', { name: 'Новая задача в отдельной ветке', exact: true });
  await worktreeDialog.waitFor();
  assert.equal(await worktreeDialog.getByRole('button', { name: 'Создать и открыть', exact: true }).isDisabled(), true, 'Empty name cannot be submitted');
  await page.evaluate(() => { window.__tree.failWorktree = true; });
  await worktreeDialog.getByLabel('Имя задачи', { exact: true }).fill('fix-login');
  await worktreeDialog.getByRole('button', { name: 'Создать и открыть', exact: true }).click();
  await worktreeDialog.getByRole('alert').filter({ hasText: 'уже занята' }).waitFor();
  assert.equal(await page.getByRole('tab').count(), tabsBeforeWorktree, 'A failed worktree opens no tab');
  await worktreeDialog.getByRole('button', { name: 'Создать и открыть', exact: true }).click();
  await worktreeDialog.waitFor({ state: 'detached' });
  await page.getByRole('status').filter({ hasText: 'Задача «fix-login» открыта' }).waitFor();
  assert.equal(await page.getByRole('tab').count(), tabsBeforeWorktree + 1);
  const worktreeCalls = await page.evaluate(() => window.__tree.worktrees);
  assert.equal(worktreeCalls.length, 2); assert.equal(worktreeCalls[1].name, 'fix-login'); assert.equal(worktreeCalls[1].cwd, 'C:/Fixtures/PROJECT_A', 'The folder comes from the menu, not from the active tab');
  await tree().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_A.worktrees/fix-login"]').waitFor();
  assert.equal(await modelCalls(), modelCallsBeforeWorktree, 'Opening a worktree tab sends no model request');
  await page.getByRole('button', { name: 'Скрыть уведомление', exact: true }).click();
  // Leave the rest of the scenario as it was: close the worktree tab and return to the previous one.
  await page.getByRole('button', { name: /^Закрыть вкладку fix-login/ }).click();
  await tabs(tabsBeforeWorktree);
  await page.locator(`.session-tab[data-session-id="${activeBeforeWorktree}"]`).getByRole('tab').click();
  assert.equal(await activeId(), activeBeforeWorktree);
  await tree().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_A.worktrees/fix-login"]').getByRole('button', { name: 'Действия проекта fix-login', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Закрыть проект', exact: true }).click();
  await tree().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_A.worktrees/fix-login"]').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: compact folder tree, isolated history/loading/errors/pagination, history reuse, new project and empty-folder chat, inline cache at 1440/940px; project menu/keyboard/context menu, immediate and confirmed close, cancel with draft/running task, close failure recovery, archived views close, other project isolation, history returns after adding, empty workspace, isolated task via worktree menu/dialog. Fake bridges and token events only; no real model request.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/project-tree-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
