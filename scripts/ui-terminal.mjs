import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with independent, scoped fake bridges. No terminal process,
// Codex request, or user history is opened by this regression.
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
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, closed: false, turn: 0, starts: 0, threadId: 'shared-thread', requests: [], terminals: [], turns: [], listeners: new Set(), settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings } };
      state.emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.notify = (method, params) => state.emit('notification', { method, params });
      state.bridge = {
        async start() { state.starts++; return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: state.threadId, cwd, turns: [] }, model: params.model };
          if (method === 'thread/resume') {
            if (state.holdResume) await new Promise(resolve => { state.resolveResume = resolve; });
            return { thread: { id: state.threadId, cwd, turns: structuredClone(state.turns), historyMode: 'legacy' }, model: 'fixture-alpha', reasoningEffort: 'high' };
          }
          if (method === 'turn/start') {
            const turn = { id: `turn-${++state.turn}`, startedAt: Math.floor(Date.now() / 1000), status: 'inProgress', items: [{ id: `user-${state.turn}`, type: 'userMessage', content: params.input }] };
            state.turns.push(turn);
            state.notify('turn/started', { threadId: state.threadId, turn }); return { turn };
          }
          if (method === 'thread/compact/start') return {};
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async openTerminal(options) {
          state.terminals.push(options);
          if (state.failTerminal) { state.failTerminal = false; throw new Error('Fixture terminal launch failed'); }
          return new Promise(resolve => { state.resolveTerminal = resolve; });
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state; return { id, cwd };
    };
    create(projects[0]); create(projects[1]);
    window.__terminal = { sessions, projects };
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
  const terminal = () => view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true });
  const closeTab = () => page.locator('.session-tab[data-session-id="session-1"] .session-tab-close');
  const model = () => view().getByRole('combobox', { name: 'Модель', exact: true });
  const effort = () => view().getByRole('combobox', { name: 'Глубина размышлений', exact: true });
  const access = () => view().getByRole('combobox', { name: 'Режим доступа', exact: true });
  const flush = () => page.waitForTimeout(100);
  const ready = async () => { await model().waitFor(); await terminal().waitFor(); await flush(); };
  const requests = (id = 'session-1') => page.evaluate(id => window.__terminal.sessions[id].requests, id);
  const count = async (method, id = 'session-1') => (await requests(id)).filter(request => request.method === method).length;
  const starts = (id = 'session-1') => page.evaluate(id => window.__terminal.sessions[id].starts, id);
  const emit = async (type, data, id = 'session-1') => { await page.evaluate(({ id, type, data }) => window.__terminal.sessions[id].emit(type, data), { id, type, data }); await flush(); };
  const notify = async (method, params, id = 'session-1') => emit('notification', { method, params }, id);
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const finish = async (id = 'session-1') => {
    await page.evaluate(id => {
      const state = window.__terminal.sessions[id];
      const turn = state.turns.at(-1);
      const item = { id: `answer-${state.turn}`, type: 'agentMessage', phase: 'final_answer', text: `Ответ ${id}` };
      turn.items.push(item); turn.status = 'completed';
      state.notify('item/completed', { threadId: state.threadId, turnId: turn.id, item });
      const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, totalTokens: 1200 };
      state.notify('thread/tokenUsage/updated', { threadId: state.threadId, turnId: turn.id, tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 } });
      state.notify('turn/completed', { threadId: state.threadId, turn: { ...turn, error: null } });
    }, id); await flush();
  };
  const compact = async () => {
    await view().getByRole('button', { name: 'Подробности токенов', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Использование токенов', exact: true });
    await popup.waitFor();
    const disabled = await popup.getByRole('button', { name: 'Сжать контекст', exact: true }).isDisabled();
    await popup.getByRole('button', { name: 'Закрыть сведения о токенах', exact: true }).click();
    await page.mouse.move(5, 5); await flush(); return disabled;
  };
  const image = { name: 'terminal-draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') };

  await ready();
  assert.equal(await terminal().isDisabled(), true, 'An unsent conversation has no session to resume in a terminal');
  assert.equal(await terminal().locator('xpath=ancestor::*[contains(@class,"composer-footer")]').count(), 1, 'Terminal button is below the chat composer');
  await input().fill('Задача проекта A'); await input().press('Enter'); await flush();
  assert.equal(await terminal().isDisabled(), true, 'Active model turn blocks terminal handoff');
  await finish(); assert.equal(await terminal().isEnabled(), true);
  await model().click(); await page.getByRole('listbox', { name: 'Модель', exact: true }).getByRole('option', { name: 'fixture-beta', exact: true }).click();
  await effort().click(); await page.getByRole('listbox', { name: 'Глубина размышлений', exact: true }).getByRole('option', { name: 'Средний', exact: true }).click();
  await access().click(); await page.getByRole('listbox', { name: 'Выберите режим доступа', exact: true }).getByRole('option').filter({ hasText: 'Одобрять за меня' }).click();
  await view().locator('input[type="file"]').setInputFiles(image);
  await view().getByRole('button', { name: 'Удалить terminal-draft.png', exact: true }).waitFor();
  const draft = 'Неотправленный черновик после терминала';
  await input().fill(draft);
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  await view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true }).check();
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  const beforeTurns = await count('turn/start');
  const beforeStarts = await starts();
  await terminal().evaluate(button => { button.click(); button.click(); }); await flush();
  assert.deepEqual(await page.evaluate(() => window.__terminal.sessions['session-1'].terminals), [{ threadId: 'shared-thread', model: 'fixture-beta', effort: 'medium', access: 'auto' }], 'Only the current session and current controls are passed; no prompt, cwd, or executable from renderer');
  assert.equal(await terminal().isDisabled(), true, 'Launch promise reserves terminal ownership synchronously');
  assert.equal(await closeTab().isDisabled(), true, 'Terminal ownership prevents closing and reopening the same conversation as a second writer');
  assert.equal(await input().inputValue(), draft);
  assert.equal(await view().getByRole('button', { name: 'Удалить terminal-draft.png', exact: true }).count(), 1);
  await input().press('Enter'); await flush();
  assert.equal(await count('turn/start'), beforeTurns, 'Local sending is blocked while the same thread belongs to terminal');
  assert.equal(await compact(), true, 'Compaction cannot race a terminal conversation');
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  assert.equal(await view().getByRole('button', { name: 'Пинг сейчас', exact: true }).isDisabled(), true, 'Cache ping cannot race terminal conversation');
  assert.equal(await view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true }).isChecked(), false, 'Terminal handoff invalidates cache and disables autoping');
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  await page.evaluate(() => {
    const state = window.__terminal.sessions['session-1'];
    state.emit('terminal', { state: 'opened', threadId: state.threadId });
    state.resolveTerminal({ threadId: state.threadId });
  }); await flush();
  assert.equal(await terminal().isDisabled(), true, 'Launching acknowledgement does not return ownership to GUI');
  assert.match(await view().innerText(), /Диалог открыт в терминале/);
  await page.screenshot({ path: 'artifacts/terminal-open.png' });
  await emit('terminal', { state: 'closed', threadId: 'unrelated-thread' });
  assert.equal(await starts(), beforeStarts, 'Unrelated completion does not reconnect current session');
  assert.equal(await terminal().isDisabled(), true);

  await activate('session-2');
  assert.equal(await terminal().isDisabled(), true, 'Other project still has its own new conversation');
  await input().fill('Задача проекта B'); await input().press('Enter'); await flush(); await finish('session-2');
  assert.equal(await terminal().isEnabled(), true, 'Other project continues independently while A is in terminal');
  const otherDraft = 'Черновик проекта B'; await input().fill(otherDraft);
  const otherRequests = await requests('session-2');
  const otherStarts = await starts('session-2');
  await page.evaluate(() => {
    const state = window.__terminal.sessions['session-1'];
    state.holdResume = true;
    state.turns.push({ id: 'terminal-turn', status: 'completed', items: [{ id: 'terminal-answer', type: 'agentMessage', phase: 'final_answer', text: 'Продолжение из терминала проекта A' }] });
    state.emit('terminal', { state: 'closed', threadId: state.threadId });
  });
  await page.waitForFunction(() => Boolean(window.__terminal.sessions['session-1'].resolveResume));
  assert.equal(await starts(), beforeStarts + 1, 'Terminal closure starts a fresh App Server connection');
  assert.equal(await count('thread/resume'), 1, 'Terminal closure resumes the exact existing conversation');
  assert.equal((await requests()).find(request => request.method === 'thread/resume').params.threadId, 'shared-thread');
  assert.equal(await input().inputValue(), otherDraft);
  assert.deepEqual(await requests('session-2'), otherRequests, 'Background terminal closure does not touch other scoped bridge');
  assert.equal(await starts('session-2'), otherStarts);
  await activate('session-1');
  assert.equal(await terminal().isDisabled(), true, 'Reloading terminal history remains locked');
  assert.equal(await closeTab().isDisabled(), true, 'Tab stays open until terminal history reload completes');
  await page.evaluate(() => { const state = window.__terminal.sessions['session-1']; state.holdResume = false; state.resolveResume(); });
  await view().getByText('Продолжение из терминала проекта A', { exact: true }).waitFor(); await flush();
  assert.equal(await terminal().isEnabled(), true, 'Loaded history restores normal chat operation');
  assert.equal(await closeTab().isEnabled(), true, 'Loaded history makes ordinary tab closing available again');
  assert.equal(await input().inputValue(), draft, 'Handoff and resume preserve draft');
  assert.equal(await view().getByRole('button', { name: 'Удалить terminal-draft.png', exact: true }).count(), 1, 'Handoff and resume preserve attached image');
  assert.equal(await model().getAttribute('data-value'), 'fixture-beta');
  assert.equal(await effort().getAttribute('data-value'), 'medium');
  assert.equal(await access().getAttribute('data-value'), 'auto');
  assert.equal(await count('turn/start'), beforeTurns, 'Terminal launch/reload creates no synthetic prompt or model turn');
  assert.equal(await count('thread/start'), 1, 'Terminal continuation does not create a new conversation');
  assert.equal(await compact(), false);

  await page.evaluate(() => { window.__terminal.sessions['session-1'].failTerminal = true; });
  await terminal().click(); await flush();
  await view().getByRole('alert').filter({ hasText: 'Fixture terminal launch failed' }).waitFor();
  assert.equal(await terminal().isEnabled(), true, 'Failed launcher releases ownership for retry');
  assert.equal(await input().inputValue(), draft);
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  const startsBeforeEarlyClose = await starts();
  await page.evaluate(() => { const state = window.__terminal.sessions['session-1']; state.holdResume = true; state.resolveResume = null; });
  await terminal().click(); await flush();
  await emit('terminal', { state: 'closed', threadId: 'shared-thread', error: 'Fixture failure after detach' });
  await page.waitForFunction(() => Boolean(window.__terminal.sessions['session-1'].resolveResume));
  await page.evaluate(() => {
    const state = window.__terminal.sessions['session-1'];
    state.emit('terminal', { state: 'opened', threadId: state.threadId });
    state.resolveTerminal({ threadId: state.threadId });
  }); await flush();
  assert.equal(await terminal().isDisabled(), true, 'Late launch acknowledgement cannot end history reload');
  await page.evaluate(() => { const state = window.__terminal.sessions['session-1']; state.holdResume = false; state.resolveResume(); });
  await view().getByRole('alert').filter({ hasText: 'Fixture failure after detach' }).waitFor();
  assert.equal(await terminal().isEnabled(), true, 'Close before launch acknowledgement still restores usable chat');
  assert.equal(await starts(), startsBeforeEarlyClose + 1);
  await emit('terminal', { state: 'closed', threadId: 'shared-thread' });
  assert.equal(await starts(), startsBeforeEarlyClose + 1, 'Duplicate close cannot reconnect an already restored conversation');
  assert.equal(await count('turn/start'), beforeTurns);
  assert.equal(await input().inputValue(), draft);
  await emit('serverRequest', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-thread', turnId: 'pending', itemId: 'command', command: 'echo fixture', reason: 'Проверка' } });
  assert.equal(await terminal().isDisabled(), true, 'Pending approval prevents moving the conversation');
  await notify('serverRequest/resolved', { threadId: 'shared-thread', requestId: 'approval' });
  assert.equal(await terminal().isEnabled(), true);
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  await page.screenshot({ path: 'artifacts/terminal-button.png' });
  await page.setViewportSize({ width: 940, height: 640 }); await flush();
  const box = await terminal().boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 941 && box.y + box.height <= 641, 'Terminal button remains visible at 940px');
  await page.screenshot({ path: 'artifacts/terminal-button-940.png' });
  await activate('session-2');
  assert.equal(await input().inputValue(), otherDraft);
  await emit('status', { state: 'disconnected', message: 'Fixture disconnect' }, 'session-2');
  assert.equal(await terminal().isDisabled(), true, 'Disconnected session cannot launch a terminal');
  assert.deepEqual(errors, []);
  console.log('PASS: terminal action under composer, exact thread/model/effort/access, no synthetic prompt, pending/active/loading/approval/disconnect guards, draft/image preservation, terminal close reload and settings preservation, independent project tabs, launch failure recovery, responsive 940px. Production renderer with fake bridges only; no real terminal/model/user history.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/terminal-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
