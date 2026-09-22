import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with a controlled bridge. No Electron, real Codex,
// provider calls, or modifications to the user's history.
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
const pageErrors = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const openScenario = async scenario => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(scenario => {
      const cwd = 'C:/Fixtures/Resume';
      const threadId = '01a0ae2f-319d-7991-8cc4-64c522c1b1b3';
      const paginated = scenario !== 'disconnect';
      const history = { id: threadId, name: 'Сохранённый диалог', preview: 'История проверки', cwd, historyMode: paginated ? 'paginated' : 'legacy' };
      const savedItems = [
        { id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: 'Сохранённый вопрос' }] },
        { id: 'saved-answer', type: 'agentMessage', text: 'Переписка восстановлена из истории.' },
      ];
      const savedTurn = { id: 'saved-turn', status: 'completed', items: savedItems };
      const olderTurn = { id: 'older-turn', status: 'completed', items: [{ id: 'older-answer', type: 'agentMessage', text: 'Самый ранний ответ из полной истории.' }] };
      const savedThread = { ...history, status: { type: 'idle' }, turns: paginated ? [] : [savedTurn] };
      const settings = { cwd, model: 'fixture-model', effort: 'high', access: 'inherited' };
      const listeners = new Set();
      let resumeCount = 0;
      const state = { requests: [], resumeCount: 0, pendingResume: null, starts: 0 };
      state.emit = (type, data) => { for (const listener of listeners) listener({ type, data }); };
      state.finishResume = (fresh = false) => {
        const pending = state.pendingResume;
        state.pendingResume = null;
        if (fresh) { pending?.({ thread: savedThread, model: 'fixture-model', reasoningEffort: 'high' }); return; }
        pending?.({ thread: { ...savedThread, turns: [{ ...savedTurn, items: [{ id: 'stale-answer', type: 'agentMessage', text: 'STALE RESUME MUST NOT APPEAR' }] }] }, model: 'stale-model', reasoningEffort: 'low' });
      };
      window.__resume = state;
      window.codex = {
        async start() { state.starts++; return { initialize: {}, models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], cwd, executable: 'C:/Fixtures/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-model', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...settings }; },
        async setSettings(patch) { Object.assign(settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [history], nextCursor: null };
          if (method === 'thread/resume') {
            state.resumeCount = ++resumeCount;
            if (scenario === 'disconnect') return await new Promise(resolve => { state.pendingResume = resolve; });
            if (scenario === 'writer-conflict') throw new Error(`Error invoking remote method 'codex:request': Error: thread ${threadId} already has an active writer`);
            if (scenario === 'retry-resume' && resumeCount === 1) throw new Error(`Error invoking remote method 'codex:request': Error: thread not found: ${threadId}`);
            return { thread: savedThread, model: 'fixture-model', reasoningEffort: 'high' };
          }
          if (method === 'thread/read') return { thread: { ...savedThread, turns: scenario === 'retry-resume' ? [olderTurn, savedTurn] : [savedTurn] } };
          if (method === 'thread/items/list') {
            if (scenario === 'items-failure') throw new Error('Fixture: item pagination unavailable');
            return { data: [...savedItems].reverse().map(item => ({ item, turnId: savedTurn.id })), nextCursor: null };
          }
          if (method === 'thread/turns/list') {
            if (scenario === 'metadata-failure') throw new Error('Fixture: turn metadata unavailable');
            return { data: [savedTurn], nextCursor: null };
          }
          if (method === 'turn/start') {
            if (scenario === 'retry-start-rejected') return await new Promise((resolve, reject) => { state.rejectStart = () => reject(new Error('Fixture turn/start rejected')); });
            return { turn: { id: 'new-turn', status: 'inProgress', items: [] } };
          }
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async respond() {}, async chooseDirectory() { return null; }, async chooseExecutable() { return null; },
        async saveImages(images) { return images; }, async readAttachment() { return null; },
        async listFiles() { return { entries: [], nextCursor: null }; }, async openPath() {},
      };
    }, scenario);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.history-item').getByText('Сохранённый диалог', { exact: true }).waitFor();
    await page.locator('.history-item').filter({ hasText: 'Сохранённый диалог' }).click();
  };
  const input = () => page.getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const send = () => page.getByRole('button', { name: 'Отправить сообщение', exact: true });
  const requests = () => page.evaluate(() => window.__resume.requests);
  const readable = () => page.getByText('Переписка восстановлена из истории.', { exact: true }).waitFor();

  await openScenario('retry-resume');
  await readable();
  await page.getByText('Самый ранний ответ из полной истории.', { exact: true }).waitFor();
  let calls = await requests();
  assert.ok(calls.some(call => call.method === 'thread/read' && call.params.includeTurns === true), 'Failed resume reads the existing history without acquiring another writer');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 0, 'Opening a conversation never sends a model turn');
  await input().fill('Продолжить сохранённую беседу');
  await send().click();
  await page.waitForFunction(() => window.__resume.requests.some(call => call.method === 'turn/start'));
  calls = await requests();
  const resumes = calls.flatMap((call, index) => call.method === 'thread/resume' ? [index] : []);
  const turnIndex = calls.findIndex(call => call.method === 'turn/start');
  assert.equal(resumes.length, 2, 'Send retries the original resume after read-only fallback');
  assert.ok(resumes[1] < turnIndex, 'Writable resume must succeed before turn/start');
  assert.equal(calls[turnIndex].params.threadId, '01a0ae2f-319d-7991-8cc4-64c522c1b1b3');
  assert.equal(calls.some(call => call.method === 'thread/start'), false, 'Retry preserves the original thread rather than creating a new one');
  await readable();
  const historyOrder = await page.locator('.chat-scroll').innerText();
  const oldestPosition = historyOrder.indexOf('Самый ранний ответ из полной истории.');
  const questionPosition = historyOrder.indexOf('Сохранённый вопрос');
  const answerPosition = historyOrder.indexOf('Переписка восстановлена из истории.');
  const newPosition = historyOrder.indexOf('Продолжить сохранённую беседу');
  assert.ok(oldestPosition >= 0 && questionPosition > oldestPosition && answerPosition > questionPosition && newPosition > answerPosition,
    'Retry keeps older full-history messages before the recent page and the new user message');
  assert.equal(await page.getByText('Самый ранний ответ из полной истории.', { exact: true }).count(), 1, 'Retry preserves older messages once when the latest page omits them');

  await openScenario('writer-conflict');
  await readable();
  await input().fill('Черновик после ошибки занятого диалога');
  await send().click();
  await page.waitForFunction(() => window.__resume.resumeCount >= 2);
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Отправить сообщение"]');
    return button && !button.disabled;
  });
  calls = await requests();
  assert.equal(calls.some(call => call.method === 'turn/start'), false, 'An unresolved writer conflict cannot start a turn');
  assert.equal(calls.some(call => call.method === 'thread/start'), false, 'Writer conflict cannot silently create a new conversation');
  assert.equal(await input().inputValue(), 'Черновик после ошибки занятого диалога', 'Failed retry preserves the draft');
  await readable();
  await page.screenshot({ path: 'artifacts/resume-writer-conflict.png' });

  await openScenario('metadata-failure');
  await readable();
  calls = await requests();
  assert.ok(calls.some(call => call.method === 'thread/items/list'));
  assert.ok(calls.some(call => call.method === 'thread/turns/list'));
  assert.equal(calls.some(call => call.method === 'turn/start'), false);
  assert.equal(await page.locator('.chat-scroll .user-message').getByText('Сохранённый вопрос', { exact: true }).count(), 1, 'Optional turn metadata failure does not discard the readable item page');
  await page.screenshot({ path: 'artifacts/resume-metadata-failure.png' });

  await openScenario('items-failure');
  await readable();
  calls = await requests();
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1, 'Unreadable pagination does not acquire a second writer');
  assert.ok(calls.some(call => call.method === 'thread/items/list'));
  assert.ok(calls.some(call => call.method === 'thread/read' && call.params.includeTurns === true), 'Failed items paging falls back to the stored transcript');
  assert.equal(await page.locator('.chat-scroll .user-message').getByText('Сохранённый вопрос', { exact: true }).count(), 1);
  await input().fill('Продолжить после резервного чтения');
  await send().click();
  await page.waitForFunction(() => window.__resume.requests.some(call => call.method === 'turn/start'));
  calls = await requests();
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1, 'History fallback keeps the successfully acquired writer');
  assert.equal(calls.find(call => call.method === 'turn/start').params.threadId, '01a0ae2f-319d-7991-8cc4-64c522c1b1b3');
  await readable();

  await openScenario('disconnect');
  await page.waitForFunction(() => Boolean(window.__resume.pendingResume));
  await input().fill('Черновик на время восстановления');
  await page.evaluate(() => window.__resume.emit('status', { state: 'exited', message: 'Fixture connection lost during resume' }));
  await page.getByText('Fixture connection lost during resume', { exact: true }).waitFor();
  await page.evaluate(() => window.__resume.finishResume());
  // Cross two animation frames so the resolved promise and React state updates settle.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('STALE RESUME MUST NOT APPEAR', { exact: true }).count(), 0, 'A disconnected generation cannot hydrate a late resume result');
  assert.equal(await page.getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-model', 'A late response cannot overwrite the current model selection');
  assert.equal(await send().isDisabled(), true, 'Disconnected composer stays blocked');

  // One-click reconnect keeps the transcript and draft on screen and resumes the same dialog.
  const startsBefore = await page.evaluate(() => window.__resume.starts);
  await page.getByRole('button', { name: 'Переподключить диалог', exact: true }).click();
  await page.waitForFunction(count => window.__resume.starts === count + 1, startsBefore);
  await page.waitForFunction(() => Boolean(window.__resume.pendingResume), null, { timeout: 10000 });
  assert.equal(await input().inputValue(), 'Черновик на время восстановления', 'Draft survives the reconnect');
  await page.evaluate(() => window.__resume.finishResume(true));
  await page.waitForFunction(() => !document.querySelector('[aria-label="Отправить сообщение"]')?.disabled);
  const reconnectCalls = await requests();
  assert.equal(reconnectCalls.filter(call => call.method === 'thread/resume').at(-1).params.threadId, '01a0ae2f-319d-7991-8cc4-64c522c1b1b3', 'Reconnect resumes the same dialog');
  assert.equal(reconnectCalls.filter(call => call.method === 'turn/start').length, 0, 'Reconnect never sends a turn');
  await page.getByText('Переписка восстановлена из истории.', { exact: true }).waitFor();
  assert.equal(await page.getByText('STALE RESUME MUST NOT APPEAR', { exact: true }).count(), 0);

  await openScenario('automatic-retry');
  await readable();
  const notify = async (method, params) => {
    await page.evaluate(({ method, params }) => window.__resume.emit('notification', { method, params }), { method, params });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const retryContext = { threadId: '01a0ae2f-319d-7991-8cc4-64c522c1b1b3', turnId: 'retry-live' };
  const reconnect = () => page.locator('.reconnect-alert');
  const showRetry = async (attempt = 2, context = retryContext) => {
    await notify('error', { ...context, willRetry: true, error: { message: `Reconnecting... ${attempt}/5` } });
    await reconnect().waitFor();
  };
  await notify('turn/started', { threadId: retryContext.threadId, turn: { id: retryContext.turnId, status: 'inProgress', items: [] } });
  await showRetry();
  assert.equal(await reconnect().getAttribute('role'), 'status', 'Automatic retry is presented as a live status');
  assert.equal(await reconnect().locator('.spin').count(), 1, 'Retry has a visible activity indicator');
  await reconnect().getByText('Переподключаемся… Попытка 2 из 5', { exact: true }).waitFor();
  await reconnect().getByText('Ответ временно прерван. Ждём восстановления соединения.', { exact: true }).waitFor();
  assert.equal(await page.locator('.error-alert').count(), 0, 'A transient retry is not retained as a terminal error');
  await page.screenshot({ path: 'artifacts/resume-automatic-retry.png' });
  await page.setViewportSize({ width: 560, height: 900 });
  await page.screenshot({ path: 'artifacts/resume-automatic-retry-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await showRetry(3);
  await showRetry(3);
  assert.equal(await reconnect().count(), 1, 'Repeated retry notifications update one status without duplicates');
  await reconnect().getByText('Переподключаемся… Попытка 3 из 5', { exact: true }).waitFor();

  const unrelatedEvents = [
    ['error', { ...retryContext, threadId: 'foreign-thread', willRetry: true, error: { message: 'Reconnecting... 5/5' } }],
    ['error', { ...retryContext, turnId: 'foreign-turn', willRetry: true, error: { message: 'Reconnecting... 5/5' } }],
    ['thread/tokenUsage/updated', { ...retryContext, tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 10, totalTokens: 1010 } } }],
    ['thread/status/changed', { threadId: retryContext.threadId, status: { type: 'active', activeFlags: [] } }],
    ['item/started', { ...retryContext, item: { id: 'retry-command', type: 'commandExecution', command: 'fixture', status: 'inProgress', aggregatedOutput: '' } }],
    ['item/commandExecution/outputDelta', { ...retryContext, itemId: 'retry-command', delta: 'Fixture tool output' }],
    ['item/completed', { ...retryContext, item: { id: 'retry-command', type: 'commandExecution', command: 'fixture', status: 'completed', aggregatedOutput: 'Fixture tool output', exitCode: 0 } }],
    ...['item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].map((method, index) => [method, { ...retryContext, itemId: `empty-retry-${index}`, delta: '' }]),
    ['item/agentMessage/delta', { ...retryContext, threadId: 'foreign-thread', itemId: 'foreign-answer', delta: 'Foreign response' }],
    ['item/reasoning/textDelta', { ...retryContext, turnId: 'foreign-turn', itemId: 'foreign-reasoning', delta: 'Foreign reasoning' }],
    ['item/completed', { ...retryContext, turnId: 'foreign-turn', item: { id: 'foreign-item', type: 'agentMessage', text: 'Foreign item' } }],
    ['turn/completed', { threadId: 'foreign-thread', turn: { id: retryContext.turnId, status: 'completed', items: [], error: null } }],
    ['turn/completed', { threadId: retryContext.threadId, turn: { id: 'foreign-turn', status: 'completed', items: [], error: null } }],
  ];
  for (const [method, params] of unrelatedEvents) {
    await notify(method, params);
    assert.equal(await reconnect().count(), 1, `${method} without a matching model response must not clear retry status`);
    assert.ok((await reconnect().innerText()).includes('Попытка 3 из 5'), 'Foreign retry notifications cannot overwrite the current attempt');
  }

  const modelDeltas = ['item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'];
  for (const [index, method] of modelDeltas.entries()) {
    await showRetry();
    await notify(method, { ...retryContext, itemId: `recovered-delta-${index}`, delta: `Ответ восстановлен: ${index}` });
    assert.equal(await reconnect().count(), 0, `${method} from the retried turn clears its status`);
  }
  for (const method of ['item/started', 'item/completed']) {
    for (const type of ['agentMessage', 'reasoning', 'plan']) {
      await showRetry();
      await notify(method, { ...retryContext, item: { id: `recovered-${method}-${type}`, type, text: 'Восстановленный элемент', summary: [], content: [] } });
      assert.equal(await reconnect().count(), 0, `${method} for a matching ${type} proves recovery without a delta`);
    }
  }

  await showRetry(4);
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).click();
  const unrelatedError = 'Выбор файлов доступен после обновления приложения. Изображение можно вставить через Ctrl+V.';
  await page.locator('.error-alert').getByText(unrelatedError, { exact: true }).waitFor();
  assert.equal(await reconnect().count(), 1, 'An unrelated UI error can coexist with retry status');
  await notify('item/agentMessage/delta', { ...retryContext, itemId: 'recovered-with-error', delta: 'Соединение восстановлено' });
  assert.equal(await reconnect().count(), 0);
  assert.equal(await page.locator('.error-alert').innerText(), unrelatedError, 'Recovery preserves unrelated file-picker errors');
  await page.getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();

  await showRetry(5);
  await notify('error', { ...retryContext, willRetry: false, error: { message: 'Fixture retry exhausted' } });
  assert.equal(await reconnect().count(), 0, 'A terminal error replaces the retry status');
  await page.locator('.error-alert').getByText('Fixture retry exhausted', { exact: true }).waitFor();
  await notify('item/agentMessage/delta', { ...retryContext, itemId: 'late-after-error', delta: 'Late response' });
  assert.equal(await page.locator('.error-alert').innerText(), 'Fixture retry exhausted', 'A late delta cannot dismiss a terminal error');
  await page.getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();

  await showRetry();
  const requestsBeforeDismiss = await requests();
  await page.getByRole('button', { name: 'Скрыть статус переподключения', exact: true }).click();
  assert.equal(await reconnect().count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Остановить выполнение', exact: true }).count(), 1, 'Hiding retry status keeps the current turn running');
  assert.deepEqual(await requests(), requestsBeforeDismiss, 'Hiding retry status does not interrupt, resume, or start a turn');

  for (const status of ['completed', 'interrupted', 'failed']) {
    const context = { ...retryContext, turnId: status === 'completed' ? retryContext.turnId : `retry-${status}` };
    if (status !== 'completed') await notify('turn/started', { threadId: context.threadId, turn: { id: context.turnId, status: 'inProgress', items: [] } });
    await showRetry(2, context);
    await notify('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status, items: [], error: status === 'failed' ? { message: 'Fixture completion failed' } : null } });
    assert.equal(await reconnect().count(), 0, `Accepted ${status} completion clears retry without model deltas`);
    await notify('error', { ...context, willRetry: true, error: { message: 'Reconnecting... 5/5' } });
    assert.equal(await reconnect().count(), 0, 'Late retry notifications cannot revive status for a settled turn');
    if (status === 'failed') await page.locator('.error-alert').getByText('Fixture completion failed', { exact: true }).waitFor();
  }
  assert.equal((await requests()).some(call => call.method === 'turn/start'), false, 'Automatic retry fixture never sends a model turn');

  await openScenario('retry-start-rejected');
  await readable();
  await input().fill('Черновик после отказа turn/start');
  await send().click();
  await page.waitForFunction(() => typeof window.__resume.rejectStart === 'function');
  await showRetry();
  await page.evaluate(() => window.__resume.rejectStart());
  await page.locator('.error-alert').getByText('Fixture turn/start rejected', { exact: true }).waitFor();
  assert.equal(await reconnect().count(), 0, 'A terminal turn/start rejection clears retry status before any turn completion');
  assert.equal(await page.getByRole('button', { name: 'Остановить выполнение', exact: true }).count(), 0, 'Rejected send stops showing live work');
  assert.equal(await input().inputValue(), 'Черновик после отказа turn/start', 'A rejected send preserves the draft');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: failed resume preserves readable history, send safely retries resume before turn/start, active writer keeps the draft and blocks turns, optional turn metadata failure keeps paginated messages, item paging failure reads the stored transcript without a duplicate resume, disconnected resume response is ignored; automatic retry shows progress, respects thread/turn scope, clears on model recovery or completion, preserves unrelated errors, and can be hidden without stopping work. Controlled bridge only; no real Codex/provider/history mutations.');
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/resume-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
