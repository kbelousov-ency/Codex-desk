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
      const state = { requests: [], resumeCount: 0, pendingResume: null };
      state.emit = (type, data) => { for (const listener of listeners) listener({ type, data }); };
      state.finishResume = () => {
        const pending = state.pendingResume;
        state.pendingResume = null;
        pending?.({ thread: { ...savedThread, turns: [{ ...savedTurn, items: [{ id: 'stale-answer', type: 'agentMessage', text: 'STALE RESUME MUST NOT APPEAR' }] }] }, model: 'stale-model', reasoningEffort: 'low' });
      };
      window.__resume = state;
      window.codex = {
        async start() { return { initialize: {}, models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], cwd, executable: 'C:/Fixtures/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-model', model_reasoning_effort: 'high' } }; },
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
          if (method === 'turn/start') return { turn: { id: 'new-turn', status: 'inProgress', items: [] } };
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
  assert.equal(await page.getByText('Сохранённый вопрос', { exact: true }).count(), 1, 'Optional turn metadata failure does not discard the readable item page');
  await page.screenshot({ path: 'artifacts/resume-metadata-failure.png' });

  await openScenario('items-failure');
  await readable();
  calls = await requests();
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1, 'Unreadable pagination does not acquire a second writer');
  assert.ok(calls.some(call => call.method === 'thread/items/list'));
  assert.ok(calls.some(call => call.method === 'thread/read' && call.params.includeTurns === true), 'Failed items paging falls back to the stored transcript');
  assert.equal(await page.getByText('Сохранённый вопрос', { exact: true }).count(), 1);
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
  assert.deepEqual(pageErrors, []);
  console.log('PASS: failed resume preserves readable history, send safely retries resume before turn/start, active writer keeps the draft and blocks turns, optional turn metadata failure keeps paginated messages, item paging failure reads the stored transcript without a duplicate resume, disconnected resume response is ignored. Controlled bridge only; no real Codex/provider/history mutations.');
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/resume-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
