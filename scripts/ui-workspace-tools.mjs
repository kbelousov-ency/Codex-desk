import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with scoped fixtures. No model requests or filesystem mutations.
const root = resolve('dist');
const server = createServer(async (request, response) => {
  const file = resolve(root, `.${new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/WORKSPACE';
    const image = { name: 'draft.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=' };
    const fixture = window.__workspace = { sessions: {}, calls: [], created: [], saved: [], failCreate: false, failFork: false, serial: 0 };
    const history = provider => ({ id: `${provider}:source`, provider, cwd, name: `История ${provider}`, historyMode: provider === 'codex' ? 'paginated' : 'legacy' });
    const turns = provider => [{ id: 'history-turn', status: 'completed', items: [{ id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: `Вопрос ${provider}` }] }, { id: 'history-answer', type: 'agentMessage', phase: 'final_answer', text: `Ответ ${provider}` }] }];
    const make = (provider, options = {}) => {
      const id = `session-${++fixture.serial}`;
      const settings = { provider, cwd, model: `${provider}-model`, effort: 'high', access: 'workspace-write', ...options.settings };
      const state = fixture.sessions[id] = { id, provider, settings, closed: false, listeners: new Set() };
      state.bridge = {
        async start() { return { provider, cwd, capabilities: { usage: false }, initialize: {}, executable: `${provider}.exe`, account: null, config: {}, models: [settings.model, `${provider}-alternate`].map(model => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high', 'medium'].map(reasoningEffort => ({ reasoningEffort })) })) }; },
        async getSettings() { return { ...settings }; }, async setSettings(patch) { Object.assign(settings, patch); },
        async request(method, params = {}) {
          fixture.calls.push({ sessionId: id, provider, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [history(provider)], nextCursor: null };
          if (method === 'thread/fork' && fixture.failFork) { fixture.failFork = false; throw new Error('Проверочная ошибка ответвления'); }
          if (method === 'thread/resume' || method === 'thread/fork') return { thread: { ...history(provider), id: method === 'thread/fork' ? `${provider}:fork-${id}` : params.threadId, name: method === 'thread/fork' ? `Ответвление ${provider}` : history(provider).name, turns: provider === 'codex' ? [] : turns(provider), status: { type: 'idle' } }, model: settings.model, reasoningEffort: settings.effort };
          if (method === 'thread/items/list') return { data: turns(provider).flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), nextCursor: null };
          if (method === 'thread/turns/list') return { data: turns(provider).map(turn => ({ ...turn, items: [] })), nextCursor: null };
          if (method === 'agent/capabilities') return { commands: [], agents: [], mcpServers: [] };
          if (method === 'usage/read') return { available: false, windows: [] };
          throw new Error(`Unexpected request ${method}`);
        },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseComposerFiles() { return { images: [image], paths: [] }; }, async chooseDirectory() { return cwd; },
        async chooseExecutable() { return null; }, async readAttachment() { return null; }, async openPath() {},
      };
      return { id, cwd, provider };
    };
    const initial = make('codex');
    window.codex = {
      ...fixture.sessions[initial.id].bridge,
      async getWorkspace() {
        const saved = JSON.parse(localStorage.getItem('workspace-tools') || 'null');
        if (!saved) return { projects: [cwd], sessions: [initial] };
        const restored = saved.tabs.map(tab => ({ ...make(tab.settings?.provider || 'codex', tab), ...tab, sessionId: undefined }));
        return { projects: [cwd], sessions: restored.map(({ id, cwd, provider }) => ({ id, cwd, provider })), restore: { kind: 'workspace', activeIndex: saved.activeIndex, tabs: restored } };
      },
      async listProjectThreads() { return { data: [history('codex'), history('claude')], nextCursor: null }; },
      async createSession(options) { fixture.created.push(structuredClone(options)); if (fixture.failCreate) { fixture.failCreate = false; throw new Error('Проверочная ошибка открытия'); } return make(options.provider || options.settings?.provider || 'codex', options); },
      async closeSession(id) { fixture.sessions[id].closed = true; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async saveWorkspaceState(snapshot) { fixture.saved.push(structuredClone(snapshot)); localStorage.setItem('workspace-tools', JSON.stringify(snapshot)); },
      async completeUpdateRestore() {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().locator('.composer textarea');
  const active = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const ids = () => page.locator('.session-tab').evaluateAll(nodes => nodes.map(node => node.dataset.sessionId));
  const tab = id => page.locator(`.session-tab[data-session-id="${id}"]`);
  const ready = () => page.waitForFunction(() => { const input = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return input && !input.disabled; });
  const palette = async query => { await page.keyboard.press('Control+k'); await page.getByRole('combobox', { name: 'Найти команду' }).fill(query); };
  const choose = async (label, value) => { await view().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('listbox', { name: label, exact: true }).locator(`[data-value="${value}"]`).click(); };
  const context = async id => { await tab(id).getByRole('tab').click({ button: 'right' }); return page.getByRole('menu', { name: /^Вкладка:/ }); };
  const close = id => tab(id).getByRole('button', { name: /^Закрыть вкладку/ }).click();
  const waitCount = count => page.waitForFunction(count => document.querySelectorAll('.session-tab').length === count, count);
  await ready();
  await view().getByRole('button', { name: 'История codex', exact: true }).click(); await ready();
  await view().getByText('Ответ codex', { exact: true }).waitFor();
  const codexSource = await active();
  await draft().fill('Исходный черновик Codex');
  await page.evaluate(() => { window.__workspace.failFork = true; });
  await view().getByRole('button', { name: 'Ответвить беседу', exact: true }).click();
  await waitCount(3); await ready();
  await view().getByText(/Проверочная ошибка ответвления/).waitFor();
  const failedFork = await active();
  assert.equal(await view().getByRole('button', { name: 'Повторить подключение', exact: true }).count(), 0, 'A failed fork cannot resume its source as another writer');
  assert.equal(await page.evaluate(id => window.__workspace.calls.some(call => call.sessionId === id && call.method === 'thread/resume'), failedFork), false);
  await close(failedFork); await waitCount(2); await tab(codexSource).getByRole('tab').click();
  await view().getByRole('button', { name: 'Ответвить беседу', exact: true }).click();
  await waitCount(3); await ready(); await view().getByText('Ответ codex', { exact: true }).waitFor();
  const codexFork = await active();
  assert.equal(await draft().inputValue(), '');
  await tab(codexSource).getByRole('tab').click(); assert.equal(await draft().inputValue(), 'Исходный черновик Codex');
  await view().getByRole('button', { name: 'История claude', exact: true }).click(); await ready();
  await view().getByText('Ответ claude', { exact: true }).waitFor();
  const claudeSource = await active();
  await palette('ответвить текущую'); await page.keyboard.press('Enter');
  await waitCount(5); await ready(); await view().getByText('Ответ claude', { exact: true }).waitFor();
  const claudeFork = await active();
  const forkCalls = await page.evaluate(() => window.__workspace.calls.filter(call => call.method === 'thread/fork'));
  assert.deepEqual(forkCalls.map(call => [call.provider, call.params.threadId, call.params.cwd]), [['codex', 'codex:source', 'C:/Fixtures/WORKSPACE'], ['codex', 'codex:source', 'C:/Fixtures/WORKSPACE'], ['claude', 'claude:source', 'C:/Fixtures/WORKSPACE']]);
  assert.equal(forkCalls[1].params.excludeTurns, true);
  const forkPages = await page.evaluate(id => window.__workspace.calls.filter(call => call.sessionId === id && ['thread/items/list', 'thread/turns/list'].includes(call.method)), codexFork);
  assert.deepEqual(forkPages.map(call => [call.method, call.params.threadId]), [['thread/items/list', `codex:fork-${codexFork}`], ['thread/turns/list', `codex:fork-${codexFork}`]]);
  assert.notEqual(codexFork, codexSource); assert.notEqual(claudeFork, claudeSource);
  await page.keyboard.press('Control+Tab'); assert.equal(await active(), 'session-1');
  await page.keyboard.press('Control+Shift+Tab'); assert.equal(await active(), claudeFork);
  await palette('история codex'); await page.keyboard.press('Enter'); assert.equal(await active(), codexSource);
  await choose('Модель', 'codex-alternate'); await choose('Глубина размышлений', 'medium');
  await draft().fill('Черновик для возврата');
  await view().getByRole('button', { name: 'Добавить файлы', exact: true }).click();
  await view().locator('.attachment img[alt="draft.png"]').waitFor();
  await close(codexSource); await waitCount(4);
  await page.evaluate(() => { window.__workspace.failCreate = true; });
  await page.keyboard.press('Control+Shift+t'); await page.getByText('Проверочная ошибка открытия', { exact: true }).waitFor();
  await page.keyboard.press('Control+Shift+t'); await waitCount(5); await ready();
  const restored = await active();
  assert.equal(await draft().inputValue(), 'Черновик для возврата');
  assert.equal(await view().locator('.attachment img[alt="draft.png"]').count(), 1);
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'codex-alternate');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'medium');
  await (await context(restored)).getByRole('menuitem', { name: 'Закрепить вкладку', exact: true }).click();
  assert.equal((await ids())[0], restored); assert.equal(await tab(restored).getAttribute('data-pinned'), 'true');
  assert.equal(await tab(restored).locator('.session-tab-close').count(), 0);
  const before = await ids();
  const target = tab(before[1]); const box = await target.boundingBox();
  await tab(claudeFork).dragTo(target, { targetPosition: { x: 2, y: box.height / 2 } });
  const after = await ids(); assert.equal(after[0], restored); assert.equal(after[1], claudeFork);
  await draft().focus(); await page.keyboard.press('Control+k');
  await page.keyboard.press('Tab'); assert.equal(await page.getByRole('button', { name: 'Закрыть палитру' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); assert.equal(await draft().evaluate(el => el === document.activeElement), true);
  await page.waitForFunction(order => { const snapshot = window.__workspace.saved.at(-1); return snapshot?.tabs[0].pinned && snapshot.tabs.map(tab => tab.sessionId).join() === order.join(); }, after);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', ctrlKey: true, bubbles: true })));
  await page.getByRole('dialog', { name: 'Палитра команд' }).waitFor();
  await page.screenshot({ path: 'artifacts/workspace-tools.png' });
  await page.keyboard.press('Escape');
  await page.reload(); await ready();
  assert.equal(await page.locator('.session-tab').first().getAttribute('data-pinned'), 'true');
  assert.equal(await draft().inputValue(), 'Черновик для возврата');
  assert.equal(await view().locator('.attachment img[alt="draft.png"]').count(), 1);
  await (await context(await active())).getByRole('menuitem', { name: 'Закрыть остальные', exact: true }).click();
  await waitCount(1);
  await palette('ничего-не-найти'); await page.getByText('Ничего не найдено.', { exact: true }).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__workspace.calls.filter(call => /^(turn\/|thread\/start)/.test(call.method)).length), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: Codex/Claude forks into separate tabs with unchanged source/directory; palette keyboard/filter/focus, Ctrl+Tab, closed draft/image/model/effort restore after failed opening, pinning/drag/persistence, close others. Scoped fixtures, 0 model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/workspace-tools-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
