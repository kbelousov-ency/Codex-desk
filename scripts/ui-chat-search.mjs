import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with disposable, independent bridge fixtures. No real
// Codex request, user history change, model turn, or filesystem link is made.
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
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const outside = 'C:/Fixtures/OTHER_PROJECT';
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const user = (id, text, withImage = false) => ({ id, type: 'userMessage', content: [{ type: 'text', text }, ...(withImage ? [{ type: 'image', url: image }] : [])] });
    const answer = (id, text) => ({ id, type: 'agentMessage', phase: 'final_answer', text });
    const turn = (id, items) => ({ id, status: 'completed', durationMs: 12000, items });
    const threads = {
      'chat-a': { id: 'chat-a', name: 'Основной поиск A', cwd: projects[0], archived: false, historyMode: 'legacy', turns: [
        turn('turn-a1', [user('user-a1', 'Поиск: ИГЛА и ещё игла. Проверим вид сообщений.', true),
          { id: 'reason-a', type: 'reasoning', summary: ['Уточнение: внутри размышлений встречается тайник.'], content: [] },
          { id: 'tool-a', type: 'commandExecution', command: 'node --check fixture.js', status: 'completed', exitCode: 0, aggregatedOutput: 'Вывод инструмента: потайной результат', encrypted_content: 'СЕКРЕТ_НЕ_ИСКАТЬ' },
          answer('answer-a1', 'Готово: игла найдена. **Выделение** сохраняется.\n\n[Файл **поиска**](src/search.ts:7)\n\n```js\nconst literal = "a+b[0]";\n```')]),
        turn('turn-a2', [user('user-a2', 'Продолжим проверку интерфейса'), answer('answer-a2', 'Второй ответ остаётся читаемым.')]),
      ] },
      'chat-b': { id: 'chat-b', name: 'Поиск в проекте B', cwd: projects[1], archived: false, historyMode: 'legacy', turns: [turn('turn-b', [user('user-b', 'Уникальный вопрос B'), answer('answer-b', 'Скрытый диалог: игла, игла, игла и маркер_другого_чата.')])] },
      'search-a': { id: 'search-a', name: 'Найти настройку A', cwd: projects[0], archived: false, historyMode: 'legacy', turns: [turn('search-turn-a', [answer('search-answer-a', 'Найденный диалог A')])] },
      'search-outside': { id: 'search-outside', name: 'Найти внешний проект', cwd: outside, archived: false, historyMode: 'legacy', turns: [turn('search-turn-outside', [answer('search-answer-outside', 'Диалог вне списка проектов')])] },
      'search-next': { id: 'search-next', name: 'Найти ещё один диалог', cwd: projects[1], archived: false, historyMode: 'legacy', turns: [turn('search-turn-next', [answer('search-answer-next', 'Дополнительный диалог')])] },
      'archive-a': { id: 'archive-a', name: 'Найти архивную историю', cwd: outside, archived: true, historyMode: 'paginated', turns: [] },
    };
    for (const thread of Object.values(threads)) { thread.preview = thread.name; thread.updatedAt = 1789644000; }
    const sessions = {}, calls = [];
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    let serial = 0;
    const fixture = window.__search = { projects, outside, sessions, threads, calls, held: {}, holdQuery: '', failQuery: '' };
    const clone = value => structuredClone(value);
    const create = cwd => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' } };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          calls.push({ method, params: clone(params), sessionId: id });
          if (method === 'thread/list') return { data: Object.values(threads).filter(t => !t.archived && t.cwd === cwd).map(clone), nextCursor: null };
          if (method === 'thread/resume') {
            const thread = threads[params.threadId];
            if (!thread || thread.archived || thread.cwd !== cwd) throw new Error('Fixture refuses wrong resume scope');
            return { thread: clone(thread), model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          throw new Error(`Search must not call ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; },
        async openPath(target) { calls.push({ method: 'openPath', target, sessionId: id }); }, async showPathMenu(target) { calls.push({ method: 'showPathMenu', target, sessionId: id }); },
        async readAttachment() { return null; }, async saveImages() { return []; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]); create(projects[1]);
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(s => !s.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd) { return { data: Object.values(threads).filter(t => !t.archived && t.cwd === cwd).map(clone), nextCursor: null }; },
      async listArchivedThreads() { return { data: Object.values(threads).filter(t => t.archived).map(clone), nextCursor: null }; },
      async searchThreads(params) {
        calls.push({ method: 'searchThreads', params: clone(params) });
        if (fixture.holdQuery === params.query) await new Promise(resolve => { fixture.held[params.query] = resolve; });
        if (fixture.failQuery === params.query) throw new Error('Ошибка тестового поиска');
        if (params.query === 'устаревший') return { data: [clone({ ...threads['search-a'], name: 'Устаревший результат' })], nextCursor: null };
        const matched = Object.values(threads).filter(t => t.archived === params.archived && t.name.toLowerCase().includes(params.query.toLowerCase()));
        return { data: matched.slice(params.cursor ? 2 : 0, params.cursor ? 4 : 2).map(clone), nextCursor: !params.cursor && matched.length > 2 ? 'search-page-2' : null };
      },
      async readArchivedThread(params) {
        calls.push({ method: 'readArchivedThread', params: clone(params) });
        if (params.threadId !== 'archive-a') throw new Error('Unexpected archive ID');
        const items = params.cursor ? [user('archive-old-user', 'Архивный ранний вопрос'), answer('archive-old-answer', 'Ранний маркер: давнишний')] : [answer('archive-recent', 'Архивный последний ответ')];
        return { thread: clone(threads['archive-a']), items: items.map(item => ({ ...item, turnId: `turn-${item.id}`, complete: true })), turns: [], nextCursor: params.cursor ? null : 'earlier-archive' };
      },
      async createSession({ cwd = projects[0] } = {}) { calls.push({ method: 'createSession', cwd }); return create(cwd); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      async manageThread() { throw new Error('Search cannot mutate history'); },
      async openArchivedPath(params) { calls.push({ method: 'openArchivedPath', params }); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const sidebar = () => view().locator('.sidebar');
  const row = id => sidebar().locator(`.folder-thread[data-thread-id="${id}"]`);
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const find = () => view().getByRole('textbox', { name: 'Найти в чате', exact: true });
  const count = () => view().locator('.chat-search-count');
  const flush = () => page.waitForTimeout(100);
  const calls = () => page.evaluate(() => window.__search.calls);
  const until = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, label); await page.waitForTimeout(40); } };
  const query = async (text, expected) => { await find().fill(text); await until(async () => (await count().innerText()).includes(expected), `Count for ${text}: ${expected}`); await flush(); };
  const highlights = () => page.evaluate(() => ({ all: CSS.highlights.get('chat-search-results')?.size || 0, current: CSS.highlights.get('chat-search-current')?.size || 0 }));
  const chatSession = async id => {
    if (!await row(id).count()) {
      const cwd = await page.evaluate(id => window.__search.threads[id].cwd, id);
      const folder = sidebar().getByRole('button', { name: `Диалоги папки ${cwd.split('/').at(-1)}`, exact: true });
      if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
    }
    await row(id).click(); await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await until(() => input().isEnabled(), `Ready ${id}`); return view().getAttribute('data-session-id');
  };
  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await row('chat-a').waitFor();
  const sessionA = await chatSession('chat-a');
  await view().locator('[data-item-id="answer-a2"]').waitFor();
  await input().fill('Черновик должен остаться');
  const imageBefore = await view().locator('.message-images img').getAttribute('src');
  assert.ok(imageBefore.startsWith('data:image/png;'));
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size); await flush();
    const geometry = await view().evaluate(node => {
      const bounds = selector => { const { left, right, width } = node.querySelector(selector).getBoundingClientRect(); return { left, right, width }; };
      return { user: bounds('[data-item-id="user-a2"]'), answer: bounds('[data-item-id="answer-a2"]'), conversation: bounds('.conversation'), panel: bounds('.details-panel'), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.ok(geometry.user.left > geometry.answer.left + 20, `User bubble begins to the right at ${size.width}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.user.right > geometry.answer.right + 10, `User bubble ends to the right at ${size.width}: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.overflow, false, `No document overflow at ${size.width}`);
    assert.ok(!geometry.panel.width || geometry.conversation.right <= geometry.panel.left + 1, `Chat cannot be obscured by the side panel at ${size.width}: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: `artifacts/messenger-${size.width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await input().focus(); await page.keyboard.press('Control+f'); await find().waitFor();
  assert.equal(await find().evaluate(node => node === document.activeElement), true, 'Ctrl+F focuses active chat search');
  await query('игла', '1 из 3');
  assert.deepEqual(await highlights(), { all: 3, current: 1 });
  await find().press('Enter'); await until(async () => (await count().innerText()).includes('2 из 3'), 'Enter moves forward');
  await find().press('Shift+Enter'); await until(async () => (await count().innerText()).includes('1 из 3'), 'Shift Enter moves backward');
  await find().press('Shift+Enter'); await until(async () => (await count().innerText()).includes('3 из 3'), 'Backward navigation wraps');
  assert.equal(await view().locator('[data-item-id="answer-a1"][data-chat-search-current="true"]').count(), 1);
  await query('a+b[0]', '1 из 1');
  assert.deepEqual(await highlights(), { all: 1, current: 1 }, 'Code query is literal, not a regexp');
  assert.equal(await view().locator('pre code').innerText(), 'const literal = "a+b[0]";\n');
  await query('Файл поиска', '1 из 1');
  const link = view().getByRole('link', { name: 'Файл поиска', exact: true });
  await link.click(); await link.click({ button: 'right' });
  assert.deepEqual((await calls()).filter(c => ['openPath', 'showPathMenu'].includes(c.method)).map(c => [c.method, c.target, c.sessionId]), [['openPath', 'src/search.ts:7', sessionA], ['showPathMenu', 'src/search.ts:7', sessionA]]);
  assert.equal(await view().locator('.message-images img').getAttribute('src'), imageBefore, 'Searching leaves attachment intact');
  assert.equal(await view().locator('.markdown strong').first().innerText(), 'Выделение');
  await query('тайник', '1 из 1');
  assert.equal(await view().locator('.work-log[data-turn-id="turn-a1"]').evaluate(node => node.open), true, 'Search opens matching collapsed work log');
  await query('потайной', '1 из 1');
  assert.equal(await view().locator('[data-item-id="tool-a"]').evaluate(node => node.open), true, 'Search reveals matching command output');
  await query('СЕКРЕТ_НЕ_ИСКАТЬ', 'Нет совпадений');
  await view().getByRole('button', { name: 'Очистить поиск по чату', exact: true }).click();
  assert.equal(await find().inputValue(), '');
  assert.deepEqual(await highlights(), { all: 0, current: 0 });
  assert.equal(await view().locator('.work-log[data-turn-id="turn-a1"]').evaluate(node => node.open), false, 'Clearing restores work log disclosure');
  await find().press('Escape');
  assert.equal(await find().count(), 0);
  assert.equal(await input().inputValue(), 'Черновик должен остаться');

  // A mounted but inactive session cannot receive the shortcut or pollute hits.
  const sessionB = await chatSession('chat-b');
  await view().locator('[data-item-id="answer-b"]').waitFor();
  await page.keyboard.press('Control+f'); await query('маркер_другого_чата', '1 из 1');
  await page.locator(`.session-tab[data-session-id="${sessionA}"] [role="tab"]`).click();
  await page.keyboard.press('Control+f'); await query('маркер_другого_чата', 'Нет совпадений');
  await query('игла', '1 из 3');
  assert.deepEqual(await highlights(), { all: 3, current: 1 }, 'Only active chat owns CSS highlights');
  await find().press('Escape');
  assert.equal(await page.locator(`.session-tab[data-session-id="${sessionB}"]`).count(), 1, 'Other chat remains open');

  // Search history is global by title and separate from current chat contents.
  const searchInput = () => sidebar().getByRole('textbox', { name: 'Поиск диалогов', exact: true });
  const results = () => sidebar().getByRole('navigation', { name: 'Результаты поиска диалогов', exact: true });
  await searchInput().fill('Найти');
  await results().locator('[data-thread-id="search-outside"]').waitFor();
  assert.equal(await results().locator('.dialog-search-folder').count(), 2);
  assert.equal(await results().locator('[data-thread-id="search-next"]').count(), 0);
  await results().getByRole('button', { name: 'Загрузить ещё', exact: true }).click();
  await results().locator('[data-thread-id="search-next"]').waitFor();
  assert.equal(await results().locator('.dialog-search-folder').count(), 3);
  assert.deepEqual((await calls()).filter(c => c.method === 'searchThreads').slice(-2).map(c => c.params), [{ query: 'Найти', archived: false }, { query: 'Найти', archived: false, cursor: 'search-page-2' }]);
  await page.screenshot({ path: 'artifacts/dialog-search-1440.png' });
  await page.evaluate(() => { window.__search.holdQuery = 'устаревший'; });
  await searchInput().fill('устаревший');
  await until(() => page.evaluate(() => Boolean(window.__search.held['устаревший'])), 'Old search sent');
  await searchInput().fill('настройку');
  await results().locator('[data-thread-id="search-a"]').waitFor();
  await page.evaluate(() => { window.__search.held['устаревший'](); }); await flush();
  assert.doesNotMatch(await results().innerText(), /Устаревший результат/, 'Late old response cannot replace current query');
  await page.evaluate(() => { window.__search.failQuery = 'ошибка'; });
  await searchInput().fill('ошибка');
  await sidebar().getByRole('alert').filter({ hasText: 'Ошибка тестового поиска' }).waitFor();
  await searchInput().fill('невозможный_диалог');
  await until(async () => (await calls()).some(c => c.method === 'searchThreads' && c.params.query === 'невозможный_диалог'), 'Empty search resolved'); await flush();
  assert.equal(await results().locator('[data-thread-id]').count(), 0);
  const beforeClear = (await calls()).filter(c => ['thread/resume', 'createSession'].includes(c.method));
  await sidebar().getByRole('button', { name: 'Очистить поиск диалогов', exact: true }).click();
  await row('chat-a').waitFor();
  assert.deepEqual((await calls()).filter(c => ['thread/resume', 'createSession'].includes(c.method)), beforeClear, 'Clearing search has no session effects');
  await searchInput().fill('внешний'); await results().locator('[data-thread-id="search-outside"]').click();
  await view().locator('[data-item-id="search-answer-outside"]').waitFor();
  assert.equal((await calls()).filter(c => c.method === 'thread/resume').at(-1).params.threadId, 'search-outside');
  assert.equal((await calls()).filter(c => c.method === 'createSession').at(-1).cwd, 'C:/Fixtures/OTHER_PROJECT');

  await sidebar().getByRole('button', { name: 'Архив', exact: true }).click();
  const archiveSearch = () => sidebar().getByRole('textbox', { name: 'Поиск в архиве', exact: true });
  await archiveSearch().fill('Найти');
  await results().locator('[data-thread-id="archive-a"]').waitFor();
  const beforeArchive = (await calls()).filter(c => ['thread/resume', 'createSession'].includes(c.method));
  await results().locator('[data-thread-id="archive-a"]').click();
  await view().locator('[data-item-id="archive-recent"]').waitFor();
  assert.equal(await input().count(), 0);
  assert.deepEqual((await calls()).filter(c => ['thread/resume', 'createSession'].includes(c.method)), beforeArchive, 'Archive search opens a read-only view');
  await page.keyboard.press('Control+f'); await query('давнишний', 'Нет совпадений');
  await view().getByRole('button', { name: 'Искать в более ранних сообщениях', exact: true }).click();
  await until(async () => (await count().innerText()).includes('1 из 1'), 'Earlier archive page becomes searchable');
  assert.deepEqual((await calls()).filter(c => c.method === 'readArchivedThread').map(c => c.params), [{ threadId: 'archive-a' }, { threadId: 'archive-a', cursor: 'earlier-archive' }]);
  assert.equal(await input().count(), 0);
  await page.setViewportSize({ width: 940, height: 640 });
  await page.screenshot({ path: 'artifacts/chat-search-archive-940.png' });
  assert.deepEqual((await calls()).filter(c => ['thread/resume', 'createSession'].includes(c.method)), beforeArchive);
  assert.equal((await calls()).filter(c => ['turn/start', 'thread/start', 'thread/compact/start', 'manageThread'].includes(c.method)).length, 0, 'All searches are passive');
  assert.deepEqual(errors, []);
  console.log('PASS: messenger bubble geometry 1440/940px, scoped Ctrl+F, literal Cyrillic/code search, hit navigation, link/image preservation, work log/tool reveal/restore, hidden tab isolation, global title search, pagination/stale/error/clear, exact resume, archive read-only and earlier messages. Fixture bridges only; no real Codex/model/history.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/chat-search-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
