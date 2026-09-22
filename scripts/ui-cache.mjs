import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with scoped bridge fixtures and Playwright's clock.
// This test never connects to Codex or sends a real model request.
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
let browser;
let page;
await mkdir('artifacts', { recursive: true });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const epoch = new Date('2026-09-17T12:00:00Z');
  await page.clock.install({ time: epoch });
  await page.clock.pauseAt(new Date(epoch.getTime() + 1000));
  await page.addInitScript(() => {
    let serial = 0;
    const sessions = {};
    const projects = ['C:/Fixtures/PROJECT_A'];
    const models = ['fixture-alpha', 'fixture-beta'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings }, requests: [], listeners: new Set(), closed: false, failNext: false, turn: 0 };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.bridge = {
        async start() { return { initialize: {}, models, cwd, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: 'shared-thread', cwd, turns: [] }, model: params.model };
          if (method === 'turn/start') {
            if (state.failNext) { state.failNext = false; throw new Error('Fixture ping request failed'); }
            const turn = { id: `turn-${++state.turn}`, status: 'inProgress', items: [] };
            state.emit('notification', { method: 'turn/started', params: { threadId: 'shared-thread', turn } });
            return { turn };
          }
          if (method === 'turn/interrupt') { state.emit('notification', { method: 'turn/completed', params: { threadId: 'shared-thread', turn: { id: `turn-${state.turn}`, status: 'interrupted', items: [], error: null } } }); return {}; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return 'C:/Fixtures/PROJECT_B'; }, async chooseExecutable() { return null; }, async openPath() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    create(projects[0]);
    window.__cache = { sessions, projects };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession({ cwd = 'C:/Fixtures/PROJECT_B', fromSessionId, settings } = {}) {
        if (!projects.includes(cwd)) projects.push(cwd);
        return create(cwd, { ...sessions[fromSessionId]?.settings, ...settings, cwd });
      },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const selectValue = async (name, value) => {
    const cacheWasOpen = await auto().isVisible();
    await collapseSettings();
    await view().getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('listbox', { name, exact: true }).locator(`[role="option"][data-value="${value}"]`).click();
    if (cacheWasOpen) await settings();
  };
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const auto = () => view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true });
  const ping = () => view().getByRole('button', { name: 'Пинг сейчас', exact: true });
  const count = id => page.evaluate(id => window.__cache.sessions[id].requests.filter(request => request.method === 'turn/start').length, id);
  const flush = async () => { await page.clock.runFor(50); await page.waitForTimeout(50); };
  const advanceTo = async target => { const now = await page.evaluate(() => Date.now()); assert.ok(target >= now, 'Fixture time only moves forwards'); await page.clock.fastForward(target - now); await flush(); };
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await flush(); };
  const settings = async () => { const summary = view().getByLabel('Настройки кэша', { exact: true }); if (!await auto().isVisible()) await summary.click(); };
  const bodyText = async () => (await view().innerText()).replace(/\s+/g, ' ');
  const notify = async (id, method, params) => { await page.evaluate(({ id, method, params }) => window.__cache.sessions[id].emit('notification', { method, params }), { id, method, params }); await flush(); };
  const finish = async id => {
    const time = await page.evaluate(id => {
      const state = window.__cache.sessions[id];
      const context = { threadId: 'shared-thread', turnId: `turn-${state.turn}` };
      const usage = { totalTokens: 10100, inputTokens: 10000, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
      state.emit('notification', { method: 'item/agentMessage/delta', params: { ...context, itemId: `answer-${state.turn}`, delta: 'ОК' } });
      state.emit('notification', { method: 'thread/tokenUsage/updated', params: { ...context, tokenUsage: { total: usage, last: usage, modelContextWindow: 200000 } } });
      state.emit('notification', { method: 'turn/completed', params: { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } } });
      return Date.now();
    }, id);
    await flush(); return time;
  };
  const collapseSettings = async () => { if (await auto().isVisible()) await view().getByLabel('Настройки кэша', { exact: true }).click(); };
  const send = async text => { await collapseSettings(); await input().fill(text); await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click(); await flush(); await settings(); };
  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush();
  await settings();
  assert.equal(await auto().isChecked(), false);
  assert.equal(await ping().isEnabled(), false, 'A ping cannot create a conversation without a user task');
  assert.match(await bodyText(), /Кэш: нет данных/);
  assert.equal(await view().getByRole('spinbutton', { name: 'Срок кэша, минут', exact: true }).inputValue(), '60');
  const defaultPing = 'Пинг для поддержания кэша. Ответь только «ОК», без инструментов и изменений файлов.';
  assert.equal(await view().getByRole('textbox', { name: 'Текст пинга', exact: true }).inputValue(), defaultPing);
  await page.clock.fastForward(7200000); await flush(); assert.equal(await count('session-1'), 0);
  await selectValue('Модель', 'fixture-beta');
  await selectValue('Глубина размышлений', 'medium');
  await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).click(); await view().getByRole('option', { name: /^Одобрять за меня/ }).click();
  await send('Разработка PROJECT_A');
  const warmedA = await finish('session-1');
  assert.match(await bodyText(), /Кэш ≈ (?:59:[0-5]\d|60:00)/);
  assert.match(await bodyText(), /Без кэша: 2 000/); assert.match(await bodyText(), /Из кэша: 8 000/);
  await auto().check();
  await input().fill('Черновик A не должен отправиться с пингом');
  await view().locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  await view().getByRole('button', { name: 'Новый проект', exact: true }).first().click(); await flush();
  await settings(); assert.equal(await auto().isChecked(), false, 'New tab never inherits enabled auto ping');
  await send('Исправление PROJECT_B'); await finish('session-2');
  await advanceTo(warmedA + 3539000);
  assert.equal(await count('session-1'), 1, 'No ping earlier than the one-minute lead');
  await advanceTo(warmedA + 3541000);
  assert.equal(await count('session-1'), 2, 'Hidden enabled tab sends its own ping at the threshold');
  assert.equal(await count('session-2'), 1, 'Disabled active tab does not send a ping');
  const pingParams = await page.evaluate(() => window.__cache.sessions['session-1'].requests.filter(request => request.method === 'turn/start').at(-1).params);
  assert.equal(pingParams.threadId, 'shared-thread'); assert.equal(pingParams.cwd, 'C:/Fixtures/PROJECT_A');
  assert.equal(pingParams.model, 'fixture-beta'); assert.equal(pingParams.effort, 'medium'); assert.equal(pingParams.approvalsReviewer, 'auto_review');
  assert.deepEqual(pingParams.input, [{ type: 'text', text: defaultPing, text_elements: [] }]);
  await activate('session-1');
  // Switching tabs is an outside click and dismisses the cache popup.
  await settings();
  assert.equal(await input().inputValue(), 'Черновик A не должен отправиться с пингом');
  assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
  assert.equal(await view().locator('.chat-scroll').getByText(defaultPing, { exact: true }).count(), 1, 'Ping is visible as a user message');
  await page.clock.fastForward(7200000); await flush();
  assert.equal(await count('session-1'), 2, 'Accepted but unfinished ping cannot create a retry loop');
  const warmedPing = await finish('session-1');
  await page.evaluate(() => window.__cache.sessions['session-1'].emit('serverRequest', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-thread', turnId: 'turn-2', itemId: 'command', command: 'echo fixture', reason: 'Fixture pending approval' } })); await flush();
  await advanceTo(warmedPing + 3541000); assert.equal(await count('session-1'), 2, 'Pending approval suppresses automatic ping');
  await advanceTo(warmedPing + 3601000);
  await notify('session-1', 'serverRequest/resolved', { threadId: 'shared-thread', requestId: 'approval' });
  assert.equal(await count('session-1'), 2, 'Expired timer never sends a missed ping after approval clears');
  assert.match(await bodyText(), /Кэш: возможно остыл/);
  assert.equal(await auto().isChecked(), false, 'Missed expiry turns auto ping off');
  await ping().click(); await flush(); assert.equal(await count('session-1'), 3, 'Manual ping works after estimated expiry');
  const warmedManual = await finish('session-1');
  await auto().check();
  await page.evaluate(() => { window.__cache.sessions['session-1'].failNext = true; });
  await advanceTo(warmedManual + 3541000);
  assert.equal(await count('session-1'), 4); assert.equal(await auto().isChecked(), false, 'Failure turns auto ping off');
  assert.match(await bodyText(), /Fixture ping request failed|Автопинг.*отключ/i);
  await page.clock.fastForward(7200000); await flush(); assert.equal(await count('session-1'), 4, 'Failure does not retry');
  await ping().click(); await flush(); await finish('session-1');
  await auto().check(); await send('Проверка ручной остановки');
  await collapseSettings(); await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).click(); await flush(); await settings();
  assert.equal(await auto().isChecked(), false, 'Stopping a task disables auto ping');
  await auto().check();
  await selectValue('Модель', 'fixture-alpha'); await flush();
  assert.equal(await auto().isChecked(), false, 'Changing the model invalidates cache and disables auto ping');
  assert.match(await bodyText(), /Кэш: нет данных/);
  await send('Долгая команда после ответа модели'); await auto().check();
  const context = await page.evaluate(() => ({ threadId: 'shared-thread', turnId: `turn-${window.__cache.sessions['session-1'].turn}` }));
  await notify('session-1', 'item/reasoning/summaryTextDelta', { ...context, itemId: 'long-reasoning', summaryIndex: 0, delta: 'Проверяю проект' });
  await notify('session-1', 'item/completed', { ...context, item: { id: 'long-reasoning', type: 'reasoning', summary: ['Проверяю проект'] } });
  const requestsBeforeLongCommand = await count('session-1');
  await page.clock.fastForward(3541000); await flush();
  await notify('session-1', 'item/commandExecution/outputDelta', { ...context, itemId: 'long-command', delta: 'Still working' });
  await page.clock.fastForward(61000); await flush();
  assert.equal(await count('session-1'), requestsBeforeLongCommand, 'Busy work never gets interrupted by a ping');
  await notify('session-1', 'item/completed', { ...context, item: { id: 'long-command', type: 'commandExecution', status: 'completed', command: 'echo fixture', aggregatedOutput: 'Команда завершена' } });
  await notify('session-1', 'turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
  assert.match(await bodyText(), /Кэш: возможно остыл/, 'Completion after a long tool run does not pretend the model just responded');
  assert.equal(await auto().isChecked(), false);
  await notify('session-1', 'thread/tokenUsage/updated', { ...context, tokenUsage: { last: { totalTokens: 100, inputTokens: 100, cachedInputTokens: 0 } } });
  assert.match(await bodyText(), /Кэш: возможно остыл/, 'Late usage from a settled turn does not refresh the estimate');
  await ping().click(); await flush(); await finish('session-1'); await auto().check();
  await page.screenshot({ path: 'artifacts/cache-controls.png' });
  for (const size of [{ width: 940, height: 640 }, { width: 650, height: 640 }]) {
    await page.setViewportSize(size); await flush();
    const bounds = await view().locator('.cache-settings').evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.scrollWidth <= bounds.width + 1, 'Cache settings remain reachable without document overflow');
  }
  await page.evaluate(() => window.__cache.sessions['session-1'].emit('status', { state: 'disconnected', message: 'Fixture disconnect' })); await flush();
  assert.equal(await auto().isChecked(), false); assert.equal(await ping().isEnabled(), false);
  assert.match(await bodyText(), /Кэш: нет данных/);
  const countAtDisconnect = await count('session-1'); await page.clock.fastForward(7200000); await flush();
  assert.equal(await count('session-1'), countAtDisconnect, 'No pings while disconnected');
  assert.deepEqual(errors, []);
  console.log('PASS: estimated cache/counts, explicit per-tab enable, one-minute threshold, background isolation, visible same-settings ping, draft/image preservation, busy and approval suppression, no expired catch-up, completion rearm, failure/no retry, stop/model/disconnect invalidation, long commands and stale usage, 1440/940/650px layout. Production renderer; fake bridges and controlled clock only, no real model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/cache-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
