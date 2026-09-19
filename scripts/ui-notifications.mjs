import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Real renderer and App Server event handling, isolated bridge. No model requests or native toasts.
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
    const query = new URL(location.href).searchParams;
    const defaults = { enabled: true, sound: false, completed: true, question: true, approval: true, error: true };
    const fixture = window.__notifications = {
      sessions: {}, calls: [], saves: [], requests: [], delivered: [], settingWrites: [],
      focusListeners: new Set(), activationListeners: new Set(), focused: true,
      context: {}, supported: !query.has('unsupported'), failLoad: query.has('load-error'), failSave: false,
      settings: { ...defaults, ...JSON.parse(localStorage.getItem('fixture-notifications') || '{}') },
    };
    fixture.focus = focused => {
      fixture.focused = focused;
      for (const listener of fixture.focusListeners) listener(focused);
    };
    fixture.activate = sessionId => { for (const listener of fixture.activationListeners) listener({ sessionId }); };
    const cwd = 'C:/Fixtures/NOTIFICATIONS';
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    for (const id of ['a', 'b']) {
      const state = fixture.sessions[id] = { listeners: new Set(), turn: null };
      const thread = state.thread = { id: `thread-${id}`, cwd, name: `Задача ${id}`, turns: [{ id: `historical-${id}`, status: 'completed', items: [{ id: `answer-${id}`, type: 'agentMessage', text: `Сохранённый ответ ${id}` }] }] };
      state.emit = (method, params = {}) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: thread.id, ...params } } }); };
      state.begin = turnId => { state.turn = turnId; state.emit('turn/started', { turn: { id: turnId, status: 'inProgress' } }); };
      state.complete = (status = 'completed', error = null) => state.emit('turn/completed', { turn: { id: state.turn, status, error } });
      state.request = (requestId, method, params = {}) => { for (const listener of state.listeners) listener({ type: 'serverRequest', data: { id: requestId, method, params: { threadId: thread.id, turnId: state.turn, ...params } } }); };
      state.status = value => { for (const listener of state.listeners) listener({ type: 'status', data: { state: value } }); };
      state.bridge = {
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'workspace-write' }; }, async setSettings() {},
        async start() { return { cwd, models: [model], executable: 'fixture', account: {}, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async request(method, params = {}) {
          fixture.calls.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
          if (method === 'thread/compact/start') {
            state.begin(`compact-${id}`);
            return {};
          }
          if (method === 'turn/start' && params.input?.[0]?.text === 'Проверочный пинг уведомлений') {
            state.begin(`ping-${id}`);
            return { turn: { id: state.turn, status: 'inProgress' } };
          }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond(requestId, result) { fixture.calls.push({ sessionId: id, method: 'respond', requestId, result }); state.emit('serverRequest/resolved', { requestId }); },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; }, async readAttachment() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [], restore: { kind: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd, thread: state.thread })) } }; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async listProjectThreads() { return { data: Object.values(fixture.sessions).map(state => state.thread), nextCursor: null }; },
      async saveWorkspaceState(snapshot) { fixture.saves.push(structuredClone(snapshot)); },
      async completeUpdateRestore() {},
      async getNotificationSettings() {
        if (fixture.failLoad) throw new Error('fixture settings unavailable');
        return { settings: structuredClone(fixture.settings), supported: fixture.supported };
      },
      async setNotificationSettings(patch) {
        fixture.settingWrites.push(structuredClone(patch));
        if (fixture.failSave) throw new Error('fixture disk unavailable');
        Object.assign(fixture.settings, patch);
        localStorage.setItem('fixture-notifications', JSON.stringify(fixture.settings));
        return { settings: structuredClone(fixture.settings), supported: fixture.supported };
      },
      async setNotificationContext(context) { fixture.context = structuredClone(context); },
      async getWindowFocus() { return fixture.focused; },
      onWindowFocus(listener) { fixture.focusListeners.add(listener); return () => fixture.focusListeners.delete(listener); },
      onNotificationActivated(listener) { fixture.activationListeners.add(listener); return () => fixture.activationListeners.delete(listener); },
      async notifySession(event) {
        fixture.requests.push(structuredClone(event));
        if (fixture.supported && fixture.settings.enabled && fixture.settings[event.kind] && !(fixture.focused && fixture.context.activeSessionId === event.sessionId)) fixture.delivered.push(structuredClone(event));
      },
    };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const view = () => page.locator('.session-view:visible');
  const tab = id => page.locator(`.session-tab[data-session-id="${id}"]`);
  const unread = id => tab(id).getByLabel('Непрочитанный результат', { exact: true });
  const selected = () => page.getByRole('tab', { selected: true }).evaluate(node => node.closest('[data-session-id]').dataset.sessionId);
  const activate = id => tab(id).getByRole('tab').click();
  const attention = () => page.getByRole('button', { name: /^Требуют внимания/ });
  const openAttention = async () => { if (await attention().getAttribute('aria-expanded') !== 'true') await attention().click(); };
  const event = (id, action, args = []) => page.evaluate(({ id, action, args }) => window.__notifications.sessions[id][action](...args), { id, action, args });
  const delivered = () => page.evaluate(() => window.__notifications.delivered);
  const settingsButton = () => page.getByRole('button', { name: 'Настройки уведомлений', exact: true });
  const settings = () => page.getByRole('dialog', { name: 'Быть в курсе задач', exact: true });
  await view().getByText('Сохранённый ответ a', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__notifications.calls.filter(call => call.method === 'thread/resume').length === 2 && window.__notifications.context.activeSessionId === 'a');
  await settle();
  assert.equal((await delivered()).length, 0, 'Restored history must not cause notifications');
  assert.equal(await page.getByLabel('Непрочитанный результат', { exact: true }).count(), 0);
  await event('b', 'emit', ['turn/completed', { turn: { id: 'historical-b', status: 'completed' } }]);
  await event('b', 'begin', ['interrupted-b']);
  await event('b', 'emit', ['error', { turnId: 'interrupted-b', error: { message: 'Transient retry' }, willRetry: true }]);
  await event('b', 'complete', ['interrupted']);
  await settle();
  assert.equal((await delivered()).length, 0, 'Replayed history, retrying errors and interrupted turns do not notify');
  assert.equal(await page.locator('.tab-unread').count(), 0);

  // Real compact command and manual cache ping finish in the background, not hidden by focus suppression.
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('/compact');
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).press('Enter');
  await page.waitForFunction(() => window.__notifications.calls.some(call => call.method === 'thread/compact/start'));
  await tab('a').getByLabel('Выполняется', { exact: true }).waitFor();
  await activate('b');
  await event('a', 'emit', ['item/completed', { turnId: 'compact-a', item: { id: 'compact-item-a', type: 'contextCompaction' } }]);
  await event('a', 'complete');
  await tab('a').getByLabel('Готов', { exact: true }).waitFor();
  await settle();
  assert.equal((await delivered()).length, 0, 'A background successful compaction does not notify');
  assert.equal(await page.locator('.tab-unread').count(), 0);
  await activate('a');
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  await view().getByRole('textbox', { name: 'Текст пинга', exact: true }).fill('Проверочный пинг уведомлений');
  await view().getByRole('button', { name: 'Пинг сейчас', exact: true }).click();
  await page.waitForFunction(() => window.__notifications.calls.some(call => call.method === 'turn/start'));
  await tab('a').getByLabel('Выполняется', { exact: true }).waitFor();
  await view().locator('.user-text').filter({ hasText: /^Проверочный пинг уведомлений$/ }).waitFor();
  await activate('b');
  await event('a', 'complete');
  await tab('a').getByLabel('Готов', { exact: true }).waitFor();
  await settle();
  assert.equal((await delivered()).length, 0, 'A background cache ping completion does not notify');
  assert.equal(await page.locator('.tab-unread').count(), 0);
  assert.equal(await page.evaluate(() => window.__notifications.requests.length), 0, 'Silent maintenance never even requests a native notification');
  await activate('a');

  // Focused visible conversation is already being read, regardless of host suppression details.
  await event('a', 'begin', ['visible-a']); await event('a', 'complete'); await settle();
  assert.equal((await delivered()).length, 0);
  assert.equal(await unread('a').count(), 0);
  await event('b', 'begin', ['background-b']); await event('b', 'complete');
  await unread('b').waitFor();
  await page.waitForFunction(() => window.__notifications.delivered.length === 1);
  assert.equal((await delivered())[0].sessionId, 'b'); assert.equal((await delivered())[0].kind, 'completed');
  await event('b', 'complete');
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).fill('Черновик вызывает перерисовку');
  await settle(); assert.equal((await delivered()).length, 1, 'Repeated completion and rerender must not duplicate a toast');
  await openAttention();
  await page.locator('.attention-item').filter({ hasText: 'Задача b' }).click();
  assert.equal(await selected(), 'b'); await unread('b').waitFor({ state: 'hidden' });

  // Losing native window focus makes the active tab unread; regaining it clears the marker.
  await page.evaluate(() => window.__notifications.focus(false));
  await event('b', 'begin', ['unfocused-b']); await event('b', 'complete');
  await unread('b').waitFor();
  await page.waitForFunction(() => window.__notifications.delivered.length === 2);
  await page.evaluate(() => window.__notifications.focus(true));
  await unread('b').waitFor({ state: 'hidden' });

  // Permission requests stay in the attention list until actually resolved, even after reading.
  await event('a', 'begin', ['approval-a']);
  await event('a', 'request', ['approve-a', 'item/commandExecution/requestApproval', { command: 'fixture command' }]);
  await page.waitForFunction(() => window.__notifications.delivered.length === 3);
  assert.equal((await delivered()).at(-1).kind, 'approval');
  await event('a', 'request', ['approve-a', 'item/commandExecution/requestApproval', { command: 'fixture command' }]);
  await settle(); assert.equal((await delivered()).length, 3);
  await page.evaluate(() => window.__notifications.activate('a'));
  await view().getByText('Нужно ваше решение', { exact: true }).waitFor();
  assert.equal(await selected(), 'a');
  await openAttention();
  await page.locator('.attention-item').filter({ hasText: 'Задача a' }).waitFor();
  await attention().click();
  await view().getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await view().getByText('Нужно ваше решение', { exact: true }).waitFor({ state: 'hidden' });
  await event('a', 'complete');

  // Questions route to the correct tab and do not auto-answer it.
  await event('b', 'begin', ['question-b']);
  await event('b', 'request', ['question-b', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Какой формат сохранить?', options: [{ label: 'Прежний', description: 'Оставить совместимость' }] }] }]);
  await page.waitForFunction(() => window.__notifications.delivered.length === 4);
  assert.equal((await delivered()).at(-1).kind, 'question');
  assert.equal(await page.evaluate(() => window.__notifications.calls.filter(call => call.method === 'respond').length), 1);
  await openAttention(); await page.locator('.attention-item').filter({ hasText: 'Задача b' }).click();
  await view().getByText('Какой формат сохранить?', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'Пропустить', exact: true }).click();
  await event('b', 'complete');

  // A failed background turn creates one error notification; a foreign thread is ignored.
  await event('a', 'begin', ['failed-a']);
  await event('a', 'complete', ['failed', { message: 'Fixture task failed' }]);
  await tab('a').getByLabel('Непрочитанное событие', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__notifications.delivered.length === 5);
  assert.equal((await delivered()).at(-1).kind, 'error');
  await event('a', 'emit', ['turn/completed', { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'completed' } }]);
  await settle(); assert.equal((await delivered()).length, 5);
  await activate('a'); await tab('a').getByLabel('Непрочитанное событие', { exact: true }).waitFor({ state: 'hidden' });

  // Reconnecting errors remain visible; repeated disconnected status is one incident.
  await event('b', 'status', ['disconnected']);
  await page.waitForFunction(() => window.__notifications.delivered.length === 6);
  assert.equal((await delivered()).at(-1).kind, 'error');
  await event('b', 'status', ['disconnected']); await settle();
  assert.equal((await delivered()).length, 6);
  await openAttention();
  await page.locator('.attention-item').filter({ hasText: 'Задача b' }).waitFor();
  await page.screenshot({ path: 'artifacts/notifications-attention.png' });
  await page.setViewportSize({ width: 940, height: 640 });
  const bounds = await page.locator('.attention-menu').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }; });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, 'Attention menu fits narrow windows');
  await attention().click();

  // Changes persist, failed saves show the old value and can retry, keyboard focus stays in modal.
  await settingsButton().click();
  await settings().getByRole('checkbox', { name: 'Звук', exact: true }).waitFor();
  assert.equal(await settings().getByRole('checkbox', { name: 'Звук', exact: true }).isChecked(), false);
  await settings().getByRole('checkbox', { name: 'Звук', exact: true }).check();
  await page.waitForFunction(() => window.__notifications.settings.sound === true);
  await page.evaluate(() => { window.__notifications.failSave = true; });
  await settings().getByRole('checkbox', { name: 'Завершение задач', exact: true }).click();
  await settings().getByRole('alert').waitFor();
  assert.equal(await settings().getByRole('checkbox', { name: 'Завершение задач', exact: true }).isChecked(), true);
  await page.evaluate(() => { window.__notifications.failSave = false; });
  await settings().getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  await page.waitForFunction(() => window.__notifications.settings.completed === false);
  await settings().getByRole('alert').waitFor({ state: 'hidden' });
  await settings().getByRole('button', { name: 'Готово', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Закрыть настройки уведомлений');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Готово');
  await page.screenshot({ path: 'artifacts/notifications-settings-940.png' });
  await page.keyboard.press('Escape'); await settings().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Настройки уведомлений');

  // Disabling a toast category leaves unread results operational.
  await activate('b');
  await event('a', 'begin', ['disabled-completion-a']); await event('a', 'complete');
  await unread('a').waitFor(); await settle();
  assert.equal((await delivered()).length, 6);
  await settingsButton().click();
  assert.equal(await settings().getByRole('checkbox', { name: 'Звук', exact: true }).isChecked(), true);
  assert.equal(await settings().getByRole('checkbox', { name: 'Завершение задач', exact: true }).isChecked(), false);
  await settings().getByRole('checkbox', { name: 'Уведомления Windows', exact: true }).uncheck();
  await page.waitForFunction(() => window.__notifications.settings.enabled === false);
  assert.equal(await settings().getByRole('checkbox', { name: 'Вопросы агентов', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await event('a', 'begin', ['disabled-question-a']);
  await event('a', 'request', ['disabled-question', 'item/tool/requestUserInput', { questions: [] }]);
  await openAttention(); await page.locator('.attention-item').filter({ hasText: 'Задача a' }).waitFor();
  await settle(); assert.equal((await delivered()).length, 6);
  assert.equal(await page.evaluate(() => window.__notifications.calls.some(call => ['turn/steer', 'thread/start'].includes(call.method))), false);
  assert.deepEqual(await page.evaluate(() => window.__notifications.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text)), ['Проверочный пинг уведомлений'], 'Only the explicit fixture ping submits a turn');

  // A native click and immediate focus event belong to the clicked tab, not the previously selected one.
  await page.goto(url);
  await view().getByText('Сохранённый ответ a', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__notifications.calls.filter(call => call.method === 'thread/resume').length === 2 && window.__notifications.context.activeSessionId === 'a');
  await settle();
  const beforeNativeRace = (await delivered()).length;
  await page.evaluate(() => window.__notifications.focus(false));
  await event('a', 'begin', ['native-focus-race-a']); await event('a', 'complete');
  await event('b', 'begin', ['native-focus-race-b']); await event('b', 'complete');
  await unread('a').waitFor(); await unread('b').waitFor();
  await page.evaluate(() => { window.__notifications.activate('b'); window.__notifications.focus(true); });
  await unread('b').waitFor({ state: 'hidden' });
  assert.equal(await selected(), 'b');
  await unread('a').waitFor();
  assert.equal((await delivered()).length, beforeNativeRace, 'Disabled system notifications remain disabled during activation');

  // A new renderer restores preferences, reports unsupported toasts, and can recover load failure.
  await page.goto(`${url}/?unsupported=1&load-error=1`);
  await view().getByText('Сохранённый ответ a', { exact: true }).waitFor();
  await settingsButton().click();
  await settings().getByRole('alert').waitFor();
  await page.evaluate(() => { window.__notifications.failLoad = false; });
  await settings().getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await settings().getByText('Системные уведомления недоступны.', { exact: false }).waitFor();
  assert.equal(await settings().getByRole('checkbox', { name: 'Уведомления Windows', exact: true }).isChecked(), false);
  assert.equal(await settings().getByRole('checkbox', { name: 'Звук', exact: true }).isChecked(), true);
  assert.equal(await settings().getByRole('checkbox', { name: 'Завершение задач', exact: true }).isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: history silence, background compact/cache ping silence, active/focused suppression, background unread, native focus and activation ordering, attention navigation, persistent pending questions/approvals, native activation, dedupe, failure/disconnect, category/master switches independent from unread, preference persistence and retry, unsupported OS, modal keyboard focus, narrow layout. Isolated bridge only; no model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/notifications-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
