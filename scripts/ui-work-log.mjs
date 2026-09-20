import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Real production renderer, controlled clock and isolated fixture bridges.
// No Codex process, user profile, filesystem operation or real model request.
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
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const epoch = new Date('2026-09-17T12:00:00Z');
  await page.clock.install({ time: epoch });
  await page.clock.pauseAt(new Date(epoch.getTime() + 1000));
  await page.addInitScript(() => {
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const sessions = {};
    let serial = 0;
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const history = cwd => ({ id: 'saved-history', name: `История ${cwd.split('/').at(-1)}`, cwd, historyMode: 'legacy' });
    const make = cwd => {
      const id = `session-${++serial}`;
      const state = { id, cwd, turn: 0, turns: {}, requests: [], listeners: new Set(), closed: false, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' } };
      state.emit = (method, params) => { if (!state.closed) for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [history(cwd)], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: 'shared-thread', cwd, turns: [] }, model: params.model };
          if (method === 'turn/start') {
            const turn = { id: `turn-${++state.turn}`, startedAt: Math.floor(Date.now() / 1000), status: 'inProgress', items: [] };
            state.turns[turn.id] = turn;
            state.emit('turn/started', { threadId: 'shared-thread', turn });
            state.emit('item/completed', { threadId: 'shared-thread', turnId: turn.id, item: { id: `user-${state.turn}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } });
            return { turn };
          }
          if (method === 'turn/interrupt') {
            state.emit('turn/completed', { threadId: params.threadId, turn: { ...state.turns[params.turnId], status: 'interrupted', completedAt: Math.floor(Date.now() / 1000), error: null } });
            return {};
          }
          if (method === 'thread/resume') return {
            thread: { ...history(cwd), status: { type: 'idle' }, turns: [
              { id: 'known-history', status: 'completed', startedAt: 1789646100, completedAt: 1789646162, durationMs: 62000, items: [
                { id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'Сохранённый вопрос', text_elements: [] }] },
                { id: 'history-reasoning', type: 'reasoning', summary: ['Пояснение из истории'], content: [] },
                { id: 'history-final', type: 'agentMessage', phase: 'final_answer', text: 'Ответ из истории со временем' },
              ] },
              { id: 'unknown-history', status: 'completed', items: [
                { id: 'legacy-user', type: 'userMessage', content: [{ type: 'text', text: 'Старый вопрос', text_elements: [] }] },
                { id: 'legacy-reasoning', type: 'reasoning', summary: ['Старое пояснение без метаданных времени'], content: [] },
                { id: 'legacy-final', type: 'agentMessage', phase: null, text: 'Старый ответ без phase' },
              ] },
            ] }, model: 'fixture-alpha', reasoningEffort: 'high',
          };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async listFiles(path = '') {
          const entries = path === 'src'
            ? [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }, { name: 'main.ts', path: 'src/main.ts', type: 'file' }]
            : [{ name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file' }];
          return { path, entries, nextCursor: null };
        },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    make(projects[0]);
    window.__work = { projects, sessions };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads(cwd) { return { data: [history(cwd)], nextCursor: null }; },
      async createSession({ cwd = projects[1] } = {}) { return make(cwd); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const chat = () => view().locator('.chat-scroll');
  const log = turn => chat().locator(`.work-log[data-turn-id="${turn}"]`);
  const summary = turn => log(turn).locator(':scope > summary');
  const flush = async () => { await page.clock.runFor(30); await page.waitForTimeout(25); };
  const ready = async () => { await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor(); await flush(); };
  const notify = async (id, method, params) => { await page.evaluate(({ id, method, params }) => window.__work.sessions[id].emit(method, params), { id, method, params }); await flush(); };
  const item = async (id, turn, value, completed = true) => notify(id, completed ? 'item/completed' : 'item/started', { threadId: 'shared-thread', turnId: turn, item: value });
  const send = async text => {
    await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
    await flush();
  };
  const complete = async (id, turn, status = 'completed', durationMs = 302000) => {
    const startedAt = await page.evaluate(({ id, turn }) => window.__work.sessions[id].turns[turn].startedAt, { id, turn });
    await notify(id, 'turn/completed', { threadId: 'shared-thread', turn: { id: turn, startedAt, completedAt: startedAt + durationMs / 1000, durationMs, status, items: [], error: status === 'failed' ? { message: 'Тестовая ошибка выполнения' } : null } });
  };
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await flush(); };
  const openState = locator => locator.evaluate(node => node.open);
  await ready();
  await send('Сделай компактный интерфейс');
  await item('session-1', 'turn-1', { id: 'empty-reasoning', type: 'reasoning', summary: [' \n\t '], content: [' '] });
  assert.equal(await chat().locator('.work-reasoning').count(), 0, 'Whitespace is not an invented reasoning block');
  await item('session-1', 'turn-1', { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] }, false);
  await notify('session-1', 'item/reasoning/summaryTextDelta', { threadId: 'shared-thread', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: 'Проверяю структуру проекта и текущие отступы.' });
  await chat().getByText('Проверяю структуру проекта и текущие отступы.', { exact: true }).waitFor();
  assert.equal(await openState(log('turn-1')), true, 'Live reasoning is expanded');
  await item('session-1', 'turn-1', { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'Уменьшу отступы в обеих боковых панелях.' });
  await item('session-1', 'turn-1', { id: 'command-1', type: 'commandExecution', command: 'npm.cmd run build', commandActions: [], status: 'inProgress', aggregatedOutput: '' }, false);
  await notify('session-1', 'item/commandExecution/outputDelta', { threadId: 'shared-thread', turnId: 'turn-1', itemId: 'command-1', delta: 'Сборка успешно завершена\n' });
  await item('session-1', 'turn-1', { id: 'command-1', type: 'commandExecution', command: 'npm.cmd run build', commandActions: [], status: 'completed', aggregatedOutput: 'Сборка успешно завершена\n', exitCode: 0, durationMs: 1030 });
  await item('session-1', 'turn-1', { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/Fixtures/PROJECT_A/src/styles.css', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-padding: 20px\n+padding: 6px' }] });
  await item('session-1', 'turn-1', { id: 'agent-started', type: 'subAgentActivity', kind: 'started', agentPath: '/root/check_design', agentThreadId: 'agent-one' });
  await item('session-1', 'turn-1', { id: 'agent-completed', type: 'subAgentActivity', kind: 'completed', agentPath: '/root/check_design', agentThreadId: 'agent-one' });
  assert.equal(await log('turn-1').getByText('Уменьшу отступы в обеих боковых панелях.', { exact: true }).isVisible(), true, 'Commentary belongs to the work log');
  assert.match(await log('turn-1').innerText(), /npm\.cmd run build/);
  assert.match(await log('turn-1').innerText(), /styles\.css/);
  assert.match(await log('turn-1').innerText(), /check_design/);
  await page.clock.fastForward(301000); await flush();
  await item('session-1', 'turn-1', { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '' }, false);
  assert.equal(await openState(log('turn-1')), false, 'Work collapses as soon as the final answer starts, before its first text delta');
  assert.equal(await chat().getByText('Проверяю структуру проекта и текущие отступы.', { exact: true }).isVisible(), false);
  await notify('session-1', 'item/agentMessage/delta', { threadId: 'shared-thread', turnId: 'turn-1', itemId: 'final-1', delta: 'Готово. Интерфейс стал компактнее.' });
  await chat().getByText('Готово. Интерфейс стал компактнее.', { exact: true }).waitFor();
  assert.equal(await chat().getByText('Готово. Интерфейс стал компактнее.', { exact: true }).evaluate(node => Boolean(node.closest('.work-log'))), false, 'Final response stays outside collapsed work');
  await complete('session-1', 'turn-1');
  assert.match(await summary('turn-1').innerText(), /Работал 5 мин 2 с/);
  assert.equal(await openState(log('turn-1')), false);
  assert.equal(await chat().getByText('Сделай компактный интерфейс', { exact: true }).count(), 1, 'The user echo does not duplicate the optimistic user message');
  await page.screenshot({ path: 'artifacts/work-log-collapsed.png' });
  await summary('turn-1').click();
  await log('turn-1').getByText('Проверяю структуру проекта и текущие отступы.', { exact: true }).waitFor();
  const commandRow = log('turn-1').locator('.work-log-row').filter({ hasText: 'npm.cmd run build' });
  assert.equal(await commandRow.count(), 1, 'A streamed command becomes one preserved action');
  await commandRow.locator(':scope > summary').click();
  await commandRow.getByText('Сборка успешно завершена', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/work-log-expanded.png' });

  // An unrelated tab receives identical thread/turn IDs through its own bridge.
  await view().getByRole('button', { name: 'Новый проект', exact: true }).first().click();
  await ready();
  await send('Исправь второй проект');
  await item('session-2', 'turn-1', { id: 'reasoning-1', type: 'reasoning', summary: ['Пояснение только второго проекта'], content: [] });
  await activate('session-1');
  assert.equal(await chat().getByText('Пояснение только второго проекта', { exact: true }).count(), 0);
  assert.equal(await openState(log('turn-1')), true, 'User expansion survives switching tabs');
  await item('session-2', 'turn-1', { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'Второй проект исправлен.' });
  await complete('session-2', 'turn-1', 'completed', 10000);
  assert.equal(await openState(log('turn-1')), true, 'Background completion cannot collapse another tab with the same turn ID');
  assert.equal(await chat().getByText('Второй проект исправлен.', { exact: true }).count(), 0);
  await activate('session-2');
  assert.equal(await openState(log('turn-1')), false);
  await chat().getByText('Второй проект исправлен.', { exact: true }).waitFor();
  await activate('session-1');

  // New work has independent disclosure state; answers without reasoning remain visible.
  await send('Ответь коротко без пояснений');
  await item('session-1', 'turn-2', { id: 'empty-second', type: 'reasoning', summary: ['  '], content: [] });
  await item('session-1', 'turn-2', { id: 'final-2', type: 'agentMessage', phase: 'final_answer', text: 'Короткий ответ.' });
  await complete('session-1', 'turn-2', 'completed', 3000);
  assert.equal(await log('turn-2').locator('.work-reasoning').count(), 0);
  await chat().getByText('Короткий ответ.', { exact: true }).waitFor();
  assert.equal(await openState(log('turn-1')), true, 'Completing a new turn preserves manual expansion of an older turn');
  await send('Проверка остановки');
  await item('session-1', 'turn-3', { id: 'stop-reasoning', type: 'reasoning', summary: ['Пояснение до остановки'], content: [] }, false);
  assert.equal(await openState(log('turn-3')), true);
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).click(); await flush();
  assert.equal(await openState(log('turn-3')), false);
  assert.match(await summary('turn-3').innerText(), /Остановлено/);
  await summary('turn-3').click();
  await log('turn-3').getByText('Пояснение до остановки', { exact: true }).waitFor();
  await send('Проверка ошибки');
  await item('session-1', 'turn-4', { id: 'fail-reasoning', type: 'reasoning', summary: ['Пояснение до ошибки'], content: [] }, false);
  await complete('session-1', 'turn-4', 'failed', 4000);
  assert.equal(await openState(log('turn-4')), false);
  assert.match(await summary('turn-4').innerText(), /Ошибка/);
  assert.equal(await log('turn-4').getByText('Пояснение до ошибки', { exact: true }).isVisible(), false);
  assert.equal(await chat().getByText('Готово. Интерфейс стал компактнее.', { exact: true }).isVisible(), true);

  const folderA = () => view().locator('.folder-tree-entry[data-cwd="C:/Fixtures/PROJECT_A"]');
  if (await folderA().getByRole('button', { name: 'Диалоги папки PROJECT_A', exact: true }).getAttribute('aria-expanded') !== 'true') await folderA().getByRole('button', { name: 'Диалоги папки PROJECT_A', exact: true }).click();
  await folderA().locator('.folder-thread[data-thread-id="saved-history"]').click();
  await ready();
  await summary('known-history').waitFor();
  assert.match(await summary('known-history').innerText(), /Работал 1 мин 2 с/);
  assert.equal(await openState(log('known-history')), false);
  assert.equal((await summary('unknown-history').innerText()).trim(), 'Ход работы', 'Old history with no timing must not invent a duration');
  await chat().getByText('Ответ из истории со временем', { exact: true }).waitFor();
  await chat().getByText('Старый ответ без phase', { exact: true }).waitFor();
  assert.equal(await chat().getByText('Старый ответ без phase', { exact: true }).evaluate(node => Boolean(node.closest('.work-log'))), false);
  await summary('unknown-history').click();
  await log('unknown-history').getByText('Старое пояснение без метаданных времени', { exact: true }).waitFor();

  await activate('session-1');
  await item('session-1', 'turn-1', { id: 'spawn-worker', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['worker-a'], prompt: 'Проверить контракт API', agentsStates: { 'worker-a': { status: 'running', message: null } } });
  await view().locator('.panel-tabs').getByRole('button', { name: 'Подагенты', exact: true }).click();
  const agentCard = view().locator('.subagent-card').filter({ hasText: 'worker-a' });
  await agentCard.getByText('Проверить контракт API', { exact: true }).waitFor();
  assert.match(await agentCard.innerText(), /Работает/);
  await item('session-1', 'turn-1', { id: 'wait-worker', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['worker-a'], agentsStates: { 'worker-a': { status: 'errored', message: 'Контракт требует исправления' } } });
  await agentCard.getByRole('alert').getByText('Контракт требует исправления', { exact: true }).waitFor();
  await agentCard.getByRole('button', { name: 'К результату в чате', exact: true }).click();
  await flush();
  const target = chat().locator('[data-item-id="wait-worker"]');
  assert.equal(await target.evaluate(node => node === document.activeElement), true, 'Subagent result opens its work log and focuses exact event');
  await target.getByText(/Контракт требует исправления/).waitFor();
  assert.equal(await openState(log('turn-1')), true);
  await page.screenshot({ path: 'artifacts/subagents-panel.png' });
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size); await flush();
    const folderHeights = await view().locator('.folder-toggle').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(folderHeights.length > 0 && folderHeights.every(height => height <= 28), `Compact project rows: ${folderHeights}`);
    if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    await view().locator('.panel-tabs').getByRole('button', { name: /^Файлы/ }).click();
    const srcFolder = view().getByRole('button', { name: 'Раскрыть папку src', exact: true });
    if (await srcFolder.getAttribute('aria-expanded') !== 'true') await srcFolder.click();
    await view().getByRole('button', { name: 'Открыть файл index.ts', exact: true }).waitFor();
    const treeHeights = await view().locator('.tree-file-row').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(treeHeights.length >= 4 && treeHeights.every(height => height <= 26), `Compact nested file rows: ${treeHeights}`);
    await page.screenshot({ path: `artifacts/compact-work-files-${size.width}.png` });
    await view().locator('.panel-tabs').getByRole('button', { name: /^Действия/ }).click();
    const actionHeights = await view().locator('.activity-item > summary').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(actionHeights.length >= 4 && actionHeights.every(height => height <= 32), `Compact action summaries: ${actionHeights}`);
    const overflow = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, actualWidth: document.documentElement.scrollWidth, actualHeight: document.documentElement.scrollHeight }));
    assert.ok(overflow.actualWidth <= overflow.width + 1 && overflow.actualHeight <= overflow.height + 1, `No document overflow at ${size.width}px`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: per-turn live compact work, final-start collapse, exact 5m2s duration, expandable preserved reasoning/commentary/tool output, independent turns/tabs, no invented reasoning, failed/interrupted work, legacy known/unknown timing and phase, compact folders/files/actions at 1440/940px. Production renderer with fake scoped bridges and controlled clock only; no real model request.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/work-log-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
