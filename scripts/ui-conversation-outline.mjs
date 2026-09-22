import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/OUTLINE';
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', supportedReasoningEfforts: [] };
    const fixture = window.__outline = { calls: [], sessions: {} };
    for (const id of ['a', 'b']) {
      const state = fixture.sessions[id] = { listeners: new Set() };
      state.thread = { id: `thread-${id}`, cwd, name: `Диалог ${id}`, historyMode: 'legacy', status: { type: 'idle' }, turns: Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: [
        { id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Запрос ${i}: ${i === 0 ? 'Авторизация' : i === 1 ? 'Оформление' : 'Другие задачи'} в диалоге ${id}` }] },
        { id: `answer-${i}`, type: 'agentMessage', phase: 'final_answer', text: `Ответ в диалоге ${id}.\n\n${'Содержимое обсуждения. '.repeat(60)}` },
      ] })) };
      state.bridge = {
        async start() { return { cwd, models: [model], executable: 'fixture', account: { account: null }, config: { model: 'fixture' } }; },
        async getSettings() { return { cwd, model: 'fixture', access: 'auto' }; }, async setSettings() {},
        async request(method, params = {}) {
          fixture.calls.push({ id, method, params });
          if (method === 'thread/list') return { data: [state.thread], nextCursor: null };
          if (method === 'thread/resume') return { thread: structuredClone(state.thread), model: 'fixture' };
          throw new Error(`Unexpected request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {},
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd, thread: state.thread, draft: `Черновик ${id}` })) } }; },
      async completeUpdateRestore() {}, async saveWorkspaceState() {},
      async listProjectThreads() { return { data: Object.values(fixture.sessions).map(state => state.thread), nextCursor: null }; },
      forSession(id) { return fixture.sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const outline = () => view().getByRole('region', { name: 'Оглавление диалога', exact: true });
  const open = () => view().getByRole('button', { name: 'Открыть оглавление диалога', exact: true }).click();
  await view().locator('.message[data-item-id="user-11"]').waitFor();
  await open();
  await outline().locator('.outline-jump').first().waitFor();
  assert.equal(await outline().locator('.outline-jump').count(), 12);
  await outline().getByRole('button', { name: 'Подписать этап', exact: true }).first().click();
  await outline().getByRole('textbox', { name: 'Подпись этапа', exact: true }).fill('Исправляли вход');
  await outline().getByRole('button', { name: 'Сохранить', exact: true }).click();
  await outline().getByRole('textbox', { name: 'Найти запрос в оглавлении', exact: true }).fill('Исправляли');
  assert.equal(await outline().locator('.outline-jump').count(), 1);
  await outline().locator('.outline-jump').click();
  await view().locator('.message[data-item-id="user-0"].message-jump-highlight').waitFor();
  assert.equal(await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).inputValue(), 'Черновик a');
  await page.locator('.session-tab[data-session-id="b"]').getByRole('tab').click();
  await open();
  assert.equal(await outline().getByText('Исправляли вход', { exact: true }).count(), 0, 'Same item id in another thread must not inherit a label');
  await page.reload();
  await view().locator('.message[data-item-id="user-11"]').waitFor();
  await open();
  await outline().getByText('Исправляли вход', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/conversation-outline.png' });
  await page.setViewportSize({ width: 700, height: 760 });
  await open();
  await outline().locator('.outline-jump').first().click();
  await view().locator('.message[data-item-id="user-0"].message-jump-highlight').waitFor();
  assert.equal(await view().locator('.details-panel').isVisible(), false, 'Narrow screen closes the outline after navigating');
  assert.equal(await page.evaluate(() => window.__outline.calls.filter(call => call.method.startsWith('turn/')).length), 0);
  assert.deepEqual(errors, []);
  console.log('Outline: navigation, labels, filter, reload, tab isolation and narrow screen passed; model requests: 0.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
