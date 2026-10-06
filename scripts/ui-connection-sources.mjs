import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with isolated per-tab bridges. No CLI, account, portal or model calls.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/Sources';
    const sessions = {}, calls = [], saves = [];
    const fixture = window.__sources = { sessions, calls, saves, portalError: '', pendingPortal: null,
      failSource: false, incompatibleCatalogue: false, info: { configured: true, encryptionAvailable: true, baseUrl: 'https://router.example.test', providerName: 'Fixture router' } };
    const tabs = [
      { id: 'claude-a', provider: 'claude', source: 'account', title: 'Личная беседа', draft: 'Черновик личного аккаунта' },
      { id: 'claude-b', provider: 'claude', source: 'router', title: 'Беседа роутера', draft: 'Независимый черновик роутера' },
      { id: 'codex-c', provider: 'codex', source: 'inherited', title: 'Беседа Codex', draft: 'Черновик Codex' },
    ];
    const preview = () => ({ previewId: 'fixture-preview', agent: 'claude', providerName: 'Fixture router',
      baseUrl: 'https://router.example.test', expiresAt: new Date(Date.now() + 600000).toISOString() });
    fixture.finishPortal = () => { fixture.pendingPortal?.(preview()); fixture.pendingPortal = null; };
    for (const tab of tabs) {
      const settings = { cwd, provider: tab.provider, connectionSource: tab.source,
        model: tab.provider === 'claude' ? 'fixture-sonnet' : 'fixture-astra', effort: 'high', access: 'workspace-write' };
      const thread = { id: `${tab.provider}:preserved-${tab.id}`, provider: tab.provider, cwd, name: tab.title, historyMode: 'legacy' };
      const state = sessions[tab.id] = { settings, thread, listeners: new Set() };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async getSettings() { return { ...settings }; },
        async setSettings(patch) {
          calls.push({ id: tab.id, method: 'setSettings', patch: structuredClone(patch) });
          if (fixture.failSource && patch.connectionSource === 'router') throw new Error('Подключите роутер перед сменой источника.');
          Object.assign(settings, patch);
        },
        async start() {
          calls.push({ id: tab.id, method: 'start', source: settings.connectionSource });
          const currentModel = { id: settings.model, model: settings.model, displayName: settings.model, inputModalities: ['text', 'image'],
            defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) };
          const models = fixture.incompatibleCatalogue && tab.id === 'claude-a' && settings.connectionSource === 'router'
            ? [{ ...currentModel, unavailable: true }, { ...currentModel, id: 'fixture-router-sonnet', model: 'fixture-router-sonnet', displayName: 'Router Sonnet' }]
            : [currentModel];
          return { initialize: {}, cwd, provider: tab.provider, executable: 'C:/Fixture/agent.exe', account: null,
            capabilities: { compact: true, steer: true, terminal: true, mcp: false, archive: true, usage: tab.provider === 'claude' },
            config: { model: settings.model, model_reasoning_effort: settings.effort },
            models };
        },
        async request(method, params = {}) {
          calls.push({ id: tab.id, method, params: structuredClone(params), source: settings.connectionSource });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'agent/capabilities') return { commands: [], agents: [], mcpServers: [] };
          if (method === 'usage/read') return { available: false, windows: [], message: 'Fixture' };
          if (method === 'thread/resume') return { thread: { ...thread, id: params.threadId, turns: [
            { id: `history-${tab.id}`, status: 'completed', items: [
              { id: `question-${tab.id}`, type: 'userMessage', content: [{ type: 'text', text: `Вопрос ${tab.title}` }] },
              { id: `answer-${tab.id}`, type: 'agentMessage', text: `Ответ ${tab.title}`, phase: 'final_answer' },
            ] },
          ] }, model: settings.model, reasoningEffort: settings.effort };
          if (method === 'turn/start') throw new Error('Source switching must never start a model turn.');
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async getRouterConnection() { calls.push({ id: tab.id, method: 'getRouterConnection' }); return { ...fixture.info }; },
        async connectRouterPortal() {
          calls.push({ id: tab.id, method: 'connectRouterPortal' });
          if (fixture.portalError) throw new Error(fixture.portalError);
          return new Promise(resolve => { fixture.pendingPortal = resolve; });
        },
        async cancelRouterConnection() {
          calls.push({ id: tab.id, method: 'cancelRouterConnection' });
          fixture.pendingPortal?.(null); fixture.pendingPortal = null;
        },
        async previewRouterInstaller() { calls.push({ id: tab.id, method: 'previewRouterInstaller' }); return preview(); },
        async applyRouterConnection(options) {
          calls.push({ id: tab.id, method: 'applyRouterConnection', options });
          if (options.previewId !== 'fixture-preview') throw new Error('Unexpected preview');
          fixture.info = { ...fixture.info, configured: true, savedAt: new Date().toISOString() };
          return { ...fixture.info };
        },
        async getClaudeAuthStatus() { return { loggedIn: true }; },
        async getClaudeToken() { return { configured: true, encryptionAvailable: true }; },
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
        async readAttachment() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
      tab.cwd = cwd; tab.thread = thread; tab.settings = { ...settings };
    }
    window.codex = {
      ...sessions['claude-a'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: tabs, restore: { kind: 'workspace', activeIndex: 0, tabs } }; },
      forSession(id) { return sessions[id].bridge; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async saveWorkspaceState(snapshot) { saves.push(structuredClone(snapshot)); },
      async closeSession() {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().locator('.composer textarea');
  const source = () => view().getByRole('combobox', { name: 'Источник', exact: true });
  const ready = () => page.waitForFunction(() => {
    const control = document.querySelector('.session-view:not([hidden]) [aria-label="Источник"]');
    return control && !control.disabled;
  });
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const calls = method => page.evaluate(method => window.__sources.calls.filter(call => call.method === method), method);
  const choose = async value => {
    await source().click();
    await page.getByRole('listbox', { name: 'Источник', exact: true }).locator(`[data-value="${value}"]`).click();
  };
  const switchTo = async (id, value) => {
    const before = (await calls('thread/resume')).filter(call => call.id === id).length;
    await choose(value);
    await page.waitForFunction(({ id, before }) => window.__sources.calls.filter(call => call.id === id && call.method === 'thread/resume').length > before, { id, before });
    await ready();
    assert.equal(await source().getAttribute('data-value'), value);
  };
  await ready();
  await view().locator('.user-message').getByText('Вопрос Личная беседа', { exact: true }).waitFor();
  assert.equal(await source().getAttribute('data-value'), 'account', 'source restores from the saved tab');
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  const otherStarts = (await calls('start')).filter(call => call.id === 'claude-b').length;
  await switchTo('claude-a', 'router');
  await switchTo('claude-a', 'account');
  await source().click();
  await page.getByRole('listbox', { name: 'Источник', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/connection-sources.png' });
  await page.keyboard.press('Escape');
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-sonnet');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.equal((await calls('thread/resume')).filter(call => call.id === 'claude-a').every(call => call.params.threadId === 'claude:preserved-claude-a'), true);
  assert.equal((await calls('start')).filter(call => call.id === 'claude-b').length, otherStarts, 'another tab does not reconnect');
  await activate('claude-b');
  assert.equal(await source().getAttribute('data-value'), 'router');
  assert.equal(await draft().inputValue(), 'Независимый черновик роутера');
  await activate('codex-c');
  assert.equal(await source().getAttribute('data-value'), 'inherited');
  await switchTo('codex-c', 'account');
  assert.equal(await draft().inputValue(), 'Черновик Codex');
  assert.equal((await calls('thread/resume')).filter(call => call.id === 'codex-c').every(call => call.params.threadId === 'codex:preserved-codex-c'), true);
  await page.waitForFunction(() => window.__sources.saves.at(-1)?.tabs.some(tab => tab.sessionId === 'codex-c' && tab.settings?.connectionSource === 'account'));
  await activate('claude-a');
  await page.evaluate(() => {
    const state = window.__sources.sessions['claude-a'];
    state.emit('turn/started', { threadId: state.thread.id, turn: { id: 'fixture-busy', status: 'inProgress', items: [] } });
  });
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) [aria-label="Источник"]')?.disabled);
  assert.equal(await source().isDisabled(), true, 'source cannot change during a running turn');
  await page.evaluate(() => {
    const state = window.__sources.sessions['claude-a'];
    state.emit('turn/completed', { threadId: state.thread.id, turn: { id: 'fixture-busy', status: 'completed', items: [] } });
  });
  await ready();
  await page.evaluate(() => { window.__sources.failSource = true; });
  const startsBeforeFailure = (await calls('start')).length;
  await choose('router');
  await view().getByRole('alert').filter({ hasText: 'Подключите роутер перед сменой источника.' }).waitFor();
  assert.equal(await source().getAttribute('data-value'), 'account', 'failed preparation keeps the current source');
  assert.equal((await calls('start')).length, startsBeforeFailure);
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  await page.evaluate(() => { window.__sources.failSource = false; });

  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  const panel = () => view().getByRole('region', { name: 'Роутер Claude', exact: true });
  await panel().getByRole('status').filter({ hasText: 'Подключение сохранено' }).waitFor();
  await panel().getByRole('button', { name: 'Подключить через портал', exact: true }).click();
  await panel().getByText('Завершите вход и подключение Claude в окне портала.', { exact: true }).waitFor();
  assert.equal(await panel().getByRole('button', { name: 'Подключить через портал', exact: true }).isDisabled(), true);
  await panel().getByRole('button', { name: 'Отменить подключение', exact: true }).click();
  await panel().getByText('Завершите вход и подключение Claude в окне портала.', { exact: true }).waitFor({ state: 'detached' });
  assert.equal((await calls('applyRouterConnection')).length, 0, 'cancelled browser flow cannot save');
  await page.evaluate(() => { window.__sources.portalError = 'Ссылка подключения истекла. Подключитесь заново.'; });
  await panel().getByRole('button', { name: 'Подключить через портал', exact: true }).click();
  await panel().getByRole('alert').getByText('Ссылка подключения истекла. Подключитесь заново.', { exact: true }).waitFor();
  await page.evaluate(() => { window.__sources.portalError = ''; });
  await panel().getByRole('button', { name: 'Подключить через портал', exact: true }).click();
  await page.evaluate(() => window.__sources.finishPortal());
  await panel().getByRole('heading', { name: 'Подключение готово к сохранению', exact: true }).waitFor();
  assert.equal((await calls('applyRouterConnection')).length, 0, 'successful browser approval still requires explicit Apply');
  await panel().getByRole('button', { name: 'Отменить подключение', exact: true }).click();
  await panel().getByRole('heading', { name: 'Подключение готово к сохранению', exact: true }).waitFor({ state: 'detached' });
  await panel().getByRole('button', { name: 'Выбрать установщик с портала', exact: true }).click();
  await panel().getByRole('heading', { name: 'Подключение готово к сохранению', exact: true }).waitFor();
  assert.equal((await calls('applyRouterConnection')).length, 0, 'preview alone cannot save');
  await page.screenshot({ path: 'artifacts/connection-portal-preview.png' });
  await panel().getByRole('button', { name: 'Сохранить и использовать', exact: true }).click();
  await panel().getByText('Подключение сохранено. Источник и модель для следующего сообщения показаны под полем ввода.', { exact: true }).waitFor();
  assert.equal((await calls('applyRouterConnection')).length, 1);
  await view().getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await ready();
  assert.equal(await source().getAttribute('data-value'), 'router');
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  await view().locator('.user-message').getByText('Вопрос Личная беседа', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__sources.saves.at(-1)?.tabs.some(tab => tab.sessionId === 'claude-a' && tab.settings?.connectionSource === 'router'));

  // A source may have a different model catalogue. The old choice remains visible until the user explicitly chooses a supported model.
  await switchTo('claude-a', 'account');
  await page.evaluate(() => { window.__sources.incompatibleCatalogue = true; });
  await switchTo('claude-a', 'router');
  const chooseModel = view().getByRole('button', { name: 'Выбрать модель', exact: true });
  await chooseModel.waitFor();
  await view().getByRole('status').filter({ hasText: 'Модель «fixture-sonnet» отсутствует в списке этого источника.' }).waitFor();
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-sonnet', 'switching source never chooses a different model implicitly');
  assert.equal(await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).isDisabled(), true, 'the old unsupported model cannot be sent');
  assert.equal((await calls('setSettings')).some(call => call.patch.model === 'fixture-router-sonnet'), false);
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  await page.screenshot({ path: 'artifacts/connection-model-unavailable.png' });
  await chooseModel.click();
  await page.getByRole('listbox', { name: 'Модель', exact: true }).locator('[data-value="fixture-router-sonnet"]').click();
  await chooseModel.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) [aria-label="Отправить сообщение"]')?.disabled === false);
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-router-sonnet');
  assert.equal(await source().getAttribute('data-value'), 'router');
  assert.equal(await draft().inputValue(), 'Черновик личного аккаунта');
  await view().locator('.user-message').getByText('Вопрос Личная беседа', { exact: true }).waitFor();
  assert.equal((await calls('thread/resume')).filter(call => call.id === 'claude-a').every(call => call.params.threadId === 'claude:preserved-claude-a'), true);
  assert.equal((await calls('turn/start')).length, 0, 'changing a source or saving a portal connection never sends a model prompt');
  assert.deepEqual(errors, []);
  console.log('PASS: restored per-tab sources; account/router switching resumes the same thread and preserves draft/model/effort; busy and failed switches are safe; portal cancel/error/preview/apply work; incompatible models require explicit selection before Send. Fixture bridges only, no model or network account calls.');
} catch (cause) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/connection-sources-failure.png' });
  throw cause;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
