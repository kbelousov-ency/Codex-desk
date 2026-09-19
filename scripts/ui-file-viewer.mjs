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
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fixture = window.__files = { sessions: {}, requests: [], reads: [], searches: [], opens: [], activationListeners: new Set() };
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    for (const id of ['a', 'b']) {
      const cwd = `C:/Fixtures/FILES_${id.toUpperCase()}`;
      const state = fixture.sessions[id] = { cwd, listeners: new Set(), pendingReads: [], pendingSearches: [] };
      const thread = state.thread = { id: `thread-${id}`, name: `Файлы ${id}`, cwd, turns: [{ id: `turn-${id}`, status: 'completed', items: [
        { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Проверь файлы ${id}`, text_elements: [] }] },
        { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Файлы ${id} готовы.` },
      ] }] };
      state.files = ['src/app.ts', 'docs/readme.md', 'assets/image.png', 'binary.pdf', 'large.txt'].map(path => ({ path, name: path.split('/').at(-1) }));
      state.bridge = {
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'workspace-write' }; }, async setSettings() {},
        async start() { return { cwd, models: [model], executable: 'fixture', account: {}, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async request(method, params = {}) {
          fixture.requests.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume' || method === 'thread/read') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async searchProjectFiles(options) {
          fixture.searches.push({ sessionId: id, ...options });
          if (state.failSearch) { state.failSearch = false; throw new Error('Тестовая ошибка поиска'); }
          const result = { files: state.files.filter(file => file.path.toLowerCase().includes(options.query.toLowerCase())), nextCursor: null };
          if (options.query === 'many') return options.cursor ? { files: [{ path: 'page-2.txt', name: 'page-2.txt' }], nextCursor: null } : { files: [{ path: 'page-1.txt', name: 'page-1.txt' }], nextCursor: '200' };
          if (state.deferSearch) { state.deferSearch = false; return new Promise(resolve => state.pendingSearches.push(() => resolve(result))); }
          return result;
        },
        async readProjectFile({ path }) {
          fixture.reads.push({ sessionId: id, path });
          if (state.failRead) { state.failRead = false; throw new Error('Тестовая ошибка чтения'); }
          const data = { path, kind: 'text', text: `const project = '${id}';\nconst greeting = 'Привет';\nconsole.log(greeting);\n`, language: 'TypeScript' };
          if (path.endsWith('.md')) Object.assign(data, { kind: 'markdown', text: '# Документация\n\nБезопасный **Markdown**.\n\n<script>window.fileScriptRan = true</script>\n\n[Ссылка](../README.md)' });
          if (path.endsWith('.png')) Object.assign(data, { kind: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CfkAAAAASUVORK5CYII=' });
          if (path.endsWith('.pdf')) Object.assign(data, { kind: 'unsupported', message: 'Предпросмотр двоичного файла недоступен.' });
          if (path === 'large.txt') Object.assign(data, { truncated: true, message: 'Показан первый 1 МБ файла.' });
          if (state.deferRead) { state.deferRead = false; return new Promise(resolve => state.pendingReads.push(() => resolve(data))); }
          return data;
        },
        async openPath(path) { fixture.opens.push({ sessionId: id, path }); },
        async showPathMenu() {}, async readAttachment() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: Object.values(fixture.sessions).map(state => state.cwd), sessions: [], restore: { kind: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd: state.cwd, thread: state.thread })) } }; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async listProjectThreads(cwd) { return { data: Object.values(fixture.sessions).filter(state => state.cwd === cwd).map(state => state.thread), nextCursor: null }; },
      async listBookmarks() { return []; },
      async saveWorkspaceState() {}, async completeUpdateRestore() {},
      onNotificationActivated(listener) { fixture.activationListeners.add(listener); return () => fixture.activationListeners.delete(listener); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const modal = () => page.getByRole('dialog', { name: 'Файлы проекта', exact: true });
  const search = () => modal().getByRole('combobox', { name: 'Найти файл проекта', exact: true });
  const source = () => modal().getByRole('textbox', { name: 'Содержимое файла', exact: true });
  const result = path => modal().getByRole('option').filter({ has: page.locator('small', { hasText: path }) });
  const openViewer = async () => { await page.keyboard.press('Control+p'); await search().waitFor(); };
  const closeViewer = async () => { await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' }); };
  const ready = async () => { await view().locator('[role="combobox"][aria-label="Модель"]:not(:disabled)').waitFor(); };
  await ready();
  const composer = () => view().locator('.composer textarea').first();
  await composer().fill('Существующий черновик');
  await openViewer();
  await result('src/app.ts').waitFor();
  await search().fill('APP');
  await result('src/app.ts').waitFor();
  await search().press('Enter');
  await source().waitFor();
  assert.match(await source().inputValue(), /const project = 'a'/);
  assert.equal(await source().getAttribute('readonly'), '');
  await source().evaluate(element => {
    element.focus();
    element.setSelectionRange(element.value.indexOf('const greeting'), element.value.indexOf('console.log'));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await modal().getByRole('button', { name: 'Спросить о выделении', exact: true }).click();
  await modal().waitFor({ state: 'hidden' });
  const draft = await composer().inputValue();
  assert.match(draft, /^Существующий черновик/);
  assert.match(draft, /C:\/Fixtures\/FILES_A\/src\/app.ts — строки 2/);
  assert.match(draft, /const greeting = 'Привет';/);
  assert.ok(!draft.includes('console.log'));

  await openViewer();
  await result('docs/readme.md').click();
  await modal().getByRole('heading', { name: 'Документация', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fileScriptRan), undefined);
  await modal().getByRole('button', { name: 'Исходник', exact: true }).click();
  assert.match(await source().inputValue(), /<script>/);
  await result('assets/image.png').click();
  await modal().getByRole('img', { name: 'assets/image.png', exact: true }).waitFor();
  await result('binary.pdf').click();
  await modal().getByText('Предпросмотр двоичного файла недоступен.', { exact: true }).waitFor();
  await modal().getByRole('button', { name: 'Открыть во внешней программе', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__files.opens.at(-1)), { sessionId: 'a', path: 'binary.pdf' });
  await result('large.txt').click();
  await modal().getByText('Показан первый 1 МБ файла.', { exact: true }).waitFor();

  await page.evaluate(() => { window.__files.sessions.a.failRead = true; });
  await result('src/app.ts').click();
  await modal().getByRole('alert').filter({ hasText: 'Тестовая ошибка чтения' }).waitFor();
  await modal().getByRole('button', { name: 'Повторить', exact: true }).click();
  await source().waitFor();
  await page.evaluate(() => { window.__files.sessions.a.deferRead = true; });
  await result('docs/readme.md').click();
  await result('src/app.ts').click();
  await source().waitFor();
  await page.evaluate(() => window.__files.sessions.a.pendingReads.shift()());
  assert.match(await source().inputValue(), /const project/);
  assert.equal(await modal().getByRole('heading', { name: 'Документация', exact: true }).count(), 0, 'Old file response does not overwrite latest file');

  await search().fill('many');
  await result('page-1.txt').waitFor();
  await modal().getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await result('page-2.txt').waitFor();
  await page.evaluate(() => { window.__files.sessions.a.deferSearch = true; });
  await search().fill('app');
  await page.waitForFunction(() => window.__files.sessions.a.pendingSearches.length === 1);
  await search().fill('readme');
  await result('docs/readme.md').waitFor();
  await page.evaluate(() => window.__files.sessions.a.pendingSearches.shift()());
  assert.equal(await result('src/app.ts').count(), 0, 'Old search response does not replace current results');
  await search().fill('nothing here');
  await modal().getByText('Файлы не найдены.', { exact: true }).waitFor();
  await page.evaluate(() => { window.__files.sessions.a.failSearch = true; });
  await search().fill('app');
  await modal().getByRole('alert').filter({ hasText: 'Тестовая ошибка поиска' }).waitFor();
  await modal().getByRole('button', { name: 'Повторить', exact: true }).click();
  await result('src/app.ts').waitFor();
  await search().fill('');
  await result('src/app.ts').click();
  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
    const bounds = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollWidth, client: node.clientWidth }; });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1 && bounds.scroll <= bounds.client + 1);
    await page.screenshot({ path: `artifacts/file-viewer-${width}.png` });
  }
  await closeViewer();
  await page.evaluate(() => { for (const listener of window.__files.activationListeners) listener({ sessionId: 'b' }); });
  await page.locator('.session-view[data-session-id="b"]:visible').waitFor();
  await ready();
  await openViewer();
  await result('src/app.ts').click();
  await source().waitFor();
  assert.match(await source().inputValue(), /const project = 'b'/);
  await modal().getByRole('button', { name: 'Добавить путь', exact: true }).click();
  assert.match(await composer().inputValue(), /FILES_B\/src\/app.ts/);
  assert.ok(!(await composer().inputValue()).includes('Существующий черновик'));
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__files.requests.filter(call => !['thread/list', 'thread/read', 'thread/resume'].includes(call.method)).length), 0);
  console.log('PASS: Ctrl+P project file search, keyboard open, code/lines, safe Markdown/source/image/binary, selected fragment to existing draft, pagination/errors/retry, stale searches/reads, scoped tabs, 1440/940 layouts. No model requests or user file changes.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/file-viewer-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
