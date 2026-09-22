import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(path); response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners = new Set();
    const state = { requests: [], responses: [], savedImages: [], starts: [], settings: {}, turns: 0, created: false, cwd: 'C:/Fixtures/Original', chosenDirectory: 'C:/Fixtures/Review Project' };
    const models = [
      { id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'high', description: 'High' }], inputModalities: ['text', 'image'] },
      { id: 'gpt-5.6', model: 'gpt-5.6', displayName: 'GPT-5.6', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'high', description: 'High' }], inputModalities: ['text', 'image'] },
    ];
    const history = { id: 'fixture-history', name: 'Saved fixture conversation', preview: 'Saved fixture conversation', cwd: state.chosenDirectory, updatedAt: 1789644000 };
    const emit = (type, data) => { for (const listener of listeners) listener({ type, data }); };
    window.__scenario = { state, emit };
    window.codex = {
      async start(options) {
        state.starts.push(options || {}); state.cwd = options?.cwd || state.cwd;
        return { initialize: {}, models, cwd: state.cwd, executable: 'C:/Codex/codex.exe', account: { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' } }, config: { config: { model: 'gpt-6', model_reasoning_effort: 'high', approval_policy: 'on-request', sandbox_mode: 'workspace-write' } } };
      },
      async request(method, params = {}) {
        state.requests.push({ method, params });
        if (method === 'thread/list') return { data: [history, ...(state.created ? [{ id: 'fixture-thread', name: 'Current fixture conversation', cwd: state.cwd }] : [])], nextCursor: null };
        if (method === 'thread/start') { state.created = true; return { thread: { id: 'fixture-thread', cwd: state.cwd, turns: [] }, model: params.model || 'gpt-6' }; }
        if (method === 'turn/start') { state.turns += 1; return { turn: { id: `fixture-turn-${state.turns}`, status: 'inProgress', items: [] } }; }
        if (method === 'turn/interrupt') {
          emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [], error: null } } });
          return {};
        }
        if (method === 'thread/resume') return { model: 'gpt-6', reasoningEffort: 'high', thread: { ...history, historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: 'Previously saved fixture question' }] }, { id: 'saved-answer', type: 'agentMessage', text: 'Restored fixture answer' }] }] } };
        if (method === 'thread/read') return { thread: { id: 'fixture-thread', turns: [{ id: `fixture-turn-${state.turns}`, status: 'inProgress' }] } };
        throw new Error(`Unexpected mock request: ${method}`);
      },
      async respond(id, result) { state.responses.push({ id, result }); },
      async chooseDirectory() { return state.chosenDirectory; },
      async saveImages(images) { state.savedImages.push(...images); return images.map((image, i) => ({ ...image, path: `C:/Fixtures/images/upload-${i}.png` })); },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async getSettings() { return state.settings; },
      async setSettings(settings) { Object.assign(state.settings, settings); },
      // Opening settings reads MCP configuration. Keep the legacy scenario
      // bridge complete without touching any real configuration or server.
      async getMcpConfig() { return { configPath: 'C:/Fixtures/.codex/config.toml', servers: [] }; },
      async checkMcp() { return { servers: [] }; },
      async reloadMcp() { return { status: 'applied', message: 'Fixture: нет подключений MCP.' }; },
      async previewMcpImport() { throw new Error('MCP import is outside this fixture scenario'); },
      async saveMcpImport() { throw new Error('MCP writes are outside this fixture scenario'); },
      async openPath() {},
      async chooseExecutable() { return null; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const waitState = async predicate => page.waitForFunction(predicate);
  const notify = async (method, params) => page.evaluate(({ method, params }) => window.__scenario.emit('notification', { method, params }), { method, params });
  const requestApproval = async (id, method, params) => page.evaluate(({ id, method, params }) => window.__scenario.emit('serverRequest', { id, method, params }), { id, method, params });
  const clickNamed = async (name) => page.getByRole('button', { name }).first().click();
  const selectValue = async (trigger, value) => { await trigger.click(); await page.getByRole('listbox', { name: await trigger.getAttribute('aria-label'), exact: true }).locator(`[role="option"][data-value="${value}"]`).click(); };
  await page.locator('.composer textarea').waitFor({ state: 'visible' });
  await waitState(() => window.__scenario.state.requests.some(request => request.method === 'thread/list'));

  // Settings and directory selection must reach the bridge unchanged.
  const modelSelect = page.getByRole('combobox', { name: 'Модель', exact: true });
  const effortSelect = page.getByRole('combobox', { name: 'Глубина размышлений' });
  const accessSelect = page.getByRole('combobox', { name: 'Режим доступа' });
  assert.equal(await modelSelect.getAttribute('data-value'), 'gpt-6');
  assert.equal(await effortSelect.getAttribute('data-value'), 'high');
  await page.locator('.project-card').click();
  await waitState(() => window.__scenario.state.cwd === window.__scenario.state.chosenDirectory && window.__scenario.state.requests.filter(request => request.method === 'thread/list').length > 1);
  await selectValue(modelSelect, 'gpt-5.6');
  await selectValue(effortSelect, 'medium');
  await accessSelect.click(); await page.getByRole('option', { name: /^Одобрять за меня/ }).click();
  await waitState(() => window.__scenario.state.settings.access === 'auto');

  // Reconnecting restores the saved access, model, and effort without starting a turn.
  await clickNamed(/^Настройки$/);
  await page.getByRole('tab', { name: 'Подключение', exact: true }).click();
  await clickNamed(/^Переподключить$/);
  await waitState(() => window.__scenario.state.starts.length === 3 && window.__scenario.state.requests.filter(request => request.method === 'thread/list').length === 3);
  await clickNamed(/^Готово$/);
  assert.equal(await accessSelect.getAttribute('data-value'), 'auto');
  assert.equal(await modelSelect.getAttribute('data-value'), 'gpt-5.6');
  assert.equal(await effortSelect.getAttribute('data-value'), 'medium');

  // Clipboard paste creates a visible attachment and sends a localImage input.
  await page.locator('.composer textarea').fill('Review this fixture image');
  await page.locator('.composer textarea').evaluate((element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], 'fixture.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, png);
  await page.locator('img').first().waitFor({ state: 'visible' });
  await clickNamed(/отправить/i);
  await waitState(() => window.__scenario.state.requests.some(request => request.method === 'turn/start'));
  let state = await page.evaluate(() => window.__scenario.state);
  const threadStart = state.requests.find(request => request.method === 'thread/start').params;
  const turnStart = state.requests.find(request => request.method === 'turn/start').params;
  assert.equal(threadStart.cwd, 'C:/Fixtures/Review Project');
  assert.equal(threadStart.sandbox, 'workspace-write');
  assert.equal(threadStart.approvalPolicy, 'on-request');
  assert.equal(threadStart.approvalsReviewer, 'auto_review');
  assert.equal(turnStart.model, 'gpt-5.6');
  assert.equal(turnStart.effort, 'medium');
  assert.deepEqual(turnStart.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['C:/Fixtures/Review Project'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(turnStart.approvalPolicy, 'on-request');
  assert.equal(turnStart.approvalsReviewer, 'auto_review');
  assert.equal(state.settings.access, 'auto');
  assert.equal(turnStart.input[0].text, 'Review this fixture image');
  assert.deepEqual(turnStart.input[1], { type: 'localImage', path: 'C:/Fixtures/images/upload-0.png' });
  assert.equal(state.savedImages.length, 1);
  assert.match(state.savedImages[0].dataUrl, /^data:image\/png;base64,/);

  const context = { threadId: 'fixture-thread', turnId: 'fixture-turn-1' };
  await notify('turn/started', { threadId: context.threadId, turn: { id: context.turnId, status: 'inProgress', items: [] } });
  await notify('item/completed', { ...context, item: { id: 'user-1', clientId: turnStart.clientUserMessageId, type: 'userMessage', content: turnStart.input } });
  await page.locator('.user-message .message-images img').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.user-message').count(), 1);
  await notify('item/started', { ...context, item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] } });
  await page.waitForFunction(() => document.querySelector('.working-indicator'));
  assert.equal(await page.locator('.work-reasoning').count(), 0, 'Empty reasoning must not create a placeholder card');
  await notify('item/reasoning/summaryTextDelta', { ...context, itemId: 'reason-1', summaryIndex: 0, delta: '  \n\t' });
  await notify('item/reasoning/textDelta', { ...context, itemId: 'reason-1', contentIndex: 0, delta: '\n  ' });
  assert.equal(await page.locator('.work-reasoning').count(), 0, 'Whitespace reasoning must remain hidden');
  await notify('item/reasoning/summaryTextDelta', { ...context, itemId: 'reason-1', summaryIndex: 0, delta: 'Fixture reasoning summary: inspect the image.' });
  await page.getByText('Fixture reasoning summary: inspect the image.', { exact: true }).waitFor({ state: 'visible' });
  await notify('item/completed', { ...context, item: { id: 'reason-fallback', type: 'reasoning', summary: [''], content: ['Fixture explanation fallback: inspect the file.'] } });
  await page.getByText('Fixture explanation fallback: inspect the file.', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.work-reasoning').count(), 2);
  assert.equal(await page.getByText('Codex обдумывает задачу…', { exact: true }).count(), 0);
  await notify('item/agentMessage/delta', { ...context, itemId: 'answer-1', delta: 'Streaming fixture ' });
  await notify('item/agentMessage/delta', { ...context, itemId: 'answer-1', delta: 'answer.' });
  await page.getByText('Streaming fixture answer.', { exact: true }).waitFor({ state: 'visible' });
  await notify('item/completed', { ...context, item: { id: 'answer-1', type: 'agentMessage', text: 'Streaming fixture answer.' } });

  await page.getByRole('button', { name: 'Действия', exact: true }).click();
  const readCommand = 'Get-Content fixture.ts';
  const commandActions = [{ type: 'read', command: readCommand, name: 'fixture.ts', path: 'C:/Fixtures/Review Project/fixture.ts' }];
  await notify('item/started', { ...context, item: { id: 'command-1', type: 'commandExecution', command: readCommand, commandActions, cwd: 'C:/Fixtures/Review Project', status: 'inProgress', aggregatedOutput: '' } });
  await page.locator('.activity-item summary').getByText('Чтение: fixture.ts', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('.working-indicator').getByText('Чтение: fixture.ts', { exact: false }).waitFor({ state: 'visible' });
  await page.locator('.activity-body').getByText(readCommand, { exact: true }).waitFor({ state: 'visible' });
  await notify('item/commandExecution/outputDelta', { ...context, itemId: 'command-1', delta: 'fixture-command-output-v1' });
  await page.locator('.activity-body').getByText('fixture-command-output-v1', { exact: true }).waitFor({ state: 'visible' });

  // Both approval decisions must preserve the protocol decision and request ID.
  await requestApproval('approve-1', 'item/commandExecution/requestApproval', { ...context, itemId: 'command-1', command: readCommand, reason: 'Fixture approval request' });
  await page.getByRole('button', { name: 'Разрешить один раз' }).click();
  await waitState(() => window.__scenario.state.responses.length === 1);
  await requestApproval('decline-1', 'item/fileChange/requestApproval', { ...context, itemId: 'file-1', reason: 'Fixture file permission request' });
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await waitState(() => window.__scenario.state.responses.length === 2);
  state = await page.evaluate(() => window.__scenario.state);
  assert.deepEqual(state.responses, [{ id: 'approve-1', result: { decision: 'accept' } }, { id: 'decline-1', result: { decision: 'decline' } }]);

  // MCP form elicitation: typed fields are validated and sent as structured content; decline sends none.
  const schema = { type: 'object', required: ['project', 'env'], properties: {
    project: { type: 'string', title: 'Проект', description: 'Имя проекта в трекере', minLength: 2 },
    env: { type: 'string', title: 'Окружение', oneOf: [{ const: 'stage', title: 'Стенд' }, { const: 'prod', title: 'Продакшен' }] },
    replicas: { type: 'integer', title: 'Реплики', minimum: 1, maximum: 5, default: 2 },
    notify: { type: 'boolean', title: 'Уведомить команду', default: true },
    tags: { type: 'array', title: 'Метки', items: { type: 'string', enum: ['api', 'ui', 'db'] } },
  } };
  await requestApproval('elicit-1', 'mcpServer/elicitation/request', { threadId: context.threadId, turnId: context.turnId, serverName: 'deploy-mcp', mode: 'form', _meta: null, message: 'Параметры выкладки', requestedSchema: schema });
  const form = page.getByRole('form', { name: 'Форма подключения deploy-mcp', exact: true });
  await form.waitFor();
  await form.getByRole('button', { name: 'Отправить', exact: true }).click();
  await form.getByText('Обязательное поле.', { exact: true }).first().waitFor();
  assert.equal((await page.evaluate(() => window.__scenario.state.responses)).length, 2, 'Invalid form is not sent');
  await form.getByLabel('Проект', { exact: false }).fill('Desk');
  await form.getByRole('radio', { name: 'Продакшен', exact: true }).check();
  await form.getByRole('checkbox', { name: 'ui', exact: true }).check();
  await form.getByRole('checkbox', { name: 'db', exact: true }).check();
  await form.getByRole('button', { name: 'Отправить', exact: true }).click();
  await waitState(() => window.__scenario.state.responses.length === 3);
  state = await page.evaluate(() => window.__scenario.state);
  assert.deepEqual(state.responses[2], { id: 'elicit-1', result: { action: 'accept', content: { project: 'Desk', env: 'prod', replicas: 2, notify: true, tags: ['ui', 'db'] }, _meta: null } });
  await requestApproval('elicit-2', 'mcpServer/elicitation/request', { threadId: context.threadId, turnId: context.turnId, serverName: 'deploy-mcp', mode: 'url', _meta: null, message: 'Войдите в систему', url: 'https://example.invalid/login', elicitationId: 'e2' });
  await page.getByText('https://example.invalid/login', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await waitState(() => window.__scenario.state.responses.length === 4);
  state = await page.evaluate(() => window.__scenario.state);
  assert.deepEqual(state.responses[3], { id: 'elicit-2', result: { action: 'decline', content: null, _meta: null } });

  const diff = 'diff --git a/fixture.ts b/fixture.ts\n--- a/fixture.ts\n+++ b/fixture.ts\n@@ -1 +1 @@\n-const before = true;\n+const after = true;';
  await notify('item/completed', { ...context, item: { id: 'command-1', type: 'commandExecution', command: readCommand, commandActions, aggregatedOutput: 'fixture-command-output-v1', status: 'completed', exitCode: 0, durationMs: 50 } });
  await notify('item/completed', { ...context, item: { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/Fixtures/Review Project/fixture.ts', kind: { type: 'update', movePath: null }, diff }] } });
  await notify('turn/diff/updated', { ...context, diff });
  await clickNamed(/изменения/i);
  await page.locator('.change-file > summary').first().click();
  // ReviewDiff renders the sign and the code in separate spans; match the added row by its code text.
  await page.locator('.changes-panel .diff-unified-row.add', { hasText: 'const after = true;' }).first().waitFor({ state: 'visible' });
  await notify('turn/completed', { threadId: context.threadId, turn: { id: context.turnId, status: 'completed', items: [], error: null } });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/scenarios.png', fullPage: true });

  // Restored history is rendered, then interruption targets its actual active turn.
  await clickNamed(/Saved fixture conversation/);
  await page.getByText('Restored fixture answer', { exact: true }).waitFor({ state: 'visible' });
  state = await page.evaluate(() => window.__scenario.state);
  const resumed = state.requests.find(request => request.method === 'thread/resume').params;
  assert.equal(resumed.approvalsReviewer, 'auto_review');
  assert.equal(resumed.sandbox, 'workspace-write');
  assert.equal(await modelSelect.getAttribute('data-value'), 'gpt-6');
  await accessSelect.click(); await page.getByRole('option', { name: /^Спрашивать разрешение/ }).click();
  assert.equal(await modelSelect.getAttribute('data-value'), 'gpt-6', 'Changing access must not change the resumed model');
  await page.locator('.composer textarea').fill('Another fixture request');
  await clickNamed(/отправить/i);
  await waitState(() => window.__scenario.state.turns === 2);
  await clickNamed(/остановить/i);
  await waitState(() => window.__scenario.state.requests.some(request => request.method === 'turn/interrupt'));
  state = await page.evaluate(() => window.__scenario.state);
  const secondTurn = state.requests.filter(request => request.method === 'turn/start')[1].params;
  assert.equal(secondTurn.approvalsReviewer, 'user', 'Leaving auto must restore manual review');
  assert.equal(secondTurn.approvalPolicy, 'on-request');
  assert.deepEqual(secondTurn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['C:/Fixtures/Review Project'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(secondTurn.model, 'gpt-6');
  assert.equal(secondTurn.effort, 'high');
  const interruption = state.requests.find(request => request.method === 'turn/interrupt');
  assert.deepEqual(interruption.params, { threadId: 'fixture-history', turnId: 'fixture-turn-2' });
  await page.getByText(/Выполнение остановлено/).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('UI scenarios passed: directory, model/effort, auto access and persistence, manual access switch, clipboard image, hidden empty explanations, summary and fallback text, current read action, command output, approvals, diff, legacy history and interruption.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
