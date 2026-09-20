import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Real production renderer, deterministic scoped bridges; no model requests.
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
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const sessions = {};
    let serial = 0;
    const fixture = { projects, sessions };
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const history = cwd => ({ id: 'saved-history', name: `История ${cwd.split('/').at(-1)}`, cwd, historyMode: 'legacy' });
    const make = cwd => {
      const id = `session-${++serial}`;
      const state = { id, cwd, requests: [], lists: [], opens: [], menus: [], menuMode: 'cancel', closed: false, failDirectory: true, listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' } };
      state.emit = (method, params) => { if (!state.closed) for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start(options = {}) { if (options.cwd) { cwd = options.cwd; state.cwd = cwd; state.settings.cwd = cwd; } return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [history(cwd)], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: `new-${id}`, cwd, turns: [] }, model: 'fixture-alpha' };
          if (method === 'turn/start') return { turn: { id: `sent-${id}`, status: 'inProgress', items: [] } };
          if (method === 'thread/resume') return { thread: { ...history(cwd), status: { type: 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [
            { id: 'answer', type: 'agentMessage', text: 'Файлы изменены. Проверьте правую панель.' },
            { id: 'patch-1', type: 'fileChange', status: 'completed', changes: [{ path: `${cwd}/docs/TABS.md`, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-старое описание\n+первое изменение' }] },
            { id: 'patch-2', type: 'fileChange', status: 'completed', changes: [{ path: `${cwd}/docs/TABS.md`.replaceAll('/', '\\'), kind: { type: 'update' }, diff: '@@ -4 +4 @@\n-старая строка\n+второе изменение ' + 'длинная_строка_без_пробелов_'.repeat(24) }] },
            { id: 'patch-3', type: 'fileChange', status: 'completed', changes: [{ path: `${cwd}/src/new.ts`, kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+export const ready = true;' }, { path: `${cwd}/src/old.ts`, kind: { type: 'delete' }, diff: '@@ -1 +0,0 @@\n-export const old = true;' }] },
          ] }] }, model: 'fixture-alpha', reasoningEffort: 'high' };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async listFiles(path = '', cursor) {
          state.lists.push({ path, cursor });
          const entry = (name, type) => ({ name, path: path ? `${path}/${name}` : name, type });
          if (!path && cwd.endsWith('PROJECT_B')) return { path, entries: [entry('other-project.txt', 'file')], nextCursor: null };
          if (!path && cursor) return { path, entries: [entry('second-page.txt', 'file')], nextCursor: null };
          if (!path) return { path, entries: [entry('docs', 'directory'), entry('empty', 'directory'), entry('retry', 'directory'), entry('README.md', 'file'), entry('shortcut', 'link')], nextCursor: 500 };
          if (path === 'docs') return { path, entries: [entry('TABS.md', 'file'), entry('пример файла [1].txt', 'file')], nextCursor: null };
          if (path === 'retry' && state.failDirectory) { state.failDirectory = false; throw new Error('Тестовая ошибка чтения папки'); }
          return { path, entries: [], nextCursor: null };
        },
        async openPath(path) { state.opens.push(path); },
        async showPathMenu(path, options) {
          state.menus.push({ path, options });
          const result = { action: 'askCodex', path: `${cwd}/${path}`.replaceAll('/', '\\') };
          if (state.menuMode === 'error') throw new Error('Тестовая ошибка меню файла');
          if (state.menuMode === 'deferred') return new Promise(resolve => { state.finishMenu = () => { delete state.finishMenu; resolve(result); }; });
          if (state.menuMode === 'ask') return result;
        },
        async respond() {},
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; },
        async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    make(projects[0]); make(projects[1]);
    window.__panels = fixture;
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd) { return { data: [history(cwd)], nextCursor: null }; },
      async createSession(options = {}) { return make(options.cwd || projects[1]); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
    if (location.search === '?single') delete window.codex.getWorkspace;
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const panel = () => view().locator('.details-panel');
  const files = () => panel().locator('.file-browser');
  const access = () => view().getByRole('combobox', { name: 'Режим доступа', exact: true });
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const activeId = () => view().getAttribute('data-session-id');
  const activeState = async key => page.evaluate(({ id, key }) => window.__panels.sessions[id][key], { id: await activeId(), key });
  const selectWorkspaceTab = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const setMenu = async mode => page.evaluate(({ id, mode }) => { window.__panels.sessions[id].menuMode = mode; }, { id: await activeId(), mode });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const assertComposer = async value => {
    await page.waitForFunction(value => document.querySelector('.session-view:not([hidden]) textarea[aria-label="Сообщение Codex"]')?.value === value, value);
    assert.deepEqual(await composer().evaluate(node => ({ value: node.value, focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd })), { value, focused: true, start: value.length, end: value.length });
  };
  await ready();
  // Workspace may restore its last created tab as active; deliberately start in A.
  await selectWorkspaceTab('session-1');
  await files().waitFor();
  assert.deepEqual(await panel().locator('.panel-tabs button').allTextContents(), ['Файлы', 'Действия', 'Подагенты', 'Изменения']);
  const directory = name => files().getByRole('button', { name: `Раскрыть папку ${name}`, exact: true });
  const fileButton = name => files().getByRole('button', { name: `Открыть файл ${name}`, exact: true });
  await fileButton('README.md').waitFor();
  assert.equal((await activeState('lists')).filter(call => call.path === 'docs').length, 0, 'Nested directories load lazily');
  await directory('docs').click();
  await fileButton('TABS.md').waitFor();
  await page.screenshot({ path: 'artifacts/right-panel-files.png' });
  assert.equal(await directory('docs').getAttribute('aria-expanded'), 'true');
  await fileButton('TABS.md').click();
  await fileButton('TABS.md').click({ button: 'right' });
  assert.deepEqual(await activeState('opens'), ['docs/TABS.md']);
  assert.deepEqual(await activeState('menus'), [{ path: 'docs/TABS.md', options: { askCodex: true } }]);
  // Native menu choices only edit the current draft; paths stay literal and visible.
  const originalDraft = 'Посмотри эти материалы:';
  const chosenFile = 'C:\\Fixtures\\PROJECT_A\\docs\\пример файла [1].txt';
  const chosenDirectory = 'C:\\Fixtures\\PROJECT_A\\docs';
  await composer().fill(originalDraft);
  await setMenu('ask');
  await fileButton('пример файла [1].txt').click({ button: 'right' });
  const withFile = `${originalDraft}\n${chosenFile}\n`;
  await assertComposer(withFile);
  await directory('docs').focus();
  await page.keyboard.press('Shift+F10');
  const withPaths = `${withFile}${chosenDirectory}\n`;
  await assertComposer(withPaths);
  assert.equal(await directory('docs').getAttribute('aria-expanded'), 'true', 'Asking about a directory does not toggle the tree');
  assert.deepEqual((await activeState('menus')).slice(-2), [
    { path: 'docs/пример файла [1].txt', options: { askCodex: true } },
    { path: 'docs', options: { askCodex: true } },
  ]);
  for (const mode of ['cancel', 'reveal']) {
    await setMenu(mode);
    await fileButton('README.md').click({ button: 'right' });
    await settle();
    assert.equal(await composer().inputValue(), withPaths, `${mode} leaves the draft untouched`);
  }
  await setMenu('error');
  await fileButton('README.md').click({ button: 'right' });
  await files().getByRole('alert').filter({ hasText: 'Тестовая ошибка меню файла' }).waitFor();
  assert.equal(await composer().inputValue(), withPaths, 'Menu errors are visible without changing the draft');
  await setMenu('deferred');
  await fileButton('README.md').click({ button: 'right' });
  await page.waitForFunction(() => typeof window.__panels.sessions['session-1'].finishMenu === 'function');
  await selectWorkspaceTab('session-2');
  const secondDraft = 'Отдельный вопрос во второй вкладке';
  await composer().fill(secondDraft);
  await page.evaluate(() => window.__panels.sessions['session-1'].finishMenu());
  await settle();
  assert.equal(await composer().inputValue(), secondDraft, 'Late menu replies never edit another tab');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true, 'Late menu replies never steal focus from another tab');
  await selectWorkspaceTab('session-1');
  assert.equal(await composer().inputValue(), withPaths, 'A menu reply arriving after tab departure is discarded');
  await setMenu('cancel');
  await page.screenshot({ path: 'artifacts/right-panel-ask-codex.png' });
  await directory('docs').click();
  assert.equal(await fileButton('TABS.md').isVisible(), false);
  await directory('docs').click();
  await fileButton('TABS.md').waitFor();
  await directory('empty').click();
  await files().getByText('Папка пуста', { exact: true }).waitFor();
  await directory('retry').click();
  await files().getByText('Тестовая ошибка чтения папки', { exact: true }).waitFor();
  await files().getByRole('button', { name: 'Повторить', exact: true }).click();
  await files().getByText('Тестовая ошибка чтения папки', { exact: true }).waitFor({ state: 'hidden' });
  await files().getByRole('button', { name: 'Показать ещё файлов в PROJECT_A', exact: true }).click();
  await fileButton('second-page.txt').waitFor();
  assert.ok((await activeState('lists')).some(call => call.path === '' && call.cursor === 500));
  const beforeRefresh = (await activeState('lists')).filter(call => call.path === '').length;
  await files().getByRole('button', { name: 'Обновить дерево файлов', exact: true }).click();
  await page.waitForFunction(({ id, count }) => window.__panels.sessions[id].lists.filter(call => call.path === '').length > count, { id: await activeId(), count: beforeRefresh });
  await selectWorkspaceTab('session-2');
  await fileButton('other-project.txt').waitFor();
  await fileButton('other-project.txt').click();
  assert.deepEqual(await activeState('opens'), ['other-project.txt']);
  assert.equal(await fileButton('README.md').count(), 0, 'File tree follows its session cwd');
  await setMenu('ask');
  await fileButton('other-project.txt').click({ button: 'right' });
  await assertComposer(`${secondDraft}\nC:\\Fixtures\\PROJECT_B\\other-project.txt\n`);
  await selectWorkspaceTab('session-1');
  assert.equal(await composer().inputValue(), withPaths, 'Each session retains its own selected paths and draft');
  const project = () => view().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_A"]');
  const projectToggle = () => project().getByRole('button', { name: 'Диалоги папки PROJECT_A', exact: true });
  if (await projectToggle().getAttribute('aria-expanded') !== 'true') await projectToggle().click();
  await project().locator('.folder-thread[data-thread-id="saved-history"]').click();
  await ready();
  await view().getByText('Файлы изменены. Проверьте правую панель.', { exact: true }).waitFor();
  await panel().locator('.panel-tabs button').filter({ hasText: 'Изменения' }).click();
  const groups = () => panel().locator('.change-file');
  await groups().first().waitFor();
  assert.equal(await groups().count(), 3, 'Multiple events for one file become one group');
  assert.equal(await panel().locator('.panel-tabs .count-badge').innerText(), '3', 'Changes badge uses the same canonical file grouping');
  assert.deepEqual(await groups().locator('.change-path').allTextContents(), ['docs/TABS.md', 'src/new.ts', 'src/old.ts']);
  const tabsGroup = () => groups().filter({ has: page.locator('.change-path', { hasText: 'docs/TABS.md' }) });
  await tabsGroup().locator('summary').first().click();
  assert.equal(await tabsGroup().locator('.change-patch').count(), 2, 'Both distinct patches remain available');
  assert.match(await tabsGroup().innerText(), /первое изменение/);
  assert.match(await tabsGroup().innerText(), /второе изменение/);
  assert.match(await tabsGroup().locator('.change-status').first().innerText(), /Изменён/);
  assert.match(await groups().nth(1).locator('.change-status').first().innerText(), /Добавлен/);
  assert.match(await groups().nth(2).locator('.change-status').first().innerText(), /Удалён/);
  assert.equal(await tabsGroup().locator('.change-patch .change-line-counts').count(), 2);
  for (const counts of await tabsGroup().locator('.change-patch .change-line-counts').allTextContents()) assert.match(counts, /\+1.*−1/s);
  // Styled access menu retains normal keyboard navigation and the existing full-access confirmation.
  await access().click();
  const menu = () => view().getByRole('listbox');
  await menu().waitFor();
  assert.equal(await access().getAttribute('aria-expanded'), 'true');
  assert.equal(await menu().getByRole('option').count(), 3);
  assert.equal(await menu().getByRole('option', { selected: true }).count(), 1);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await menu().waitFor({ state: 'hidden' });
  assert.match(await access().innerText(), /Одобрять за меня/);
  assert.equal((await activeState('settings')).access, 'auto');
  await access().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const confirm = () => view().getByRole('alertdialog');
  await confirm().waitFor();
  await confirm().getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.match(await access().innerText(), /Одобрять за меня/);
  assert.equal((await activeState('settings')).access, 'auto');
  await access().click();
  await menu().getByRole('option', { name: /^Полный доступ/ }).click();
  await confirm().getByRole('button', { name: 'Включить полный доступ', exact: true }).click();
  assert.match(await access().innerText(), /Полный доступ/);
  assert.equal((await activeState('settings')).access, 'danger-full-access');
  await access().click();
  await page.keyboard.press('Escape');
  await menu().waitFor({ state: 'hidden' });
  assert.equal(await access().evaluate(node => node === document.activeElement), true, 'Escape returns focus to access trigger');
  await access().click();
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).click();
  await menu().waitFor({ state: 'hidden' });
  await page.evaluate(id => window.__panels.sessions[id].emit('turn/started', { threadId: 'saved-history', turn: { id: 'busy-turn', status: 'inProgress', items: [] } }), await activeId());
  await access().waitFor({ state: 'visible' });
  await page.waitForFunction(id => document.querySelector(`.session-view[data-session-id="${id}"] [aria-label="Режим доступа"]`).disabled, await activeId());
  assert.equal(await access().isDisabled(), true, 'Access remains locked while a turn is running');
  await page.evaluate(id => window.__panels.sessions[id].emit('turn/completed', { threadId: 'saved-history', turn: { id: 'busy-turn', status: 'completed', items: [], error: null } }), await activeId());
  await ready();
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size);
    const overflow = await tabsGroup().evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, diffs: [...node.querySelectorAll('.diff-code')].map(diff => ({ client: diff.clientWidth, scroll: diff.scrollWidth, whiteSpace: getComputedStyle(diff).whiteSpace })) }));
    assert.ok(overflow.scroll <= overflow.width + 1, 'Change group has no horizontal overflow');
    assert.ok(overflow.diffs.every(diff => diff.scroll <= diff.client + 1), 'Long diff lines wrap inside the right panel');
    if (size.width <= 1000) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    await access().click();
    const bounds = await menu().evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, 'Custom access menu fits viewport');
    assert.equal(await menu().evaluate(node => node.tagName === 'SELECT'), false, 'Access options use the app design instead of a native popup');
    await page.screenshot({ path: `artifacts/right-panels-access-${size.width}.png` });
    await page.keyboard.press('Escape');
  }
  assert.equal(await page.evaluate(() => Object.values(window.__panels.sessions).flatMap(state => state.requests).filter(call => /turn\/start|thread\/start/.test(call.method)).length), 0, 'Browsing and changing access never sends a model request');
  await selectWorkspaceTab('session-1');
  await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
  await panel().locator('.panel-tabs button').filter({ hasText: 'Файлы' }).click();
  await setMenu('ask');
  await fileButton('README.md').click({ button: 'right' });
  const narrowDraft = `${withPaths}C:\\Fixtures\\PROJECT_A\\README.md\n`;
  await assertComposer(narrowDraft);
  assert.equal(await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden')), true, 'Choosing a file on a narrow screen makes the composer visible');
  await page.screenshot({ path: 'artifacts/right-panel-ask-codex-940.png' });
  const question = 'Что описано в этих файлах и папке?';
  await page.keyboard.insertText(question);
  const sentText = `${narrowDraft}${question}`;
  const sendingSession = await activeId();
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await page.waitForFunction(id => window.__panels.sessions[id].requests.some(call => call.method === 'turn/start'), sendingSession);
  const sent = (await activeState('requests')).filter(call => call.method === 'turn/start');
  assert.equal(sent.length, 1, 'Only the explicit send button starts a turn');
  assert.deepEqual(sent[0].params.input, [{ type: 'text', text: sentText, text_elements: [] }], 'All visible selected paths and the user question are sent as ordinary text');
  assert.equal(sent[0].params.cwd, 'C:/Fixtures/PROJECT_A');
  assert.equal(sent[0].params.model, 'fixture-alpha');
  assert.equal(sent[0].params.effort, 'high');
  assert.equal(await page.evaluate(() => window.__panels.sessions['session-2'].requests.filter(call => call.method === 'turn/start').length), 0, 'Sending the question does not affect the other session');
  await page.evaluate(id => window.__panels.sessions[id].emit('turn/completed', { threadId: `new-${id}`, turn: { id: `sent-${id}`, status: 'completed', items: [], error: null } }), sendingSession);
  await ready();
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
  await panel().locator('.panel-tabs button').filter({ hasText: 'Файлы' }).click();
  // Closing the originating session also invalidates a still-open menu.
  await setMenu('deferred');
  await fileButton('README.md').click({ button: 'right' });
  await page.waitForFunction(() => typeof window.__panels.sessions['session-1'].finishMenu === 'function');
  await page.locator('.session-tab[data-session-id="session-1"] .session-tab-close').click();
  await selectWorkspaceTab('session-2');
  const preservedSecond = await composer().inputValue();
  await composer().focus();
  await page.evaluate(() => window.__panels.sessions['session-1'].finishMenu());
  await settle();
  assert.equal(await composer().inputValue(), preservedSecond, 'A closed session cannot append to the remaining session');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true);
  // The legacy single-session view permits changing cwd without changing bridge.
  await page.goto(`http://127.0.0.1:${server.address().port}/?single`);
  const singleComposer = page.getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  await page.getByRole('button', { name: 'Открыть файл README.md', exact: true }).waitFor();
  await singleComposer.fill('Черновик при смене папки');
  await page.evaluate(() => { window.__panels.sessions['session-1'].menuMode = 'deferred'; });
  await page.getByRole('button', { name: 'Открыть файл README.md', exact: true }).click({ button: 'right' });
  await page.waitForFunction(() => typeof window.__panels.sessions['session-1'].finishMenu === 'function');
  await page.locator('.project-card').click();
  await page.getByRole('button', { name: 'Открыть файл other-project.txt', exact: true }).waitFor();
  const afterDirectoryChange = await singleComposer.inputValue();
  await singleComposer.focus();
  await page.evaluate(() => window.__panels.sessions['session-1'].finishMenu());
  await settle();
  assert.equal(await singleComposer.inputValue(), afterDirectoryChange, 'A reply for the old cwd is discarded even when the bridge is unchanged');
  assert.equal(await singleComposer.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.__panels.sessions['session-1'].requests.filter(call => /turn\/start|thread\/start/.test(call.method)).length), 0, 'Directory changes and stale menu replies do not send a prompt');
  assert.deepEqual(errors, []);
  console.log('PASS: scoped lazy file trees/open/reveal/refresh/errors/paging, Ask Codex files/folders/Unicode/keyboard/draft preservation/focus/cancel/errors, stale replies after tab/cwd/session changes, narrow-screen composer visibility and explicit question submission; grouped wrapped patches and access controls at 1440/940. Production renderer with fake scoped bridges; one fixture turn, no real model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/right-panels-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
