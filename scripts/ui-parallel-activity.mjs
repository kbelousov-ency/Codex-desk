import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Built renderer, scoped synthetic public events; no Electron IPC or model requests.
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
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const sessions = {};
    const models = [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const create = (id, cwd) => {
      const state = { id, cwd, turn: 0, listeners: new Set(), requests: [], settings: { model: 'fixture', effort: 'high', access: 'workspace-write' } };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: `thread-${id}`, ...params } } }); };
      state.bridge = {
        async start() { return { initialize: {}, models, cwd, executable: 'C:/Fixture/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async getSettings() { return state.settings; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/start') return { thread: { id: `thread-${id}`, cwd, turns: [] }, model: 'fixture' };
          if (method === 'turn/start') return { turn: { id: `${id}-turn-${++state.turn}`, status: 'inProgress', items: [] } };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {},
        async searchProjectFiles() { return { files: [{ path: 'readme.md', name: 'readme.md' }], nextCursor: null }; },
        async readProjectFile({ path }) { return { path, kind: 'markdown', text: '# Файл для первого запроса\n\nСодержимое до начала беседы.' }; },
        async saveImages(images) { return images; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
    };
    create('a', 'C:/Fixtures/Shared'); create('b', 'c:\\fixtures\\shared\\'); create('worktree', 'C:/Fixtures/Shared-task');
    window.__parallel = { sessions };
    window.codex = {
      ...sessions.a.bridge,
      async getWorkspace() { return { projects: ['C:/Fixtures/Shared', 'C:/Fixtures/Shared-task'], sessions: Object.values(sessions).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const toggle = () => page.getByRole('button', { name: 'Диалоги в общей папке', exact: true });
  const panel = () => page.getByRole('region', { name: 'Диалоги в общей рабочей папке', exact: true });
  const activate = async id => { await page.locator(`#tab-${id}`).click(); await page.waitForFunction(id => !document.getElementById(`view-${id}`).hidden, id); };
  const ready = () => page.waitForFunction(() => { const node = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return node && !node.disabled; });
  const send = async (id, text) => {
    await activate(id); await ready(); await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await page.waitForFunction(id => window.__parallel.sessions[id].turn > 0, id);
    await page.evaluate(id => { const state = window.__parallel.sessions[id]; state.emit('turn/started', { turn: { id: `${id}-turn-${state.turn}`, status: 'inProgress', items: [] } }); }, id);
  };
  const edit = (id, status, path) => page.evaluate(({ id, status, path }) => {
    const state = window.__parallel.sessions[id];
    state.emit(status === 'inProgress' ? 'item/started' : 'item/completed', { turnId: `${id}-turn-${state.turn}`, item: { id: `${id}-edit-${state.turn}`, type: 'fileChange', status, changes: [{ path, kind: { type: 'update' }, diff: '-old\n+new' }] } });
  }, { id, status, path });
  const finish = id => page.evaluate(id => { const state = window.__parallel.sessions[id]; state.emit('turn/completed', { turn: { id: `${id}-turn-${state.turn}`, status: 'completed', items: [], error: null } }); }, id);
  await ready();
  assert.equal(await toggle().isVisible(), true);
  assert.equal(await toggle().locator('.parallel-count').textContent(), '2');
  // Opening a file before the first message must survive initial thread/start.
  await page.keyboard.press('Control+p');
  await page.getByRole('option', { name: /readme/ }).click();
  await page.getByRole('button', { name: 'Закрепить файл рядом с чатом', exact: true }).click();
  await view().getByRole('region', { name: 'Файл рядом с чатом', exact: true }).waitFor();
  await view().getByRole('button', { name: 'Добавить путь', exact: true }).click();
  assert.match(await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), /readme\.md/);
  await send('a', 'Задача А'); await edit('a', 'completed', 'src/App.tsx');
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  assert.equal(await view().locator('.result-dock').count(), 1, 'Initial thread/start preserves the pinned file');
  await view().locator('.result-dock').getByRole('heading', { name: 'Файл для первого запроса', exact: true }).waitFor();
  await activate('b');
  assert.equal(await view().locator('.result-dock').count(), 0, 'Pinned files belong to their own tab');
  await activate('a');
  await view().locator('.result-dock').getByRole('heading', { name: 'Файл для первого запроса', exact: true }).waitFor();
  await view().getByRole('button', { name: 'Закрыть просмотр файлов', exact: true }).click();
  await send('worktree', 'Отдельная рабочая копия'); await edit('worktree', 'completed', 'src/App.tsx');
  assert.equal(await toggle().count(), 0, 'A worktree is a separate folder');
  await send('b', 'Задача Б'); await edit('b', 'inProgress', 'C:/FIXTURES/SHARED/src/app.tsx');
  assert.equal(await toggle().locator('.parallel-overlap-count').count(), 0, 'Proposed edits are not completed changes');
  await edit('b', 'failed', 'C:/FIXTURES/SHARED/src/app.tsx');
  assert.equal(await toggle().locator('.parallel-overlap-count').count(), 0, 'Failed edits do not overlap');
  await edit('b', 'completed', 'C:/FIXTURES/SHARED/src/app.tsx');
  await toggle().locator('.parallel-overlap-count').waitFor();
  assert.equal(await toggle().locator('.parallel-overlap-count').textContent(), '1');
  await toggle().click(); await panel().waitFor();
  assert.equal(await panel().locator('.parallel-session').count(), 2);
  assert.match(await panel().textContent(), /src\/App\.tsx|src\/app\.tsx/);
  assert.doesNotMatch(await panel().textContent(), /Отдельная рабочая копия/);
  await panel().getByRole('button', { name: /Задача А/ }).click();
  assert.equal(await page.getByRole('tab', { selected: true }).getAttribute('id'), 'tab-a');
  assert.equal(await panel().count(), 0);
  await toggle().click(); await panel().waitFor(); await page.keyboard.press('Escape');
  assert.equal(await panel().count(), 0);
  assert.equal(await toggle().evaluate(node => node === document.activeElement), true, 'Escape restores focus');
  await toggle().click();
  await page.screenshot({ path: 'artifacts/parallel-activity.png' });
  await page.setViewportSize({ width: 760, height: 700 });
  const bounds = await panel().boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 761, 'Popover stays within a narrow window');
  await page.keyboard.press('Escape'); await finish('b');
  await page.waitForFunction(() => !document.querySelector('.parallel-overlap-count'));
  await activate('b'); await send('b', 'Новый запрос Б без правок');
  assert.equal(await toggle().locator('.parallel-overlap-count').count(), 0, 'Starting a new turn cannot revive past overlaps');
  await finish('a'); await finish('b'); await finish('worktree');
  assert.deepEqual(errors, []);
  console.log('Parallel activity: shared folders, successful edits, navigation, keyboard, worktree isolation, lifecycle and pinned file across initial thread/start passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
