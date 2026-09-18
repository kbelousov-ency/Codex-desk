import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, per-tab fake bridges, and explicit App Server events.
// Never starts Codex or sends a real model request/compaction.
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
    const models = ['fixture-alpha', 'fixture-beta'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    const history = cwd => [{ id: `history-${cwd.endsWith('A') ? 'a' : 'b'}`, cwd, name: `История ${cwd.endsWith('A') ? 'A' : 'B'}`, preview: 'Диалог для возобновления', historyMode: 'legacy', turns: [] }];
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, turn: 0, compact: 0, threadId: 'shared-thread', requests: [], listeners: new Set(), failCompact: false, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings } };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.notify = (method, params) => state.emit('notification', { method, params });
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: history(cwd), nextCursor: null };
          if (method === 'thread/start') { state.threadId = 'shared-thread'; return { thread: { id: state.threadId, cwd, turns: [] }, model: params.model }; }
          if (method === 'thread/resume') { state.threadId = params.threadId; return { thread: { id: state.threadId, cwd, turns: [], historyMode: 'legacy' }, model: 'fixture-alpha', reasoningEffort: 'high' }; }
          if (method === 'turn/start') {
            const turn = { id: `turn-${++state.turn}`, startedAt: Math.floor(Date.now() / 1000), status: 'inProgress', items: [] };
            state.notify('turn/started', { threadId: state.threadId, turn }); return { turn };
          }
          if (method === 'thread/compact/start') {
            state.compact++;
            if (state.failCompact) { state.failCompact = false; throw new Error('Fixture compact request failed'); }
            if (state.compactImmediate) {
              state.compactImmediate = false;
              const turnId = `immediate-${state.compact}`;
              state.notify('turn/started', { threadId: state.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
              state.notify('item/completed', { threadId: state.threadId, turnId, item: { id: `item-${turnId}`, type: 'contextCompaction' } });
              state.notify('turn/completed', { threadId: state.threadId, turn: { id: turnId, status: 'completed', items: [], error: null } });
            }
            return {}; // Ack intentionally arrives before lifecycle notifications.
          }
          if (method === 'turn/interrupt') { state.notify('turn/completed', { threadId: state.threadId, turn: { id: params.turnId, status: 'interrupted', items: [], error: null } }); return {}; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]);
    window.__commands = { sessions, projects };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd) { return { data: history(cwd), nextCursor: null }; },
      async createSession({ cwd = projects[1], settings } = {}) { return create(cwd, settings); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const trigger = () => view().getByRole('button', { name: 'Подробности токенов', exact: true });
  const popup = () => page.getByRole('dialog', { name: 'Использование токенов', exact: true });
  const compact = () => popup().getByRole('button', { name: 'Сжать контекст', exact: true });
  const menu = () => page.getByRole('listbox', { name: 'Команды Codex', exact: true });
  const flush = () => page.waitForTimeout(90);
  const ready = async () => { await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush(); };
  const closeTokens = async () => { if (await popup().isVisible()) await popup().getByRole('button', { name: 'Закрыть сведения о токенах', exact: true }).click(); await page.mouse.move(5, 5); await flush(); };
  const command = async text => { await closeTokens(); await input().fill(text); await input().press('Enter'); await flush(); };
  const requests = (id = 'session-1') => page.evaluate(id => window.__commands.sessions[id].requests, id);
  const count = async (method, id = 'session-1') => (await requests(id)).filter(request => request.method === method).length;
  const notify = async (method, params, id = 'session-1') => { await page.evaluate(({ id, method, params }) => window.__commands.sessions[id].notify(method, params), { id, method, params }); await flush(); };
  const emit = async (type, data, id = 'session-1') => { await page.evaluate(({ id, type, data }) => window.__commands.sessions[id].emit(type, data), { id, type, data }); await flush(); };
  const activate = async id => { await closeTokens(); await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const finishTask = async (id = 'session-1') => {
    await page.evaluate(id => {
      const state = window.__commands.sessions[id];
      const context = { threadId: state.threadId, turnId: `turn-${state.turn}` };
      const usage = { inputTokens: 10000, cachedInputTokens: 8000, cacheWriteInputTokens: 1000, outputTokens: 1500, reasoningOutputTokens: 1000, totalTokens: 11500 };
      state.notify('item/completed', { ...context, item: { id: `answer-${state.turn}`, type: 'agentMessage', phase: 'final_answer', text: 'Готовый ответ для проверки команд.' } });
      state.notify('thread/tokenUsage/updated', { ...context, tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 } });
      state.notify('turn/completed', { threadId: state.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
    }, id); await flush();
  };
  const startCompactTurn = async turnId => notify('turn/started', { threadId: 'shared-thread', turn: { id: turnId, status: 'inProgress', items: [] } });
  const finishCompact = async turnId => {
    await notify('item/completed', { threadId: 'shared-thread', turnId, item: { id: `item-${turnId}`, type: 'contextCompaction' } });
    await notify('turn/completed', { threadId: 'shared-thread', turn: { id: turnId, status: 'completed', items: [], error: null } });
  };
  const alertText = async () => (await view().getByRole('alert').allInnerTexts()).join(' ');
  const image = { name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') };

  await ready();
  const beforeHover = await requests();
  await trigger().hover(); await popup().waitFor();
  assert.equal(await compact().isDisabled(), true, 'New unsent conversation cannot compact');
  assert.equal(await popup().locator('[data-token-section="compact"]').count(), 0, 'Speculative compact explanation section is removed');
  assert.doesNotMatch(await popup().innerText(), /Экономия заранее неизвестна|здесь compact не запускается|Если запустить compact сейчас/);
  assert.deepEqual(await requests(), beforeHover, 'Hover cannot start compaction');
  await closeTokens();
  await command('/Compact');
  assert.equal(await count('thread/compact/start'), 0); assert.equal(await count('turn/start'), 0);
  assert.equal(await input().inputValue(), '/Compact', 'Rejected command keeps its draft');

  await input().fill('Мой неизменный черновик');
  await view().getByRole('button', { name: 'Команды Codex', exact: true }).click(); await menu().waitFor();
  assert.equal(await input().inputValue(), 'Мой неизменный черновик', 'Explicit command menu preserves draft');
  for (const name of ['compact', 'new', 'status', 'model', 'permissions', 'resume', 'help']) assert.equal(await menu().locator(`[data-command="${name}"]`).count(), 1);
  await page.keyboard.press('Escape'); await menu().waitFor({ state: 'hidden' });
  await input().fill('/sta'); await menu().waitFor();
  assert.equal(await menu().getByRole('option').count(), 1);
  assert.equal(await menu().locator('[data-command="status"]').count(), 1);
  await input().press('Enter'); await popup().waitFor();
  assert.equal(await trigger().getAttribute('aria-pressed'), 'true', '/status pins usage');
  assert.equal(await input().inputValue(), ''); await closeTokens();
  await command('/MODEL'); await page.getByRole('listbox', { name: 'Модель', exact: true }).waitFor(); await page.keyboard.press('Escape');
  await command('/permissions'); await page.getByRole('listbox', { name: 'Выберите режим доступа', exact: true }).waitFor(); await page.keyboard.press('Escape');
  await command('/resume'); const historyDialog = page.getByRole('dialog', { name: 'История диалогов', exact: true }); await historyDialog.waitFor();
  assert.match(await historyDialog.innerText(), /История A/); await page.keyboard.press('Escape'); await historyDialog.waitFor({ state: 'hidden' });
  await command('/help'); await menu().waitFor(); await page.screenshot({ path: 'artifacts/standard-commands.png' }); await page.keyboard.press('Escape');
  assert.equal(await count('turn/start'), 0, 'Local commands are never sent to the model');
  for (const text of ['/unsupported', '/compact force']) {
    await command(text); assert.equal(await input().inputValue(), text);
    assert.equal(await count('turn/start'), 0); assert.equal(await count('thread/compact/start'), 0);
    assert.ok((await alertText()).length, 'Unsupported syntax gives a visible error');
  }
  await command('/help'); await menu().waitFor();
  await command('/compact force'); assert.equal(await count('thread/compact/start'), 0); assert.equal(await count('turn/start'), 0);
  assert.equal(await input().inputValue(), '/compact force', 'Editing an explicit help menu to unsupported command arguments must not execute its first option');
  await command('/help'); await menu().waitFor();
  await command('Обычная задача после меню команд'); assert.equal(await count('turn/start'), 1, 'Editing an explicit menu back to prose sends the actual draft'); await finishTask();
  await input().fill('Черновик отправляется через Enter при открытой панели');
  await view().getByRole('button', { name: 'Команды Codex', exact: true }).click(); await menu().waitFor();
  await input().press('Enter'); await flush();
  assert.equal(await count('turn/start'), 2, 'Opening the toolbar above a draft does not turn Enter into implicit compact'); await finishTask();
  await command('/help'); await menu().waitFor();
  await command('/src/file.ts'); assert.equal(await count('turn/start'), 3, 'A path remains normal user text after an explicit help menu'); await finishTask();
  assert.equal((await requests()).filter(request => request.method === 'turn/start').at(-1).params.input[0].text, '/src/file.ts');
  await command('/tmp это обычный текст'); assert.equal(await count('turn/start'), 4, 'Slash-prefixed prose remains user text'); await finishTask();

  await view().locator('input[type="file"]').setInputFiles(image);
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  await command('/compact'); assert.equal(await count('thread/compact/start'), 0);
  assert.equal(await input().inputValue(), '/compact'); assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
  await input().fill('Черновик после сжатия с картинкой');
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  await view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true }).check();
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  await trigger().click(); await popup().waitFor();
  assert.equal(await compact().isEnabled(), true);
  await compact().scrollIntoViewIfNeeded(); await page.screenshot({ path: 'artifacts/token-compact-action.png' });
  const ordinaryTurns = await count('turn/start');
  await compact().evaluate(button => { button.click(); button.click(); }); await flush();
  assert.equal(await count('thread/compact/start'), 1, 'Duplicate click is guarded');
  assert.equal(await count('turn/start'), ordinaryTurns, 'Compaction calls its own RPC, not turn/start');
  assert.deepEqual((await requests()).filter(request => request.method === 'thread/compact/start')[0].params, { threadId: 'shared-thread' });
  assert.equal(await compact().isDisabled(), true, 'Ack alone remains busy');
  assert.equal(await input().inputValue(), 'Черновик после сжатия с картинкой');
  assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
  assert.equal(await view().locator('.chat-scroll').getByText('/compact', { exact: true }).count(), 0, 'Commands never become fake user messages');
  await closeTokens(); await view().getByLabel('Настройки кэша', { exact: true }).click();
  assert.equal(await view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true }).isChecked(), false, 'Compact invalidates the cache and switches autoping off');
  assert.match(await view().innerText(), /Кэш: нет данных/); await view().getByLabel('Настройки кэша', { exact: true }).click();
  await startCompactTurn('compact-1');
  await notify('turn/completed', { threadId: 'shared-thread', turn: { id: 'turn-4', status: 'completed', items: [], error: null } });
  await trigger().click(); assert.equal(await compact().isDisabled(), true, 'Stale ordinary completion cannot release compaction');
  await notify('item/completed', { threadId: 'shared-thread', turnId: 'compact-1', item: { id: 'compact-item-1', type: 'contextCompaction' } });
  assert.equal(await compact().isDisabled(), true, 'Item completion waits for its known turn completion');
  await notify('turn/completed', { threadId: 'shared-thread', turn: { id: 'compact-1', status: 'completed', items: [], error: null } });
  assert.equal(await compact().isEnabled(), true);
  assert.match(await view().innerText(), /Контекст сжат/);
  assert.match(await trigger().innerText(), /нет данных/, 'No fabricated reduced usage without a new measurement');
  assert.match(await popup().locator('[data-token-section="total"]').innerText(), /11\s*500/, 'Real cumulative metrics are retained');

  await closeTokens(); await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).click();
  await command('/CoMpAcT'); assert.equal(await count('thread/compact/start'), 2, 'Command matching is case insensitive');
  assert.equal(await input().inputValue(), '');
  await notify('thread/compacted', { threadId: 'shared-thread', turnId: 'compact-legacy' });
  await trigger().click(); assert.equal(await compact().isEnabled(), true, 'Legacy compacted notification releases busy');
  await page.evaluate(() => { window.__commands.sessions['session-1'].failCompact = true; });
  await compact().click(); await flush(); assert.match(await alertText(), /Fixture compact request failed/); assert.equal(await compact().isEnabled(), true, 'RPC rejection releases busy for explicit retry');
  await compact().click(); await flush(); assert.equal(await compact().isDisabled(), true);
  await startCompactTurn('compact-retry');
  await notify('error', { threadId: 'shared-thread', turnId: 'compact-retry', error: { message: 'Temporary fixture error' }, willRetry: true });
  assert.equal(await compact().isDisabled(), true, 'Retryable error preserves lifecycle');
  await notify('error', { threadId: 'shared-thread', turnId: 'compact-retry', error: { message: 'Final fixture error' }, willRetry: false });
  assert.equal(await compact().isEnabled(), true, 'Terminal error releases lifecycle');

  await closeTokens();
  await page.evaluate(() => { window.__commands.sessions['session-1'].compactImmediate = true; });
  await command('/compact');
  assert.equal(await input().inputValue(), '', 'Immediate completion before RPC acknowledgment still consumes a successful command');
  await trigger().click(); assert.equal(await compact().isEnabled(), true, 'Completion before RPC acknowledgment does not restore stale busy state');
  await compact().click(); await flush();
  await notify('turn/completed', { threadId: 'shared-thread', turn: { id: 'compact-retry', status: 'completed', items: [], error: null } });
  assert.equal(await compact().isDisabled(), true, 'Prior compact completion cannot finish the new operation while its turn is unknown');
  await notify('item/completed', { threadId: 'shared-thread', turnId: 'compact-item-only', item: { id: 'item-only', type: 'contextCompaction' } });
  assert.equal(await compact().isEnabled(), true, 'Older item-only lifecycle releases busy');
  await startCompactTurn('compact-item-only');
  assert.equal(await compact().isEnabled(), true, 'Late start after item-only completion cannot resurrect busy');
  await compact().click(); await flush(); await startCompactTurn('compact-fresh-usage');
  const freshUsage = { last: { inputTokens: 600, outputTokens: 40, totalTokens: 640, cachedInputTokens: 0 }, total: { inputTokens: 10600, outputTokens: 1540, totalTokens: 12140, cachedInputTokens: 8000 }, modelContextWindow: 200000 };
  await notify('thread/tokenUsage/updated', { threadId: 'shared-thread', turnId: 'compact-fresh-usage', tokenUsage: freshUsage });
  await finishCompact('compact-fresh-usage');
  assert.match(await trigger().innerText(), /640/, 'Fresh compact usage remains after completion');
  await compact().click(); await flush(); await startCompactTurn('compact-stop'); await closeTokens();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).click(); await flush();
  assert.deepEqual((await requests()).filter(request => request.method === 'turn/interrupt').at(-1).params, { threadId: 'shared-thread', turnId: 'compact-stop' }, 'Stop uses the correlated compact turn');
  assert.match(await view().innerText(), /Сжатие контекста остановлено/);
  await trigger().click(); assert.equal(await compact().isEnabled(), true);

  await closeTokens();
  await emit('serverRequest', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-thread', turnId: 'pending-fixture', itemId: 'pending-command', command: 'echo fixture', reason: 'Подтверждение для проверки' } });
  await trigger().click(); assert.equal(await compact().isDisabled(), true, 'Pending approval blocks compact');
  const beforeApproval = await count('thread/compact/start');
  await command('/compact'); assert.equal(await count('thread/compact/start'), beforeApproval);
  await notify('serverRequest/resolved', { threadId: 'shared-thread', requestId: 'approval' });
  await command('/compact'); assert.equal(await count('thread/compact/start'), beforeApproval + 1);
  await startCompactTurn('compact-background');
  await input().fill('/new'); await input().press('Enter'); await flush(); await ready();
  assert.equal(await page.locator('.session-tab').count(), 2, '/new remains available during another tab compaction');
  assert.equal(await count('turn/start', 'session-2'), 0);
  assert.equal(await page.evaluate(() => window.__commands.sessions['session-2'].cwd), 'C:/Fixtures/PROJECT_A');
  await trigger().click(); assert.equal(await compact().isDisabled(), true, 'Separate new tab has no thread');
  await finishCompact('compact-background');
  await closeTokens(); assert.match(await trigger().innerText(), /нет данных/, 'Background completion cannot leak old tab counters');
  await activate('session-1'); await trigger().click(); assert.equal(await compact().isEnabled(), true);
  await compact().click(); await flush(); await emit('status', { state: 'disconnected', message: 'Fixture compact disconnect' });
  assert.equal(await compact().isDisabled(), true); assert.match(await alertText(), /Fixture compact disconnect/);
  assert.equal(await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).count(), 0, 'Disconnect ends stuck busy state');
  assert.equal(await count('turn/start'), ordinaryTurns, 'All compactions and local commands stayed outside model turns');
  await activate('session-2'); await command('/resume');
  await page.getByRole('dialog', { name: 'История диалогов', exact: true }).getByRole('button', { name: 'История A', exact: true }).click(); await ready();
  assert.equal(await page.locator('.session-tab').count(), 3, 'History selection opens a separate session in the same project');
  assert.equal(await count('thread/resume', 'session-3'), 1); assert.equal(await count('turn/start', 'session-3'), 0);
  assert.equal((await requests('session-3')).find(request => request.method === 'thread/resume').params.threadId, 'history-a');
  for (const size of [{ width: 940, height: 640 }, { width: 650, height: 700 }]) {
    await page.setViewportSize(size); await flush(); await command('/help'); await menu().waitFor();
    const box = await menu().boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Command menu remains inside ${size.width}px viewport`);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: local slash menu/case/filter/keyboard, model/access/status/history/help/new, unsupported syntax vs paths/prose, no hidden command messages, compact RPC scoping/ack/duplicate/lifecycle/retry/error/disconnect/approval guards, cache invalidation, draft and image preservation, no invented post-compact metrics, background tab isolation. Production renderer and scoped fake App Server events; no real model/compact requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/commands-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
