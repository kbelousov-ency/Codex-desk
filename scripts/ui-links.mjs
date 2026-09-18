import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Real production renderer with scoped fake bridges; never opens files or a model connection.
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const sessions = {};
    const models = [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    for (const letter of ['A', 'B']) {
      const id = `session-${letter}`;
      const cwd = `C:/Fixtures/PROJECT_${letter}`;
      const state = { id, cwd, actions: [], requests: [], listeners: new Set(), openError: '', menuError: '' };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() { return { initialize: {}, models, cwd, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'workspace-write' }; },
        async setSettings() {},
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: 'shared-thread', cwd, turns: [] }, model: 'fixture' };
          if (method === 'turn/start') return { turn: { id: 'shared-turn', status: 'inProgress', items: [] } };
          throw new Error(`Unexpected fixture request ${method}`);
        },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async respond() {}, async chooseDirectory() { return null; }, async chooseExecutable() { return null; },
        async saveImages() { return []; }, async readAttachment() { return null; },
        async openPath(href) {
          state.actions.push({ kind: 'open', href, cwd });
          if (state.openError) throw new Error(state.openError);
        },
        async showPathMenu(href) {
          state.actions.push({ kind: 'menu', href, cwd });
          if (state.menuError) throw new Error(state.menuError);
        },
      };
      sessions[id] = state;
    }
    window.__links = { sessions };
    window.codex = {
      ...sessions['session-A'].bridge,
      async getWorkspace() { return { projects: Object.values(sessions).map(s => s.cwd), sessions: Object.values(sessions).map(({ id, cwd }) => ({ id, cwd })) }; },
      forSession(id) { return sessions[id].bridge; },
      async createSession() { throw new Error('Unexpected createSession'); }, async closeSession() {},
      async openPath() { throw new Error('Unscoped openPath must not be used'); },
      async showPathMenu() { throw new Error('Unscoped showPathMenu must not be used'); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const activate = async id => {
    await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
    await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, id);
    await ready();
  };
  const actions = id => page.evaluate(id => window.__links.sessions[id].actions, id);
  const cases = [
    ['Посмотреть интерфейс', 'E:/My projects/CodexDesk/artifacts/x.png'],
    ['Актуальный Codex Desk.exe', '/E:/My projects/CodexDesk/release/win-unpacked/Codex Desk.exe'],
    ['Относительный файл', 'docs/My%20Report.md'],
    ['Файл с кириллицей', 'file:///E:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82/%D0%A4%D0%B0%D0%B9%D0%BB.txt'],
    ['Строка исходника', '/E:/My projects/CodexDesk/src/App.tsx:48'],
    ['Строка README', 'README.md:12'],
    ['Строка и столбец Python', 'main.py:20:4'],
    ['Документация', 'https://example.test/docs?q=codex'],
  ];
  const blocked = [
    ['JavaScript запрещён', 'javascript:alert%281%29'],
    ['Числовой JavaScript запрещён', 'javascript:123'],
    ['Data запрещён', 'data:text/html,test'],
    ['VBScript запрещён', 'vbscript:msgbox%281%29'],
    ['Произвольная схема запрещена', 'customapp:launch'],
  ];
  const markdown = '# Файлы из ответа Codex\n\n' + [...cases, ...blocked].map(([label, href]) => `- [${label}](<${href}>)`).join('\n');
  const populate = async id => {
    await ready();
    await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Покажи ссылки');
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await page.waitForFunction(id => window.__links.sessions[id].requests.some(request => request.method === 'turn/start'), id);
    await page.evaluate(({ id, markdown }) => {
      const state = window.__links.sessions[id];
      const context = { threadId: 'shared-thread', turnId: 'shared-turn' };
      state.emit('turn/started', { threadId: context.threadId, turn: { id: context.turnId, status: 'inProgress', items: [] } });
      state.emit('item/completed', { ...context, item: { id: 'links-answer', type: 'agentMessage', text: markdown } });
      state.emit('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
    }, { id, markdown });
    await view().getByText('Посмотреть интерфейс', { exact: true }).waitFor();
  };
  const link = label => view().locator('.markdown-link').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  const checkAction = async (id, kind, label, href, trigger) => {
    const before = await actions(id);
    await trigger(link(label));
    await page.waitForFunction(({ id, length }) => window.__links.sessions[id].actions.length === length, { id, length: before.length + 1 });
    const after = await actions(id);
    assert.equal(after.at(-1).kind, kind);
    assert.equal(decodeURIComponent(after.at(-1).href), decodeURIComponent(href));
    assert.equal(after.at(-1).cwd, `C:/Fixtures/PROJECT_${id.at(-1)}`);
  };

  await populate('session-A');
  assert.deepEqual(await actions('session-A'), [], 'Rendering must not open or reveal links');
  assert.deepEqual(await actions('session-B'), []);
  for (const [label, href] of cases) {
    await checkAction('session-A', 'open', label, href, element => element.click());
    if (!href.startsWith('https:')) await checkAction('session-A', 'menu', label, href, element => element.click({ button: 'right' }));
  }
  const beforeWebMenu = await actions('session-A');
  await link('Документация').click({ button: 'right' });
  await page.keyboard.press('Escape');
  assert.deepEqual(await actions('session-A'), beforeWebMenu, 'Web context menu must not invoke a file action');
  await checkAction('session-A', 'open', ...cases[0], async element => { await element.focus(); await page.keyboard.press('Enter'); });

  const beforeBlocked = await actions('session-A');
  for (const [label] of blocked) {
    const text = view().getByText(label, { exact: true });
    await text.dispatchEvent('click');
    await text.dispatchEvent('contextmenu');
  }
  assert.deepEqual(await actions('session-A'), beforeBlocked, 'Blocked schemes must never reach the bridge');

  await page.evaluate(() => { window.__links.sessions['session-A'].openError = 'Не удалось открыть: файл отсутствует'; });
  await link(cases[0][0]).click();
  await view().getByRole('alert').filter({ hasText: 'Не удалось открыть: файл отсутствует' }).waitFor();
  await page.evaluate(() => { window.__links.sessions['session-A'].openError = ''; window.__links.sessions['session-A'].menuError = 'Не удалось показать файл в проводнике'; });
  await link(cases[1][0]).click({ button: 'right' });
  await view().getByRole('alert').filter({ hasText: 'Не удалось показать файл в проводнике' }).waitFor();

  const frozenA = await actions('session-A');
  await activate('session-B');
  await populate('session-B');
  assert.deepEqual(await actions('session-B'), []);
  await checkAction('session-B', 'open', ...cases[2], element => element.click());
  await checkAction('session-B', 'menu', ...cases[2], element => element.click({ button: 'right' }));
  assert.deepEqual(await actions('session-A'), frozenA, 'Tab B must use its own bridge and working folder');
  await activate('session-A');
  await page.screenshot({ path: 'artifacts/links-browser.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: rendered Markdown file/EXE, relative/encoded/Unicode/file-URL/line links, click/Enter, local context callback, web links, blocked schemes, visible action errors and scoped tab isolation. Fake bridges only; no shell, Electron IPC or model requests.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/links-browser-failure.png' });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
