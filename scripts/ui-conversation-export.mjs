import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(bytes); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fixture = window.__export = { saves: [], calls: [], sessions: {}, listeners: new Set() };
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    for (const id of ['a', 'b']) {
      const cwd = `C:/Fixture/EXPORT_${id.toUpperCase()}`;
      const provider = id === 'b' ? 'claude' : 'codex';
      const thread = { id: `thread-${id}`, name: `Экспорт ${id}`, cwd, provider, historyMode: 'paginated', turns: [] };
      const state = fixture.sessions[id] = { thread, cwd, provider, fail: false, noProgress: false };
      const recent = [
        { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Сообщение ${id}\n<script>window.exportScriptRan = 1</script>` }, { type: 'localImage', path: 'C:/fixture/photo.png' }] },
        { id: `reason-${id}`, type: 'reasoning', summary: ['Полученное пояснение'], encrypted_content: 'PRIVATE_REASONING' },
        { id: `comment-${id}`, type: 'agentMessage', phase: 'commentary', text: 'Комментарий агента' },
        { id: `tool-${id}`, type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', exitCode: 0, privatePayload: 'PRIVATE_TOOL' },
        { id: `hidden-${id}`, type: 'hookPrompt', text: 'PRIVATE_HOOK' },
        { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: '**Готово**\n\n![remote](https://should-not-load.invalid/pixel.png)\n\n<script>window.exportScriptRan = 1</script>\n\n[Плохая ссылка](javascript:alert(1))' },
      ];
      state.bridge = {
        async getSettings() { return { cwd, provider, model: 'fixture', effort: 'high', access: 'workspace-write' }; }, async setSettings() {},
        async start() { return { cwd, provider, models: [model], executable: 'fixture', account: {}, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async request(method, params = {}) {
          fixture.calls.push({ id, method, params });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'usage/read') return { available: false, windows: [] };
          if (method === 'thread/read' || method === 'thread/resume') return { thread, model: 'fixture', reasoningEffort: 'high' };
          if (method === 'thread/turns/list') return { data: ['oldest', 'older', 'recent'].map(key => ({ id: `${key}-${id}`, status: 'completed', startedAt: 1700000000, completedAt: 1700000003 })), nextCursor: null };
          if (method === 'thread/items/list') {
            if (!params.cursor) return { data: recent.map(item => ({ turnId: `recent-${id}`, item })).reverse(), nextCursor: 'older' };
            if (state.fail) { state.fail = false; throw new Error('Тестовая ошибка истории'); }
            if (state.noProgress) return { data: [], nextCursor: params.cursor };
            return { data: [{ turnId: `${params.cursor}-${id}`, item: { id: `${params.cursor}-${id}`, type: 'agentMessage', text: `${params.cursor === 'oldest' ? 'Самый ранний' : 'Предыдущий'} ответ ${id}` } }], nextCursor: params.cursor === 'older' ? 'oldest' : null };
          }
          throw new Error(`Unexpected request: ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        onEvent() { return () => {}; },
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: Object.values(fixture.sessions).map(state => state.cwd), sessions: [], restore: { kind: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd: state.cwd, provider: state.provider, thread: state.thread })) } }; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async listProjectThreads(cwd) { return { data: Object.values(fixture.sessions).filter(state => state.cwd === cwd).map(state => state.thread), nextCursor: null }; },
      async listBookmarks() { return []; }, async saveWorkspaceState() {}, async completeUpdateRestore() {},
      async exportConversation(file) { if (fixture.saveError) { fixture.saveError = false; throw new Error('Тестовая ошибка сохранения'); } if (fixture.cancel) { fixture.cancel = false; return { canceled: true }; } fixture.saves.push(file); return { canceled: false, path: `C:/Exports/${file.filename}` }; },
      onNotificationActivated(listener) { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const modal = () => page.getByRole('dialog', { name: 'Экспорт беседы', exact: true });
  await view().getByRole('button', { name: 'Экспорт беседы', exact: true }).click();
  await modal().getByRole('button', { name: 'Сохранить фрагмент…', exact: true }).click();
  await modal().getByRole('status').filter({ hasText: 'Сохранено:' }).waitFor();
  const partial = await page.evaluate(() => window.__export.saves.at(-1));
  assert.equal(partial.format, 'markdown');
  assert.match(partial.content, /загруженный фрагмент/);
  assert.match(partial.content, /\*\*Готово\*\*/);
  assert.ok(!partial.content.includes('git status'));
  assert.ok(!partial.content.includes('PRIVATE_'));
  await modal().getByRole('button', { name: 'Загрузить всю беседу', exact: true }).click();
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).waitFor();
  await modal().getByRole('radio', { name: 'Переписка и ход работы', exact: true }).check();
  await modal().getByRole('combobox', { name: 'Формат', exact: true }).selectOption('html');
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).click();
  await page.waitForFunction(() => window.__export.saves.length === 2);
  const html = await page.evaluate(() => window.__export.saves.at(-1));
  assert.equal(html.format, 'html');
  for (const expected of ['Самый ранний ответ a', 'Предыдущий ответ a', 'git status', 'Комментарий агента', 'Полученное пояснение']) assert.ok(html.content.includes(expected), expected);
  for (const rejected of ['PRIVATE_', '<script>', 'загруженный фрагмент', 'src="https://should-not-load']) assert.ok(!html.content.includes(rejected), rejected);
  const exported = await browser.newPage();
  const requested = [];
  exported.on('request', request => requested.push(request.url()));
  await exported.setContent(html.content);
  assert.equal(await exported.locator('strong').first().innerText(), 'Готово');
  assert.equal(await exported.locator('script, img, iframe').count(), 0);
  assert.equal(await exported.evaluate(() => window.exportScriptRan), undefined);
  assert.deepEqual(requested, []);
  await exported.screenshot({ path: 'artifacts/conversation-export-html.png' });
  await exported.close();
  await modal().getByRole('combobox', { name: 'Формат', exact: true }).selectOption('markdown');
  await page.evaluate(() => { window.__export.cancel = true; });
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).click();
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__export.saves.length), 2);
  assert.equal(await modal().getByRole('status').count(), 0);
  await page.evaluate(() => { window.__export.saveError = true; });
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).click();
  await modal().getByRole('alert').filter({ hasText: 'Тестовая ошибка сохранения' }).waitFor();
  await page.screenshot({ path: 'artifacts/conversation-export-dialog.png' });
  await page.keyboard.press('Escape');
  await modal().waitFor({ state: 'hidden' });
  await page.evaluate(() => { for (const listener of window.__export.listeners) listener({ sessionId: 'b' }); });
  await page.locator('.session-view[data-session-id="b"]:visible').waitFor();
  await view().getByRole('button', { name: 'Экспорт беседы', exact: true }).click();
  const beforeNoProgress = await page.evaluate(() => { window.__export.sessions.b.noProgress = true; return window.__export.calls.filter(call => call.id === 'b' && call.method === 'thread/items/list' && call.params.cursor).length; });
  await modal().getByRole('button', { name: 'Загрузить всю беседу', exact: true }).click();
  await modal().getByRole('alert').filter({ hasText: 'Загрузка истории не продвинулась' }).waitFor();
  const count = await page.evaluate(() => window.__export.calls.filter(call => call.id === 'b' && call.method === 'thread/items/list' && call.params.cursor).length);
  assert.equal(count - beforeNoProgress, 1, `No-progress pagination stops immediately: ${JSON.stringify(await page.evaluate(() => window.__export.calls.filter(call => call.id === 'b')))}`);
  await page.evaluate(() => { window.__export.sessions.b.noProgress = false; });
  await modal().getByRole('button', { name: 'Загрузить всю беседу', exact: true }).click();
  await modal().getByRole('button', { name: 'Сохранить…', exact: true }).click();
  await page.waitForFunction(() => window.__export.saves.length === 3);
  const claude = await page.evaluate(() => window.__export.saves.at(-1));
  assert.match(claude.content, /Агент: Claude/);
  assert.match(claude.content, /Самый ранний ответ b/);
  assert.ok(!claude.content.includes('ответ a'));
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__export.calls.some(call => !['thread/list', 'thread/read', 'thread/resume', 'thread/items/list', 'thread/turns/list', 'usage/read'].includes(call.method))), false);
  console.log('PASS: Markdown/HTML export, conversation/work, paginated complete history, labeled partial export, public fields only, safe offline HTML, cancel/error/retry, no-progress pagination stop, scoped Codex/Claude. No model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/conversation-export-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
