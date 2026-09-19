import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Real renderer interactions with an isolated bridge. Never starts Codex or closes a user's window.
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLuoAAAAASUVORK5CYII=';
    const fixture = window.__workspace = {
      saves: [], attempts: [], requests: [], closeResults: [], closeListeners: new Set(),
      listeners: {}, settings: {}, closed: [], failSave: false, updateRestored: 0, releaseHistory: null,
    };
    const projects = ['C:/Fixtures/A', 'C:/Fixtures/B'];
    const thread = { id: 'dialogue-a', name: 'Открытая беседа', cwd: projects[0], historyMode: 'legacy' };
    const archivedThread = { id: 'archived', name: 'Архивная беседа', cwd: projects[0] };
    const tabs = [
      {
        id: 'session-a', cwd: projects[0], thread, draft: 'Черновик A', scrollTop: 620,
        attachments: [{ name: 'draft.png', dataUrl: png }],
        settings: { model: 'fixture-b', effort: 'high', access: 'danger-full-access' },
        // Even an old snapshot which says "running" must require explicit queue continuation on restore.
        queue: { items: [{ id: 'queued-a', text: 'Проверить после задачи', attachments: [], state: 'waiting' }], paused: false, threadId: thread.id, cwd: projects[0] },
      },
      { id: 'archive:archived', cwd: projects[0], archivedThread, scrollTop: 310 },
      { id: 'session-b', cwd: projects[1], draft: 'Черновик B', settings: { model: 'fixture-a', effort: '', access: 'auto' } },
    ];
    const query = new URL(location.href).searchParams;
    const empty = query.has('empty');
    const editing = query.has('edit');
    const anchor = query.has('anchor');
    if (anchor) {
      thread.historyMode = 'paginated';
      tabs[0].scrollTop = 11;
      tabs[0].scrollAnchor = { itemId: 'answer-3', offset: -24 };
    }
    if (editing) {
      tabs[0].draft = 'Исправление прошлого сообщения';
      tabs[0].attachments = [{ name: 'edited.png', dataUrl: png }];
      tabs[0].preservedDraft = { text: 'Исходный неотправленный черновик', attachments: [{ name: 'preserved.png', dataUrl: png }] };
    }
    const models = ['fixture-a', 'fixture-b'].map(model => ({
      id: model, model, displayName: model, inputModalities: ['text', 'image'],
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort })),
    }));
    const history = Array.from({ length: 35 }, (_, index) => ({
      id: `old-turn-${index}`, status: 'completed', items: [
        { id: `prompt-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Исторический запрос ${index + 1}` }] },
        { id: `answer-${index}`, type: 'agentMessage', text: `Ответ из истории ${index + 1}.\n\nПодробности сохранённого решения для проверки позиции чтения.` },
      ],
    }));
    const bridges = {};
    for (const tab of tabs.filter(tab => !tab.archivedThread)) {
      fixture.listeners[tab.id] = new Set();
      fixture.settings[tab.id] = { cwd: tab.cwd, ...tab.settings };
      bridges[tab.id] = {
        async getSettings() { return fixture.settings[tab.id]; },
        async setSettings(patch) { Object.assign(fixture.settings[tab.id], patch); },
        async start() { return { initialize: {}, models, cwd: tab.cwd, config: { model: 'fixture-a', model_reasoning_effort: 'medium' }, account: {}, executable: 'fixture' }; },
        async request(method, params) {
          fixture.requests.push({ sessionId: tab.id, method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/resume') {
            await new Promise(resolve => { fixture.releaseHistory = resolve; });
            return { thread: { ...thread, status: { type: 'idle' }, turns: anchor ? [] : history }, model: 'fixture-a', reasoningEffort: 'medium' };
          }
          if (anchor && method === 'thread/items/list') {
            const turns = params.cursor === 'older-page' ? history.slice(0, 20) : history.slice(20);
            return { data: turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), nextCursor: params.cursor ? null : 'older-page' };
          }
          if (anchor && method === 'thread/turns/list') return { data: history.map(({ items, ...turn }) => turn).reverse(), nextCursor: null };
          throw new Error(`Unexpected request ${method}`);
        },
        onEvent(listener) { fixture.listeners[tab.id].add(listener); return () => fixture.listeners[tab.id].delete(listener); },
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
        async readAttachment() { return null; },
      };
    }
    window.codex = {
      ...bridges['session-a'],
      async getWorkspace() { return { projects, sessions: empty ? [] : tabs.filter(tab => !tab.archivedThread), restore: { kind: 'workspace', activeIndex: empty || editing || anchor ? 0 : 2, tabs: empty ? [] : tabs } }; },
      forSession(id) { return bridges[id]; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async readArchivedThread() { return { thread: archivedThread, items: history.flatMap(turn => turn.items), turns: [], nextCursor: null }; },
      async closeSession(id) { fixture.closed.push(id); },
      async completeUpdateRestore() { fixture.updateRestored++; },
      async saveWorkspaceState(snapshot) {
        fixture.attempts.push(structuredClone(snapshot));
        if (fixture.failSave) throw new Error('fixture disk unavailable');
        fixture.saves.push(structuredClone(snapshot));
      },
      onWorkspaceSave(listener) { fixture.closeListeners.add(listener); return () => fixture.closeListeners.delete(listener); },
      async completeWorkspaceSave(result) { fixture.closeResults.push(structuredClone(result)); },
    };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const activate = id => page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
  const latest = () => page.evaluate(() => window.__workspace.saves.at(-1));
  const waitSavedDraft = (id, text) => page.waitForFunction(({ id, text }) => window.__workspace.saves.at(-1)?.tabs.some(tab => tab.sessionId === id && tab.draft === text), { id, text });
  const notify = (method, turn) => page.evaluate(({ method, turn }) => {
    for (const listener of window.__workspace.listeners['session-a']) listener({ type: 'notification', data: { method, params: { threadId: 'dialogue-a', turn } } });
  }, { method, turn });

  await input().waitFor();
  await page.waitForFunction(() => typeof window.__workspace.releaseHistory === 'function');
  assert.equal(await page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId), 'session-b');
  assert.equal(await input().inputValue(), 'Черновик B');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), '');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'auto');

  // Restore scroll only after the delayed history really exists in the visible tab.
  await activate('session-a');
  assert.equal(await input().inputValue(), 'Черновик A');
  assert.equal(await view().locator('.attachment img').getAttribute('alt'), 'draft.png');
  await page.evaluate(() => window.__workspace.releaseHistory());
  await view().getByText('Исторический запрос 35', { exact: true }).waitFor();
  await page.waitForFunction(() => Math.abs(document.querySelector('.session-view:not([hidden]) .chat-scroll').scrollTop - 620) < 3);
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-b');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'danger-full-access');
  const queue = view().getByRole('region', { name: 'Очередь сообщений', exact: true });
  await queue.getByText('На паузе', { exact: true }).waitFor();
  await queue.getByText('Проверить после задачи', { exact: true }).waitFor();
  await queue.getByRole('button', { name: 'Продолжить очередь', exact: true }).waitFor();

  // User scroll is saved and survives switching to an archived tab and back.
  await view().locator('.chat-scroll').evaluate(el => { el.scrollTop = 910; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await activate('archive:archived');
  await view().getByText('Исторический запрос 35', { exact: true }).waitFor();
  await page.waitForFunction(() => Math.abs(document.querySelector('.session-view:not([hidden]) .chat-scroll').scrollTop - 310) < 3);
  await activate('session-a');
  await page.waitForFunction(() => Math.abs(document.querySelector('.session-view:not([hidden]) .chat-scroll').scrollTop - 910) < 3);

  // Work proceeds in A while both its draft and the independent B draft remain durable.
  await notify('turn/started', { id: 'running-a', status: 'inProgress' });
  await page.locator('.session-tab[data-session-id="session-a"]').getByLabel('Выполняется', { exact: true }).waitFor();
  await input().fill('Черновик A во время выполнения');
  await waitSavedDraft('session-a', 'Черновик A во время выполнения');
  let saved = await latest();
  assert.equal(saved.tabs[0].queue.paused, true);
  assert.equal(saved.tabs[0].queue.items[0].text, 'Проверить после задачи');
  assert.equal(saved.tabs[0].scrollTop, 910);
  assert.equal(saved.tabs[0].thread.id, 'dialogue-a');
  assert.equal(saved.tabs[0].thread.turns, undefined, 'Workspace snapshots reference history rather than copying messages');
  assert.deepEqual(saved.tabs[0].attachments.map(item => item.name), ['draft.png']);
  assert.deepEqual(saved.tabs[0].settings, { model: 'fixture-b', effort: 'high', access: 'danger-full-access' });
  assert.equal(saved.tabs[1].archivedThread.id, 'archived');
  assert.equal(saved.tabs[1].scrollTop, 310);
  assert.equal(saved.tabs[2].thread, undefined, 'A new unsent tab must not create a thread');
  await activate('session-b');
  assert.equal(await input().inputValue(), 'Черновик B');
  await input().fill('Независимый черновик B');
  await waitSavedDraft('session-b', 'Независимый черновик B');
  saved = await latest();
  assert.equal(saved.activeIndex, 2);
  assert.equal(saved.tabs[0].draft, 'Черновик A во время выполнения');
  assert.equal(saved.tabs[2].attachments.length, 0);

  // Failed disk writes stay visible; retry saves the current draft without losing it.
  await page.evaluate(() => { window.__workspace.failSave = true; });
  await input().fill('Черновик после сбоя диска');
  const saveError = page.getByRole('alert').filter({ hasText: 'Не удалось сохранить вкладки и черновики.' });
  await saveError.waitFor();
  assert.equal(await input().inputValue(), 'Черновик после сбоя диска');
  assert.ok((await saveError.innerText()).includes('fixture disk unavailable'));
  await page.evaluate(() => { window.__workspace.failSave = false; });
  await saveError.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  await waitSavedDraft('session-b', 'Черновик после сбоя диска');
  await saveError.waitFor({ state: 'hidden' });

  await notify('turn/completed', { id: 'running-a', status: 'completed' });
  await page.locator('.session-tab[data-session-id="session-a"]').getByLabel('Готов', { exact: true }).waitFor();
  await activate('session-a');
  await queue.getByText('На паузе', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/workspace-state-restored.png' });

  // Native window close captures the newest value, then blocks further edits and saves.
  await activate('session-b');
  await input().fill('Последние символы перед закрытием');
  await page.evaluate(() => { for (const listener of window.__workspace.closeListeners) listener({ requestId: 'close-now' }); });
  await page.waitForFunction(() => window.__workspace.closeResults.some(result => result.requestId === 'close-now'));
  const close = await page.evaluate(() => window.__workspace.closeResults.find(result => result.requestId === 'close-now'));
  assert.equal(close.snapshot.tabs[2].draft, 'Последние символы перед закрытием');
  assert.equal(close.snapshot.tabs[0].draft, 'Черновик A во время выполнения');
  assert.equal(close.snapshot.activeIndex, 2);
  await page.getByRole('dialog', { name: 'Сохраняем рабочее место…', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-views').evaluate(el => el.inert), true, 'The close checkpoint freezes editing until the window exits');
  assert.equal(await page.locator('.workspace-tabs-bar').evaluate(el => el.inert), true);
  const attemptsAtClose = await page.evaluate(() => window.__workspace.attempts.length);
  // Exercise both the draft debounce and the maximum-delay autosave timer.
  await page.waitForTimeout(2300);
  assert.equal(await page.evaluate(() => window.__workspace.attempts.length), attemptsAtClose, 'No autosave may overtake the final close checkpoint');
  assert.equal(await page.evaluate(() => window.__workspace.requests.some(request => ['turn/start', 'turn/steer', 'thread/start'].includes(request.method))), false, 'Restore, background completion and autosave must never submit an unsent prompt');

  // An intentionally empty saved workspace stays empty across a fresh renderer startup.
  await page.goto(`${url}/?empty=1`);
  await page.getByRole('heading', { name: 'Откройте диалог', exact: true }).waitFor();
  await page.waitForFunction(() => window.__workspace.saves.length > 0);
  assert.deepEqual(await latest(), { version: 1, activeIndex: 0, tabs: [] });
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__workspace.requests), []);

  // Both drafts survive restoring an interrupted edit, including the original image on Cancel.
  await page.goto(`${url}/?edit=1`);
  await page.waitForFunction(() => typeof window.__workspace.releaseHistory === 'function');
  await page.evaluate(() => window.__workspace.releaseHistory());
  await view().getByText('Исторический запрос 35', { exact: true }).waitFor();
  await view().getByText('Редактирование сообщения', { exact: true }).waitFor();
  assert.equal(await input().inputValue(), 'Исправление прошлого сообщения');
  assert.equal(await view().locator('.attachment img').getAttribute('alt'), 'edited.png');
  await waitSavedDraft('session-a', 'Исправление прошлого сообщения');
  saved = await latest();
  assert.equal(saved.tabs[0].preservedDraft.text, 'Исходный неотправленный черновик');
  assert.equal(saved.tabs[0].preservedDraft.attachments[0].name, 'preserved.png');
  await view().getByRole('button', { name: 'Отменить редактирование', exact: true }).click();
  assert.equal(await input().inputValue(), 'Исходный неотправленный черновик');
  assert.equal(await view().locator('.attachment img').getAttribute('alt'), 'preserved.png');
  await waitSavedDraft('session-a', 'Исходный неотправленный черновик');
  assert.equal((await latest()).tabs[0].preservedDraft, undefined);
  for (const id of ['session-a', 'archive:archived', 'session-b']) {
    await page.locator(`.session-tab[data-session-id="${id}"] .session-tab-close`).click();
  }
  await page.getByRole('heading', { name: 'Откройте диалог', exact: true }).waitFor();
  await page.waitForFunction(() => window.__workspace.saves.at(-1)?.tabs.length === 0);
  assert.deepEqual(await page.evaluate(() => window.__workspace.closed), ['session-a', 'session-b']);
  assert.equal(await page.evaluate(() => window.__workspace.requests.some(request => ['turn/start', 'turn/steer', 'thread/start'].includes(request.method))), false);

  // An old message on an unloaded page is restored by identity, not stale pixel position.
  await page.goto(`${url}/?anchor=1`);
  await page.waitForFunction(() => typeof window.__workspace.releaseHistory === 'function');
  await page.evaluate(() => window.__workspace.releaseHistory());
  await page.waitForFunction(() => window.__workspace.requests.some(request => request.method === 'thread/items/list' && request.params.cursor === 'older-page'));
  await view().getByText('Исторический запрос 4', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.session-view:not([hidden]) .chat-scroll');
    const anchor = scroller?.querySelector('.message[data-item-id="answer-3"]');
    return anchor && Math.abs(anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 24) < 3;
  });
  assert.ok(await view().locator('.chat-scroll').evaluate(el => el.scrollTop > 500), 'Restored message anchor takes precedence over the obsolete scrollTop=11');
  await waitSavedDraft('session-a', 'Черновик A');
  saved = await latest();
  assert.equal(saved.tabs[0].scrollAnchor.itemId, 'answer-3');
  assert.ok(Math.abs(saved.tabs[0].scrollAnchor.offset + 24) < 3, 'Persist the restored offset within browser subpixel rounding');
  const anchorRequests = await page.evaluate(() => window.__workspace.requests.filter(request => request.method === 'thread/items/list'));
  assert.deepEqual(anchorRequests.map(request => request.params.cursor), [undefined, 'older-page'], 'Load only the history pages needed to locate the saved message');
  assert.equal(await page.evaluate(() => window.__workspace.requests.some(request => ['turn/start', 'turn/steer', 'thread/start'].includes(request.method))), false);
  assert.deepEqual(errors, []);
  console.log('PASS: workspace tab/order/settings/drafts/images/paused queue restore, delayed history scroll and paginated message anchor, background isolation, busy autosave, fresh close checkpoint/freeze without late save, visible save error/retry, interrupted edit/Cancel preserves original draft+image, closed and initially empty workspace, no model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/workspace-state-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
