import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
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
    const cwd = 'C:/Fixtures/QUEUE';
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
    const fixture = window.__queue = { calls: [], snapshots: [], sessions: {}, failSend: false, holdSend: false, holdImage: false, holdFlush: false, failFlush: false, failSteer: false };
    for (const id of ['a', 'b']) {
      const state = fixture.sessions[id] = { listeners: new Set(), turn: `running-${id}` };
      const thread = { id: `thread-${id}`, cwd, name: `Задача ${id}`, turns: [{ id: `running-${id}`, status: 'inProgress', items: [{ id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Исходная задача ${id}` }] }] }] };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: thread.id, ...params } } }); };
      state.status = status => { for (const listener of state.listeners) listener({ type: 'status', data: { state: status } }); };
      state.complete = (status = 'completed', error = null) => state.emit('turn/completed', { turn: { id: state.turn, status, error, items: [] } });
      state.begin = id => { state.turn = id; state.emit('turn/started', { turn: { id, status: 'inProgress', items: [] } }); };
      state.bridge = {
        async start() { return { cwd, models: [model], executable: 'fixture', account: { account: null }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'auto' }; }, async setSettings() {},
        async request(method, params = {}) {
          fixture.calls.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
          if (method === 'message/status') return fixture.receipt || { accepted: false, rejected: false };
          if (method === 'turn/steer') {
            if (fixture.failSteer) throw new Error('expectedTurnId no longer active');
            state.emit('item/started', { turnId: params.expectedTurnId, item: { id: `echo-${params.clientUserMessageId}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } });
            state.emit('item/completed', { turnId: params.expectedTurnId, item: { id: `echo-${params.clientUserMessageId}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } });
            return { turnId: params.expectedTurnId };
          }
          if (method === 'turn/start') {
            if (fixture.echoTimeout) {
              state.turn = 'accepted-before-timeout';
              state.emit('turn/started', { turn: { id: state.turn, status: 'inProgress', items: [] } });
              state.emit('item/completed', { turnId: state.turn, item: { id: 'provider-echo', clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } });
              throw new Error('Transport timeout after write');
            }
            if (fixture.unrelatedTimeout) {
              state.turn = 'uncertain-turn';
              state.emit('turn/started', { turn: { id: state.turn, status: 'inProgress', items: [] } });
              state.emit('item/completed', { turnId: state.turn, item: { id: 'other-message', clientId: 'other-client-id', type: 'userMessage', content: params.input } });
              throw new Error('Transport timeout after write');
            }
            if (fixture.failSend) throw new Error('Transport timeout after write');
            if (fixture.holdSend) await new Promise(resolve => { fixture.resolveSend = resolve; });
            state.turn = `sent-${fixture.calls.filter(call => call.method === 'turn/start').length}`;
            state.emit('turn/started', { turn: { id: state.turn, status: 'inProgress', items: [] } });
            return { turn: { id: state.turn, status: 'inProgress', items: [] } };
          }
          if (method === 'turn/interrupt') { state.complete('interrupted'); return {}; }
          throw new Error(`Forbidden fixture request ${method}`);
        },
        async saveImages(images) { if (fixture.holdImage) await new Promise(resolve => { fixture.resolveImage = resolve; }); return images.map((image, index) => ({ ...image, path: `${cwd}/saved-${index}.png` })); },
        async readAttachment() { return image; }, async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async respond(id) { state.emit('serverRequest/resolved', { requestId: id }); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
      };
      state.thread = thread;
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { source: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd, thread: state.thread, draft: id === 'a' ? 'Учитывай старый формат' : 'Черновик B', attachments: id === 'a' ? [{ name: 'test.png', dataUrl: image }] : [], ...(id === 'b' ? { queue: { items: [{ id: 'restored', text: 'Восстановленная очередь', attachments: [] }], paused: false } } : {}) })) } }; },
      async saveWorkspaceState(state) { fixture.snapshots.push(structuredClone(state)); if (fixture.failFlush) throw new Error('Disk write failed'); if (fixture.holdFlush) await new Promise(resolve => { fixture.resolveFlush = resolve; }); },
      async completeUpdateRestore() {}, async listProjectThreads() { return { data: Object.values(fixture.sessions).map(state => state.thread), nextCursor: null }; },
      forSession(id) { return fixture.sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const queue = () => view().getByRole('region', { name: 'Очередь сообщений', exact: true });
  const tab = async id => page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const starts = () => page.evaluate(() => window.__queue.calls.filter(call => call.method === 'turn/start'));
  const enqueue = async text => { await composer().fill(text); await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click(); };
  const complete = async (status = 'completed') => page.evaluate(status => window.__queue.sessions.a.complete(status), status);
  await view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true }).waitFor();
  await view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true }).click();
  await page.waitForFunction(() => window.__queue.calls.some(call => call.method === 'turn/steer'));
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) .composer textarea').value === '');
  const steer = await page.evaluate(() => window.__queue.calls.find(call => call.method === 'turn/steer'));
  assert.equal(steer.params.threadId, 'thread-a'); assert.equal(steer.params.expectedTurnId, 'running-a');
  assert.deepEqual(steer.params.input, [{ type: 'text', text: 'Учитывай старый формат', text_elements: [] }, { type: 'localImage', path: 'C:/Fixtures/QUEUE/saved-0.png' }]);
  assert.deepEqual(Object.keys(steer.params).sort(), ['clientUserMessageId', 'expectedTurnId', 'input', 'threadId']);
  assert.equal(await view().locator('.user-text').filter({ hasText: /^Учитывай старый формат$/ }).count(), 1, 'Server echo replaces optimistic steer once');
  assert.equal((await starts()).length, 0, 'Steer never starts another turn');
  await enqueue('Первое из очереди'); await enqueue('Второе из очереди'); await enqueue('Удалить эту задачу');
  await queue().locator('li').nth(2).getByRole('button', { name: 'Удалить из очереди', exact: true }).click();
  await queue().locator('li').nth(1).getByRole('button', { name: 'Изменить', exact: true }).click();
  await queue().getByRole('textbox', { name: 'Сообщение в очереди', exact: true }).fill('Второе исправлено');
  await queue().getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await composer().fill('Черновик остаётся со мной');
  await complete();
  await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 1);
  await queue().getByText('Второе исправлено', { exact: true }).waitFor();
  assert.equal((await starts())[0].params.input[0].text, 'Первое из очереди');
  assert.equal((await starts())[0].params.model, 'fixture'); assert.equal((await starts())[0].params.effort, 'high'); assert.equal((await starts())[0].params.approvalsReviewer, 'auto_review');
  assert.equal(await composer().inputValue(), 'Черновик остаётся со мной');
  const snapshots = await page.evaluate(() => window.__queue.snapshots);
  assert.ok(snapshots.some(snapshot => snapshot.tabs.some(tab => tab.sessionId === 'a' && tab.queue?.items[0]?.state === 'uncertain')), 'Durable uncertain checkpoint precedes queue request');
  await complete(); await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal((await starts())[1].params.input[0].text, 'Второе исправлено');
  await enqueue('После остановки');
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).click();
  await queue().getByText('На паузе', { exact: true }).waitFor(); await settle(); assert.equal((await starts()).length, 2);
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 3);
  await enqueue('После ошибки отправки');
  await page.evaluate(() => { window.__queue.failSend = true; }); await complete();
  await queue().getByText('Отправка не подтверждена. Проверьте историю перед повтором.', { exact: true }).waitFor();
  assert.equal(await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).isDisabled(), true);
  await settle(); assert.equal((await starts()).length, 4, 'Uncertain sends never retry automatically');
  await queue().getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await queue().getByText(/Подтверждение не найдено/).waitFor();
  assert.equal((await starts()).length, 4, 'Missing history ID never authorizes retry');
  await page.evaluate(() => { window.__queue.failSend = false; window.__queue.receipt = { accepted: false, rejected: true }; });
  await queue().getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 5);

  // Restoring another tab never turns an old completion into authorization.
  await tab('b'); await queue().getByText('На паузе', { exact: true }).waitFor();
  await page.evaluate(() => window.__queue.sessions.b.complete()); await settle();
  assert.equal((await starts()).length, 5);
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 6);
  assert.equal((await starts())[5].sessionId, 'b'); assert.equal(await composer().inputValue(), 'Черновик B');
  await tab('a'); assert.equal(await composer().inputValue(), '');

  // The turn can finish while an image is being saved. The draft survives;
  // there must be no steer to a stale turn and no fallback turn/start.
  await page.evaluate(() => { window.__queue.holdImage = true; });
  await view().locator('input[type="file"]').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
  await composer().fill('Уточнение на границе завершения');
  await view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__queue.resolveImage));
  await complete();
  await page.evaluate(() => { window.__queue.holdImage = false; window.__queue.resolveImage(); });
  await view().getByRole('alert').filter({ hasText: 'Уточнение осталось в поле ввода' }).waitFor();
  assert.equal(await composer().inputValue(), 'Уточнение на границе завершения');
  assert.equal(await page.evaluate(() => window.__queue.calls.filter(call => call.method === 'turn/steer').length), 1);
  assert.equal((await starts()).length, 6);
  await view().getByRole('button', { name: 'Удалить late.png', exact: true }).click();
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  await page.evaluate(() => window.__queue.sessions.a.begin('late-steer'));
  await page.evaluate(() => { window.__queue.failSteer = true; });
  await view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true }).click();
  await view().getByRole('alert').filter({ hasText: 'Уточнение не подтверждено' }).waitFor();
  assert.equal(await composer().inputValue(), 'Уточнение на границе завершения');
  assert.equal((await starts()).length, 6);
  await page.evaluate(() => { window.__queue.failSteer = false; });
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();

  // Failure to checkpoint the queue must prevent the network request entirely.
  await enqueue('Не отправлять без сохранения');
  await page.evaluate(() => { window.__queue.failFlush = true; }); await complete();
  await queue().getByText('Не удалось сохранить очередь. Сообщение не отправлено.', { exact: true }).waitFor();
  assert.equal((await starts()).length, 6);
  assert.equal(await queue().getByRole('button', { name: 'Проверить отправку', exact: true }).count(), 0);
  await page.evaluate(() => { window.__queue.failFlush = false; });
  await queue().getByRole('button', { name: 'Удалить из очереди', exact: true }).click();
  await page.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  // A pause/error can arrive in the same microtask as durable persistence.
  // Its synchronous fence must win before React has processed the event.
  await page.evaluate(() => window.__queue.sessions.a.begin('flush-race'));
  await enqueue('Не отправлять после ошибки при сохранении');
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.evaluate(() => { window.__queue.holdFlush = true; });
  await complete();
  await page.waitForFunction(() => Boolean(window.__queue.resolveFlush));
  await page.evaluate(() => { window.__queue.holdFlush = false; window.__queue.sessions.a.emit('error', { error: { message: 'Ошибка между сохранением и отправкой' }, willRetry: false }); window.__queue.resolveFlush(); });
  await queue().getByText('На паузе', { exact: true }).waitFor();
  await settle(); assert.equal((await starts()).length, 6, 'Error during flush wins over pending queue send');
  await queue().getByRole('button', { name: 'Удалить из очереди', exact: true }).click();
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  await page.evaluate(() => window.__queue.sessions.a.begin('approval-task'));

  // Stop/error/disconnect require explicit resume. Approval blocks live steering.
  await enqueue('Ждать подтверждения');
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.evaluate(() => { for (const listener of window.__queue.sessions.a.listeners) listener({ type: 'serverRequest', data: { id: 'approve', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'fixture' } } }); });
  await composer().fill('Уточнение при разрешении');
  assert.equal(await view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__queue.sessions.a.emit('serverRequest/resolved', { requestId: 'approve' }));
  await queue().getByRole('button', { name: 'Пауза очереди', exact: true }).click();
  await complete(); await settle(); assert.equal((await starts()).length, 6);
  await page.evaluate(() => window.__queue.sessions.a.begin('error-task'));
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await complete('failed'); await queue().getByText('На паузе', { exact: true }).waitFor();
  await page.evaluate(() => window.__queue.sessions.a.begin('disconnect-task'));
  await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await page.evaluate(() => window.__queue.sessions.a.status('disconnected'));
  await queue().getByText('На паузе', { exact: true }).waitFor(); assert.equal((await starts()).length, 6);
  assert.equal(await queue().getByRole('button', { name: 'Продолжить очередь', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 940, height: 640 });
  await page.screenshot({ path: 'artifacts/message-queue-940.png' });
  const bounds = await queue().evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }; });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1);
  // Ordinary composer timeout: a matching exact echo is accepted; identical text with another ID is not.
  await tab('b'); await page.evaluate(() => window.__queue.sessions.b.complete());
  await composer().fill('Обычная отправка с задержкой ACK');
  await page.evaluate(() => { window.__queue.echoTimeout = true; window.__queue.receipt = null; });
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await page.waitForFunction(() => window.__queue.calls.filter(call => call.method === 'turn/start').length === 7);
  await settle(); assert.equal(await composer().inputValue(), '');
  assert.equal(await view().locator('.pending-message').count(), 0);
  await page.evaluate(() => window.__queue.sessions.b.complete());
  await page.evaluate(() => { window.__queue.echoTimeout = false; window.__queue.unrelatedTimeout = true; });
  await composer().fill('Одинаковый текст другого сообщения');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().locator('.pending-message').waitFor();
  assert.equal(await composer().inputValue(), 'Одинаковый текст другого сообщения');
  await view().locator('.pending-message').getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await settle(); assert.equal((await starts()).length, 8); assert.equal(await view().locator('.pending-message').count(), 1);
  const last = (await starts()).at(-1);
  await page.evaluate(id => window.__queue.sessions.b.emit('message/receipt', { clientUserMessageId: id, accepted: true, rejected: false, turnId: 'uncertain-turn', status: 'inProgress' }), last.params.clientUserMessageId);
  await view().locator('.pending-message').getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await settle(); assert.equal(await composer().inputValue(), ''); assert.equal(await view().locator('.pending-message').count(), 0);
  assert.equal((await starts()).length, 8, 'Late ACK reconciles without repeating the task');
  assert.deepEqual(errors, []);
  console.log('PASS: exact steer precondition/text/images and echo reconciliation; stale-turn image race and steer rejection preserve draft; ordered queue, edit/delete, preserved draft, durable uncertain checkpoint and write failure prevents request, no automatic retry, stop/failure/disconnect/approval guards, restart pause, per-tab isolation and narrow layout. Mock bridge only, no model calls.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/message-queue-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
