import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with independently scoped fake App Server bridges.
// No user config/history, real terminal or model request is touched.
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
    const sessions = {};
    let serial = 0;
    const models = ['fixture-alpha', 'fixture-beta'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, turn: 0, compact: 0, threadId: 'shared-thread', requests: [], turns: [], imagesSaved: 0, listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings } };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.notify = (method, params) => state.emit('notification', { method, params });
      state.finish = (status = 'completed', turnId = state.turns.at(-1)?.id) => {
        const turn = state.turns.find(turn => turn.id === turnId) || { id: turnId, items: [] };
        turn.status = status;
        state.notify('turn/completed', { threadId: state.threadId, turn: { ...turn, error: status === 'failed' ? { message: 'Fixture turn failed' } : null } });
      };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: state.threadId, cwd, turns: [] }, model: params.model };
          if (method === 'thread/resume' || method === 'thread/read') {
            if (state.holdResume) await new Promise(resolve => { state.resolveResume = resolve; });
            if (state.failResume && method === 'thread/resume') throw new Error('already has an active writer');
            return { thread: { id: state.threadId, cwd, turns: structuredClone(state.turns), historyMode: 'legacy' }, model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'turn/start') {
            if (state.failSend) { const message = state.failSend; state.failSend = false; throw new Error(message); }
            if (state.holdSend) await new Promise(resolve => { state.resolveSend = resolve; });
            const turn = { id: `turn-${++state.turn}`, startedAt: Math.floor(Date.now() / 1000), status: 'inProgress', items: [] };
            const item = { id: `user-${state.turn}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
            turn.items.push(item); state.turns.push(turn);
            state.notify('turn/started', { threadId: state.threadId, turn });
            state.notify('item/completed', { threadId: state.threadId, turnId: turn.id, item });
            return { turn };
          }
          if (method === 'turn/interrupt') { if (!state.holdStop) state.finish('interrupted', params.turnId); return {}; }
          if (method === 'thread/compact/start') {
            const turn = { id: `compact-${++state.compact}`, status: 'inProgress', items: [] }; state.turns.push(turn);
            state.notify('turn/started', { threadId: state.threadId, turn }); return {};
          }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async openTerminal() { return new Promise(resolve => { state.resolveTerminal = resolve; }); },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond(id) { state.notify('serverRequest/resolved', { requestId: id }); },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async saveImages(images) { state.imagesSaved++; return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]); create(projects[1]);
    window.__continue = { sessions, projects };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession({ cwd = projects[1], settings } = {}) { return create(cwd, settings); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const action = () => view().getByRole('button', { name: 'Продолжить выполнение', exact: true });
  const stop = () => view().getByRole('button', { name: 'Остановить выполнение', exact: true });
  const model = () => view().getByRole('combobox', { name: 'Модель', exact: true });
  const flush = () => page.waitForTimeout(80);
  const ready = async () => { await model().waitFor(); await flush(); };
  const requests = (id = 'session-1') => page.evaluate(id => window.__continue.sessions[id].requests, id);
  const count = async (method, id = 'session-1') => (await requests(id)).filter(request => request.method === method).length;
  const set = async (patch, id = 'session-1') => page.evaluate(({ id, patch }) => Object.assign(window.__continue.sessions[id], patch), { id, patch });
  const emit = async (type, data, id = 'session-1') => { await page.evaluate(({ id, type, data }) => window.__continue.sessions[id].emit(type, data), { id, type, data }); await flush(); };
  const notify = async (method, params, id = 'session-1') => emit('notification', { method, params }, id);
  const finish = async (status = 'completed', id = 'session-1') => { await page.evaluate(({ id, status }) => window.__continue.sessions[id].finish(status), { id, status }); await flush(); };
  const send = async text => { await input().fill(text); await input().press('Enter'); await stop().waitFor(); await flush(); };
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const unavailable = async label => assert.ok(!await action().count() || !await action().isEnabled(), label);
  const image = { name: 'continue-draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') };

  await ready(); await unavailable('An unsent conversation has nothing to continue');
  await send('Задача до остановки');
  await unavailable('A running task cannot continue twice');
  await set({ holdStop: true }); await stop().click(); await flush();
  await unavailable('Interrupt acknowledgement alone does not confirm an interrupted turn');
  assert.equal(await count('turn/interrupt'), 1);
  await finish('interrupted'); await action().waitFor();
  assert.equal(await action().isEnabled(), true);
  assert.equal(await action().getAttribute('title'), 'Отправить «Продолжай» в этот диалог');
  assert.ok(await view().locator('.user-avatar .pixel-avatar').count() > 0, 'User avatar is a pixel SVG');
  assert.equal((await view().locator('.user-avatar').first().innerText()).trim(), '', 'Old letter placeholder is gone');
  await model().click(); await page.getByRole('listbox', { name: 'Модель', exact: true }).getByRole('option', { name: 'fixture-beta', exact: true }).click();
  await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).click();
  await page.getByRole('listbox', { name: 'Глубина размышлений', exact: true }).getByRole('option', { name: 'Средний', exact: true }).click();
  await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).click();
  await page.getByRole('listbox', { name: 'Выберите режим доступа', exact: true }).getByRole('option').filter({ hasText: 'Одобрять за меня' }).click();
  const draft = 'Неотправленный черновик с картинкой'; await input().fill(draft);
  await view().locator('input[type="file"]').setInputFiles(image);
  await view().getByRole('button', { name: 'Удалить continue-draft.png', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/continue-stopped.png' });
  await set({ holdSend: true });
  const othersBefore = await requests('session-2');
  await action().evaluate(button => { button.click(); button.click(); }); await flush();
  assert.equal(await count('turn/start'), 2, 'Duplicate clicks reserve only one new turn synchronously');
  await unavailable('Continue is unavailable while the new request awaits acknowledgement');
  assert.equal(await input().inputValue(), draft);
  const resumed = (await requests()).filter(request => request.method === 'turn/start').at(-1).params;
  assert.deepEqual(resumed.input, [{ type: 'text', text: 'Продолжай', text_elements: [] }], 'The only model input is the visible fixed continuation text');
  assert.equal(resumed.threadId, 'shared-thread'); assert.equal(resumed.model, 'fixture-beta'); assert.equal(resumed.effort, 'medium');
  assert.equal(resumed.cwd, 'C:/Fixtures/PROJECT_A');
  assert.deepEqual(resumed.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['C:/Fixtures/PROJECT_A'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(resumed.approvalPolicy, 'on-request'); assert.equal(resumed.approvalsReviewer, 'auto_review');
  assert.equal(await page.evaluate(() => window.__continue.sessions['session-1'].imagesSaved), 0, 'Continuation never stores or sends pending images');
  assert.deepEqual(await requests('session-2'), othersBefore, 'Continue uses only its owning bridge');
  await page.evaluate(() => { const state = window.__continue.sessions['session-1']; state.holdSend = false; state.resolveSend(); }); await flush();
  assert.equal(await view().locator('.user-message').getByText('Продолжай', { exact: true }).count(), 1, 'Continuation is a visible user message exactly once');
  assert.doesNotMatch(await view().innerText(), /Выполнение остановлено/);
  await notify('turn/completed', { threadId: 'shared-thread', turn: { id: 'turn-1', status: 'interrupted', items: [], error: null } });
  await unavailable('Late interrupted completion cannot resurrect Continue during a later turn');
  await finish(); await unavailable('Normally completed task has no continuation notice');
  assert.equal(await input().inputValue(), draft); assert.equal(await view().getByRole('button', { name: 'Удалить continue-draft.png', exact: true }).count(), 1);

  // A failed submission removes its optimistic item, retains the retry action,
  // and cannot consume the unrelated composer draft or attachment.
  await view().getByRole('button', { name: 'Удалить continue-draft.png', exact: true }).click();
  await send('Следующая остановленная задача'); await finish('interrupted');
  await input().fill(draft); await set({ failSend: 'Fixture continue rejected' });
  await action().click(); await flush(); await action().waitFor();
  assert.equal(await action().isEnabled(), true, 'Rejected continuation remains explicitly retryable');
  assert.match(await view().innerText(), /Fixture continue rejected/);
  assert.equal(await view().locator('.user-message').getByText('Продолжай', { exact: true }).count(), 1, 'Rejected optimistic continuation is removed');
  const retryBefore = await count('turn/start'); await action().evaluate(button => { button.click(); button.click(); }); await flush();
  assert.equal(await count('turn/start'), retryBefore + 1); await finish('failed'); await unavailable('Failed model task does not masquerade as an interrupted task');
  assert.equal(await input().inputValue(), draft);

  await send('Задача с подтверждением'); await finish('interrupted');
  await emit('serverRequest', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-thread', turnId: 'approval-turn', itemId: 'approval-item', command: 'echo fixture', reason: 'Подтверждение теста' } });
  await unavailable('Pending approval blocks continuation');
  await notify('serverRequest/resolved', { requestId: 'approval' }); await flush();
  assert.equal(await action().isEnabled(), true, 'Resolved approval restores the eligible action');
  await set({ holdStop: false });
  await input().fill('/compact'); await input().press('Enter'); await stop().waitFor(); await stop().click(); await flush();
  await unavailable('An interrupted compaction must not send a model continuation');
  assert.match(await view().innerText(), /Сжатие контекста остановлено/);

  await send('Остановка перед терминалом'); await finish('interrupted');
  await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).click(); await flush();
  await unavailable('Terminal ownership blocks continuation');
  await page.evaluate(() => { const state = window.__continue.sessions['session-1']; state.emit('terminal', { state: 'opened', threadId: state.threadId }); state.resolveTerminal({ threadId: state.threadId }); });
  await set({ holdResume: true }); await emit('terminal', { state: 'closed', threadId: 'shared-thread' });
  await page.waitForFunction(() => Boolean(window.__continue.sessions['session-1'].resolveResume));
  await unavailable('Reloading thread history blocks continuation');
  await page.evaluate(() => { const state = window.__continue.sessions['session-1']; state.holdResume = false; state.resolveResume(); }); await flush();

  await activate('session-2'); await unavailable('Other tab with the same possible thread ID does not inherit continuation');
  await send('Независимая задача B'); await finish('interrupted', 'session-2'); assert.equal(await action().isEnabled(), true);
  await emit('status', { state: 'disconnected', message: 'Fixture disconnected' }, 'session-2');
  await unavailable('Disconnect clears actionable interrupted state');
  await activate('session-1'); await send('Последняя остановленная задача'); await finish('interrupted');
  await input().fill('/new'); await input().press('Enter'); await ready(); await unavailable('A new tab never inherits a stopped notice');
  await page.setViewportSize({ width: 940, height: 780 }); await activate('session-1');
  await action().waitFor(); await page.screenshot({ path: 'artifacts/continue-narrow.png' });
  const warningBefore = await count('turn/start');
  await notify('configWarning', { message: 'Fixture configuration warning' });
  await unavailable('Continuation does not appear as an action on an unrelated configuration warning');
  assert.match(await view().innerText(), /Fixture configuration warning/);
  await send('Проверка скрытого уведомления'); await finish('interrupted'); await action().waitFor();
  await view().getByRole('button', { name: 'Скрыть уведомление', exact: true }).click(); await unavailable('Dismissing the stopped notice hides its action');
  await notify('deprecationNotice', { message: 'Fixture unrelated deprecation' });
  await unavailable('A later unrelated notice cannot resurrect dismissed Continue');
  assert.equal(await count('turn/start'), warningBefore + 1, 'Warnings and dismissing never send continuation input');
  await send('Остановка перед конфликтом записи'); await finish('interrupted'); await input().fill(draft);
  await set({ failSend: 'thread shared-thread already has an active writer', failResume: true });
  await action().click(); await flush(); await unavailable('Writer conflict invalidates readiness and blocks direct Continue');
  const conflictBefore = await count('turn/start');
  if (await action().count()) await action().evaluate(button => button.click()); await flush();
  assert.equal(await count('turn/start'), conflictBefore, 'A disconnected writer never bypasses normal attachment guards');
  const reconnect = view().getByRole('button', { name: 'Повторить подключение', exact: true });
  await reconnect.click(); await flush(); await unavailable('Failed reattachment cannot revive stopped continuation');
  assert.equal(await count('turn/start'), conflictBefore); assert.equal(await input().inputValue(), draft);
  assert.deepEqual(errors, []);
  console.log('PASS: pixel avatar; confirmed interrupt only; single visible continuation with unchanged thread/model/effort/access; draft/image preservation; retries, stale events, completion/failure, approvals, compact, terminal/reload, disconnect and session isolation. Fake bridges only, no real Codex/model.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/continue-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally { if (browser) await browser.close(); server.close(); }
