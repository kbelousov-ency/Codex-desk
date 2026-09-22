import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer and independent scoped fake bridges. The data below is
// disposable: this regression never opens Codex, a terminal, or user history.
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
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const orphan = 'C:/Fixtures/ARCHIVE_ONLY';
    const threads = {};
    for (const [id, name, cwd, archived] of [
      ['active-a', 'Разработка проекта A', projects[0], false],
      ['active-b', 'Постпроцессор B', projects[1], false],
      ['archived-a', 'Старая задача A', projects[0], true],
      ['archived-c', 'История отдельной папки', orphan, true],
      ['archive-delete', 'Архив для удаления', orphan, true],
      ['archived-pages', 'Длинная история', orphan, true],
    ]) {
      threads[id] = { id, name, preview: name, cwd, archived, updatedAt: 1726500000, historyMode: 'legacy', turns: [{ id: `history-${id}`, status: 'completed', items: [
        { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Вопрос ${name}` }] },
        { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Ответ ${name}` },
      ] }] };
    }
    const sessions = {};
    const calls = [];
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    let serial = 0;
    const fixture = window.__archive = { projects, orphan, threads, sessions, calls, failAction: '', failRead: '', holdAction: '', holdTurn: false };
    const snapshot = thread => structuredClone(thread);
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
          if (method === 'thread/list') return { data: Object.values(threads).filter(thread => thread.cwd === cwd && !thread.archived).map(snapshot), nextCursor: null };
          if (method === 'thread/resume') {
            const thread = threads[params.threadId];
            if (!thread || thread.archived) throw new Error('Fixture: writable resume of archived/missing thread');
            state.threadId = thread.id;
            return { thread: snapshot(thread), model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'thread/start') {
            const thread = { id: `created-${id}`, cwd, name: 'Новый диалог', turns: [], historyMode: 'legacy', archived: false };
            threads[thread.id] = thread; state.threadId = thread.id;
            return { thread: snapshot(thread), model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'turn/start') {
            const thread = threads[params.threadId];
            if (!thread || thread.archived) throw new Error('Fixture: writing archived/missing thread');
            const turn = { id: `turn-${id}-${++state.turn}`, status: 'inProgress', items: [{ id: `user-${id}-${state.turn}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input }] };
            thread.turns.push(turn); state.notify('turn/started', { threadId: thread.id, turn });
            state.finish = () => {
              const answer = { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Продолжение восстановленного диалога' };
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
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {}, async openTerminal(options) { calls.push({ method: 'openTerminal', params: options, sessionId: id }); },
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]); create(projects[1]);
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd, cursor) { calls.push({ method: 'listProjectThreads', cwd, cursor }); return { data: Object.values(threads).filter(thread => thread.cwd === cwd && !thread.archived).map(snapshot), nextCursor: null }; },
      async listArchivedThreads(cursor) { calls.push({ method: 'listArchivedThreads', cursor }); return { data: Object.values(threads).filter(thread => thread.archived).map(snapshot), nextCursor: null }; },
      async readArchivedThread(params) {
        calls.push({ method: 'readArchivedThread', params });
        if (fixture.failRead === params.threadId) throw new Error('Fixture archive read failed');
        const thread = threads[params.threadId];
        if (!thread?.archived) throw new Error('Fixture: missing archived thread');
        if (thread.id === 'archived-pages') {
          const message = (id, text) => ({ id, type: 'agentMessage', phase: 'final_answer', text, turnId: id, complete: true });
          const latest = message('latest', 'Последняя страница истории');
          return { thread: snapshot(thread), items: params.cursor ? [message('older', 'Предыдущая страница истории'), latest] : [latest], turns: [], nextCursor: params.cursor ? null : 'page-older' };
        }
        return { thread: snapshot(thread), items: thread.turns.flatMap(turn => turn.items.map(item => ({ ...snapshot(item), turnId: turn.id, complete: true }))), turns: [], nextCursor: null };
      },
      async manageThread(params) {
        calls.push({ method: 'manageThread', params: snapshot(params) });
        if (fixture.holdAction === params.action) await new Promise(resolve => { fixture.resolveAction = resolve; });
        if (fixture.failAction === params.action) throw new Error(`Fixture ${params.action} failed`);
        const thread = threads[params.threadId];
        if (!thread || thread.cwd !== params.cwd) throw new Error('Fixture: wrong conversation scope');
        if (params.action === 'rename') thread.name = params.name;
        if (params.action === 'archive') thread.archived = true;
        if (params.action === 'restore') thread.archived = false;
        if (params.action === 'delete') delete threads[params.threadId];
        return { thread: snapshot(thread), affectedThreadIds: [thread.id] };
      },
      async createSession({ cwd = projects[0], settings } = {}) { calls.push({ method: 'createSession', cwd }); return create(cwd, settings); },
      async closeSession(id) { calls.push({ method: 'closeSession', sessionId: id }); if (fixture.holdClose) await new Promise(resolve => { fixture.resolveClose = resolve; }); if (fixture.failClose) throw new Error('Fixture close failed'); sessions[id].closed = true; sessions[id].listeners.clear(); },
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
  const archive = () => sidebar().getByRole('button', { name: 'Архив', exact: true });
  const flush = () => page.waitForTimeout(100);
  const calls = () => page.evaluate(() => window.__archive.calls);
  const managed = async action => (await calls()).filter(call => call.method === 'manageThread' && (!action || call.params.action === action));
  const writes = async () => (await calls()).filter(call => ['createSession', 'thread/resume', 'thread/start', 'turn/start', 'openTerminal', 'manageThread'].includes(call.method));
  const action = async (title, name) => {
    await sidebar().getByRole('button', { name: `Действия диалога ${title}`, exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click(); await flush();
  };
  const ready = async () => { await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush(); };
  const modal = () => page.getByRole('dialog', { name: 'Переименовать диалог', exact: true });
  const deletion = () => page.getByRole('alertdialog');
  const toggleArchive = async () => { await archive().click(); await flush(); };

  await ready(); await row('active-a').waitFor();
  const footerOrder = await view().locator('.composer-footer').evaluate(footer => {
    const access = footer.querySelector('[aria-label="Режим доступа"]');
    const terminal = footer.querySelector('[aria-label="Открыть текущую сессию в терминале"]');
    return Boolean(access.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(footerOrder, true, 'Access precedes the terminal control below chat');
  await row('active-a').click(); await ready();
  await view().getByText('Ответ Разработка проекта A', { exact: true }).waitFor();
  const activeSession = await view().getAttribute('data-session-id');
  await input().fill('Сохранённый черновик проекта A');
  await action('Разработка проекта A', 'Переименовать'); await modal().waitFor();
  await modal().getByRole('textbox').fill('   ');
  assert.equal(await modal().getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true, 'Blank names cannot be submitted');
  assert.equal((await managed()).length, 0);
  await modal().getByRole('textbox').fill('  Новый заголовок A  ');
  await modal().getByRole('button', { name: 'Сохранить', exact: true }).click();
  await modal().waitFor({ state: 'hidden' }); await flush();
  assert.deepEqual((await managed('rename')).at(-1).params, { action: 'rename', threadId: 'active-a', cwd: 'C:/Fixtures/PROJECT_A', name: 'Новый заголовок A' });
  assert.match(await row('active-a').innerText(), /Новый заголовок A/);
  assert.match(await page.locator(`.session-tab[data-session-id="${activeSession}"]`).innerText(), /Новый заголовок A/);
  assert.equal(await input().inputValue(), 'Сохранённый черновик проекта A');

  // A rejected server mutation must not remove a conversation or its draft.
  await page.evaluate(() => { window.__archive.failAction = 'archive'; });
  await action('Новый заголовок A', 'В архив');
  await page.getByRole('alert').filter({ hasText: 'Fixture archive failed' }).waitFor();
  assert.equal(await row('active-a').count(), 1);
  assert.equal(await page.locator(`.session-tab[data-session-id="${activeSession}"]`).count(), 1);
  assert.equal(await input().inputValue(), 'Сохранённый черновик проекта A');
  await page.evaluate(() => { window.__archive.failAction = ''; });
  await action('Новый заголовок A', 'В архив');
  await page.locator(`.session-tab[data-session-id="${activeSession}"]`).waitFor({ state: 'detached' });
  assert.equal(await row('active-a').count(), 0);
  assert.equal(await page.evaluate(id => window.__archive.sessions[id].closed, activeSession), true);
  await toggleArchive(); await archivedRow('active-a').waitFor();
  assert.equal(await sidebar().getByRole('button', { name: 'Новый проект', exact: true }).isVisible(), false, 'Archive covers the new project action');
  assert.equal(await sidebar().locator('.project-tree:visible').count(), 0, 'Archive replaces the live project list');
  assert.match(await sidebar().innerText(), /ARCHIVE_ONLY/);
  assert.match(await sidebar().innerText(), /PROJECT_A/);
  assert.doesNotMatch(await sidebar().innerText(), /PROJECT_B/, 'An empty archive folder does not appear');
  const beforeRead = await writes();
  await archivedRow('archived-c').click(); await flush();
  await page.getByText('Ответ История отдельной папки', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).count(), 0, 'Archive has no writable composer');
  assert.deepEqual(await writes(), beforeRead, 'Reading archive creates no session, resume, model turn, or mutation');
  assert.equal((await calls()).filter(call => call.method === 'readArchivedThread').at(-1).params.threadId, 'archived-c');
  await sidebar().getByRole('button', { name: 'Действия диалога История отдельной папки', exact: true }).click();
  assert.deepEqual((await page.getByRole('menuitem').allTextContents()).sort(), ['Удалить', 'Восстановить'].sort());
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/archive-readonly.png' });

  await action('Архив для удаления', 'Удалить'); await deletion().waitFor();
  await deletion().getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal((await managed('delete')).length, 0, 'Cancel does not delete history');
  await action('Архив для удаления', 'Удалить'); await deletion().waitFor();
  await deletion().getByRole('button', { name: 'Удалить', exact: true }).click(); await flush();
  assert.deepEqual((await managed('delete')).at(-1).params, { action: 'delete', threadId: 'archive-delete', cwd: 'C:/Fixtures/ARCHIVE_ONLY' });
  assert.equal(await archivedRow('archive-delete').count(), 0);
  assert.equal(await archivedRow('archived-c').count(), 1, 'Sibling archived history remains intact');

  await page.evaluate(() => { window.__archive.failAction = 'restore'; });
  await action('Новый заголовок A', 'Восстановить');
  await page.getByRole('alert').filter({ hasText: 'Fixture restore failed' }).waitFor();
  assert.equal(await archivedRow('active-a').count(), 1);
  await page.evaluate(() => { window.__archive.failAction = ''; });
  await action('Новый заголовок A', 'Восстановить'); await flush();
  assert.equal(await archivedRow('active-a').count(), 0);
  assert.deepEqual((await managed('restore')).at(-1).params, { action: 'restore', threadId: 'active-a', cwd: 'C:/Fixtures/PROJECT_A' });
  await toggleArchive();
  await row('active-a').waitFor(); await row('active-a').click(); await ready();
  await input().fill('Продолжаем после архива'); await input().press('Enter');
  await view().getByText('Продолжение восстановленного диалога', { exact: true }).waitFor();
  const continuation = (await calls()).filter(call => call.method === 'turn/start').at(-1);
  assert.equal(continuation.params.threadId, 'active-a', 'Restored history continues under its exact original identifier');
  assert.deepEqual(continuation.params.input.map(part => part.text), ['Продолжаем после архива']);
  assert.equal(await page.evaluate(() => window.__archive.threads['active-b'].name), 'Постпроцессор B');
  assert.equal(await page.evaluate(() => window.__archive.threads['archived-c'].archived), true);
  await page.screenshot({ path: 'artifacts/archive-restored.png' });

  // Active turns and terminal ownership protect the dialog menu as well as send.
  await page.evaluate(() => { window.__archive.holdTurn = true; });
  await input().fill('Длительная работа'); await input().press('Enter'); await flush();
  const currentSession = await view().getAttribute('data-session-id');
  assert.equal(await sidebar().getByRole('button', { name: 'Действия диалога Новый заголовок A', exact: true }).isDisabled(), true, 'Busy dialog cannot be renamed, archived, or deleted');
  await page.evaluate(id => { const fixture = window.__archive; fixture.holdTurn = false; fixture.sessions[id].finish(); }, currentSession); await flush();
  await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).click(); await flush();
  assert.equal(await sidebar().getByRole('button', { name: 'Действия диалога Новый заголовок A', exact: true }).isDisabled(), true, 'Terminal ownership blocks destructive history actions');
  await page.evaluate(id => window.__archive.sessions[id].emit('terminal', { state: 'closed', threadId: 'active-a' }), currentSession); await ready();

  // Confirmation is retained on delete failure and reserved until the response.
  await page.evaluate(() => { window.__archive.failAction = 'delete'; });
  await action('Новый заголовок A', 'Удалить'); await deletion().waitFor();
  await deletion().getByRole('button', { name: 'Удалить', exact: true }).click(); await flush();
  await deletion().getByRole('alert').filter({ hasText: 'Fixture delete failed' }).waitFor();
  assert.equal(await row('active-a').count(), 1);
  assert.equal(await page.locator(`.session-tab[data-session-id="${currentSession}"]`).count(), 1);
  await page.evaluate(() => { window.__archive.failAction = ''; window.__archive.holdAction = 'delete'; });
  const beforeHeldDelete = (await managed('delete')).length;
  await deletion().getByRole('button', { name: 'Удалить', exact: true }).click(); await flush();
  assert.equal(await deletion().getByRole('button', { name: 'Выполняем…', exact: true }).isDisabled(), true);
  assert.equal(await deletion().getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true);
  assert.equal(await page.locator(`.session-tab[data-session-id="${currentSession}"] .session-tab-close`).isDisabled(), true, 'The reserved mutation prevents closing its active session early');
  assert.equal(await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).isDisabled(), true, 'No terminal handoff can begin while deletion is reserved');
  assert.equal((await managed('delete')).length, beforeHeldDelete + 1);
  assert.equal(await row('active-a').count(), 1, 'Pending delete keeps history visible until acknowledged');
  await page.evaluate(() => { window.__archive.holdAction = ''; window.__archive.resolveAction(); });
  await deletion().waitFor({ state: 'hidden' });
  await page.locator(`.session-tab[data-session-id="${currentSession}"]`).waitFor({ state: 'detached' });
  assert.equal(await row('active-a').count(), 0);

  // Failed archive reads remain read-only and can be retried without a session.
  await toggleArchive();
  await page.evaluate(() => { window.__archive.failRead = 'archived-a'; });
  const beforeFailedRead = await writes();
  await archivedRow('archived-a').click();
  const readAlert = view().getByRole('alert').filter({ hasText: 'Fixture archive read failed' });
  await readAlert.waitFor();
  assert.deepEqual(await writes(), beforeFailedRead);
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).count(), 0);
  await page.evaluate(() => { window.__archive.failRead = ''; });
  await readAlert.getByRole('button', { name: 'Повторить', exact: true }).click();
  await view().getByText('Ответ Старая задача A', { exact: true }).waitFor();
  assert.deepEqual(await writes(), beforeFailedRead);

  await archivedRow('archived-pages').click();
  await view().getByText('Последняя страница истории', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'Загрузить предыдущие сообщения', exact: true }).click();
  await view().getByText('Предыдущая страница истории', { exact: true }).waitFor();
  assert.deepEqual((await view().locator('.assistant-message .message-content').allTextContents()).map(text => text.trim()), ['Предыдущая страница истории', 'Последняя страница истории'], 'Earlier page is prepended and overlapping items are deduplicated');
  assert.deepEqual((await calls()).filter(call => call.method === 'readArchivedThread' && call.params.threadId === 'archived-pages').map(call => call.params), [{ threadId: 'archived-pages' }, { threadId: 'archived-pages', cursor: 'page-older' }]);

  // A successful archive is authoritative even if disposing its old transport fails.
  await toggleArchive();
  await sidebar().getByRole('button', { name: 'Диалоги папки PROJECT_B', exact: true }).click();
  await row('active-b').click(); await ready();
  const closingSession = await view().getAttribute('data-session-id');
  await page.evaluate(() => { window.__archive.holdClose = true; window.__archive.failClose = true; });
  await action('Постпроцессор B', 'В архив');
  await page.waitForFunction(() => Boolean(window.__archive.resolveClose));
  assert.equal(await page.evaluate(() => window.__archive.threads['active-b'].archived), true);
  assert.equal(await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).isDisabled(), true, 'Archive reserves the old conversation until transport disposal settles');
  await page.evaluate(() => { window.__archive.holdClose = false; window.__archive.resolveClose(); });
  await page.locator(`.session-tab[data-session-id="${closingSession}"]`).waitFor({ state: 'detached' });
  await page.getByRole('alert').filter({ hasText: 'Fixture close failed' }).waitFor();
  assert.equal(await row('active-b').count(), 0, 'Confirmed archive cannot remain writable after close cleanup failure');
  await page.evaluate(() => { window.__archive.failClose = false; });
  await toggleArchive(); await archivedRow('active-b').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: production renderer, scoped thread menus, rename validation/title/draft, archive failure/success and tab closure, bottom archive overlay and folder grouping, read-only history without writable resume, exact deletion cancel/confirm/error/pending lock, restore failure/recovery and original thread continuation, busy/terminal guards, archive read error/retry, access before terminal. No real Codex/provider/user history.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/archive-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
