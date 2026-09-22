import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with deterministic App Server events. No model requests.
const root = resolve('dist');
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/QUESTIONS';
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
    const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
    const question = (id, title, options, phase = 'commentary', text = `${title}\n\n${options?.map(option => `- ${option}`).join('\n') || ''}`) => ({ id, type: 'agentMessage', phase, text, questions: [{ title, options }] });
    const old = question('q-old', 'Прежний вопрос?', ['Старый вариант', 'Ещё старый вариант']);
    const current = question('q-live', 'Такой сценарий подходит?', ['Да, передача Codex ↔ Claude Code', 'Нужна передача в уже открытый диалог', 'Нужна передача между подагентами']);
    const multi = { id: 'q-multi', type: 'agentMessage', phase: 'final_answer', text: 'Уточните оформление и срок.', questions: [{ title: 'Какой формат?', options: ['Короткий', 'Подробный'] }, { title: 'Когда подготовить?', options: null }] };
    const fixture = window.__questions = { calls: [], sessions: {}, failSteer: false, holdSteer: true, image, snapshots: [] };
    for (const id of ['a', 'b']) {
      const turnId = `turn-${id}`;
      const state = fixture.sessions[id] = { listeners: new Set(), turn: turnId };
      state.thread = { id: `thread-${id}`, cwd, name: `Вопросы ${id}`, historyMode: 'legacy', status: { type: id === 'a' ? 'active' : 'idle' }, turns: [{ id: turnId, status: id === 'a' ? 'inProgress' : 'completed', items: id === 'a' ? [old, user('user-a', 'Добавить выбор ответа'), { id: 'plain-list', type: 'agentMessage', phase: 'final_answer', text: 'Обычный список:\n\n- первый пункт\n- второй пункт' }, current] : [user('user-b', 'Подготовить описание'), multi] }] };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: state.thread.id, ...params } } }); };
      state.ask = (itemId, title, options, text) => state.emit('item/completed', { turnId: state.turn, item: question(itemId, title, options, 'commentary', text) });
      state.complete = () => state.emit('turn/completed', { turn: { id: state.turn, status: 'completed', items: [], error: null } });
      state.bridge = {
        async start() { return { cwd, models: [model], executable: 'fixture', account: { account: null }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'auto' }; }, async setSettings() {},
        async request(method, params = {}) {
          fixture.calls.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [state.thread], nextCursor: null };
          if (method === 'thread/resume') return { thread: structuredClone(state.thread), model: 'fixture', reasoningEffort: 'high' };
          if (method === 'turn/steer') {
            if (fixture.failSteer) throw new Error('expectedTurnId no longer active');
            if (fixture.holdSteer) await new Promise(resolve => { fixture.resolveSteer = resolve; });
            state.emit('item/completed', { turnId: params.expectedTurnId, item: { ...user(`echo-${params.clientUserMessageId}`, ''), clientId: params.clientUserMessageId, content: params.input } });
            return { turnId: params.expectedTurnId };
          }
          if (method === 'turn/start') {
            state.turn = `started-${fixture.calls.filter(call => call.method === method).length}`;
            state.emit('turn/started', { turn: { id: state.turn, status: 'inProgress', items: [] } });
            state.emit('item/completed', { turnId: state.turn, item: { ...user(`echo-${params.clientUserMessageId}`, ''), clientId: params.clientUserMessageId, content: params.input } });
            return { turn: { id: state.turn, status: 'inProgress', items: [] } };
          }
          if (method === 'message/status') return { accepted: false, rejected: false };
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async saveImages(images) { fixture.calls.push({ sessionId: id, method: 'saveImages' }); return images.map((item, index) => ({ ...item, path: `${cwd}/saved-${index}.png` })); },
        async readAttachment() { return image; }, async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async respond(requestId) { state.emit('serverRequest/resolved', { requestId }); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
      };
    }
    const archive = { id: 'archive-thread', cwd, name: 'Вопрос в архиве' };
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { activeIndex: 0, tabs: [...Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd, thread: state.thread, draft: `Независимый черновик ${id}`, attachments: id === 'a' ? [{ name: 'draft.png', dataUrl: image }] : [] })), { id: 'archive:archive-thread', cwd, archivedThread: archive }] } }; },
      async saveWorkspaceState(snapshot) { fixture.snapshots.push(structuredClone(snapshot)); },
      async completeUpdateRestore() {}, async listProjectThreads() { return { data: Object.values(fixture.sessions).map(state => state.thread), nextCursor: null }; },
      async readArchivedThread() { return { thread: archive, items: [{ ...question('q-archive', 'Архивный вопрос?', ['Архивный вариант', 'Другой вариант']), complete: true, turnId: 'archived-turn' }], turns: [], nextCursor: null }; },
      forSession(id) { return fixture.sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const message = id => view().locator(`.message[data-item-id="${id}"]`);
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const submit = id => message(id).getByRole('button', { name: 'Отправить ответ', exact: true });
  const calls = method => page.evaluate(method => window.__questions.calls.filter(call => call.method === method), method);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tab = id => page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
  await message('q-live').locator('.agent-question-option').first().waitFor();
  await composer().waitFor();
  assert.equal(await submit('q-live').isDisabled(), true, 'An unanswered form cannot be submitted');
  assert.equal(await view().locator('[data-item-id="q-old"] .agent-question-option').count(), 0, 'A question preceding a later user message is read only');
  assert.equal(await message('plain-list').locator('.agent-question-option').count(), 0, 'Markdown lists are not guessed to be question options');
  assert.equal(await message('q-live').locator('.agent-question-option').count(), 3, 'A commentary question is visible outside the collapsed work log');
  const selected = message('q-live').locator('.agent-question-option').first();
  await selected.click();
  assert.equal(await selected.getAttribute('aria-pressed'), 'true');
  assert.equal((await calls('turn/steer')).length, 0, 'Selecting an option does not send it');
  assert.equal((await calls('turn/start')).length, 0);
  await page.screenshot({ path: 'artifacts/agent-questions-selected.png' });
  // Synchronous duplicate submission must not become two distinct messages.
  await message('q-live').locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.waitForFunction(() => Boolean(window.__questions.resolveSteer));
  assert.equal((await calls('turn/steer')).length, 1);
  await page.evaluate(() => { window.__questions.holdSteer = false; window.__questions.resolveSteer(); });
  await page.waitForFunction(() => [...document.querySelectorAll('.session-view:not([hidden]) .user-text')].some(node => node.textContent === 'Да, передача Codex ↔ Claude Code'));
  const first = (await calls('turn/steer'))[0];
  assert.equal(first.sessionId, 'a');
  assert.equal(first.params.threadId, 'thread-a');
  assert.equal(first.params.expectedTurnId, 'turn-a');
  assert.deepEqual(first.params.input, [{ type: 'text', text: 'Да, передача Codex ↔ Claude Code', text_elements: [] }]);
  assert.deepEqual(Object.keys(first.params).sort(), ['clientUserMessageId', 'expectedTurnId', 'input', 'threadId']);
  assert.equal(await composer().inputValue(), 'Независимый черновик a');
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  assert.equal((await calls('saveImages')).length, 0, 'A question answer does not consume the composer attachment');
  assert.equal(await message('q-live').locator('.agent-question-option').count(), 0, 'An accepted answer leaves its old question read only');

  // Multiple questions and free text are sent together using the normal idle path.
  await tab('b');
  await message('q-multi').getByText('Уточните оформление и срок.', { exact: true }).waitFor();
  await message('q-multi').locator('.agent-question-option').first().click();
  assert.equal(await submit('q-multi').isDisabled(), true, 'All questions need answers');
  await message('q-multi').locator('fieldset').nth(1).getByRole('textbox').fill('Завтра к 15:00');
  await submit('q-multi').click();
  await page.waitForFunction(() => window.__questions.calls.some(call => call.method === 'turn/start'));
  const start = (await calls('turn/start'))[0];
  assert.equal(start.sessionId, 'b'); assert.equal(start.params.threadId, 'thread-b');
  assert.equal(start.params.input.length, 1);
  assert.match(start.params.input[0].text, /Какой формат\?\s*\nКороткий/);
  assert.match(start.params.input[0].text, /Когда подготовить\?\s*\nЗавтра к 15:00/);
  assert.equal(start.params.model, 'fixture'); assert.equal(start.params.effort, 'high');
  assert.equal(start.params.approvalsReviewer, 'auto_review');
  assert.equal(await composer().inputValue(), 'Независимый черновик b');
  assert.equal((await calls('turn/steer')).length, 1, 'An idle answer starts exactly its own tab');

  // Rejected steering keeps the selected answer available for explicit retry.
  await tab('a');
  await page.evaluate(() => { window.__questions.failSteer = true; window.__questions.sessions.a.ask('q-retry', 'Как повторить?', ['Сохранить выбор', 'Другой ответ']); });
  await message('q-retry').locator('.agent-question-option').first().click();
  await submit('q-retry').click();
  await view().getByRole('alert').filter({ hasText: 'Уточнение не подтверждено' }).waitFor();
  await settle();
  assert.equal((await calls('turn/steer')).length, 2);
  assert.equal(await message('q-retry').locator('.agent-question-option').first().getAttribute('aria-pressed'), 'true', 'Rejected RPC preserves the selection');
  assert.equal(await submit('q-retry').isDisabled(), false);
  assert.equal(await composer().inputValue(), 'Независимый черновик a');
  // A pending server approval blocks question submission, including a forged submit event.
  await page.evaluate(() => { for (const listener of window.__questions.sessions.a.listeners) listener({ type: 'serverRequest', data: { id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', command: 'fixture read' } } }); });
  await view().locator('.approval-card').waitFor();
  assert.equal(await submit('q-retry').isDisabled(), true);
  await message('q-retry').locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle(); assert.equal((await calls('turn/steer')).length, 2);
  await page.evaluate(() => { window.__questions.failSteer = false; window.__questions.sessions.a.emit('serverRequest/resolved', { requestId: 'fixture-approval' }); });
  await view().locator('.approval-card').waitFor({ state: 'hidden' });
  await submit('q-retry').click();
  await page.waitForFunction(() => window.__questions.calls.filter(call => call.method === 'turn/steer').length === 3);
  assert.equal((await calls('turn/steer'))[2].params.input[0].text, 'Сохранить выбор');
  assert.equal((await calls('turn/start')).length, 1, 'A failed steer never falls through to a new turn');

  // A textless structured item must remain answerable; custom text overrides an option.
  await page.evaluate(() => window.__questions.sessions.a.ask('q-empty', 'Свой вариант?', ['Первый', 'Второй'], ''));
  await message('q-empty').locator('.agent-question-option').first().click();
  await message('q-empty').getByRole('textbox').fill('Мой вариант без дополнительных инструкций');
  assert.equal(await message('q-empty').locator('.agent-question-option[aria-pressed="true"]').count(), 0);
  await page.setViewportSize({ width: 940, height: 700 });
  await message('q-empty').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/agent-questions-narrow.png' });
  const overflow = await message('q-empty').evaluate(node => node.scrollWidth > node.clientWidth + 1);
  assert.equal(overflow, false, 'Question controls fit a narrow chat');
  await submit('q-empty').click();
  await page.waitForFunction(() => window.__questions.calls.filter(call => call.method === 'turn/steer').length === 4);
  assert.equal((await calls('turn/steer'))[3].params.input[0].text, 'Мой вариант без дополнительных инструкций');
  assert.equal(await composer().inputValue(), 'Независимый черновик a');

  await page.setViewportSize({ width: 1440, height: 950 });
  await tab('archive:archive-thread');
  await view().getByText('Архивный вариант', { exact: true }).waitFor();
  assert.equal(await view().locator('.agent-question-option').count(), 0, 'Archive never offers actions without an answer callback');
  assert.equal(await view().getByRole('button', { name: 'Отправить ответ', exact: true }).count(), 0);
  assert.equal((await calls('turn/steer')).length, 4); assert.equal((await calls('turn/start')).length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: structured options without automatic send, active steer and idle start, exact visible answers, separate drafts/attachments, multi-question and free-text answers, commentary/textless questions, duplicate submit guard, rejected-answer retry, approval guard, old/plain/archived read-only messages, tab isolation and narrow layout. Mock bridge only; no model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/agent-questions-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
