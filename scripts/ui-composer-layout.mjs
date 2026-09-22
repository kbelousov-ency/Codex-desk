import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(10000);
  const errors = [], layouts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/COMPOSER';
    const model = { id: 'fixture', model: 'fixture', displayName: 'GPT-6-Astra', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra' };
    const thread = { id: 'thread-layout', cwd, name: 'Проверка изменений', turns: [{ id: 'turn-layout', status: 'inProgress', items: [{ id: 'user-layout', type: 'userMessage', content: [{ type: 'text', text: 'Проверь изменения и сохрани совместимость со старым форматом.' }] }] }] };
    const state = window.__composer = { listeners: new Set(), calls: [], currentTurn: 'turn-layout' };
    state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: thread.id, ...params } } }); };
    state.begin = () => { state.currentTurn += '-next'; state.emit('turn/started', { turn: { id: state.currentTurn, status: 'inProgress', items: [] } }); };
    state.complete = () => state.emit('turn/completed', { turn: { id: state.currentTurn, status: 'completed', items: [] } });
    state.approve = () => { for (const listener of state.listeners) listener({ type: 'serverRequest', data: { id: 'approve-layout', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, command: 'npm test' } } }); };
    const bridge = {
      async start() { return { cwd, models: [model], executable: 'fixture', account: { account: null }, config: { model: 'fixture', model_reasoning_effort: 'ultra' } }; },
      async getSettings() { return { cwd, model: 'fixture', effort: 'ultra', access: 'auto' }; }, async setSettings() {},
      async request(method, params = {}) {
        state.calls.push({ method, params: structuredClone(params) });
        if (method === 'thread/list') return { data: [thread], nextCursor: null };
        if (method === 'thread/resume') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'ultra' };
        if (method === 'turn/steer') return { turnId: params.expectedTurnId };
        if (method === 'turn/start') { state.begin(); return { turn: { id: state.currentTurn, status: 'inProgress', items: [] } }; }
        if (method === 'turn/interrupt') { state.emit('turn/completed', { turn: { id: state.currentTurn, status: 'interrupted', items: [] } }); return {}; }
        throw new Error(`Unexpected fixture request: ${method}`);
      },
      async saveImages(images) { return images.map((image, index) => ({ ...image, path: `${cwd}/${index}.png` })); },
      async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
      onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      async respond(id) { state.emit('serverRequest/resolved', { requestId: id }); },
      async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
    };
    window.codex = {
      ...bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { source: 'workspace', activeIndex: 0, tabs: [{ id: 'layout', cwd, thread, draft: '', attachments: [] }] } }; },
      async saveWorkspaceState() {}, async completeUpdateRestore() {},
      async listProjectThreads() { return { data: [thread], nextCursor: null }; },
      forSession() { return bridge; },
    };
  });
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const steer = () => view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true });
  const enqueue = () => view().getByRole('button', { name: 'Отправить после завершения', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = async (width, state) => {
    await settle();
    const geometry = await view().locator('.composer').evaluate(node => {
      const box = node.getBoundingClientRect();
      const toolbar = node.querySelector('.composer-toolbar').getBoundingClientRect();
      const controls = [...node.querySelectorAll('.composer-toolbar button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label'), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centerY: rect.y + rect.height / 2, width: rect.width };
      });
      return { left: box.left, right: box.right, height: box.height, toolbarBottom: toolbar.bottom, controls };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1, `${width}/${state}: composer fits viewport`);
    const controls = [...geometry.controls].sort((a, b) => a.left - b.left);
    const centers = controls.map(control => control.centerY);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, `${width}/${state}: all tools/actions remain on one row: ${JSON.stringify(controls)}`);
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      assert.ok(control.width >= 20 && control.left >= geometry.left && control.right <= geometry.right, `${width}/${state}: ${control.label} stays usable inside composer`);
      if (index) assert.ok(controls[index - 1].right <= control.left + 1, `${width}/${state}: controls do not overlap`);
    }
    assert.ok(geometry.height < 135, `${width}/${state}: no redundant action row`);
    layouts.push({ width, state, ...geometry });
  };
  for (const width of [1440, 1100, 1001, 940, 650]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
    assert.equal(await steer().isVisible(), true);
    assert.equal(await enqueue().isVisible(), true);
    assert.equal(await steer().isDisabled(), true);
    assert.equal(await enqueue().isDisabled(), true);
    await measure(width, 'busy-empty');
    await view().locator('.composer').screenshot({ path: `artifacts/composer-${width}-empty.png` });
    await draft().fill('Учитывай старый формат конфигурации.');
    await steer().waitFor();
    assert.equal(await steer().isEnabled(), true);
    await measure(width, 'busy-draft');
    await view().locator('.composer').screenshot({ path: `artifacts/composer-${width}-draft.png` });
    await page.screenshot({ path: `artifacts/composer-${width}-window.png` });
    await draft().press('Enter');
    assert.equal(await draft().inputValue(), 'Учитывай старый формат конфигурации.');
    assert.equal(await page.evaluate(() => window.__composer.calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method)).length), 0, 'Enter during busy does not silently choose an action');
    await page.evaluate(() => window.__composer.approve());
    await page.waitForFunction(() => document.querySelector('[aria-label="Уточнить текущую задачу"]')?.disabled);
    assert.equal(await enqueue().isEnabled(), true, 'Queue remains editable while approval blocks execution');
    await measure(width, 'busy-approval');
    await page.evaluate(() => window.__composer.emit('serverRequest/resolved', { requestId: 'approve-layout' }));
    await steer().click();
    await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
    assert.equal(await page.evaluate(() => window.__composer.calls.filter(call => call.method === 'turn/steer').length), 1);
    await draft().fill('Следующая проверка');
    await enqueue().click();
    await view().getByRole('region', { name: 'Очередь сообщений', exact: true }).getByText('Следующая проверка', { exact: true }).waitFor();
    await view().getByRole('button', { name: 'Пауза очереди', exact: true }).click();
    await page.evaluate(() => window.__composer.complete());
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).waitFor();
    assert.equal(await enqueue().isDisabled(), true, 'Empty idle draft keeps the queue action visible and disabled');
    await measure(width, 'idle-empty-queue');
    await draft().fill('Новый запрос после очереди');
    assert.equal(await steer().count(), 0);
    await enqueue().waitFor();
    await measure(width, 'idle-draft-queue');
    await view().locator('.composer').screenshot({ path: `artifacts/composer-${width}-idle-queue.png` });
    await draft().fill('   ');
    assert.equal(await enqueue().isDisabled(), true, 'Whitespace does not enable send actions');
    await page.evaluate(() => window.__composer.begin());
    await view().locator('input[type="file"]').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    await steer().waitFor();
    assert.equal(await steer().isEnabled(), true, 'An image without text exposes both message actions');
    assert.equal(await enqueue().isEnabled(), true);
    await view().getByRole('button', { name: 'Удалить preview.png', exact: true }).click();
    assert.equal(await steer().isDisabled(), true);
  }
  assert.deepEqual(errors, []);
  await writeFile('artifacts/composer-layout.json', JSON.stringify(layouts, null, 2));
  console.log('PASS: composer tools and actions share one row at 1440/1100/1001/940/650 px; empty/whitespace drafts keep actions visible but disabled, text/images enable them, approval preserves execution guards, and Enter keeps its existing busy behavior. Mock bridge; no model calls.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/composer-layout-failure.png' });
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
