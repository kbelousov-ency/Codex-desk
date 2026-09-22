import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, disposable read-only history bridges and local bookmark
// storage. No real CLI, model turn, personal history or project files are used.
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
  page.setDefaultTimeout(12_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/LIBRARY_A', 'C:/Fixtures/LIBRARY_B'];
    const claudeId = 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const clone = value => structuredClone(value);
    const answer = (id, text) => ({ id, type: 'agentMessage', phase: 'final_answer', text });
    const turn = (id, items) => ({ id, status: 'completed', durationMs: 1200, items });
    const recoveredClaude = localStorage.getItem('history-library-fixture-recovered') || '';
    const claudeText = 'Игла: a+b[0]. Ответ Claude из другой беседы.';
    const threads = {
      main: { id: 'main', name: 'Решения Codex', provider: 'codex', cwd: projects[0], historyMode: 'legacy', turns: [turn('main-turn', [
        { id: 'main-user', type: 'userMessage', content: [{ type: 'text', text: 'Проверим кириллицу и поиск a+b[0]' }] },
        answer('main-answer', 'Игла: a+b[0]. Согласованное решение для будущей закладки.'),
      ])] },
      [claudeId]: { id: claudeId, name: 'Решения Claude', provider: 'claude', cwd: projects[0], historyMode: 'legacy', turns: [turn('claude-turn', [answer(recoveredClaude ? 'api:text:0' : 'api:text:1', claudeText), ...(recoveredClaude === 'collision' ? [answer('api:text:1', 'Другой фрагмент ответа: этот совпавший ID нельзя подсветить.')] : [])])] },
      paged: { id: 'paged', name: 'Давний диалог', provider: 'codex', cwd: projects[0], historyMode: 'paginated', turns: [] },
      archive: { id: 'archive', name: 'Архивная инструкция', archived: true, provider: 'codex', cwd: projects[0], historyMode: 'paginated', turns: [] },
      moving: { id: 'moving', name: 'Меняющий состояние диалог', archived: localStorage.getItem('history-library-fixture-moving-archived') === 'yes', provider: 'codex', cwd: projects[0], historyMode: 'legacy', turns: [turn('moving-turn', [answer('moving-answer', 'Перемещение между обычной историей и архивом сохраняет закладку.')])] },
      other: { id: 'other', name: 'Другой проект', provider: 'codex', cwd: projects[1], historyMode: 'legacy', turns: [turn('other-turn', [answer('other-answer', 'Игла: a+b[0]. Решение второго проекта.')])] },
    };
    for (const thread of Object.values(threads)) { thread.preview = thread.name; thread.updatedAt = 1789820000; }
    const sessions = {}, calls = [];
    let serial = 0, bookmarkSerial = 0;
    const fixture = window.__library = { projects, threads, sessions, calls, claudeId, held: {}, holdQuery: '', failQuery: '', failBookmarkCwd: '' };
    const saved = () => JSON.parse(localStorage.getItem('history-library-fixture-bookmarks') || '[]');
    const persist = entries => localStorage.setItem('history-library-fixture-bookmarks', JSON.stringify(entries));
    const create = (cwd, provider = 'codex') => {
      const id = `session-${++serial}`;
      const model = provider === 'claude' ? 'fixture-claude' : 'fixture-codex';
      const models = [{ id: model, model, displayName: model, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], inputModalities: ['text', 'image'] }];
      const state = { id, cwd, provider, closed: false, settings: { cwd, provider, model, effort: 'medium', access: 'workspace-write' }, listeners: new Set() };
      state.bridge = {
        async start() { return { initialize: {}, provider, cwd, models, executable: 'fixture.exe', account: { account: null }, config: { model, model_reasoning_effort: 'medium' }, capabilities: { compact: provider === 'codex', steer: provider === 'codex', terminal: true, mcp: provider === 'codex', threadManagement: provider === 'codex' } }; },
        async getSettings() { return clone(state.settings); }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          calls.push({ method, params: clone(params), sessionId: id, provider });
          if (method === 'thread/list') return { data: Object.values(threads).filter(t => !t.archived && t.cwd === cwd && t.provider === provider).map(clone), nextCursor: null };
          if (method === 'thread/resume' || method === 'thread/read') {
            const thread = threads[params.threadId];
            if (!thread || thread.cwd !== cwd || thread.provider !== provider) throw new Error('Fixture refuses wrong provider or project');
            if (method === 'thread/resume' && thread.archived) throw new Error('Cannot resume archived source');
            return { thread: clone(thread), model, reasoningEffort: 'medium' };
          }
          if (method === 'thread/items/list' && params.threadId === 'paged') return { data: (params.cursor ? [answer('paged-target', 'Игла: a+b[0]. Древний ответ, найденный на второй странице.')] : [answer('paged-latest', 'Последняя страница без целевого ответа.')]).map(item => ({ item, turnId: params.cursor ? 'paged-old-turn' : 'paged-new-turn' })), nextCursor: params.cursor ? null : 'older-items' };
          if (method === 'thread/turns/list' && params.threadId === 'paged') return { data: [turn('paged-new-turn', []), turn('paged-old-turn', [])], nextCursor: null };
          throw new Error(`History library must not call ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; },
        async openPath() {}, async showPathMenu() {}, async readAttachment() { return null; }, async saveImages() { return []; },
      };
      sessions[id] = state; return { id, cwd, provider };
    };
    create(projects[0]);
    const target = (threadId, itemId, turnId, snippet) => ({ thread: clone(threads[threadId]), cwd: threads[threadId].cwd, provider: threads[threadId].provider, itemId, turnId, snippet });
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(s => !s.closed).map(({ id, cwd, provider }) => ({ id, cwd, provider })) }; },
      async listProjectThreads(cwd) { return { data: Object.values(threads).filter(t => !t.archived && t.cwd === cwd).map(clone), nextCursor: null }; },
      async listArchivedThreads() { return { data: [clone(threads.archive)], nextCursor: null }; },
      async readArchivedThread(params) { calls.push({ method: 'readArchivedThread', params: clone(params) }); if (params.threadId === 'moving' && threads.moving.archived) return { thread: clone(threads.moving), items: threads.moving.turns[0].items.map(item => ({ ...clone(item), turnId: 'moving-turn', complete: true })), turns: clone(threads.moving.turns), nextCursor: null }; if (params.threadId !== 'archive') throw new Error('Wrong archive'); return { thread: clone(threads.archive), items: [answer(params.cursor ? 'archive-target' : 'archive-latest', params.cursor ? 'Историческая игла в архиве.' : 'Последний архивный ответ.')].map(item => ({ ...item, turnId: params.cursor ? 'archive-old-turn' : 'archive-latest-turn', complete: true })), turns: [], nextCursor: params.cursor ? null : 'archive-earlier' }; },
      async resolveHistoryTarget(params) { calls.push({ method: 'resolveHistoryTarget', params: clone(params) }); const thread = threads[params.threadId]; if (!thread || thread.cwd !== params.cwd || thread.provider !== params.provider) throw new Error('Источник не найден в выбранном проекте'); return clone(thread); },
      async createSession(options = {}) { calls.push({ method: 'createSession', options: clone(options) }); return create(options.cwd || projects[0], options.provider || options.settings?.provider || 'codex'); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      async searchHistory(params) {
        calls.push({ method: 'searchHistory', params: clone(params) });
        if (fixture.holdQuery === params.query) await new Promise(resolve => { fixture.held[params.query] = resolve; });
        if (fixture.failQuery === params.query) throw new Error('Ошибка чтения тестовой истории');
        if (params.query === 'пропавший') return { matches: [target('main', 'missing-message', 'main-turn', 'Пропавший исходный ответ')], nextCursor: null, scannedThreads: 1, scannedPages: 1 };
        if (params.query === 'архив') return { matches: [{ ...target('archive', 'archive-target', 'archive-old-turn', 'Историческая игла в архиве.'), archived: true }], nextCursor: null, scannedThreads: 1, scannedPages: 1 };
        if (params.query === 'устаревший') return { matches: [target('main', 'main-answer', 'main-turn', 'УСТАРЕВШИЙ РЕЗУЛЬТАТ')], nextCursor: null, scannedThreads: 1, scannedPages: 1 };
        if (params.query !== 'Игла: a+b[0]') return { matches: [], nextCursor: null, scannedThreads: 4, scannedPages: 4 };
        const all = [target('main', 'main-answer', 'main-turn', 'Игла: a+b[0]. Согласованное решение.'), target(claudeId, 'api:text:1', 'claude-turn', 'Игла: a+b[0]. Ответ Claude.'), target('paged', 'paged-target', 'paged-old-turn', 'Игла: a+b[0]. Древний ответ.'), target('other', 'other-answer', 'other-turn', 'Игла: a+b[0]. Другой проект.')].filter(t => t.cwd === params.cwd && (params.provider === 'all' || t.provider === params.provider));
        const offset = params.cursor ? 2 : 0;
        return { matches: all.slice(offset, offset + 2), nextCursor: offset + 2 < all.length ? 'next-library-page' : null, scannedThreads: Math.min(offset + 2, all.length), scannedPages: params.cursor ? 2 : 1, warnings: [] };
      },
      async listBookmarks(params = {}) { calls.push({ method: 'listBookmarks', params: clone(params) }); if (params.cwd === fixture.failBookmarkCwd) throw new Error('Ошибка списка закладок другого проекта'); return saved().filter(b => (!params.cwd || b.cwd === params.cwd) && (!params.provider || params.provider === 'all' || b.provider === params.provider)); },
      async saveBookmark(value) {
        calls.push({ method: 'saveBookmark', value: clone(value) });
        const all = saved(); const index = all.findIndex(b => b.id === value.id || (b.threadId === value.threadId && b.itemId === value.itemId));
        const bookmark = { ...value, id: index >= 0 ? all[index].id : `bookmark-${Date.now()}-${++bookmarkSerial}`, createdAt: index >= 0 ? all[index].createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (index >= 0) all[index] = bookmark; else all.push(bookmark); persist(all); return clone(bookmark);
      },
      async removeBookmark(id) { calls.push({ method: 'removeBookmark', id }); persist(saved().filter(b => b.id !== id)); return { removed: true }; },
      async manageThread() { throw new Error('History library cannot mutate native history'); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const dialog = () => page.getByRole('dialog', { name: 'История и закладки', exact: true });
  const queryInput = () => dialog().getByRole('textbox', { name: 'Поиск по содержимому истории', exact: true });
  const draft = () => view().locator('.composer textarea');
  const calls = method => page.evaluate(method => window.__library.calls.filter(call => call.method === method), method);
  const until = async (predicate, label) => { const deadline = Date.now() + 12000; while (!await predicate()) { assert.ok(Date.now() < deadline, label); await page.waitForTimeout(40); } };
  const open = async () => { await view().getByRole('button', { name: 'История и закладки', exact: true }).click(); await queryInput().waitFor(); };
  const close = () => dialog().getByRole('button', { name: 'Закрыть историю и закладки', exact: true }).click();
  const search = async (query = 'Игла: a+b[0]') => { await queryInput().fill(query); await dialog().getByRole('button', { name: 'Искать', exact: true }).click(); await until(async () => !(await dialog().getByRole('status').count()), 'History search finished'); };
  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await view().locator('.folder-thread[data-thread-id="main"]').click();
  await view().locator('[data-item-id="main-answer"]').waitFor();
  await draft().fill('Черновик до поиска');
  const mainSession = await view().getAttribute('data-session-id');
  const tabsBefore = await page.locator('.session-tab').count();
  await open(); await search();
  assert.equal(await dialog().locator('.library-result').count(), 2);
  assert.match(await dialog().innerText(), /Codex/); assert.match(await dialog().innerText(), /Claude Code/);
  assert.deepEqual((await calls('searchHistory')).at(-1).params, { query: 'Игла: a+b[0]', cwd: 'C:/Fixtures/LIBRARY_A', provider: 'all' });
  await dialog().getByRole('button', { name: 'Искать дальше', exact: true }).click();
  await dialog().getByText('Давний диалог', { exact: true }).waitFor();
  assert.equal(await dialog().locator('.library-result').count(), 3);
  assert.match(await dialog().locator('.library-note').innerText(), /Проверено диалогов: 3/);
  assert.equal((await calls('searchHistory')).at(-1).params.cursor, 'next-library-page');
  await page.screenshot({ path: 'artifacts/history-library-1440.png' });
  await dialog().locator('.library-result').filter({ hasText: 'Решения Codex' }).click();
  await until(async () => (await view().locator('[data-item-id="main-answer"]').getAttribute('class')).includes('message-jump-highlight'), 'Existing message highlighted');
  assert.equal(await page.locator('.session-tab').count(), tabsBefore, 'Existing tab reused');
  assert.equal(await view().getAttribute('data-session-id'), mainSession);
  assert.equal(await draft().inputValue(), 'Черновик до поиска');

  await open(); await dialog().getByRole('combobox', { name: 'Агент истории', exact: true }).selectOption('claude'); await search();
  assert.equal(await dialog().locator('.library-result').count(), 1);
  await dialog().locator('.library-result').click();
  await view().locator('[data-item-id="api:text:1"]').waitFor();
  assert.equal(await view().getByRole('combobox', { name: 'Агент', exact: true }).getAttribute('data-value'), 'claude');
  assert.equal((await calls('createSession')).at(-1).options.provider, 'claude');
  assert.match(await view().locator('[data-item-id="api:text:1"]').getAttribute('class'), /message-jump-highlight/);
  await view().locator('[data-item-id="api:text:1"]').getByRole('button', { name: 'Сохранить закладку', exact: true }).click();
  await view().getByRole('button', { name: 'Закладка сохранена', exact: true }).waitFor();
  assert.equal((await calls('saveBookmark')).at(-1).value.provider, 'claude');
  assert.equal((await calls('saveBookmark')).at(-1).value.itemId, 'api:text:1');
  assert.equal((await calls('saveBookmark')).at(-1).value.excerpt, 'Игла: a+b[0]. Ответ Claude из другой беседы.');
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  const label = () => dialog().getByRole('textbox', { name: 'Подпись закладки Решения Claude', exact: true });
  await label().waitFor(); await label().fill('Как настроить сборку'); await label().press('Tab');
  await until(async () => (await calls('saveBookmark')).at(-1).value.label === 'Как настроить сборку', 'Bookmark label saved');
  await page.evaluate(() => { window.__library.failBookmarkCwd = window.__library.projects[1]; });
  await dialog().getByRole('combobox', { name: 'Проект истории', exact: true }).selectOption('C:/Fixtures/LIBRARY_B');
  await dialog().getByRole('alert').filter({ hasText: 'Ошибка списка закладок другого проекта' }).waitFor();
  assert.equal(await dialog().locator('.library-bookmark').count(), 0, 'Failed new filter cannot leave bookmarks from previous project actionable');
  await dialog().getByRole('combobox', { name: 'Проект истории', exact: true }).selectOption('C:/Fixtures/LIBRARY_A');
  await label().waitFor();
  await close(); await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  assert.equal(await label().inputValue(), 'Как настроить сборку');
  await dialog().locator('.library-bookmark .library-result').click();
  await view().locator('[data-item-id="api:text:1"]').waitFor();
  assert.equal(await view().getByRole('combobox', { name: 'Агент', exact: true }).getAttribute('data-value'), 'claude');

  await open(); await search(); await dialog().getByRole('button', { name: 'Искать дальше', exact: true }).click();
  await dialog().locator('.library-result').filter({ hasText: 'Давний диалог' }).click();
  await view().locator('[data-item-id="paged-target"]').waitFor();
  await until(async () => (await view().locator('[data-item-id="paged-target"]').getAttribute('class')).includes('message-jump-highlight'), 'Paged result highlighted');
  assert.ok((await calls('thread/items/list')).some(call => call.params.cursor === 'older-items'), 'Jump fetches earlier native history pages');

  await open(); await search('пропавший'); await dialog().locator('.library-result').click();
  await view().locator('.notice-alert').filter({ hasText: 'Сообщение не найдено в доступной истории.' }).waitFor();
  assert.equal(await view().getAttribute('data-session-id'), mainSession);
  assert.equal(await draft().inputValue(), 'Черновик до поиска');
  await open(); await dialog().getByRole('combobox', { name: 'Проект истории', exact: true }).selectOption('C:/Fixtures/LIBRARY_B'); await search();
  assert.equal(await dialog().locator('.library-result').count(), 1); assert.match(await dialog().innerText(), /Другой проект/);
  await dialog().getByRole('combobox', { name: 'Проект истории', exact: true }).selectOption('C:/Fixtures/LIBRARY_A');
  await page.evaluate(() => { window.__library.holdQuery = 'устаревший'; });
  await queryInput().fill('устаревший'); await dialog().getByRole('button', { name: 'Искать', exact: true }).click();
  await until(() => page.evaluate(() => Boolean(window.__library.held['устаревший'])), 'Old search pending');
  await search(); await page.evaluate(() => window.__library.held['устаревший']()); await page.waitForTimeout(50);
  assert.doesNotMatch(await dialog().innerText(), /УСТАРЕВШИЙ РЕЗУЛЬТАТ/);
  await page.evaluate(() => { window.__library.failQuery = 'ошибка'; }); await search('ошибка');
  await dialog().getByRole('alert').filter({ hasText: 'Ошибка чтения тестовой истории' }).waitFor();
  await search('нет совпадений'); await dialog().getByText('Совпадений в проверенной части истории нет.', { exact: true }).waitFor();
  assert.equal((await calls('turn/start')).length, 0);
  assert.equal((await calls('turn/steer')).length, 0);
  assert.deepEqual(errors, []);
  await search('архив'); await dialog().locator('.library-result').click();
  await view().locator('[data-item-id="archive-target"]').waitFor();
  await until(async () => (await view().locator('[data-item-id="archive-target"]').getAttribute('class')).includes('message-jump-highlight'), 'Archive target highlighted');
  assert.equal(await draft().count(), 0, 'Archived source remains read-only');
  assert.ok((await calls('readArchivedThread')).some(call => call.params.cursor === 'archive-earlier'));
  assert.equal((await calls('thread/resume')).some(call => call.params.threadId === 'archive'), false, 'Reading archive does not resume or restore it');

  // The app must read the saved store after a fresh renderer, then delete only
  // the bookmark. Its original Claude thread and message remain untouched.
  await page.reload(); await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  assert.equal(await label().inputValue(), 'Как настроить сборку');
  await page.setViewportSize({ width: 940, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: 'artifacts/history-bookmarks-940.png' });
  // Native Claude transcript numbers text separately from streamed thinking;
  // saved api:text:1 can become api:text:0 on reopening. Verify unique excerpt
  // resolution, including a reused exact ID pointing at a different sibling.
  for (const mode of ['renumbered', 'collision']) {
    await page.evaluate(mode => localStorage.setItem('history-library-fixture-recovered', mode), mode);
    await page.reload(); await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
    await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
    await label().waitFor();
    assert.equal(await label().inputValue(), 'Как настроить сборку');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('history-library-fixture-bookmarks'))[0].excerpt), 'Игла: a+b[0]. Ответ Claude из другой беседы.');
    await dialog().locator('.library-bookmark .library-result').click();
    await view().locator('[data-item-id="api:text:0"]').waitFor();
    await until(async () => (await view().locator('[data-item-id="api:text:0"]').getAttribute('class')).includes('message-jump-highlight'), `Recovered Claude message highlighted: ${mode}`);
    assert.equal(await view().locator('[data-item-id="api:text:1"].message-jump-highlight').count(), 0, 'Reused exact ID with different text is never highlighted');
  }
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  await dialog().getByRole('button', { name: 'Удалить закладку Решения Claude', exact: true }).click();
  await dialog().getByText('Закладки можно сохранить кнопкой рядом с сообщением.', { exact: true }).waitFor();
  assert.equal((await calls('removeBookmark')).length, 1);
  assert.equal(await page.evaluate(() => window.__library.threads[window.__library.claudeId].turns[0].items[0].id), 'api:text:0');
  await close();

  // Save while active, externally archive, and reopen the bookmark. Resolve
  // current source metadata instead of trusting its persisted archived flag.
  await view().locator('.folder-thread[data-thread-id="moving"]').click();
  await view().locator('[data-item-id="moving-answer"]').getByRole('button', { name: 'Сохранить закладку', exact: true }).click();
  await view().getByRole('button', { name: 'Закладка сохранена', exact: true }).waitFor();
  assert.notEqual((await calls('saveBookmark')).at(-1).value.archived, true);
  await page.evaluate(() => localStorage.setItem('history-library-fixture-moving-archived', 'yes'));
  await page.reload(); await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  await dialog().locator('.library-bookmark .library-result').filter({ hasText: 'Меняющий состояние диалог' }).click();
  await view().locator('[data-item-id="moving-answer"]').waitFor();
  assert.equal(await draft().count(), 0, 'Newly archived bookmark opens read-only');
  assert.ok((await calls('resolveHistoryTarget')).some(call => call.params.threadId === 'moving'));
  assert.equal((await calls('thread/resume')).some(call => call.params.threadId === 'moving'), false);
  await view().locator('[data-item-id="moving-answer"]').getByRole('button', { name: 'Сохранить закладку', exact: true }).click();
  await view().getByRole('button', { name: 'Закладка сохранена', exact: true }).waitFor();
  assert.equal((await calls('saveBookmark')).at(-1).value.archived, true, 'Bookmark now records its archive source');
  await page.evaluate(() => localStorage.setItem('history-library-fixture-moving-archived', 'no'));
  await page.reload(); await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  await dialog().locator('.library-bookmark .library-result').filter({ hasText: 'Меняющий состояние диалог' }).click();
  await view().locator('[data-item-id="moving-answer"]').waitFor();
  assert.equal(await draft().count(), 1, 'Externally restored bookmark opens active conversation');
  assert.ok((await calls('resolveHistoryTarget')).some(call => call.params.threadId === 'moving'));
  assert.ok((await calls('thread/resume')).some(call => call.params.threadId === 'moving'));
  assert.equal((await calls('readArchivedThread')).some(call => call.params.threadId === 'moving'), false);
  // Bookmarks outlive the workspace's project list. An unavailable original
  // must not hide the saved excerpt or prevent editing its own annotation.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('history-library-fixture-bookmarks') || '[]');
    stored.push({ id: 'orphan-bookmark', provider: 'codex', cwd: 'C:/Fixtures/CLOSED_PROJECT', threadId: 'orphan-thread', itemId: 'orphan-answer', turnId: 'orphan-turn', threadName: 'Закрытый проект', excerpt: 'Сохранённый ответ из больше не открытой папки.', label: 'Первоначальная подпись', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    localStorage.setItem('history-library-fixture-bookmarks', JSON.stringify(stored));
  });
  await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click();
  const projectFilter = () => dialog().getByRole('combobox', { name: 'Проект истории', exact: true });
  assert.equal(await projectFilter().locator('option[value=""]').textContent(), 'Все проекты');
  assert.equal(await dialog().locator('.library-bookmark').filter({ hasText: 'Закрытый проект' }).count(), 0);
  await projectFilter().selectOption('');
  const orphanCard = () => dialog().locator('.library-bookmark').filter({ hasText: 'Закрытый проект' });
  await orphanCard().waitFor();
  assert.match(await orphanCard().innerText(), /Сохранённый ответ из больше не открытой папки/);
  const orphanLabel = () => dialog().getByRole('textbox', { name: 'Подпись закладки Закрытый проект', exact: true });
  await orphanLabel().fill('Важное из закрытого проекта'); await orphanLabel().press('Tab');
  await until(async () => (await calls('saveBookmark')).at(-1).value.label === 'Важное из закрытого проекта', 'Orphan annotation saved');
  await orphanCard().locator('.library-result').click();
  await dialog().getByRole('alert').filter({ hasText: 'Источник не найден в выбранном проекте' }).waitFor();
  assert.match(await orphanCard().innerText(), /Сохранённый ответ/);
  assert.equal(await orphanLabel().inputValue(), 'Важное из закрытого проекта');
  await dialog().getByRole('button', { name: 'Поиск сообщений', exact: true }).click();
  assert.equal(await projectFilter().inputValue(), 'C:/Fixtures/LIBRARY_A', 'Returning from all bookmarks restores a valid search project');
  await search(); assert.equal((await calls('searchHistory')).at(-1).params.cwd, 'C:/Fixtures/LIBRARY_A');
  await close(); await open(); await dialog().getByRole('button', { name: 'Закладки', exact: true }).click(); await projectFilter().selectOption('');
  await orphanLabel().waitFor();
  assert.equal(await orphanLabel().inputValue(), 'Важное из закрытого проекта');
  assert.match(await orphanCard().innerText(), /Сохранённый ответ/);
  assert.equal((await calls('turn/start')).length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: literal Cyrillic history search across Codex/Claude, project/provider filters, pages, stale/error states, existing/new tab jumps including earlier history, bookmark save/label/persistence/delete, missing source feedback, preserved draft; no model calls.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/history-library-failure.png' });
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
