import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, scoped fixtures and controlled time. No real Codex,
// model requests, user config, or saved conversations are accessed.
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
const epoch = Date.parse('2026-09-18T12:00:00Z');
const errors = [];
let browser;
let page;
let currentScenario = '';
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const openScenario = async (name, options = {}) => {
    currentScenario = name;
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.clock.install({ time: new Date(epoch) });
    await page.clock.pauseAt(new Date(epoch + 1000));
    await page.addInitScript(({ options, epoch }) => {
      let serial = 0;
      const projects = ['C:/Fixtures/CacheA'];
      const sessions = {};
      const models = [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
      const create = cwd => {
        const id = `session-${++serial}`;
        const second = cwd.endsWith('CacheB');
        const age = second ? 70 : options.age ?? 20;
        const completedAt = Math.floor(epoch / 1000) - age * 60;
        const history = { id: 'shared-history', name: `История ${second ? 'B' : 'A'}`, cwd, historyMode: options.paginated ? 'paginated' : 'legacy', updatedAt: Math.floor(epoch / 1000) };
        const savedItems = [
          { id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: 'Сохранённый вопрос' }] },
          { id: 'saved-answer', type: 'agentMessage', text: `Сохранённый ответ ${second ? 'B' : 'A'}` },
        ];
        const savedTurn = { id: 'saved-turn', status: options.status || 'completed', startedAt: completedAt - 30, completedAt, items: savedItems, error: null };
        if (options.missing) delete savedTurn.completedAt;
        if (options.future) savedTurn.completedAt = Math.floor(epoch / 1000) + 60;
        if (options.error) savedTurn.error = { message: 'Fixture failed response' };
        if (options.compacted) savedItems.splice(1, 1, { id: 'compact-item', type: 'contextCompaction' });
        if (options.noModelItem) savedItems.splice(1, 1, { id: 'saved-tool', type: 'commandExecution', command: 'echo fixture', status: 'completed', aggregatedOutput: 'Fixture tool output' });
        const olderTurn = { id: 'older-turn', status: 'completed', startedAt: completedAt - 7200, completedAt: completedAt - 7140, items: [{ id: 'older-answer', type: 'agentMessage', text: 'Ответ из предыдущей страницы' }], error: null };
        const fullThread = { ...history, status: { type: options.active ? 'active' : 'idle' }, turns: [olderTurn, savedTurn] };
        const resumeThread = options.paginated ? { ...fullThread, turns: [] } : fullThread;
        const state = { id, cwd, settings: { cwd, model: 'fixture-model', effort: 'high', access: 'workspace-write' }, requests: [], listeners: new Set(), closed: false, pending: null, turn: 0, completedAt };
        state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
        state.release = () => { const pending = state.pending; state.pending = null; pending?.(); };
        state.bridge = {
          async start() { return { initialize: {}, models, cwd, executable: 'C:/Fixtures/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-model', model_reasoning_effort: 'high' } }; },
          async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
          async request(method, params = {}) {
            state.requests.push({ method, params });
            if (method === 'thread/list') return { data: [history], nextCursor: null };
            if (method === 'thread/resume') {
              if (options.writerConflict) throw new Error('Fixture thread already has an active writer');
              if (options.deferResume) await new Promise(resolve => { state.pending = resolve; });
              return { thread: resumeThread, model: 'fixture-model', reasoningEffort: 'high' };
            }
            if (method === 'thread/read') return { thread: fullThread };
            if (method === 'thread/items/list') {
              if (options.itemsFailure) throw new Error('Fixture item pagination unavailable');
              const items = params.cursor ? olderTurn.items : savedItems;
              return { data: [...items].reverse().map(item => ({ item, turnId: params.cursor ? olderTurn.id : savedTurn.id })), nextCursor: options.olderPage && !params.cursor ? 'older-items' : null };
            }
            if (method === 'thread/turns/list') {
              if (options.metadataFailure) throw new Error('Fixture metadata unavailable');
              if (options.deferTurns && !params.cursor) await new Promise(resolve => { state.pending = resolve; });
              const turns = params.cursor ? [olderTurn] : options.olderPage ? [savedTurn] : [savedTurn, olderTurn];
              return { data: turns.map(turn => ({ ...turn, items: [], itemsView: 'notLoaded' })), nextCursor: options.olderPage && !params.cursor ? 'older-turns' : null };
            }
            if (method === 'turn/start') {
              const turn = { id: `live-turn-${++state.turn}`, status: 'inProgress', items: [] };
              state.emit('notification', { method: 'turn/started', params: { threadId: history.id, turn } });
              return { turn };
            }
            if (method === 'turn/interrupt') { state.emit('notification', { method: 'turn/completed', params: { threadId: history.id, turn: { id: params.turnId, status: 'interrupted', items: [], error: null } } }); return {}; }
            throw new Error(`Unexpected fixture request: ${method}`);
          },
          onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
          async respond() {}, async chooseDirectory() { return 'C:/Fixtures/CacheB'; }, async chooseExecutable() { return null; },
          async saveImages(images) { return images; }, async readAttachment() { return null; }, async openPath() {},
          async listFiles() { return { entries: [], nextCursor: null }; },
        };
        sessions[id] = state;
        return { id, cwd };
      };
      create(projects[0]);
      window.__cacheHistory = { sessions, projects };
      window.codex = { ...sessions['session-1'].bridge };
      if (options.tabs) Object.assign(window.codex, {
        async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
        async listProjectThreads(cwd) { return { data: [{ id: 'shared-history', name: `История ${cwd.endsWith('CacheB') ? 'B' : 'A'}`, cwd, historyMode: 'legacy' }], nextCursor: null }; },
        async createSession({ cwd = 'C:/Fixtures/CacheB' } = {}) { if (!projects.includes(cwd)) projects.push(cwd); return create(cwd); },
        async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
        forSession(id) { return sessions[id].bridge; },
      });
    }, { options, epoch });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    if (options.tabs) await page.locator('.session-view:visible').getByRole('button', { name: 'История A', exact: true }).click();
    else await page.locator('.history-item').filter({ hasText: 'История A' }).click();
    await flush();
    if (!options.deferTurns && !options.deferResume) await waitLoaded();
  };
  const view = () => page.locator('.session-view:visible').count().then(count => count ? page.locator('.session-view:visible') : page.locator('.app-shell'));
  const cache = () => page.locator('.cache-control:visible');
  const auto = () => cache().getByRole('checkbox', { name: 'Автопинг кэша', exact: true });
  const ping = () => cache().getByRole('button', { name: 'Пинг сейчас', exact: true });
  const countdown = () => cache().locator('.cache-countdown').innerText();
  const flush = async () => { await page.clock.runFor(50); await page.waitForTimeout(30); };
  const waitLoaded = async () => { await (await view()).getByText('Сохранённый вопрос', { exact: true }).waitFor(); await flush(); };
  const settings = async () => { if (!await auto().isVisible()) await cache().getByLabel('Настройки кэша', { exact: true }).click(); await flush(); };
  const calls = () => page.evaluate(() => Object.values(window.__cacheHistory.sessions).flatMap(state => state.requests));
  const modelCalls = async () => (await calls()).filter(call => ['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start'].includes(call.method));
  const time = () => cache().locator('time[datetime]');
  const notify = async (method, params, id = 'session-1') => { await page.evaluate(({ id, method, params }) => window.__cacheHistory.sessions[id].emit('notification', { method, params }), { id, method, params }); await flush(); };
  const pending = () => page.waitForFunction(() => Boolean(window.__cacheHistory.sessions['session-1'].pending));
  const release = async () => { await page.evaluate(() => window.__cacheHistory.sessions['session-1'].release()); await waitLoaded(); };
  const expectTime = async (at, message) => { await settings(); assert.match(await cache().innerText(), /Последний ответ/); assert.equal(await time().getAttribute('datetime'), new Date(at).toISOString(), message); };
  const expectUnknown = async message => { assert.equal(await countdown(), 'Кэш: нет данных', message); await settings(); assert.equal(await time().count(), 0, message); assert.deepEqual(await modelCalls(), []); };

  for (const options of [{}, { paginated: true }, { paginated: true, itemsFailure: true }]) {
    await openScenario(`recent-${JSON.stringify(options)}`, options);
    assert.match(await countdown(), /Кэш ≈ (?:39:5\d|40:00)/, 'Opening a 20-minute-old answer retains only approximately 40 minutes');
    await expectTime(epoch - 20 * 60_000, 'Displayed timestamp comes from the saved completedAt, not thread.updatedAt or opening time');
    assert.equal(await auto().isChecked(), false, 'History never enables paid automatic pings');
    assert.deepEqual(await modelCalls(), [], 'Opening and reading history never calls the model');
  }
  await page.screenshot({ path: 'artifacts/cache-history-recent.png' });

  await openScenario('same-thread-reopened');
  await settings(); await auto().check();
  await cache().getByLabel('Настройки кэша', { exact: true }).click();
  await page.clock.fastForward(5 * 60_000); await flush();
  await page.locator('.history-item').filter({ hasText: 'История A' }).click(); await waitLoaded();
  await expectTime(epoch - 20 * 60_000, 'Reopening the same thread retains source completion time');
  assert.match(await countdown(), /Кэш ≈ (?:34:5\d|35:00)/);
  assert.equal(await auto().isChecked(), false, 'Explicit reconnect disables the previously enabled auto ping');
  assert.deepEqual(await modelCalls(), []);

  await openScenario('expired', { age: 70 });
  assert.equal(await countdown(), 'Кэш: возможно остыл');
  await expectTime(epoch - 70 * 60_000, 'Expired history retains the real answer date');
  await auto().click(); await flush();
  assert.equal(await auto().isChecked(), false, 'Enabling automatic ping on expired history disables it without catch-up');
  await page.clock.fastForward(2 * 60 * 60_000); await flush();
  assert.deepEqual(await modelCalls(), []);

  for (const [name, options] of [
    ['missing-time', { missing: true }], ['future-time', { future: true }],
    ['latest-interrupted', { status: 'interrupted' }], ['latest-failed', { status: 'failed', error: true }],
    ['latest-in-progress', { status: 'inProgress', active: true }],
    ['completed-with-error', { error: true }], ['latest-compacted', { compacted: true }],
    ['latest-compacted-page', { paginated: true, compacted: true }],
    ['latest-no-model-item', { paginated: true, noModelItem: true }],
    ['metadata-unavailable', { paginated: true, metadataFailure: true }],
  ]) { await openScenario(name, options); await expectUnknown(`Do not invent a fresh cache for ${name} or reuse an older successful turn`); }

  await openScenario('writer-conflict', { writerConflict: true });
  await expectTime(epoch - 20 * 60_000, 'Read-only history can still show its saved answer time');
  assert.equal(await ping().isDisabled(), true, 'Historical estimate never grants writer ownership for ping');
  assert.deepEqual(await modelCalls(), []);

  await openScenario('old-page', { paginated: true, olderPage: true });
  await expectTime(epoch - 20 * 60_000);
  await cache().getByLabel('Настройки кэша', { exact: true }).click();
  await page.getByRole('button', { name: 'Показать предыдущие сообщения', exact: true }).click();
  await page.getByText('Ответ из предыдущей страницы', { exact: true }).waitFor(); await flush();
  await expectTime(epoch - 20 * 60_000, 'Loading earlier messages cannot move the latest-response clock');

  for (const completed of [false, true]) {
    await openScenario(`live-during-paging-${completed}`, { paginated: true, deferTurns: true });
    await pending();
    const context = { threadId: 'shared-history', turnId: 'live-resume-turn', itemId: 'live-resume-answer' };
    await notify('turn/started', { threadId: context.threadId, turn: { id: context.turnId, status: 'inProgress', items: [] } });
    const liveAt = await page.evaluate(() => Date.now());
    await notify('item/agentMessage/delta', { ...context, delta: 'Свежий ответ во время открытия' });
    if (completed) await notify('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
    await release();
    await expectTime(liveAt, 'A live model response wins over older metadata even when the live turn has already completed');
    assert.match(await countdown(), /Кэш ≈ (?:59:5\d|60:00)/);
  }

  for (const withCompletion of [false, true]) {
    await openScenario(`replayed-events-${withCompletion}`, { paginated: true, deferTurns: true });
    await pending();
    const context = { threadId: 'shared-history', turnId: 'saved-turn' };
    await notify('thread/tokenUsage/updated', { ...context, tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800 } } });
    await notify('item/completed', { ...context, item: { id: 'saved-answer', type: 'agentMessage', text: 'Сохранённый ответ A' } });
    if (withCompletion) await notify('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', completedAt: (epoch - 20 * 60_000) / 1000, items: [{ id: 'saved-answer', type: 'agentMessage', text: 'Сохранённый ответ A' }], error: null } });
    await release();
    await expectTime(epoch - 20 * 60_000, 'Replayed usage, completed items and completion metadata never warm historical cache to opening time');
    await notify('thread/tokenUsage/updated', { ...context, tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800 } } });
    await notify('item/agentMessage/delta', { ...context, itemId: 'saved-answer', delta: ' delayed' });
    await expectTime(epoch - 20 * 60_000, 'Settled history ignores delayed model activity for its completed turn');
  }

  for (const [name, options] of [['successful', {}], ['interrupted', { status: 'interrupted' }], ['compacted', { compacted: true }]]) {
    await openScenario(`older-completion-replay-${name}`, { ...options, paginated: true, deferTurns: true });
    await pending();
    await notify('turn/completed', { threadId: 'shared-history', turn: { id: 'older-turn', status: 'completed', completedAt: (epoch - 70 * 60_000) / 1000, items: [{ id: 'older-answer', type: 'agentMessage', text: 'Ответ из предыдущей страницы' }], error: null } });
    await release();
    if (name === 'successful') {
      await expectTime(epoch - 20 * 60_000, 'An older replayed completion cannot block the newer authoritative history timestamp');
      assert.match(await countdown(), /Кэш ≈ (?:39:5\d|40:00)/);
    } else await expectUnknown(`An older successful replay cannot revive cache when the newest turn is ${name}`);
  }

  for (const invalidation of ['error', 'model/rerouted', 'stopped']) {
    await openScenario(`invalidation-during-paging-${invalidation}`, { paginated: true, deferTurns: true });
    await pending();
    if (invalidation === 'stopped') {
      await notify('turn/started', { threadId: 'shared-history', turn: { id: 'stopped-resume-turn', status: 'inProgress', items: [] } });
      await notify('turn/completed', { threadId: 'shared-history', turn: { id: 'stopped-resume-turn', status: 'interrupted', items: [], error: null } });
    } else await notify(invalidation, { threadId: 'shared-history', message: 'Fixture invalidation during history loading', willRetry: false });
    await release(); await expectUnknown(`Late history cannot revive cache after ${invalidation}`);
  }

  await openScenario('disconnected-resume', { deferResume: true });
  await pending();
  await page.evaluate(() => window.__cacheHistory.sessions['session-1'].emit('status', { state: 'exited', message: 'Fixture disconnect during resume' }));
  await flush(); await page.evaluate(() => window.__cacheHistory.sessions['session-1'].release()); await flush();
  await expectUnknown('A late resume response cannot revive the cache after disconnect');

  await openScenario('near-threshold', { age: 59 });
  await settings(); assert.equal(await auto().isChecked(), false);
  await page.clock.fastForward(5000); await flush(); assert.deepEqual(await modelCalls(), [], 'Near-expired restored history stays idle until the user enables ping');
  await auto().check(); await flush();
  assert.equal((await modelCalls()).filter(call => call.method === 'turn/start').length, 1, 'Explicit enable can use the restored remaining minute');
  await page.clock.fastForward(30000); await flush();
  assert.equal((await modelCalls()).length, 1, 'An unfinished automatic ping cannot loop');

  await openScenario('independent-tabs', { tabs: true });
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const idA = await activeId();
  await expectTime(epoch - 20 * 60_000);
  await (await view()).getByRole('button', { name: 'Новый проект', exact: true }).first().click(); await flush();
  await (await view()).getByRole('button', { name: 'История B', exact: true }).click(); await waitLoaded();
  const idB = await activeId(); assert.notEqual(idA, idB);
  await expectTime(epoch - 70 * 60_000, 'Same thread ID in another scoped session retains its own timestamp');
  assert.equal(await countdown(), 'Кэш: возможно остыл');
  await page.locator(`.session-tab[data-session-id="${idA}"]`).getByRole('tab').click(); await flush();
  await expectTime(epoch - 20 * 60_000, 'Switching tabs cannot reset or import another tab clock');
  await page.clock.fastForward(5 * 60_000); await flush();
  assert.match(await countdown(), /Кэш ≈ (?:34:5\d|35:00)/, 'Background and foreground time both count from the saved answer');
  assert.deepEqual(await modelCalls(), []);
  assert.deepEqual(errors, []);
  console.log('PASS: legacy/paginated/full-read history cache timestamps, expiry, unknown/invalid/latest unsuccessful metadata, no updatedAt fallback, writer ownership, older-page stability, live response priority, stop/error/reroute/disconnect guards, explicit-only ping with no expired catch-up, and scoped tab isolation. Controlled fixtures only; no real model requests.');
} catch (error) {
  console.error(`Cache history scenario: ${currentScenario}`);
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/cache-history-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
