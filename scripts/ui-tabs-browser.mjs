import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Renderer regression with a scoped bridge fixture. No Electron IPC or model calls.
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
  await page.addInitScript(() => {
    let serial = 0;
    const sessions = {};
    const projects = JSON.parse(localStorage.getItem('projects') || '["C:/Fixtures/PROJECT_A"]');
    const models = ['fixture-alpha', 'fixture-beta'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    const create = (cwd, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings }, requests: [], responses: [], listeners: new Set(), busy: false, closed: false };
      const emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.emit = emit;
      const history = { id: 'shared-history', name: `История ${cwd.split('/').at(-1)}`, cwd, historyMode: 'legacy' };
      state.bridge = {
        async start() { return { initialize: {}, models, cwd, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [history], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: 'shared-thread', cwd, turns: [] }, model: params.model };
          if (method === 'thread/resume') return { thread: { ...history, status: { type: 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old-message', type: 'agentMessage', text: `Сохранённый ответ ${cwd}` }] }] }, model: state.settings.model, reasoningEffort: state.settings.effort };
          if (method === 'turn/start') { state.busy = true; return { turn: { id: 'shared-turn', status: 'inProgress', items: [] } }; }
          if (method === 'turn/interrupt') { state.busy = false; emit('notification', { method: 'turn/completed', params: { threadId: 'shared-thread', turn: { id: 'shared-turn', status: 'interrupted', items: [], error: null } } }); return {}; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond(id, result) { state.responses.push({ id, result }); },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return window.__tabs.nextFolder; }, async chooseExecutable() { return null; }, async openPath() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    create(projects[0]);
    window.__tabs = { sessions, projects, nextFolder: 'C:/Fixtures/PROJECT_B' };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects: [...projects], sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd) { return { data: [{ id: 'shared-history', name: `История ${cwd.split('/').at(-1)}`, cwd, historyMode: 'legacy' }], nextCursor: null }; },
      async createSession({ cwd, fromSessionId, settings } = {}) {
        cwd ??= window.__tabs.nextFolder;
        if (!cwd) return null;
        if (!projects.includes(cwd)) { projects.push(cwd); localStorage.setItem('projects', JSON.stringify(projects)); }
        return create(cwd, { ...sessions[fromSessionId]?.settings, ...settings, cwd });
      },
      async closeSession(id) { sessions[id].closed = true; sessions[id].busy = false; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const select = name => view().getByRole('combobox', { name, exact: true });
  const selectValue = async (name, value) => { await select(name).click(); await page.getByRole('listbox', { name, exact: true }).locator(`[role="option"][data-value="${value}"]`).click(); };
  const stop = () => view().getByRole('button', { name: 'Остановить выполнение', exact: true });
  const tab = id => page.locator(`.session-tab[data-session-id="${id}"]`);
  const activate = async id => { await tab(id).getByRole('tab').click(); await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, id); };
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const countTabs = async count => { await page.waitForFunction(count => document.querySelectorAll('.session-tab').length === count, count); };
  const context = { threadId: 'shared-thread', turnId: 'shared-turn' };
  const notify = (id, method, params) => page.evaluate(({ id, method, params }) => window.__tabs.sessions[id].emit('notification', { method, params }), { id, method, params });
  const stream = (id, delta) => notify(id, 'item/agentMessage/delta', { ...context, itemId: 'shared-answer', delta });
  const send = async (id, marker) => {
    await input().fill(`Задача ${marker}`); await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click(); await stop().waitFor();
    await notify(id, 'turn/started', { threadId: context.threadId, turn: { id: context.turnId, status: 'inProgress', items: [] } });
    await stream(id, `Поток ${marker}\n\n`);
    await page.evaluate(({ id, marker, context }) => window.__tabs.sessions[id].emit('serverRequest', { id: 'shared-approval', method: 'item/commandExecution/requestApproval', params: { ...context, itemId: 'shared-command', command: `echo ${marker}`, reason: `Разрешение ${marker}` } }), { id, marker, context });
    await view().getByText(`Разрешение ${marker}`, { exact: true }).waitFor();
  };
  const close = id => tab(id).getByRole('button', { name: /^Закрыть вкладку / }).click();
  await ready();
  const idA = await activeId();
  await send(idA, 'PROJECT_A'); await input().fill('Черновик A');
  await stream(idA, Array.from({ length: 90 }, (_, i) => `Строка A ${i}.\n\n`).join(''));
  await view().locator('.chat-scroll').evaluate(el => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) .scroll-bottom'));
  const scrollA = await view().locator('.chat-scroll').evaluate(el => el.scrollTop);
  assert.ok(scrollA > 0);
  await view().getByRole('button', { name: 'Новый проект', exact: true }).first().click();
  await countTabs(2); await ready();
  const idB = await activeId();
  assert.notEqual(idA, idB);
  assert.deepEqual(await view().locator('.folder-toggle').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tooltip'))), ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B']);
  assert.equal(await input().inputValue(), '');
  assert.equal(await view().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_B"]').getByRole('button', { name: 'История PROJECT_A', exact: true }).count(), 0);
  await selectValue('Модель', 'fixture-beta'); await selectValue('Глубина размышлений', 'medium'); await select('Режим доступа').click(); await view().getByRole('option', { name: /^Одобрять за меня/ }).click();
  await send(idB, 'PROJECT_B'); await input().fill('Черновик B');
  await stream(idA, 'A получил ответ в фоне.\n\n');
  assert.equal(await view().getByText('A получил ответ в фоне.', { exact: true }).count(), 0);
  await page.screenshot({ path: 'artifacts/tabs-browser-concurrent.png' });
  await page.getByRole('button', { name: 'Открыть новый диалог', exact: true }).click(); await countTabs(3); await ready();
  const draftId = await activeId();
  assert.equal(await input().inputValue(), ''); assert.equal(await select('Модель').getAttribute('data-value'), 'fixture-beta');
  await activate(idB); await close(draftId); await countTabs(2);
  assert.equal(await activeId(), idB); assert.equal(await input().inputValue(), 'Черновик B');
  await activate(idA);
  assert.equal(await activeId(), idA); assert.equal(await input().inputValue(), 'Черновик A');
  assert.equal(await select('Модель').getAttribute('data-value'), 'fixture-alpha'); assert.equal(await select('Глубина размышлений').getAttribute('data-value'), 'high'); assert.equal(await select('Режим доступа').getAttribute('data-value'), 'workspace-write');
  await view().getByText('A получил ответ в фоне.', { exact: true }).waitFor();
  assert.ok(Math.abs(await view().locator('.chat-scroll').evaluate(el => el.scrollTop) - scrollA) < 2, 'Background activity preserves the reading position');
  assert.equal(await view().getByText('Поток PROJECT_B', { exact: true }).count(), 0);
  await view().getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await activate(idB); await view().getByText('Разрешение PROJECT_B', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'Отклонить', exact: true }).click();
  const responses = await page.evaluate(([a, b]) => [window.__tabs.sessions[a].responses, window.__tabs.sessions[b].responses], [idA, idB]);
  assert.deepEqual(responses, [[{ id: 'shared-approval', result: { decision: 'accept' } }], [{ id: 'shared-approval', result: { decision: 'decline' } }]]);
  await view().getByRole('button', { name: 'История PROJECT_B', exact: true }).click(); await countTabs(3); await ready();
  const historyId = await activeId(); await view().getByText('Сохранённый ответ C:/Fixtures/PROJECT_B', { exact: true }).waitFor();
  await activate(idB); await view().getByRole('button', { name: 'История PROJECT_B', exact: true }).click();
  assert.equal(await activeId(), historyId); assert.equal(await page.getByRole('tab').count(), 3);
  await activate(idA); await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).click(); await countTabs(4); await ready();
  const historyA = await activeId(); assert.notEqual(historyA, historyId);
  await view().getByText('Сохранённый ответ C:/Fixtures/PROJECT_A', { exact: true }).waitFor();
  await close(historyA); await countTabs(3);
  await activate(idB); await close(historyId); await countTabs(2);
  await activate(idA); await stop().click(); await stop().waitFor({ state: 'hidden' });
  await activate(idB); assert.equal(await stop().isVisible(), true); await stream(idB, 'B продолжает после остановки A.\n\n');
  await view().getByText('B продолжает после остановки A.', { exact: true }).waitFor();
  await activate(idA); await send(idA, 'PROJECT_A'); await activate(idB);
  await close(idA); const confirm = page.getByRole('alertdialog', { name: 'Закрыть работающий диалог?', exact: true });
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click(); assert.equal(await page.getByRole('tab').count(), 2);
  await close(idA); await confirm.getByRole('button', { name: 'Остановить и закрыть', exact: true }).click(); await countTabs(1);
  assert.equal(await activeId(), idB); assert.equal(await stop().isVisible(), true); assert.equal(await view().locator('.folder-toggle').count(), 2);
  const states = await page.evaluate(([a, b]) => [window.__tabs.sessions[a].closed, window.__tabs.sessions[b].busy, window.__tabs.sessions[b].requests.filter(request => request.method === 'turn/interrupt').length], [idA, idB]);
  assert.deepEqual(states, [true, true, 0]);
  await stream(idB, 'B продолжает после закрытия A.\n\n'); await view().getByText('B продолжает после закрытия A.', { exact: true }).waitFor();
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size);
    const bounds = await page.evaluate(() => ({ height: innerHeight, document: document.documentElement.scrollHeight, composer: document.querySelector('.session-view:not([hidden]) .composer-area').getBoundingClientRect().bottom }));
    assert.ok(bounds.document <= bounds.height + 1); assert.ok(bounds.composer <= bounds.height + 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: 'artifacts/tabs-browser.png' });
  await stop().click(); await stop().waitFor({ state: 'hidden' });
  await page.reload(); await ready();
  assert.deepEqual(await view().locator('.folder-toggle').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tooltip'))), ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B']);
  assert.deepEqual(errors, []);
  console.log('PASS: browser tabs, folders/history, concurrent scoped fixture events and approvals, drafts/settings, background scroll, busy new chat, history dedupe, isolated stop/confirmed close, retained folders, reload, 1440/940px layout. Fake bridge only; no Electron IPC or model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/tabs-browser-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
