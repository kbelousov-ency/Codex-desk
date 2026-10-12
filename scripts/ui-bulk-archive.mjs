import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with independent scoped fake bridges. Every conversation below is
// disposable fixture data: this regression never opens Codex/Claude, a terminal, or user history.
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
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const threads = {};
    // PROJECT_A: four Codex conversations plus one Claude dialog; the last page is held back.
    for (const [id, name, cwd, extra] of [
      ['a-1', 'Отчёт по фрезеровке', projects[0], {}],
      ['a-2', 'Отчёт по токарке', projects[0], {}],
      ['a-3', 'Черновик постпроцессора', projects[0], {}],
      ['claude:11111111-2222-3333-4444-555555555555', 'Отчёт Claude', projects[0], { provider: 'claude' }],
      ['a-page2', 'Отчёт со второй страницы', projects[0], { page: 2 }],
      ['b-1', 'Диалог другого проекта', projects[1], {}],
      ['old-1', 'Уже в архиве', projects[0], { archived: true }],
    ]) {
      threads[id] = {
        id, name, preview: name, cwd, archived: Boolean(extra.archived), page: extra.page || 1,
        updatedAt: 1726500000, historyMode: 'legacy', ...(extra.provider ? { provider: extra.provider } : {}),
        turns: [{ id: `history-${id}`, status: 'completed', items: [
          { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Вопрос ${name}` }] },
          { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Ответ ${name}` },
        ] }],
      };
    }
    const sessions = {};
    const calls = [];
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    let serial = 0;
    const fixture = window.__bulk = { projects, threads, sessions, calls, failArchive: new Set(), holdArchive: '', holdTurn: false, searchLimit: 0 };
    const snapshot = value => structuredClone(value);
    const live = cwd => Object.values(threads).filter(thread => thread.cwd === cwd && !thread.archived);
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, threadId: '', turn: 0, listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings } };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.notify = (method, params) => state.emit('notification', { method, params });
      state.bridge = {
        async start() { calls.push({ method: 'start', sessionId: id }); return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          calls.push({ method, params, sessionId: id });
          if (method === 'thread/list') return { data: live(cwd).map(snapshot), nextCursor: null };
          if (method === 'thread/resume') {
            const thread = threads[params.threadId];
            if (!thread || thread.archived) throw new Error('Fixture: writable resume of archived/missing thread');
            state.threadId = thread.id;
            return { thread: snapshot(thread), model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'thread/start') {
            const thread = { id: `created-${id}`, cwd, name: 'Новый диалог', turns: [], historyMode: 'legacy', archived: false, page: 1 };
            threads[thread.id] = thread; state.threadId = thread.id;
            return { thread: snapshot(thread), model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'turn/start') {
            const thread = threads[params.threadId];
            if (!thread || thread.archived) throw new Error('Fixture: writing archived/missing thread');
            const turn = { id: `turn-${id}-${++state.turn}`, status: 'inProgress', items: [{ id: `user-${id}-${state.turn}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input }] };
            thread.turns.push(turn); state.notify('turn/started', { threadId: thread.id, turn });
            state.finish = () => {
              const answer = { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Ответ фикстуры' };
              turn.items.push(answer); turn.status = 'completed';
              state.notify('item/completed', { threadId: thread.id, turnId: turn.id, item: answer });
              state.notify('turn/completed', { threadId: thread.id, turn: { ...turn, error: null } });
            };
            if (!fixture.holdTurn) setTimeout(state.finish, 30);
            return { turn: snapshot(turn) };
          }
          if (method === 'turn/interrupt') { state.finish?.(); return {}; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async openTerminal(options) { calls.push({ method: 'openTerminal', params: options, sessionId: id }); return { threadId: options.threadId }; },
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]);
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd, cursor) {
        calls.push({ method: 'listProjectThreads', cwd, cursor });
        const page = cursor === 'page-2' ? 2 : 1;
        const data = live(cwd).filter(thread => thread.page === page).map(snapshot);
        return { data, nextCursor: page === 1 && live(cwd).some(thread => thread.page === 2) ? 'page-2' : null };
      },
      async searchThreads({ query, archived, cursor }) {
        calls.push({ method: 'searchThreads', query, archived, cursor });
        const found = Object.values(threads).filter(thread => Boolean(thread.archived) === archived && thread.name.toLowerCase().includes(query.toLowerCase()));
        const limit = fixture.searchLimit || found.length;
        const first = found.slice(0, limit), rest = found.slice(limit);
        if (cursor === 'search-more') return { data: rest.map(snapshot), nextCursor: null };
        return { data: first.map(snapshot), nextCursor: rest.length ? 'search-more' : null };
      },
      async listArchivedThreads(cursor) {
        calls.push({ method: 'listArchivedThreads', cursor });
        return { data: Object.values(threads).filter(thread => thread.archived).map(snapshot), nextCursor: null };
      },
      async readArchivedThread(params) {
        calls.push({ method: 'readArchivedThread', params });
        const thread = threads[params.threadId];
        if (!thread?.archived) throw new Error('Fixture: missing archived thread');
        return { thread: snapshot(thread), items: thread.turns.flatMap(turn => turn.items.map(item => ({ ...snapshot(item), turnId: turn.id, complete: true }))), turns: [], nextCursor: null };
      },
      async manageThread(params) {
        calls.push({ method: 'manageThread', params: snapshot(params) });
        if (params.action === 'archive' && fixture.holdArchive === params.threadId) await new Promise(resolve => { fixture.resolveArchive = resolve; });
        if (params.action === 'archive' && fixture.failArchive.has(params.threadId)) throw new Error(`Fixture archive failed: ${params.threadId}`);
        const thread = threads[params.threadId];
        if (!thread || thread.cwd !== params.cwd) throw new Error('Fixture: wrong conversation scope');
        if (params.action === 'rename') thread.name = params.name;
        if (params.action === 'archive') thread.archived = true;
        if (params.action === 'restore') thread.archived = false;
        if (params.action === 'delete') delete threads[params.threadId];
        return { thread: snapshot(thread), affectedThreadIds: [params.threadId] };
      },
      async createSession({ cwd = projects[0], settings } = {}) { calls.push({ method: 'createSession', cwd }); return create(cwd, settings); },
      async closeSession(id) { calls.push({ method: 'closeSession', sessionId: id }); sessions[id].closed = true; sessions[id].listeners.clear(); },
      async openArchivedPath(params) { calls.push({ method: 'openArchivedPath', params }); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const sidebar = () => page.locator('.sidebar:visible');
  const row = id => sidebar().locator(`.folder-thread[data-thread-id="${id}"]`);
  const archivedRow = id => sidebar().locator(`.archive-thread[data-thread-id="${id}"]`);
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const flush = () => page.waitForTimeout(120);
  const calls = () => page.evaluate(() => window.__bulk.calls);
  const archiveCalls = async () => (await calls()).filter(call => call.method === 'manageThread' && call.params.action === 'archive').map(call => call.params.threadId);
  const otherMutations = async () => (await calls()).filter(call => call.method === 'manageThread' && call.params.action !== 'archive');
  const turns = async () => (await calls()).filter(call => call.method === 'turn/start');
  const ready = async () => { await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush(); };
  const dialog = () => page.getByRole('dialog').or(page.getByRole('alertdialog'));
  const pick = title => sidebar().getByRole('checkbox', { name: `Выбрать диалог ${title}`, exact: true });
  const bar = label => sidebar().getByRole('group', { name: `Выбор нескольких диалогов: ${label}`, exact: true });
  const folderLabel = 'папка PROJECT_A';
  const claudeId = 'claude:11111111-2222-3333-4444-555555555555';
  const archiveToggle = () => sidebar().getByRole('button', { name: 'Архив', exact: true });
  const enterMulti = async () => { await sidebar().getByRole('button', { name: /Действия проекта/ }).first().click(); await page.getByRole('menuitem', { name: 'Архивировать несколько', exact: true }).click(); await flush(); };

  await ready(); await row('a-1').waitFor();

  // 1. Multi-select is explicit: nothing changes until the mode is entered.
  assert.equal(await pick('Отчёт по фрезеровке').count(), 0, 'No checkboxes outside multi-select mode');
  await sidebar().getByRole('button', { name: 'Действия диалога Отчёт по фрезеровке', exact: true }).waitFor();
  await enterMulti();
  await bar(folderLabel).waitFor();
  assert.equal(await sidebar().getByRole('button', { name: 'Действия диалога Отчёт по фрезеровке', exact: true }).count(), 0, 'The per-row ⋮ menu steps aside in multi-select mode');
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 0/);
  assert.match(await bar(folderLabel).innerText(), new RegExp(`Область: ${folderLabel}`));
  assert.match(await bar(folderLabel).innerText(), /только загруженные диалоги/, 'A held-back page is stated, not silently included');
  assert.equal(await bar(folderLabel).getByRole('button', { name: 'В архив', exact: true }).isDisabled(), true, 'Archive stays disabled with an empty selection');

  // 2. Individual selection and select-all over the stated scope.
  await pick('Отчёт по фрезеровке').check();
  await pick('Отчёт по токарке').check();
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 2/);
  await pick('Отчёт по токарке').uncheck();
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 1/);
  const selectAll = () => bar(folderLabel).getByRole('button', { name: /^Выбрать все/ });
  assert.match(await selectAll().innerText(), /Выбрать все \(4\)/, 'Select all counts the loaded conversations of this folder only');
  await selectAll().click(); await flush();
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 4/);
  assert.equal(await pick('Отчёт со второй страницы').count(), 0, 'An unloaded page is outside the scope');
  await bar(folderLabel).getByRole('button', { name: 'Снять выделение', exact: true }).click(); await flush();
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 0/);

  // 3. Existing protections: a conversation that starts working leaves the selection.
  await bar(folderLabel).getByRole('button', { name: 'Отмена', exact: true }).click(); await flush();
  await row('a-3').click(); await ready();
  const busySession = await view().getAttribute('data-session-id');
  await enterMulti();
  await selectAll().click(); await flush();
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 4/);
  await page.evaluate(() => { window.__bulk.holdTurn = true; });
  await input().fill('Длительная работа'); await input().press('Enter'); await flush();
  assert.equal(await pick('Черновик постпроцессора').isDisabled(), true, 'A running conversation cannot be picked');
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 3/, 'A conversation that became busy drops out of the count');

  // 4. One confirmation that states count and scope and names what it will not touch; Cancel does nothing.
  const before = await archiveCalls();
  await bar(folderLabel).getByRole('button', { name: 'В архив', exact: true }).click();
  await dialog().waitFor();
  assert.match(await dialog().innerText(), /Архивировать 3 диалога\?/);
  assert.match(await dialog().innerText(), new RegExp(`Область: ${folderLabel}`));
  assert.match(await dialog().innerText(), /Диалоги не удаляются/);
  assert.match(await dialog().innerText(), /Не будут затронуты 1 диалог/);
  assert.match(await dialog().innerText(), /Черновик постпроцессора — идёт работа, ожидается подтверждение или открыт терминал/);
  await page.screenshot({ path: 'artifacts/bulk-archive-confirm.png' });
  await dialog().getByRole('button', { name: 'Отмена', exact: true }).click(); await flush();
  assert.deepEqual(await archiveCalls(), before, 'Cancel performs no archiving at all');
  assert.equal(await row('a-1').count(), 1);
  await page.evaluate(id => { const fixture = window.__bulk; fixture.holdTurn = false; fixture.sessions[id].finish(); }, busySession); await flush();
  await pick('Черновик постпроцессора').uncheck();
  await input().fill('Черновик уцелевшей вкладки');
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 3/);

  // 5. Progress is visible and Stop keeps what already succeeded.
  await bar(folderLabel).getByRole('button', { name: 'В архив', exact: true }).click();
  await dialog().waitFor();
  await page.evaluate(() => { window.__bulk.holdArchive = 'a-1'; });
  await dialog().getByRole('button', { name: 'Архивировать (3)', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__bulk.resolveArchive));
  await dialog().getByRole('progressbar').waitFor();
  assert.match(await dialog().innerText(), /Обработано 0 из 3/);
  assert.match(await dialog().innerText(), /Сейчас: «Отчёт по фрезеровке»/);
  await page.screenshot({ path: 'artifacts/bulk-archive-progress.png' });
  await dialog().getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.evaluate(() => { window.__bulk.holdArchive = ''; window.__bulk.resolveArchive(); });
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).waitFor();
  assert.deepEqual(await archiveCalls(), [...before, 'a-1'], 'Stop prevents the remaining archive calls');
  assert.match(await dialog().innerText(), /Архивировано: 1 из 3\. Остановлено, не обработано: 2\./);
  assert.equal(await page.evaluate(() => window.__bulk.threads['a-1'].archived), true, 'What already succeeded stays archived');
  assert.equal(await page.evaluate(() => window.__bulk.threads['a-2'].archived), false);
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click(); await flush();
  assert.equal(await row('a-1').count(), 0, 'The archived conversation leaves the folder history at once');
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 2/, 'An interrupted run stays in multi-select so it can be resumed');

  // 6. A partial failure is reported without losing the confirmed successes.
  await page.evaluate(() => { window.__bulk.failArchive = new Set(['a-2']); });
  await bar(folderLabel).getByRole('button', { name: 'В архив', exact: true }).click(); await dialog().waitFor();
  assert.match(await dialog().innerText(), /Архивировать 2 диалога\?/);
  await dialog().getByRole('button', { name: 'Архивировать (2)', exact: true }).click();
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).waitFor();
  assert.deepEqual(await archiveCalls(), [...before, 'a-1', 'a-2', claudeId], 'Each conversation uses one ordinary single-thread archive call');
  assert.match(await dialog().innerText(), /Архивировано: 1 из 2\. Не удалось: 1\./);
  assert.match(await dialog().innerText(), /Отчёт по токарке — .*Fixture archive failed: a-2/);
  await page.screenshot({ path: 'artifacts/bulk-archive-report.png' });
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click(); await flush();
  assert.equal(await page.evaluate(() => window.__bulk.threads[Object.keys(window.__bulk.threads).find(id => id.startsWith('claude:'))].archived), true, 'A Claude dialog is archived through its own local archive layer');
  assert.equal(await page.evaluate(() => window.__bulk.threads['a-2'].archived), false, 'The failed conversation stays exactly where it was');
  assert.equal(await pick('Отчёт по токарке').count(), 1, 'The failure stays selected so it can be retried');
  assert.match(await bar(folderLabel).innerText(), /Выбрано: 1/);
  await bar(folderLabel).getByRole('button', { name: 'Отмена', exact: true }).click(); await flush();
  await row('a-3').click(); await ready();
  assert.equal(await input().inputValue(), 'Черновик уцелевшей вкладки', 'An untouched tab keeps its draft and settings');
  await archiveToggle().click(); await archivedRow('a-1').waitFor();
  await archivedRow(claudeId).waitFor();
  assert.equal(await sidebar().getByRole('button', { name: 'Архивировать несколько', exact: true }).count(), 0, 'The archive panel offers no bulk archiving of archived dialogs');
  await archiveToggle().click(); await flush();

  // 7. Search results are their own scope, stated in the toolbar and the confirmation.
  await page.evaluate(() => { window.__bulk.searchLimit = 1; });
  const search = () => sidebar().getByRole('textbox', { name: 'Поиск диалогов', exact: true });
  await search().fill('отчёт'); await flush(); await flush();
  const searchLabel = 'результаты поиска «отчёт»';
  await sidebar().locator('.dialog-search-results .project-menu-trigger').click(); await page.getByRole('menuitem', { name: 'Архивировать несколько', exact: true }).click(); await flush();
  await bar(searchLabel).waitFor();
  assert.match(await bar(searchLabel).innerText(), /только загруженные диалоги/, 'Unloaded search pages are excluded and said so');
  await bar(searchLabel).getByRole('button', { name: /^Выбрать все/ }).click(); await flush();
  const picked = Number((await bar(searchLabel).innerText()).match(/Выбрано: (\d+)/)[1]);
  assert.ok(picked >= 1, 'Loaded search results can be selected');
  // 8. Editing the query is a new scope: the previous picks are dropped, not carried over.
  await search().fill('отчёт по'); await flush(); await flush();
  assert.equal(await bar(searchLabel).count(), 0, 'The old search scope is gone');
  assert.equal(await sidebar().getByRole('group', { name: /Выбор нескольких диалогов/ }).count(), 0, 'A scope change clears the selection instead of reusing it');
  await sidebar().locator('.dialog-search-results .project-menu-trigger').click(); await page.getByRole('menuitem', { name: 'Архивировать несколько', exact: true }).click(); await flush();
  const narrowed = 'результаты поиска «отчёт по»';
  await bar(narrowed).getByRole('button', { name: /^Выбрать все/ }).click(); await flush();
  assert.match(await bar(narrowed).innerText(), /Выбрано: 1/, 'Only «Отчёт по токарке» is left matching and archivable');
  await bar(narrowed).getByRole('button', { name: 'В архив', exact: true }).click(); await dialog().waitFor();
  assert.match(await dialog().innerText(), /Архивировать 1 диалог\?/);
  assert.match(await dialog().innerText(), new RegExp('Область: результаты поиска «отчёт по»'));
  await page.evaluate(() => { window.__bulk.failArchive = new Set(); });
  await dialog().getByRole('button', { name: 'Архивировать (1)', exact: true }).click();
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).waitFor();
  assert.match(await dialog().innerText(), /Архивировано: 1 из 1\./);
  await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click(); await flush();
  assert.equal(await page.evaluate(() => window.__bulk.threads['a-2'].archived), true);
  await search().fill(''); await flush();

  // 9. Nothing was deleted, renamed, restored, or sent to a model anywhere in this run.
  assert.deepEqual(await otherMutations(), [], 'Bulk archiving never deletes, renames or restores a conversation');
  assert.deepEqual((await turns()).map(call => call.params.input[0].text), ['Длительная работа'], 'Only the explicit draft of the busy-guard step reached a model');
  assert.equal(await page.evaluate(() => window.__bulk.threads['b-1'].archived), false, 'Another project is outside every scope used here');
  assert.equal(await page.evaluate(() => window.__bulk.threads['a-page2'].archived), false, 'An unloaded page was never archived');
  assert.equal(await page.evaluate(() => Object.keys(window.__bulk.threads).length), 7, 'Every fixture conversation still exists: archiving removed none of them');
  assert.deepEqual(errors, []);
  console.log('PASS: explicit multi-select mode in the sidebar, individual and scope-wide selection for one folder and for one search query, loaded-only select all with the pagination note, a conversation that starts working dropping out of the selection and being named as untouched in the confirmation, single confirmation with count and scope, Cancel doing nothing, visible progress, Stop keeping the confirmed successes, partial failure reported with its reason while the rest stays archived, Claude dialog through its own local archive, sidebar/archive/tab state updated, other drafts preserved, no multi-select in the archive panel, search scope and selection cleared on a scope change, no delete/rename/restore and no model request. No real Codex/Claude or user history.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/bulk-archive-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
