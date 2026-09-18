import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Renderer checkpoint/restore contract. Fake bridge, no Codex model requests.
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
let browser;
let page;
await mkdir('artifacts', { recursive: true });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLuoAAAAASUVORK5CYII=';
    const fixture = window.__update = { results: [], restored: 0, requests: [], captures: new Set(), statuses: new Set(), holdImages: false, finishImages: [], settings: {}, failPrepare: false };
    const NativeReader = window.FileReader;
    window.FileReader = class {
      readAsDataURL(file) {
        const reader = new NativeReader();
        reader.onload = () => {
          this.result = reader.result;
          const complete = () => this.onload?.();
          if (fixture.holdImages) fixture.finishImages.push(complete); else complete();
        };
        reader.onerror = () => this.onerror?.();
        reader.readAsDataURL(file);
      }
    };
    const projects = ['C:/Fixtures/A', 'C:/Fixtures/B'];
    const archivedThread = { id: 'archived', cwd: projects[0], name: 'Архивная беседа' };
    const thread = { id: 'dialogue-a', name: 'Открытая беседа', cwd: projects[0], historyMode: 'legacy' };
    const models = ['fixture-a', 'fixture-b'].map(model => ({ id: model, model, displayName: model, supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'] }));
    const tabs = [
      { id: 'new-a', cwd: projects[0], thread, draft: 'Черновик A', attachments: [{ name: 'draft.png', dataUrl: png }], settings: { model: 'fixture-b', effort: 'high', access: 'danger-full-access' } },
      { id: 'archive:archived', cwd: projects[0], archivedThread },
      { id: 'new-b', cwd: projects[1], draft: 'Черновик B', settings: { model: 'fixture-a', effort: '', access: 'auto' } },
    ];
    const bridges = {};
    for (const tab of tabs.filter(tab => !tab.archivedThread)) {
      fixture.settings[tab.id] = { cwd: tab.cwd, ...tab.settings };
      bridges[tab.id] = {
        async getSettings() { return fixture.settings[tab.id]; },
        async setSettings(patch) { Object.assign(fixture.settings[tab.id], patch); },
        async start() { return { initialize: {}, models, cwd: tab.cwd, config: { model: 'fixture-a', model_reasoning_effort: 'medium' }, account: {}, executable: 'fixture' }; },
        async request(method, params) {
          fixture.requests.push({ sessionId: tab.id, method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/resume') return { thread: { ...thread, status: { type: 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Ответ из истории.' }] }] }, model: 'fixture-a', reasoningEffort: 'medium' };
          throw new Error(`Unexpected request ${method}`);
        },
        onEvent() { return () => {}; },
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
        async readAttachment() { return null; },
      };
    }
    window.codex = {
      ...bridges['new-a'],
      async getWorkspace() { return { projects, sessions: tabs.filter(tab => !tab.archivedThread), restore: { activeIndex: 2, tabs } }; },
      forSession(id) { return bridges[id]; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async readArchivedThread() { return { thread: archivedThread, items: [{ id: 'archive-item', type: 'agentMessage', text: 'Ответ из архива.' }], turns: [], nextCursor: null }; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      onUpdatePrepare(listener) { fixture.captures.add(listener); return () => fixture.captures.delete(listener); },
      onUpdateStatus(listener) { fixture.statuses.add(listener); return () => fixture.statuses.delete(listener); },
      async completeUpdateRestore() { fixture.restored++; },
      async completeUpdatePrepare(result) { if (fixture.failPrepare) throw new Error('fixture checkpoint failure'); fixture.results.push(result); if (result.defer) for (const listener of fixture.statuses) listener({ state: 'waiting' }); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const activate = async id => page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
  const prepare = requestId => page.evaluate(requestId => { for (const listener of window.__update.captures) listener({ requestId }); }, requestId);
  const status = state => page.evaluate(state => { for (const listener of window.__update.statuses) listener({ state }); }, state);
  const result = requestId => page.waitForFunction(requestId => window.__update.results.find(result => result.requestId === requestId), requestId).then(handle => handle.jsonValue());
  await page.waitForFunction(() => window.__update.restored === 1 && [...document.querySelectorAll('[role="combobox"][aria-label="Модель"]')].every(el => !el.disabled));
  assert.equal(await page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId), 'new-b');
  assert.equal(await input().inputValue(), 'Черновик B');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), '');
  await activate('new-a');
  await view().getByText('Ответ из истории.', { exact: true }).waitFor();
  assert.equal(await input().inputValue(), 'Черновик A');
  assert.equal(await view().locator('.attachment img').getAttribute('alt'), 'draft.png');
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-b');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'danger-full-access');
  await input().fill('Изменённый черновик A');
  await status('waiting');
  assert.equal(await input().isEnabled(), true);
  await page.evaluate(() => { window.__update.holdImages = true; });
  await view().locator('input[type="file"]').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLuoAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => window.__update.finishImages.length === 1);
  await prepare('reading-image');
  assert.deepEqual(await result('reading-image'), { requestId: 'reading-image', defer: true });
  assert.equal(await page.getByRole('dialog', { name: 'Nightly обновляется…' }).count(), 0);
  await page.evaluate(() => { window.__update.finishImages.splice(0).forEach(fn => fn()); });
  await view().locator('.attachment').nth(1).waitFor();
  await activate('archive:archived');
  await view().getByText('Ответ из архива.', { exact: true }).waitFor();
  await prepare('snapshot');
  const saved = (await result('snapshot')).snapshot;
  assert.equal(saved.version, 1);
  assert.equal(saved.activeIndex, 1);
  assert.equal(saved.tabs.length, 3);
  assert.equal(saved.tabs[0].draft, 'Изменённый черновик A');
  assert.equal(saved.tabs[0].thread.id, 'dialogue-a');
  assert.equal(saved.tabs[0].thread.turns, undefined, 'Checkpoint must not contain loaded messages');
  assert.deepEqual(saved.tabs[0].settings, { model: 'fixture-b', effort: 'high', access: 'danger-full-access' });
  assert.deepEqual(saved.tabs[0].attachments.map(image => image.name), ['draft.png', 'second.png']);
  assert.equal(saved.tabs[1].archivedThread.id, 'archived');
  assert.equal(saved.tabs[1].sessionId, undefined);
  assert.equal(saved.tabs[2].draft, 'Черновик B');
  assert.equal(saved.tabs[2].thread, undefined, 'New unsent tab stays unsent');
  await page.getByRole('dialog', { name: 'Nightly обновляется…' }).waitFor();
  assert.equal(await page.locator('.workspace-views').evaluate(el => el.inert), true);
  await page.screenshot({ path: 'artifacts/nightly-update-prepare.png' });
  await status('error');
  await page.getByText('Не удалось применить обновление. Приложение продолжает работать.', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-views').evaluate(el => el.inert), false);
  await activate('new-a');
  assert.equal(await input().inputValue(), 'Изменённый черновик A');
  await page.evaluate(() => { window.__update.failPrepare = true; });
  await prepare('failed');
  await page.getByText('Не удалось сохранить вкладки для обновления. Приложение продолжает работать.', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-views').evaluate(el => el.inert), false);
  assert.equal((await page.evaluate(() => window.__update.requests)).some(request => request.method === 'turn/start'), false);
  assert.deepEqual(errors, []);
  console.log('PASS: Nightly restore active tab/order/archive/new thread, drafts/images/model/effort/full access, no model turn, image-read defer, minimal checkpoint, freeze/inert, error unlock and IPC failure recovery.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/nightly-restore-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
