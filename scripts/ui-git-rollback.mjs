import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer and deterministic bridges. No file mutations or model calls.
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
    const fixture = window.__rollback = { sessions: {}, calls: [], requests: [], activationListeners: new Set(), prepareListeners: new Set(), prepareResults: [] };
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    const entry = (path, indexStatus, worktreeStatus, extra = {}) => ({ path, status: `${indexStatus}${worktreeStatus}`, indexStatus, worktreeStatus, staged: ![' ', '?', 'U'].includes(indexStatus), unstaged: ![' ', '?', 'U'].includes(worktreeStatus), untracked: indexStatus === '?', conflicted: indexStatus === 'U', ...extra });
    for (const id of ['a', 'b']) {
      const cwd = `C:/Fixtures/ROLLBACK_${id.toUpperCase()}`;
      const state = fixture.sessions[id] = { cwd, listeners: new Set(), history: [{ undoId: `saved-${id}`, path: 'saved.md', createdAt: new Date('2026-09-18T12:00:00Z').toISOString() }], previews: new Map(), deferPreview: false, deferApply: false, pendingPreviews: [], pendingApplies: [], failPreview: '', failApply: '', failHistory: '', expirePreview: false, serial: 0 };
      const thread = state.thread = { id: `thread-${id}`, name: `Откаты ${id}`, cwd, historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: `turn-${id}`, status: 'completed', items: [
        { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Проверь проект ${id}`, text_elements: [] }] },
        { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Проект ${id} готов.` },
      ] }] };
      state.baseStatus = { available: true, root: cwd, branch: `feature/${id}`, detached: false, unborn: false, head: '1234567890abcdef', entries: [
        entry('src/shared.ts', 'M', 'M'), entry('src/deleted.ts', ' ', 'D'), entry('assets/binary.png', ' ', 'M'),
        entry('staged-only.ts', 'M', ' '), entry('new.md', '?', '?'), entry('conflict.ts', 'U', 'U'), entry('submodule', ' ', 'M', { submodule: true }), entry('changed-type', ' ', 'T'), entry('renamed-modified.ts', 'R', 'M', { originalPath: 'old-name.ts' }), entry('copied-modified.ts', 'C', 'M'), entry('type-modified.ts', 'T', 'M'),
      ] };
      state.status = structuredClone(state.baseStatus);
      const makePreview = (path, operation, undoId) => {
        const preview = { previewId: `${id}-preview-${++state.serial}`, path, operation, binary: path.endsWith('.png'), expiresAt: new Date(Date.now() + (state.expirePreview ? -1000 : 300000)).toISOString(), diff: path.endsWith('.png') ? '' : `@@ -3 +3 @@\n-${operation === 'restore' ? 'working edits' : 'restored version'}\n+${operation === 'restore' ? 'index version' : 'saved edits'}`,
          ...(operation === 'restore' && path === 'src/shared.ts' ? { hunks: [{ index: 0, header: '@@ -1,4 +1,4 @@', oldStart: 1, oldCount: 4, newStart: 1, newCount: 4, removed: 1, added: 1, excerpt: 'import a from "./a";' }, { index: 1, header: '@@ -40,7 +40,6 @@', oldStart: 40, oldCount: 7, newStart: 40, newCount: 6, removed: 1, added: 0, excerpt: 'console.log(debug);' }] } : {}) };
        state.expirePreview = false;
        state.previews.set(preview.previewId, { ...preview, undoId });
        if (state.deferPreview) { state.deferPreview = false; return new Promise(resolve => state.pendingPreviews.push(value => resolve(value || preview))); }
        return preview;
      };
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
        async getGitStatus() { return structuredClone(state.status); },
        async getGitDiff(options) { return { ...options, diff: '@@ -1 +1 @@\n-old\n+new' }; },
        async listGitRollbacks() {
          fixture.calls.push({ sessionId: id, method: 'list' });
          if (state.failHistory) { const message = state.failHistory; state.failHistory = ''; throw new Error(message); }
          return structuredClone(state.history);
        },
        async previewGitRollback({ path }) {
          fixture.calls.push({ sessionId: id, method: 'preview', path });
          if (state.failPreview) { const message = state.failPreview; state.failPreview = ''; throw new Error(message); }
          return makePreview(path, 'restore');
        },
        async previewUndoGitRollback({ undoId }) {
          fixture.calls.push({ sessionId: id, method: 'previewUndo', undoId });
          const saved = state.history.find(record => record.undoId === undoId);
          if (!saved) throw new Error('Откат не найден.');
          return makePreview(saved.path, 'undo', undoId);
        },
        async applyGitRollback({ previewId, hunks }) {
          fixture.calls.push({ sessionId: id, method: 'apply', previewId, ...(hunks ? { hunks } : {}) });
          if (state.failApply) { const message = state.failApply; state.failApply = ''; throw new Error(message); }
          const preview = state.previews.get(previewId);
          const result = { undoId: `${previewId}-undo`, path: preview.path, createdAt: new Date().toISOString() };
          const finish = () => {
            state.status.entries = state.status.entries.map(value => value.path === preview.path ? { ...value, worktreeStatus: ' ', unstaged: false } : value).filter(value => value.staged || value.unstaged || value.untracked || value.conflicted);
            state.history.unshift(result); return result;
          };
          if (state.deferApply) { state.deferApply = false; return new Promise(resolve => state.pendingApplies.push(() => resolve(finish()))); }
          return finish();
        },
        async undoGitRollback({ previewId }) {
          fixture.calls.push({ sessionId: id, method: 'undo', previewId });
          const preview = state.previews.get(previewId);
          state.history = state.history.filter(record => record.undoId !== preview.undoId);
          state.status = structuredClone(state.baseStatus);
          return { path: preview.path };
        },
        async openPath() {}, async showPathMenu() {}, async readAttachment() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: Object.values(fixture.sessions).map(state => state.cwd), sessions: [], restore: { kind: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd: state.cwd, thread: state.thread })) } }; },
      forSession(id) { return fixture.sessions[id].bridge; }, async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async listProjectThreads(cwd) { return { data: Object.values(fixture.sessions).filter(state => state.cwd === cwd).map(state => state.thread), nextCursor: null }; },
      async saveWorkspaceState() {}, async completeUpdateRestore() {},
      onNotificationActivated(listener) { fixture.activationListeners.add(listener); return () => fixture.activationListeners.delete(listener); },
      onUpdatePrepare(listener) { fixture.prepareListeners.add(listener); return () => fixture.prepareListeners.delete(listener); },
      onUpdateStatus() { return () => {}; }, async getUpdateStatus() { return null; },
      async completeUpdatePrepare(result) { fixture.prepareResults.push(result); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const panel = () => view().locator('.git-panel');
  const modal = () => page.locator('.git-rollback-modal');
  const rollback = path => panel().getByRole('button', { name: `Откатить ${path}`, exact: true });
  const undo = path => panel().getByRole('button', { name: `Отменить откат ${path}`, exact: true });
  const confirm = () => modal().getByRole('button', { name: 'Отменить изменения файла', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mutations = () => page.evaluate(() => window.__rollback.calls.filter(call => ['apply', 'undo'].includes(call.method)));
  const ready = async () => {
    await page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
    await settle();
  };
  const showGit = async () => {
    await view().locator('.panel-tabs button').filter({ hasText: 'Изменения' }).click();
    await view().getByRole('button', { name: 'Git', exact: true }).click();
    await rollback('src/shared.ts').waitFor();
  };
  const close = async () => { await modal().getByRole('button', { name: 'Отмена', exact: true }).click(); await modal().waitFor({ state: 'hidden' }); };
  const activate = async id => {
    await page.evaluate(id => { for (const listener of window.__rollback.activationListeners) listener({ sessionId: id }); }, id);
    await page.locator(`.session-view[data-session-id="${id}"]:visible`).waitFor(); await ready();
  };
  const event = async (method, params) => page.evaluate(({ method, params }) => { for (const listener of window.__rollback.sessions.a.listeners) listener({ type: 'notification', data: { method, params } }); }, { method, params });
  await ready(); await showGit();
  await undo('saved.md').waitFor();
  assert.equal(await panel().getByRole('button', { name: /^Откатить / }).count(), 3, 'Only eligible unstaged M/D files get rollback buttons');
  assert.equal(await panel().locator('button button').count(), 0, 'Compare and rollback are separate controls');
  await rollback('src/shared.ts').click();
  await modal().getByText('working edits', { exact: true }).waitFor();
  assert.deepEqual(await modal().locator('.diff-column-headings span').allTextContents(), ['Сейчас · рабочий файл', 'После · версия из индекса']);
  assert.match(await modal().innerText(), /остальные неподготовленные изменения файла сохранятся/, 'a multi-fragment preview explains selective restore');
  assert.match(await modal().innerText(), /резервная копия/);
  assert.equal((await mutations()).length, 0, 'Preview does not mutate');
  await modal().getByRole('button', { name: 'Единый diff', exact: true }).click();
  assert.equal(await modal().locator('.diff-unified-row').count(), 2);
  await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
  assert.equal((await mutations()).length, 0, 'Escape cancels without mutation');
  await rollback('src/deleted.ts').click(); await confirm().waitFor(); await close();
  assert.equal((await mutations()).length, 0, 'Cancel leaves a deleted file untouched');

  // A pending preview blocks preparing an update and can be cancelled safely.
  await page.evaluate(() => { window.__rollback.sessions.a.deferPreview = true; });
  await rollback('src/shared.ts').click();
  await modal().getByText('Готовим предпросмотр…', { exact: true }).waitFor();
  await page.evaluate(() => { for (const listener of window.__rollback.prepareListeners) listener({ requestId: 'rollback-preview' }); });
  await page.waitForFunction(() => window.__rollback.prepareResults.some(result => result.requestId === 'rollback-preview'));
  assert.equal(await page.evaluate(() => window.__rollback.prepareResults.find(result => result.requestId === 'rollback-preview').defer), true, 'Update waits while rollback preview is open');
  await close();
  await page.evaluate(() => window.__rollback.sessions.a.pendingPreviews.shift()()); await settle();
  assert.equal(await modal().count(), 0, 'Cancelled pending preview cannot resurrect modal');

  // Confirm is explicit, exactly once, and the pending operation cannot be dismissed.
  await rollback('src/shared.ts').click(); await confirm().waitFor();
  await page.evaluate(() => { window.__rollback.sessions.a.deferApply = true; });
  await confirm().click();
  await page.waitForFunction(() => window.__rollback.sessions.a.pendingApplies.length === 1);
  await page.keyboard.press('Escape');
  assert.equal(await modal().count(), 1);
  assert.equal(await modal().getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true);
  assert.equal(await modal().getByRole('button', { name: 'Закрыть предпросмотр отката', exact: true }).isDisabled(), true);
  assert.equal((await mutations()).length, 1);
  await page.evaluate(() => window.__rollback.sessions.a.pendingApplies.shift()());
  await modal().waitFor({ state: 'hidden' }); await undo('src/shared.ts').waitFor();
  assert.equal(await panel().getByRole('button', { name: 'Сравнить src/shared.ts — Подготовлено к коммиту', exact: true }).count(), 1, 'Staged comparison remains after rollback');
  assert.equal(await rollback('src/shared.ts').count(), 0, 'Successful rollback refreshes unstaged entries');
  await undo('src/shared.ts').click();
  await modal().getByText('saved edits', { exact: true }).waitFor();
  assert.match(await modal().innerText(), /Подготовленная к коммиту версия останется прежней/);
  assert.equal((await mutations()).length, 1, 'Undo also requires preview and confirmation');
  await modal().getByRole('button', { name: 'Вернуть изменения', exact: true }).click();
  await modal().waitFor({ state: 'hidden' }); await rollback('src/shared.ts').waitFor();
  assert.equal(await undo('src/shared.ts').count(), 0, 'Consumed backup disappears from actionable history');
  assert.equal((await mutations()).length, 2);

  // Host rejection stays visible and requires a new preview; it never retries a mutation.
  await page.evaluate(() => { window.__rollback.sessions.a.failPreview = 'Файл изменился после чтения списка.'; });
  await rollback('src/shared.ts').click();
  await modal().getByRole('alert').filter({ hasText: 'Файл изменился после чтения списка.' }).waitFor();
  assert.equal(await confirm().count(), 0);
  await modal().getByRole('button', { name: 'Обновить предпросмотр', exact: true }).click(); await confirm().waitFor();
  await page.evaluate(() => { window.__rollback.sessions.a.failApply = 'Файл изменился после предпросмотра. Обновите его.'; });
  await confirm().click();
  await modal().getByRole('alert').filter({ hasText: 'Файл изменился после предпросмотра.' }).waitFor();
  assert.equal(await confirm().count(), 0, 'Failed mutation invalidates its preview token');
  assert.equal((await mutations()).length, 3);
  await modal().getByRole('button', { name: 'Обновить предпросмотр', exact: true }).click(); await confirm().waitFor();
  assert.equal((await mutations()).length, 3, 'Preview retry does not apply automatically');
  await close();
  await page.evaluate(() => { window.__rollback.sessions.a.expirePreview = true; });
  await rollback('src/shared.ts').click();
  await modal().getByText(/Предпросмотр устарел/).waitFor();
  assert.equal(await confirm().count(), 0, 'Expired preview cannot be applied');
  await close();

  // Busy tasks block row actions and an already open confirmation.
  await rollback('src/shared.ts').click(); await confirm().waitFor();
  await event('turn/started', { threadId: 'thread-a', turn: { id: 'busy-turn', status: 'inProgress', items: [] } });
  await page.waitForFunction(() => document.querySelector('.git-rollback-confirm')?.disabled);
  assert.match(await modal().innerText(), /Дождитесь завершения задач/);
  await close();
  assert.equal(await rollback('src/shared.ts').isDisabled(), true);
  assert.equal(await undo('saved.md').isDisabled(), true);
  await event('turn/completed', { threadId: 'thread-a', turn: { id: 'busy-turn', status: 'completed', items: [] } });
  await page.waitForFunction(() => { const button = document.querySelector('.session-view:not([hidden]) [aria-label="Откатить src/shared.ts"]'); return button && !button.disabled; });

  // Hidden-tab and changed-source async previews do not open over another view.
  await page.evaluate(() => { window.__rollback.sessions.a.deferPreview = true; });
  await rollback('src/shared.ts').click();
  await page.waitForFunction(() => window.__rollback.sessions.a.pendingPreviews.length === 1);
  await activate('b'); await showGit();
  await page.evaluate(() => window.__rollback.sessions.a.pendingPreviews.shift()()); await settle();
  assert.equal(await modal().count(), 0);
  await undo('saved.md').click(); await modal().getByText('saved edits', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__rollback.calls.at(-1).sessionId), 'b');
  await activate('a'); assert.equal(await modal().count(), 0);
  await rollback('src/shared.ts').waitFor();

  await page.evaluate(() => { window.__rollback.sessions.a.deferPreview = true; });
  await rollback('src/shared.ts').click();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.session-view:not([hidden]) .changes-source-tabs button')].find(node => node.textContent === 'Из диалога');
    button.click();
  });
  await modal().waitFor({ state: 'hidden' });
  await page.evaluate(() => window.__rollback.sessions.a.pendingPreviews.shift()()); await settle();
  assert.equal(await modal().count(), 0);
  await view().getByRole('button', { name: 'Git', exact: true }).click(); await rollback('src/shared.ts').waitFor();

  // Durable history is reloaded on re-entry; history errors preserve a safe disabled list.
  await undo('saved.md').waitFor();
  await page.evaluate(() => { window.__rollback.sessions.a.failHistory = 'Не удалось прочитать резервные копии.'; });
  await panel().getByRole('button', { name: 'Обновить Git', exact: true }).click();
  await panel().getByRole('alert').filter({ hasText: 'Не удалось прочитать резервные копии.' }).waitFor();
  assert.equal(await undo('saved.md').isDisabled(), true);
  await panel().getByRole('button', { name: 'Обновить откаты', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.session-view:not([hidden]) [aria-label="Отменить откат saved.md"]')?.disabled);

  // Fragment selection: unchecking one hunk switches to a partial restore that sends only the chosen indices.
  await rollback('src/shared.ts').click(); await confirm().waitFor();
  const fragments = modal().getByRole('group', { name: /Фрагменты для отката/ });
  assert.equal(await fragments.getByRole('checkbox').count(), 2);
  assert.equal(await fragments.getByRole('checkbox', { name: 'Фрагмент 2: строки 40–46' }).isChecked(), true, 'every fragment is selected by default');
  await fragments.getByRole('checkbox', { name: 'Фрагмент 2: строки 40–46' }).uncheck();
  const partialButton = modal().getByRole('button', { name: 'Отменить выбранные фрагменты (1 из 2)', exact: true });
  await partialButton.waitFor();
  await fragments.getByRole('button', { name: 'Снять все', exact: true }).click();
  assert.equal(await modal().getByRole('button', { name: /Отменить выбранные фрагменты|Отменить изменения файла/ }).isDisabled(), true, 'nothing selected disables the confirm');
  await fragments.getByRole('checkbox', { name: 'Фрагмент 1: строки 1–4' }).check();
  await partialButton.click();
  await panel().getByText(/отменены выбранные фрагменты \(1 из 2\)/).waitFor();
  const partialCall = await page.evaluate(() => window.__rollback.calls.filter(call => call.method === 'apply').at(-1));
  assert.deepEqual(partialCall.hunks, [0], 'only the selected fragment index is sent');
  await page.evaluate(() => { const state = window.__rollback.sessions.a; state.status = structuredClone(state.baseStatus); });
  await panel().getByRole('button', { name: 'Обновить Git', exact: true }).click();
  await rollback('src/shared.ts').waitFor();

  await rollback('assets/binary.png').click();
  await modal().getByText('Бинарный файл. Текстовое сравнение недоступно.', { exact: true }).waitFor();
  assert.equal(await modal().locator('.diff-line-number').count(), 0);
  await close();
  for (const width of [1440, 940, 600]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 }); await settle();
    if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    const bounds = await panel().evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.client + 1, `Panel fits ${width}px`);
    await rollback('src/shared.ts').click(); await confirm().waitFor();
    const dimensions = await modal().evaluate(node => { const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollWidth, client: node.clientWidth }; });
    assert.ok(dimensions.left >= 0 && dimensions.top >= 0 && dimensions.right <= dimensions.width + 1 && dimensions.bottom <= dimensions.height + 1 && dimensions.scroll <= dimensions.client + 1, `Preview fits ${width}px`);
    await page.screenshot({ path: `artifacts/git-rollback-${width}.png` }); await close();
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__rollback.requests.filter(call => !['thread/list', 'thread/read', 'thread/resume'].includes(call.method)).length), 0, 'No model requests');
  console.log('PASS: rollback preview/cancel/apply/undo, staged preservation, durable history, no nested buttons, safe scopes, update deferral, pending close guard, stale preview errors/expiry, busy guard, async tab/source isolation, binary preview, 1440/940/600 layouts. Fake bridges; no repository mutations or model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/git-rollback-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
