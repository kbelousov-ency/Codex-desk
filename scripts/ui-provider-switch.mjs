import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, mock bridge that behaves like the host: an empty dialogue changes agent in the same
// tab, a dialogue with messages keeps opening a separate one. No model requests are made.
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
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/SWITCH';
    const sessions = {}, calls = [];
    // Saved profiles of the host: each agent keeps its own model/effort, the folder is shared.
    const profiles = { codex: { model: 'fixture-astra', effort: 'ultra', access: 'workspace-write' }, claude: { model: 'fixture-sonnet', effort: 'high', access: 'workspace-write' } };
    const fixture = window.__switch = { sessions, calls, profiles, create: [], failNext: false };
    const models = {
      codex: [{ id: 'fixture-astra', model: 'fixture-astra', displayName: 'GPT-6-Astra', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra' }],
      claude: [{ id: 'fixture-sonnet', model: 'fixture-sonnet', displayName: 'Claude Sonnet', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }],
    };
    const make = (id, initial = 'codex') => {
      const state = sessions[id] = { id, provider: initial, listeners: new Set(), activeTurn: null, thread: null, fail: false, settings: { cwd, provider: initial, ...profiles[initial] } };
      const emit = state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      const threadId = () => `${state.provider === 'claude' ? 'claude:' : ''}thread-${id}`;
      state.complete = () => { const turnId = state.activeTurn; emit('turn/completed', { threadId: threadId(), turn: { id: turnId, status: 'completed', items: [], error: null } }); state.activeTurn = null; };
      state.bridge = {
        async start() {
          calls.push({ id, provider: state.provider, method: 'start' });
          if (state.fail) { state.fail = false; throw new Error('Claude CLI не найден'); }
          const claude = state.provider === 'claude';
          return { initialize: {}, cwd, provider: state.provider, executable: claude ? 'C:/CLI/claude.exe' : 'C:/CLI/codex.exe', account: null,
            capabilities: { compact: true, steer: true, terminal: true, mcp: !claude, archive: true, usage: claude },
            models: models[state.provider], config: { model: state.settings.model, model_reasoning_effort: state.settings.effort } };
        },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) {
          calls.push({ id, provider: state.provider, method: 'setSettings', patch: { ...patch } });
          if (patch.provider && patch.provider !== state.provider) {
            // The host refuses as soon as the dialogue owns a thread.
            if (state.thread) throw new Error('Смена агента открывает отдельный диалог.');
            state.provider = patch.provider;
            state.fail = fixture.failNext; fixture.failNext = false;
            // Exactly like settingsStore.snapshotProvider: the new agent's own values, the same folder.
            state.settings = { cwd, provider: patch.provider, ...profiles[patch.provider] };
            return;
          }
          Object.assign(state.settings, patch);
          // Saved patches belong to the profile in force now, never to the previous agent.
          for (const key of ['model', 'effort', 'access']) if (patch[key] !== undefined) profiles[state.provider][key] = patch[key];
        },
        async getClaudeAuthStatus() { return { loggedIn: true, loginInProgress: false, authMethod: 'claude.ai' }; },
        async request(method, params = {}) {
          calls.push({ id, provider: state.provider, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: state.provider === 'claude' ? [{ id: 'claude:history-1', provider: 'claude', cwd, name: 'История Claude' }] : [{ id: 'history-codex', provider: 'codex', cwd, name: 'История Codex' }], nextCursor: null };
          if (method === 'usage/read') return { available: true, subscription: 'max', updatedAt: new Date().toISOString(), windows: [{ key: 'five_hour', label: 'Сессия 5 часов', utilization: 42, resetsAt: new Date(Date.now() + 90 * 60000).toISOString() }] };
          if (method === 'agent/capabilities') return { commands: [], agents: [], mcpServers: [] };
          if (method === 'thread/start') { state.thread = threadId(); return { thread: { id: threadId(), provider: state.provider, cwd, name: 'Диалог', turns: [] }, model: state.settings.model }; }
          if (method === 'turn/start') {
            const turnId = state.activeTurn = `turn-${calls.filter(call => call.method === 'turn/start').length}`;
            const item = { id: `user-${turnId}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
            emit('turn/started', { threadId: threadId(), turn: { id: turnId, status: 'inProgress', items: [] } });
            emit('item/completed', { threadId: threadId(), turnId, item });
            return { turn: { id: turnId, status: 'inProgress' } };
          }
          if (method === 'turn/interrupt') { state.complete(); return {}; }
          throw new Error(`Unsupported fixture request: ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async saveImages(images) { return images.map(image => ({ ...image, path: `${cwd}/${image.name}` })); },
        async chooseDirectory() { return cwd; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async respond() {},
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
      return state;
    };
    make('initial');
    window.codex = {
      ...sessions.initial.bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [{ id: 'initial', cwd, provider: 'codex' }] }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession(options) {
        fixture.create.push(structuredClone(options));
        const id = `session-${fixture.create.length}`;
        make(id, options.provider || options.settings?.provider || 'codex');
        return { id, cwd, provider: options.provider };
      },
      async closeSession() {},
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().locator('.composer textarea');
  const tabs = () => page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).getByRole('tab');
  const selector = label => view().getByRole('combobox', { name: label, exact: true });
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return model && !model.disabled; });
  const choose = async (label, value) => { await selector(label).click(); await page.getByRole('listbox', { name: label, exact: true }).locator(`[data-value="${value}"]`).click(); };
  const calls = method => page.evaluate(method => window.__switch.calls.filter(call => call.method === method), method);
  const placeholder = () => draft().getAttribute('placeholder');

  await ready();
  assert.equal(await selector('Агент').getAttribute('data-value'), 'codex');
  await draft().fill('Черновик до смены агента');
  const codexPlaceholder = await placeholder();
  const historyReads = (await calls('thread/list')).length;

  // An empty dialogue changes agent in place: one tab, no new session, everything of the new agent.
  await choose('Агент', 'claude');
  await ready();
  assert.equal(await tabs().count(), 1, 'an empty dialogue does not open another tab');
  assert.equal(await page.evaluate(() => window.__switch.create.length), 0, 'no session is created for the change');
  assert.equal(await selector('Агент').getAttribute('data-value'), 'claude');
  assert.equal(await selector('Модель').getAttribute('data-value'), 'fixture-sonnet', 'the catalog and model are the new agent’s');
  assert.equal(await selector('Глубина размышлений').getAttribute('data-value'), 'high');
  assert.equal(await draft().inputValue(), 'Черновик до смены агента', 'an unsent draft is kept');
  assert.equal(await view().getByRole('textbox', { name: 'Сообщение Claude Code', exact: true }).count(), 1, 'the composer addresses the new agent');
  assert.notEqual(await placeholder(), codexPlaceholder, 'the hint is re-rolled for the dialogue of the new agent');
  assert.equal(await page.locator('.session-tab [data-agent]').first().getAttribute('data-agent'), 'Claude', 'the tab shows the mark of the new agent');
  assert.ok((await calls('thread/list')).length > historyReads, 'history is re-read for the new agent');
  assert.equal((await calls('thread/list')).at(-1).provider, 'claude');
  const providerPatches = (await calls('setSettings')).filter(call => call.patch.provider);
  assert.equal(providerPatches.length, 1);
  assert.deepEqual(providerPatches[0].patch, { provider: 'claude' }, 'nothing of the previous agent is carried over');
  assert.equal((await calls('turn/start')).length, 0, 'changing agent sends nothing to the model');
  // Claude capabilities: plan limits appear, the Codex-only MCP editor does not.
  await view().getByRole('button', { name: /^Лимит 5 ч: 42 %/ }).waitFor();
  assert.ok((await calls('usage/read')).length >= 1);
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await view().getByRole('tab', { name: 'Агент', exact: true }).click();
  await view().getByRole('dialog').getByText(/В пустом диалоге агент меняется на месте/).waitFor();
  await view().getByRole('tab', { name: 'MCP', exact: true }).click();
  await view().getByRole('dialog').getByText(/Подключения Claude Code настраиваются/).waitFor();
  await view().getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.screenshot({ path: 'artifacts/provider-switch-in-place.png' });

  // A model chosen after the change is saved for the new agent; the previous profile is untouched.
  await choose('Модель', 'fixture-sonnet');
  assert.deepEqual(await page.evaluate(() => window.__switch.profiles), { codex: { model: 'fixture-astra', effort: 'ultra', access: 'workspace-write' }, claude: { model: 'fixture-sonnet', effort: 'high', access: 'workspace-write' } });

  // A dialogue with messages belongs to its agent: the other one opens a separate tab.
  await draft().fill('Первое сообщение Claude');
  await draft().press('Enter');
  await view().locator('.user-message').getByText('Первое сообщение Claude', { exact: true }).waitFor();
  await page.evaluate(() => window.__switch.sessions.initial.complete());
  await ready();
  await choose('Агент', 'codex');
  await ready();
  assert.equal(await tabs().count(), 2, 'a dialogue with messages keeps opening a separate tab');
  assert.equal(await page.evaluate(() => window.__switch.create.at(-1).provider), 'codex');
  assert.equal(await selector('Модель').getAttribute('data-value'), 'fixture-astra');
  assert.equal(await page.evaluate(() => window.__switch.sessions.initial.provider), 'claude', 'the previous dialogue stays with its agent');

  // A new agent that cannot start keeps its own error in the tab, and the change back works in place.
  await page.evaluate(() => { window.__switch.failNext = true; });
  await choose('Агент', 'claude');
  await view().getByRole('alert').filter({ hasText: 'Claude CLI не найден' }).waitFor();
  assert.equal(await selector('Агент').getAttribute('data-value'), 'claude', 'a failed start never silently returns to the previous agent');
  assert.equal(await tabs().count(), 2);
  await page.screenshot({ path: 'artifacts/provider-switch-failed.png' });
  await choose('Агент', 'codex');
  await ready();
  assert.equal(await selector('Агент').getAttribute('data-value'), 'codex');
  assert.equal(await tabs().count(), 2, 'returning to the working agent also stays in the tab');
  assert.equal(await view().getByRole('alert').count(), 0);

  // A tab opened as Claude and changed to Codex in place must not keep the mark of the previous agent.
  await page.locator('.session-tab[data-session-id="initial"]').getByRole('tab').click();
  await ready();
  await page.getByRole('button', { name: 'Открыть новый диалог', exact: true }).click();
  await ready();
  const opened = await page.locator('.session-tab.active').getAttribute('data-session-id');
  assert.equal(await page.evaluate(() => window.__switch.create.at(-1).provider), 'claude');
  assert.equal(await page.locator('.session-tab.active [data-agent]').getAttribute('data-agent'), 'Claude');
  await choose('Агент', 'codex');
  await ready();
  assert.equal(await page.locator('.session-tab.active').getAttribute('data-session-id'), opened, 'the empty new tab changes agent in place');
  assert.equal(await page.locator('.session-tab.active [data-agent]').getAttribute('data-agent'), 'GPT', 'the tab mark follows the change back to Codex');
  assert.equal(await selector('Модель').getAttribute('data-value'), 'fixture-astra');

  assert.deepEqual(errors, []);
  console.log('PASS: an empty dialogue changes agent in the same tab (models, catalog, capabilities, limits, history, hint and composer follow the new agent, the draft is kept, nothing reaches the model); a dialogue with messages opens a separate tab; a failed start stays visible and the change back works in place. Mock bridge; no model calls.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/provider-switch-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
