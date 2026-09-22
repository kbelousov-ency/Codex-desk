import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with isolated scoped bridge fixtures. No Codex process,
// filesystem reads through IPC, model request, ping or compaction is performed.
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
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const sessions = {};
    let serial = 0;
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const create = cwd => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, turn: 0, requests: [], listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' } };
      state.emit = (method, params) => { if (!state.closed) for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: 'shared-thread', cwd, turns: [] }, model: params.model };
          if (method === 'turn/start') {
            const turn = { id: `turn-${++state.turn}`, startedAt: Math.floor(Date.now() / 1000), status: 'inProgress', items: [] };
            state.emit('turn/started', { threadId: 'shared-thread', turn });
            return { turn };
          }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    create(projects[0]);
    window.__usage = { sessions, projects };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession({ cwd = projects[1] } = {}) { return create(cwd); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const trigger = () => view().getByRole('button', { name: 'Подробности токенов', exact: true });
  const popup = () => page.getByRole('dialog', { name: 'Использование токенов', exact: true });
  const normal = text => text.replace(/\s+/g, ' ').trim();
  const popupText = async () => normal(await popup().innerText());
  const metric = async (section, field) => normal(await popup().locator(`[data-token-section="${section}"] [data-token-field="${field}"] dd`).innerText());
  const flush = async () => page.waitForTimeout(80);
  const ready = async () => { await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush(); };
  const away = async () => { await page.mouse.move(5, 5); await page.waitForTimeout(650); };
  const close = async () => { if (await popup().isVisible()) await popup().getByRole('button', { name: 'Закрыть сведения о токенах', exact: true }).click(); await away(); };
  const hover = async () => { await trigger().hover(); await popup().waitFor(); };
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await flush(); };
  const send = async text => {
    await close();
    await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor(); await flush();
  };
  const usage = async (id, tokenUsage, complete = false) => {
    await page.evaluate(({ id, tokenUsage, complete }) => {
      const state = window.__usage.sessions[id];
      const context = { threadId: 'shared-thread', turnId: `turn-${state.turn}` };
      state.emit('thread/tokenUsage/updated', { ...context, tokenUsage });
      if (complete) {
        state.emit('item/completed', { ...context, item: { id: `answer-${state.turn}`, type: 'agentMessage', phase: 'final_answer', text: 'Ответ для проверки токенов.' } });
        state.emit('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
      }
    }, { id, tokenUsage, complete });
    await flush();
  };
  const requestSnapshot = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__usage.sessions).map(([id, state]) => [id, state.requests])));
  const sample = {
    last: { inputTokens: 10000, cachedInputTokens: 8000, cacheWriteInputTokens: 1000, outputTokens: 1500, reasoningOutputTokens: 1000, totalTokens: 11500 },
    total: { inputTokens: 20000, cachedInputTokens: 12000, cacheWriteInputTokens: 2000, outputTokens: 3000, reasoningOutputTokens: 2000, totalTokens: 23000 },
    modelContextWindow: 200000,
  };

  await ready();
  assert.equal(normal(await trigger().innerText()), 'Токены: нет данных');
  const initialRequests = await requestSnapshot();
  await hover();
  assert.match(await popupText(), /нет данных|не (?:переданы|получены|сообщ)/i, 'Missing counters have explicit unknown status');
  assert.doesNotMatch(await popupText(), /NaN|Infinity|undefined/);
  assert.deepEqual(await requestSnapshot(), initialRequests, 'Opening usage details never creates a model/compact request');
  await away(); await popup().waitFor({ state: 'hidden' });

  await send('Проверка статистики первого проекта');
  await usage('session-1', sample, true);
  assert.equal(normal(await trigger().innerText()), '11 500 токенов', 'The existing label remains the latest total, not cumulative usage or alleged resident context');
  const measuredRequests = await requestSnapshot();
  await hover();
  let text = await popupText();
  assert.match(text, /Последний запрос/); assert.match(text, /За весь диалог/);
  for (const value of ['10 000', '8 000', '1 000', '1 500', '11 500', '20 000', '12 000', '2 000', '3 000', '23 000', '200 000']) assert.ok(text.includes(value), `Reported metric ${value} is visible in details`);
  for (const [section, fields] of Object.entries({ last: { input: '10 000', cached: '8 000', write: '1 000', uncached: '2 000', ordinary: '1 000', output: '1 500', reasoning: '1 000', 'other-output': '500', total: '11 500', 'cache-share': '80%' }, total: { input: '20 000', cached: '12 000', write: '2 000', uncached: '8 000', ordinary: '6 000', output: '3 000', reasoning: '2 000', 'other-output': '1 000', total: '23 000', 'cache-share': '60%' }, context: { window: '200 000', 'context-share': '5%' } })) {
    for (const [field, expected] of Object.entries(fields)) assert.equal(await metric(section, field), expected, `${section}.${field} belongs to the correct request/accounting period`);
  }
  assert.match(text, /80\s*%/, 'Cache-hit share is 8000/10000, not cached/total-with-output');
  assert.match(text, /кэш/i); assert.match(text, /рассуждени|reasoning/i);
  assert.match(text, /AGENTS|файл/i, 'Cache composition explains limits of file/instruction attribution');
  assert.equal(await popup().getByRole('button', { name: 'Сжать контекст', exact: true }).count(), 1, 'Compact is available as an explicit action');
  assert.doesNotMatch(text, /Если запустить compact сейчас|Экономия заранее неизвестна/, 'Speculative compaction explanation was removed');
  assert.match(text, /нельзя|недоступ|не (?:сообщ|переда|показыв|предсказ|извест|определ|оцен|разбив)|заранее/i);
  const bounds = await popup().boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30, { steps: 8 });
  await page.waitForTimeout(650);
  assert.equal(await popup().isVisible(), true, 'Unpinned popover stays open while the pointer moves into and reads it');
  await page.screenshot({ path: 'artifacts/token-details-hover.png' });
  await away(); await popup().waitFor({ state: 'hidden' });

  await trigger().click();
  assert.equal(await trigger().getAttribute('aria-pressed'), 'true', 'Click pins the information');
  await away(); assert.equal(await popup().isVisible(), true, 'Pinned details persist after pointer departure');
  await popup().getByRole('button', { name: 'Открепить сведения о токенах', exact: true }).click();
  assert.equal(await trigger().getAttribute('aria-pressed'), 'false');
  await away(); await popup().waitFor({ state: 'hidden' });
  await hover();
  await popup().getByRole('button', { name: 'Закрепить сведения о токенах', exact: true }).click();
  await away(); assert.equal(await popup().isVisible(), true, 'Explicit pin also works from hover');
  await popup().getByRole('button', { name: 'Закрыть сведения о токенах', exact: true }).click();
  assert.equal(await trigger().evaluate(node => node === document.activeElement), true, 'Explicit close returns keyboard focus to the trigger');
  await away(); await popup().waitFor({ state: 'hidden' });
  await trigger().focus(); await page.keyboard.press('Enter');
  assert.equal(await trigger().getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape'); await popup().waitFor({ state: 'hidden' });
  assert.equal(await trigger().evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Space');
  assert.equal(await trigger().getAttribute('aria-pressed'), 'true');
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).click({ position: { x: 5, y: 5 } });
  await popup().waitFor({ state: 'hidden' });
  assert.deepEqual(await requestSnapshot(), measuredRequests, 'Hover, pin, read, close and keyboard actions are display-only');

  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }, { width: 650, height: 700 }]) {
    await page.setViewportSize(size); await flush();
    // At narrow widths the intentionally open right drawer covers the composer.
    if (size.width <= 1000 && !await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    const footer = await view().locator('.composer-footer').boundingBox();
    const button = await trigger().boundingBox();
    assert.ok(button.x >= footer.x - 1 && button.x + button.width <= footer.x + footer.width + 1, `Token trigger fits footer at ${size.width}px`);
    await trigger().click(); await popup().waitFor();
    const box = await popup().boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Popover fits viewport at ${size.width}: ${JSON.stringify(box)}`);
    assert.equal(await popup().evaluate(node => node.parentElement === document.body), true, 'Portal escapes clipped composer/session ancestors');
    const scrolling = await popup().evaluate(node => {
      const candidates = [node, ...node.querySelectorAll('*')];
      const scrollable = candidates.find(element => element.scrollHeight > element.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(element).overflowY));
      if (scrollable) { scrollable.scrollTop = scrollable.scrollHeight; return { exists: true, moved: scrollable.scrollTop > 0 }; }
      return { exists: false };
    });
    if (scrolling.exists) assert.equal(scrolling.moved, true, 'Long details can be scrolled without scrolling chat');
    await page.screenshot({ path: `artifacts/token-details-${size.width}.png` });
    await close();
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await flush();

  await trigger().click();
  await view().getByRole('button', { name: 'Новый проект', exact: true }).first().click(); await ready();
  assert.equal(await popup().count(), 0, 'Changing active tab closes even pinned details');
  assert.equal(normal(await trigger().innerText()), 'Токены: нет данных');
  await send('Проверка статистики второго проекта');
  await usage('session-2', { last: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 20, totalTokens: 320 }, total: { totalTokens: 320 }, modelContextWindow: null }, true);
  await hover();
  assert.match(await popupText(), /320/); assert.doesNotMatch(await popupText(), /11 500|23 000|200 000/);
  await trigger().click(); await activate('session-1');
  assert.equal(await popup().count(), 0);
  assert.equal(normal(await trigger().innerText()), '11 500 токенов');
  await hover(); assert.match(await popupText(), /23 000/); assert.doesNotMatch(await popupText(), /320/);
  await close();

  // Realistic partial/zero counters must preserve unknowns instead of inventing metrics.
  await usage('session-1', { last: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, total: { totalTokens: 0 }, modelContextWindow: null });
  assert.equal(normal(await trigger().innerText()), '0 токенов', 'Zero is measured data, not missing data');
  await hover(); text = await popupText(); assert.doesNotMatch(text, /NaN|Infinity|undefined|−0/); await close();
  // Context-window warnings: badge on the trigger and a note in the panel, driven only by reported numbers.
  await usage('session-1', { last: { inputTokens: 150000, cachedInputTokens: 140000, outputTokens: 500, totalTokens: 150500 }, total: { totalTokens: 900000 }, modelContextWindow: 200000 });
  assert.equal(await trigger().getAttribute('data-context-level'), 'warn');
  assert.equal(normal(await trigger().locator('.token-context-badge').innerText()), '75 % окна');
  await hover();
  assert.match(await popupText(), /Контекст заполнен на 75 %/);
  assert.equal(await popup().locator('[data-token-warning="warn"]').count(), 1);
  await away(); await popup().waitFor({ state: 'hidden' });
  await usage('session-1', { last: { inputTokens: 180000, cachedInputTokens: 170000, outputTokens: 500, totalTokens: 180500 }, total: { totalTokens: 1100000 }, modelContextWindow: 200000 });
  assert.equal(await trigger().getAttribute('data-context-level'), 'critical');
  await hover();
  assert.match(await popupText(), /место для ответа сокращается/);
  await away(); await popup().waitFor({ state: 'hidden' });
  await usage('session-1', { last: { inputTokens: 20000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 20100 }, total: { totalTokens: 1120100 }, modelContextWindow: 200000 });
  assert.equal(await trigger().getAttribute('data-context-level'), null, 'Below the threshold nothing is highlighted');
  assert.equal(await trigger().locator('.token-context-badge').count(), 0);
  await usage('session-1', { last: { totalTokens: 14, inputTokens: 10 }, total: null, modelContextWindow: null });
  await hover(); text = await popupText(); assert.match(text, /14/); assert.match(text, /нет данных|не (?:переда|сообщ)|—/i); assert.doesNotMatch(text, /NaN|Infinity|undefined/); await close();
  await usage('session-1', { last: { inputTokens: 10, cachedInputTokens: 90, cacheWriteInputTokens: 200, outputTokens: 2, reasoningOutputTokens: 5, totalTokens: 12 }, total: {}, modelContextWindow: 0 });
  await hover(); text = await popupText(); assert.doesNotMatch(text, /(?:-|−)80|900\s*%|NaN|Infinity|undefined/, 'Inconsistent server counters never yield negative uncached input or a fabricated percentage'); await close();
  await usage('session-1', sample);
  const requests = await requestSnapshot();
  for (const events of Object.values(requests)) {
    assert.equal(events.filter(event => event.method === 'turn/start').length, 1, 'Only explicit fixture user tasks produce turns');
    assert.equal(events.some(event => /compact/i.test(event.method)), false, 'No compact request is made while displaying possible savings');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: token hover/pointer transit/leave, pin/unpin, close/focus, keyboard, outside/Escape, last vs cumulative token and cache counters, honest missing/composition/compaction limits, zero/partial/inconsistent metrics, per-tab isolation and portal/scrolling at 1440/940/650. Production renderer and scoped fixture events only; no real model or compact request.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/token-details-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
