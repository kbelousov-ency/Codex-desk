import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with two independent CLI fixtures. No model requests.
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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/AGENTS';
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const sessions = {}, calls = [];
    const fixture = window.__providers = { sessions, calls, image, create: [], failNext: false };
    const make = (id, provider) => {
      const claude = provider === 'claude';
      const settings = { cwd, provider, model: claude ? 'fixture-sonnet' : 'fixture-astra', effort: claude ? 'high' : 'ultra', access: 'workspace-write' };
      const state = sessions[id] = { id, provider, settings, listeners: new Set(), activeTurn: null, items: [] };
      const thread = () => ({ id: `${provider}:${id}`, provider, cwd, name: `Диалог ${provider}`, turns: [] });
      const emit = state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.complete = () => { const turnId = state.activeTurn; emit('item/completed', { threadId: thread().id, turnId, item: { id: `answer-${turnId}`, type: 'agentMessage', text: 'Ответ Claude' } }); emit('turn/completed', { threadId: thread().id, turn: { id: turnId, status: 'completed', items: [], error: null } }); state.activeTurn = null; };
      state.bridge = {
        async start() { if (state.fail) throw new Error('Claude CLI не найден'); return { initialize: {}, cwd, provider, capabilities: { compact: true, steer: true, terminal: true, mcp: !claude, archive: !claude, usage: claude }, models: [{ id: settings.model, model: settings.model, displayName: claude ? 'Claude Sonnet' : 'GPT-6-Astra', inputModalities: ['text', 'image'], supportedReasoningEfforts: (claude ? ['low', 'medium', 'high'] : ['high', 'ultra']).map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'high' }], executable: claude ? 'C:/CLI/claude.exe' : 'C:/CLI/codex.exe', account: null, config: { model: settings.model, model_reasoning_effort: settings.effort } }; },
        async getSettings() { return { ...settings }; },
        async setSettings(patch) { calls.push({ id, method: 'setSettings', patch: { ...patch } }); Object.assign(settings, patch); },
        async request(method, params = {}) {
          calls.push({ id, provider, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'agent/capabilities') return { commands: [{ name: 'compact', description: 'Compact', builtin: true }, { name: 'ency-extension', description: 'Build ENCY extensions', builtin: false }], agents: [{ name: 'Explore', description: 'Search' }], mcpServers: [{ name: 'plane', status: 'connected' }, { name: 'atlassian', status: 'failed', error: 'timeout' }] };
          if (method === 'usage/read') return fixture.usageUnavailable ? { available: false, windows: [], message: 'Лимиты плана не применяются к этому способу входа.' } : { available: true, subscription: 'max', updatedAt: new Date().toISOString(), windows: [{ key: 'five_hour', label: 'Сессия 5 часов', utilization: 42, resetsAt: new Date(Date.now() + 90 * 60000).toISOString() }, { key: 'seven_day', label: 'Неделя, все модели', utilization: 9, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() }] };
          if (method === 'thread/start') return { thread: thread(), model: settings.model };
          if (method === 'thread/resume') {
            // Native Claude history: turn timestamps and the transcript's token counters come with the resume response.
            const at = Math.floor((Date.now() - 20 * 60000) / 1000);
            const turns = [{ id: 'history-turn', status: 'completed', startedAt: at - 30, completedAt: at, items: [
              { id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'Сохранённый вопрос Claude' }] },
              { id: 'history-answer', type: 'agentMessage', text: 'Сохранённый ответ Claude', phase: 'final_answer' }] }];
            return { thread: { ...thread(), id: params.threadId, name: 'История Claude', historyMode: 'legacy', turns }, model: settings.model,
              tokenUsage: { last: { inputTokens: 4505, cachedInputTokens: 4500, cacheWriteInputTokens: 0, outputTokens: 7, totalTokens: 4512 }, total: { inputTokens: 9015, cachedInputTokens: 8500, cacheWriteInputTokens: 500, outputTokens: 27, totalTokens: 9042 } } };
          }
          if (method === 'turn/start') {
            const turnId = state.activeTurn = `turn-${calls.filter(call => call.method === 'turn/start').length}`;
            const item = { id: `user-${turnId}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
            emit('turn/started', { threadId: thread().id, turn: { id: turnId, status: 'inProgress', items: [] } });
            emit('item/started', { threadId: thread().id, turnId, item });
            emit('item/completed', { threadId: thread().id, turnId, item });
            return { turn: { id: turnId, status: 'inProgress' } };
          }
          if (method === 'turn/steer') {
            const item = { id: params.clientUserMessageId, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
            emit('item/completed', { threadId: thread().id, turnId: state.activeTurn, item });
            return { turnId: state.activeTurn, userMessageId: params.clientUserMessageId };
          }
          if (method === 'thread/compact/start') {
            const turnId = `compact-${calls.filter(call => call.method === 'thread/compact/start').length}`;
            emit('turn/started', { threadId: thread().id, turn: { id: turnId, status: 'inProgress', items: [] } });
            emit('item/completed', { threadId: thread().id, turnId, item: { id: `${turnId}:boundary`, type: 'contextCompaction' } });
            emit('turn/completed', { threadId: thread().id, turn: { id: turnId, status: 'completed', items: [], error: null } });
            return {};
          }
          if (method === 'turn/interrupt') { emit('turn/completed', { threadId: thread().id, turn: { id: state.activeTurn, status: 'interrupted' } }); state.activeTurn = null; return {}; }
          throw new Error(`Unsupported fixture request: ${method}`);
        },
        async respond(requestId, result) { calls.push({ id, method: 'respond', requestId, result }); },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async chooseComposerFiles() { return { images: [{ name: 'example.png', dataUrl: image }], paths: ['C:/Fixtures/brief.pdf'] }; },
        async saveImages(images) { return images.map(item => ({ ...item, path: `${cwd}/${item.name}` })); },
        async readAttachment() { return image; },
        async openTerminal(options) { calls.push({ id, method: 'openTerminal', options }); return { threadId: options.threadId }; },
        async getMcpConfig() { calls.push({ id, method: 'getMcpConfig' }); return { configPath: 'fixture', servers: [] }; },
        async chooseDirectory() { return cwd; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
      return state;
    };
    make('initial-codex', 'codex');
    window.codex = {
      ...sessions['initial-codex'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [{ id: 'initial-codex', cwd, provider: 'codex' }] }; },
      async listProjectThreads() { return { data: [{ id: 'claude:history-1', provider: 'claude', cwd, name: 'История Claude', historyMode: 'legacy' }], nextCursor: null }; },
      async createSession(options) {
        fixture.create.push(structuredClone(options));
        const provider = options.provider || options.settings?.provider || 'codex';
        const id = `session-${fixture.create.length}`;
        make(id, provider).fail = fixture.failNext; fixture.failNext = false;
        return { id, cwd, provider };
      },
      async closeSession() {},
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().locator('.composer textarea');
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return model && !model.disabled; });
  const choose = async (label, value) => { await view().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('listbox', { name: label, exact: true }).locator(`[data-value="${value}"]`).click(); };
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const calls = method => page.evaluate(method => window.__providers.calls.filter(call => call.method === method), method);
  await ready();
  await draft().fill('Сохранить черновик Codex');
  await choose('Агент', 'claude');
  await ready();
  assert.equal(await view().getByRole('combobox', { name: 'Агент', exact: true }).getAttribute('data-value'), 'claude');
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-sonnet');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.equal(await draft().inputValue(), '');
  assert.equal(await page.getByRole('tab').count(), 2, 'Switching agent opens another tab');
  assert.equal((await calls('turn/start')).length, 0, 'Switching never sends an implicit transfer prompt');
  const created = await page.evaluate(() => window.__providers.create[0]);
  assert.equal(created.provider, 'claude');
  assert.ok(!created.settings || created.settings.model !== 'fixture-astra', 'Codex model must not be passed into a Claude session');
  await activate('initial-codex');
  assert.equal(await draft().inputValue(), 'Сохранить черновик Codex');
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-astra');
  await activate('session-1');
  await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).click();
  assert.equal(await view().getByRole('option', { name: /Одобрять за меня/ }).count(), 0);
  await view().getByRole('option', { name: /Разрешать правки/ }).click();
  assert.equal(await page.evaluate(() => window.__providers.sessions['session-1'].settings.access), 'auto');
  await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).click();
  await view().getByRole('option').filter({ hasText: 'Полный доступ' }).click();
  await view().getByRole('alertdialog').getByText(/Claude Code сможет выполнять/).waitFor();
  await view().getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__providers.sessions['session-1'].settings.access), 'auto', 'Declining full access preserves prior permissions');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await view().getByRole('dialog').getByText(/Подключения Claude Code настраиваются/).waitFor();
  const effective = view().getByRole('dialog').getByRole('region', { name: 'Действующие настройки', exact: true });
  const effectiveText = await effective.innerText();
  assert.match(effectiveText, /Claude Code/);
  assert.match(effectiveText, /fixture-sonnet\s*\n?\s*сохранённые настройки агента/, 'model and its source are listed');
  assert.match(effectiveText, /Разрешать правки\s*\n?\s*выбрано в этой вкладке/, 'access changed in this tab is attributed to the tab');
  assert.equal(await effective.locator('[data-capability="steer"]').getAttribute('data-available'), 'true');
  assert.equal(await effective.locator('[data-capability="archive"]').getAttribute('data-available'), 'false');
  await effective.locator('[data-effective="skills"] summary').waitFor();
  assert.match(await effective.locator('[data-effective="skills"]').innerText(), /1 пользовательских, 1 встроенных, субагентов: 1/);
  await effective.locator('[data-effective="skills"] summary').click();
  assert.match(await effective.locator('[data-effective="skills"]').innerText(), /\/ency-extension/);
  assert.equal(await effective.locator('[data-effective="mcp"] [data-mcp-status="connected"]').innerText(), 'plane подключён');
  assert.match(await effective.locator('[data-effective="mcp"] [data-mcp-status="failed"]').innerText(), /atlassian ошибка\s*timeout/);
  assert.equal((await calls('agent/capabilities')).every(call => call.provider === 'claude'), true, 'details are read only for the Claude tab');
  assert.equal((await calls('getMcpConfig')).length, 0, 'Claude settings never access the Codex MCP editor');
  await view().getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await draft().fill('Изучи материалы');
  await view().getByRole('button', { name: 'Добавить файлы', exact: true }).click();
  await view().getByRole('button', { name: 'Удалить example.png', exact: true }).waitFor();
  assert.match(await draft().inputValue(), /brief\.pdf/);
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  const sent = (await calls('turn/start'))[0];
  assert.equal(sent.provider, 'claude');
  assert.equal(sent.params.model, 'fixture-sonnet');
  assert.equal(sent.params.effort, 'high');
  assert.deepEqual(sent.params.input.map(item => item.type), ['text', 'localImage']);
  await draft().fill('Следующий вопрос');
  const steer = view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true });
  assert.equal(await steer.isDisabled(), false, 'Claude accepts mid-turn steering');
  await steer.click();
  await page.waitForFunction(() => window.__providers.calls.some(call => call.method === 'turn/steer'));
  const steered = (await calls('turn/steer'))[0];
  assert.equal(steered.provider, 'claude');
  assert.equal(steered.params.input[0].text, 'Следующий вопрос');
  assert.equal(steered.params.expectedTurnId, 'turn-1');
  await view().locator('.user-message').filter({ hasText: 'Следующий вопрос' }).first().waitFor();
  assert.equal(await draft().inputValue(), '', 'accepted steer clears the draft');
  await draft().fill('Следующий вопрос');
  await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click();
  await view().getByRole('region', { name: 'Очередь сообщений', exact: true }).getByText('Следующий вопрос', { exact: true }).waitFor();
  assert.equal((await calls('turn/start')).length, 1, 'Queue waits while Claude is busy');
  await page.evaluate(() => window.__providers.sessions['session-1'].complete());
  await page.waitForFunction(() => window.__providers.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal((await calls('turn/start'))[1].params.input[0].text, 'Следующий вопрос');
  await view().locator('.assistant-message .message-label strong').filter({ hasText: 'Claude Code' }).waitFor();
  await page.evaluate(() => window.__providers.sessions['session-1'].complete());
  await ready();
  assert.equal(await view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true }).isEnabled(), true, 'Terminal support is independent of compact support');
  await draft().fill('/compact');
  await draft().press('Enter');
  await view().getByText('Контекст сжат. Можно продолжить диалог.').waitFor();
  assert.equal((await calls('thread/compact/start')).length, 1, 'Claude compact runs through the documented slash command turn');
  assert.equal((await calls('thread/compact/start'))[0].provider, 'claude');
  await ready();
  await view().getByRole('button', { name: 'Команды Claude Code', exact: true }).click();
  assert.equal(await view().locator('[data-command="compact"]').count(), 1, 'compact is offered in the Claude command menu');
  await draft().press('Escape');
  // Plan limits: 5-hour window inline, every window in the popover, /usage as the CLI fallback.
  const usageTrigger = view().getByRole('button', { name: /^Лимит 5 ч: 42 %/ });
  await usageTrigger.waitFor();
  assert.match(await usageTrigger.getAttribute('title'), /5-часовой сессии: использовано 42 %.*сброс через 1 ч 30 мин/);
  await usageTrigger.click();
  const usageDialog = view().getByRole('dialog', { name: 'Лимиты плана Claude', exact: true });
  await usageDialog.waitFor();
  assert.match(await usageDialog.innerText(), /max/);
  assert.equal(await usageDialog.locator('[data-usage-window]').count(), 2);
  assert.equal(await usageDialog.locator('[data-usage-window="seven_day"] strong').innerText(), '9 %');
  await page.keyboard.press('Escape');
  await usageDialog.waitFor({ state: 'detached' });
  assert.ok((await calls('usage/read')).length >= 1, 'limits are read through the bridge, never guessed');
  assert.equal((await calls('usage/read')).every(call => call.provider === 'claude'), true);
  await page.evaluate(() => { window.__providers.usageUnavailable = true; });
  await page.evaluate(() => window.__providers.sessions['session-1'].emit('turn/completed', { threadId: 'claude:session-1', turn: { id: 'refresh-usage', status: 'completed', items: [], error: null } }));
  const plainLimit = view().getByRole('button', { name: 'Лимит: показать использование командой /usage', exact: true });
  await plainLimit.waitFor();
  const turnsBeforeUsage = (await calls('turn/start')).length;
  await plainLimit.click();
  await page.waitForFunction(count => window.__providers.calls.filter(call => call.method === 'turn/start').length === count + 1, turnsBeforeUsage);
  assert.equal((await calls('turn/start')).at(-1).params.input[0].text, '/usage', 'without plan data the label runs the CLI command');
  await page.evaluate(() => window.__providers.sessions['session-1'].complete());
  await ready();
  await choose('Агент', 'codex');
  await ready();
  assert.equal(await page.getByRole('tab').count(), 3);
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-astra');
  assert.equal((await calls('turn/steer')).length, 1, 'the only steer belongs to the Claude tab');
  assert.deepEqual(errors, []);
  await activate('session-1');
  await page.screenshot({ path: 'artifacts/provider-claude.png' });
  // Opening a stored Claude dialog shows its token counters and the cache estimate from the last answer time.
  const turnsBeforeResume = (await calls('turn/start')).length;
  await page.getByRole('button', { name: 'История Claude', exact: true }).click();
  await view().getByText('Сохранённый вопрос Claude', { exact: true }).waitFor();
  await ready();
  const resumed = await calls('thread/resume');
  assert.equal(resumed.length, 1); assert.equal(resumed[0].provider, 'claude'); assert.equal(resumed[0].params.threadId, 'claude:history-1');
  await view().getByRole('button', { name: 'Подробности токенов', exact: true }).filter({ hasText: /4.512 токенов/ }).waitFor();
  assert.match(await view().locator('.cache-control .cache-countdown').innerText(), /Кэш ≈ (?:39:5\d|40:00)/, 'the estimate counts from the stored answer time, not from opening');
  assert.equal((await calls('turn/start')).length, turnsBeforeResume, 'opening history sends nothing to the model');
  await page.screenshot({ path: 'artifacts/provider-claude-history.png' });
  await activate('session-2');
  await page.evaluate(() => { window.__providers.failNext = true; });
  await choose('Агент', 'claude');
  await view().getByRole('alert').filter({ hasText: 'Claude CLI не найден' }).waitFor();
  assert.equal(await view().getByRole('combobox', { name: 'Агент', exact: true }).getAttribute('data-value'), 'claude', 'A missing Claude CLI never falls back to Codex');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await view().getByRole('dialog').getByText(/Подключения Claude Code настраиваются/).waitFor();
  assert.equal((await calls('getMcpConfig')).length, 0, 'Failed Claude startup also cannot expose the Codex MCP editor');
  await view().getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await choose('Агент', 'codex');
  await ready();
  assert.equal(await page.evaluate(() => window.__providers.create.at(-1).cwd), 'C:/Fixtures/AGENTS', 'Changing provider after a failed connection keeps the project folder');
  assert.deepEqual(errors, []);
  console.log('PASS: Codex/Claude selection opens isolated tabs; drafts/models/effort/access survive; capability gates protect compact/steer/MCP; files/images, speaker labels and queued messages work. Mock CLI bridges; no model calls.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/provider-ui-failure.png' });
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
