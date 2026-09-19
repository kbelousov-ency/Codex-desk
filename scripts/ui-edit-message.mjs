import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Actual renderer with isolated bridges. Explicit sends reach a fixture only.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const file = resolve(root, `.${new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
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
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const cwd = 'C:/Fixtures/EDIT';
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
    const user = (id, text, parts = []) => ({ id, type: 'userMessage', content: [{ type: 'text', text }, ...parts] });
    const historyItems = [
      user('original', 'Исходный вопрос\nСо второй строкой', [{ type: 'localImage', path: 'C:/Fixtures/EDIT/source.png' }]),
      { id: 'answer', type: 'agentMessage', text: 'Исходный ответ остаётся в истории.' },
      user('plain', 'Обычный вопрос'),
      user('missing', 'Вопрос с потерянной картинкой', [{ type: 'localImage', path: 'C:/Fixtures/EDIT/missing.png' }]),
      user('slow', 'Медленная картинка', [{ type: 'localImage', path: 'C:/Fixtures/EDIT/slow.png' }]),
      user('inline', 'Встроенное изображение', [{ type: 'image', url: image }]),
      user('unsupported', 'Специальное вложение', [{ type: 'mention', name: 'Skill', path: 'skill://fixture' }]),
    ];
    const sessions = {}, calls = [];
    const fixture = window.__edit = { sessions, calls, image, failSend: false, holdSend: false, holdImage: false, resolveImage: null, resolveSend: null };
    for (const id of ['session-a', 'session-b']) {
      const thread = { id: `thread-${id}`, name: id, cwd, historyMode: 'legacy', turns: [{ id: `old-${id}`, status: 'completed', items: id === 'session-a' ? historyItems : [user('other', 'Вопрос другой вкладки')] }] };
      const state = sessions[id] = { id, cwd, thread, listeners: new Set(), reads: [] };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models: [model], executable: 'fixture', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'auto' }; }, async setSettings() {},
        async request(method, params = {}) {
          calls.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
          if (method === 'turn/start') {
            if (fixture.failSend) throw new Error('Ошибка отправки исправления');
            if (fixture.holdSend) await new Promise(resolve => { fixture.resolveSend = resolve; });
            return { turn: { id: `sent-${calls.filter(call => call.method === 'turn/start').length}`, status: 'inProgress', items: [] } };
          }
          throw new Error(`Forbidden fixture request ${method}`);
        },
        async readAttachment(path) {
          state.reads.push(path);
          if (path.endsWith('missing.png')) return null;
          if (path.endsWith('slow.png')) { if (!fixture.holdImage) return null; return new Promise(resolve => { fixture.resolveImage = () => resolve(image); }); }
          return image;
        },
        async saveImages(images) { calls.push({ sessionId: id, method: 'saveImages', images: structuredClone(images) }); return images.map((item, index) => ({ ...item, path: `${cwd}/saved-${index}.png` })); },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async respond() {}, async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
      };
    }
    window.codex = {
      ...sessions['session-a'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { activeIndex: 0, tabs: [...Object.values(sessions).map(state => ({ id: state.id, cwd, thread: state.thread, draft: state.id === 'session-a' ? 'Мой несохранённый черновик' : 'Черновик B', attachments: state.id === 'session-a' ? [{ name: 'draft.png', dataUrl: image }] : [] })), { id: 'archive', cwd, archivedThread: { id: 'archive-thread', name: 'Архив', cwd }, draft: '', attachments: [] }] } }; },
      async completeUpdateRestore() {}, async listProjectThreads() { return { data: Object.values(sessions).map(state => state.thread), nextCursor: null }; },
      async readArchivedThread() { return { thread: { id: 'archive-thread', name: 'Архив', cwd }, items: [user('archived-user', 'Архивный вопрос')], turns: [], nextCursor: null }; },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const edit = id => view().locator(`[data-item-id="${id}"]`).getByRole('button', { name: 'Редактировать сообщение', exact: true });
  const cancel = () => view().getByRole('button', { name: 'Отменить редактирование', exact: true });
  const send = () => view().getByRole('button', { name: 'Отправить сообщение', exact: true });
  const tab = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); };
  const calls = () => page.evaluate(() => window.__edit.calls);
  const turns = async () => (await calls()).filter(call => call.method === 'turn/start');
  const value = async expected => { await page.waitForFunction(expected => document.querySelector('.session-view:not([hidden]) textarea')?.value === expected, expected); };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await edit('original').waitFor();
  await view().locator('[data-item-id="original"] img').waitFor();
  const original = 'Исходный вопрос\nСо второй строкой';
  const draft = 'Мой несохранённый черновик';
  await edit('original').click();
  await value(original);
  await cancel().waitFor();
  await view().getByRole('button', { name: 'Удалить source.png', exact: true }).waitFor();
  assert.equal(await composer().evaluate(node => node === document.activeElement && node.selectionStart === node.value.length), true);
  assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 0);
  assert.equal((await turns()).length, 0, 'Preparing an edit does not send a prompt');
  await composer().fill('Исправление, которое отменим');
  await cancel().click();
  await value(draft);
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();

  for (const id of ['missing', 'unsupported']) {
    await edit(id).click();
    await view().getByRole('alert').filter({ hasText: /Текущий черновик сохранён/ }).waitFor();
    await value(draft);
    assert.equal(await cancel().count(), 0);
    await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
    await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  }
  // A late attachment read cannot replace another tab's composer or steal focus.
  await page.evaluate(() => { window.__edit.holdImage = true; });
  await edit('slow').click();
  await page.waitForFunction(() => Boolean(window.__edit.resolveImage));
  assert.equal(await composer().getAttribute('readonly'), '');
  await tab('session-b');
  await composer().fill('Другой живой черновик');
  await page.evaluate(() => window.__edit.resolveImage());
  await settle();
  await value('Другой живой черновик');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true);
  await tab('session-a');
  await value(draft);
  assert.equal(await cancel().count(), 0);
  await edit('slow').click();
  await page.waitForFunction(() => Boolean(window.__edit.resolveImage));
  await cancel().click();
  await page.evaluate(() => window.__edit.resolveImage());
  await settle(); await value(draft);
  await page.evaluate(() => { window.__edit.resolveImage = null; });
  await edit('slow').click();
  await page.waitForFunction(() => Boolean(window.__edit.resolveImage));
  await page.evaluate(() => window.__edit.resolveImage());
  await value('Медленная картинка');
  await view().getByRole('button', { name: 'Удалить slow.png', exact: true }).waitFor();
  await cancel().click(); await value(draft);

  // Busy permits preparing an edit; Enter follows the existing send lock.
  await page.evaluate(() => window.__edit.sessions['session-a'].emit('turn/started', { threadId: 'thread-session-a', turn: { id: 'busy', status: 'inProgress', items: [] } }));
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  await edit('plain').click();
  await value('Обычный вопрос');
  await composer().fill('Уточнение во время работы'); await composer().press('Enter');
  assert.equal((await turns()).length, 0);
  await composer().press('Escape'); await value(draft);
  await page.evaluate(() => window.__edit.sessions['session-a'].emit('turn/completed', { threadId: 'thread-session-a', turn: { id: 'busy', status: 'completed', items: [], error: null } }));
  await send().waitFor();

  // Error retains the edit and its preserved original draft; retry is explicit.
  await edit('original').click(); await value(original);
  await composer().fill('Исправленный вопрос');
  await page.evaluate(() => { window.__edit.failSend = true; });
  await send().click();
  await view().getByRole('alert').filter({ hasText: 'Ошибка отправки исправления' }).waitFor();
  await value('Исправленный вопрос'); await cancel().waitFor();
  assert.equal(await view().locator('[data-item-id="original"] .user-text').innerText(), original);
  await page.evaluate(() => { window.__edit.failSend = false; window.__edit.holdSend = true; });
  await send().click();
  await page.waitForFunction(() => Boolean(window.__edit.resolveSend));
  assert.equal(await cancel().isDisabled(), true);
  assert.equal(await composer().getAttribute('readonly'), '');
  await composer().press('Escape');
  await value('Исправленный вопрос');
  await page.evaluate(() => { window.__edit.holdSend = false; window.__edit.resolveSend(); });
  await value(draft);
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  const sent = await turns();
  assert.equal(sent.length, 2, 'One failed attempt plus one explicit retry');
  assert.equal(sent[1].params.threadId, 'thread-session-a');
  assert.equal(sent[1].params.model, 'fixture');
  assert.equal(sent[1].params.effort, 'high');
  assert.equal(sent[1].params.approvalsReviewer, 'auto_review');
  assert.deepEqual(sent[1].params.input, [{ type: 'text', text: 'Исправленный вопрос', text_elements: [] }, { type: 'localImage', path: 'C:/Fixtures/EDIT/saved-0.png' }]);
  assert.equal(await view().locator('[data-item-id="original"] .user-text').innerText(), original, 'Original history remains unchanged');
  assert.equal(await view().getByText('Исходный ответ остаётся в истории.', { exact: true }).count(), 1);
  assert.equal(await view().locator('.user-message .user-text').filter({ hasText: /^Исправленный вопрос$/ }).count(), 1, 'Corrected message is a new visible item');
  await page.evaluate(() => window.__edit.sessions['session-a'].emit('turn/completed', { threadId: 'thread-session-a', turn: { id: 'sent-2', status: 'completed', items: [], error: null } }));

  // Search and edit coexist; slash-like corrected text remains ordinary text.
  await view().getByRole('button', { name: 'Поиск в чате', exact: true }).click();
  await view().getByRole('textbox', { name: 'Найти в чате', exact: true }).fill('Обычный вопрос');
  await view().locator('.chat-search-count').filter({ hasText: '1 из 1' }).waitFor();
  await edit('plain').click();
  assert.equal(await view().getByRole('textbox', { name: 'Найти в чате', exact: true }).count(), 0);
  await composer().fill('/compact literal correction');
  await send().click();
  await value(draft);
  assert.equal((await turns()).at(-1).params.input[0].text, '/compact literal correction');
  assert.equal((await calls()).filter(call => /rollback|compact|thread\/start/.test(call.method)).length, 0, 'Editing never rolls back or mutates history and never interprets corrected text as a command');
  await page.evaluate(() => window.__edit.sessions['session-a'].emit('turn/completed', { threadId: 'thread-session-a', turn: { id: 'sent-3', status: 'completed', items: [], error: null } }));
  await page.setViewportSize({ width: 940, height: 640 });
  await edit('inline').click();
  await value('Встроенное изображение');
  await view().locator('.attachments img').waitFor();
  await page.screenshot({ path: 'artifacts/edit-message-940.png' });
  const bounds = await view().locator('.composer-edit-banner').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }; });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1);
  await tab('session-b'); await value('Другой живой черновик');
  await tab('session-a'); await value('Встроенное изображение');
  await cancel().click(); await value(draft);
  await tab('archive');
  await view().getByText('Архивный вопрос', { exact: true }).waitFor();
  assert.equal(await view().getByRole('button', { name: 'Редактировать сообщение', exact: true }).count(), 0, 'Archive remains read-only');
  assert.deepEqual(errors, []);
  console.log('PASS: edit/resend as a new turn, original history preserved, exact text/image/model/access, cancel/success restores draft and image, send error/retry, busy lock, pending image cancellation/tab isolation, search/slash text, narrow layout and read-only archive. Fixture requests only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/edit-message-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
