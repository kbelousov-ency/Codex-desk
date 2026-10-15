import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, isolated bridge and localStorage. No CLI or model requests.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
await mkdir('artifacts', { recursive: true });
// Windows viewers can retain a handle to a prior screenshot. Each run owns its
// output files, so reruns never overwrite an image still open for inspection.
const screenshotDirectory = await mkdtemp(resolve('artifacts', 'executor-auto-review-'));
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/EXECUTOR-AUTO';
    const read = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const known = () => read('auto-threads', []);
    const links = () => read('auto-links', []);
    const titles = () => read('auto-titles', {});
    const stored = read('auto-workspace', null);
    let serial = 0;
    let threads = known().length;
    const f = window.__auto = { sessions: {}, calls: [], snapshots: [], timeline: [], receipts: {}, timeoutNext: false, failSave: false };
    const models = [{ id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const create = (folder = cwd, settings = {}, restoredId) => {
      const id = restoredId || `session-${++serial}`;
      serial = Math.max(serial, Number(id.replace('session-', '')) || 0);
      const state = { id, cwd: folder, settings: { cwd: folder, model: 'fixture', effort: 'high', access: 'workspace-write', ...settings }, listeners: new Set(), threadId: null, turnId: null, closed: false };
      state.emit = (type, data) => { if (!state.closed) for (const fn of state.listeners) fn({ type, data }); };
      state.notify = (method, params) => state.emit('notification', { method, params: { threadId: state.threadId, ...params } });
      state.complete = (status = 'completed', text = '', turnId = state.turnId) => {
        const item = { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text };
        if (text) state.notify('item/completed', { turnId, item });
        const turn = { id: turnId, status, items: text ? [item] : [], error: status === 'failed' ? { message: 'Fixture execution failed' } : null };
        state.notify('turn/completed', { turn });
        if (turnId === state.turnId) {
          write('auto-threads', known().map(thread => thread.id === state.threadId ? { ...thread, turns: [turn] } : thread));
          for (const receipt of Object.values(f.receipts)) if (receipt.turnId === turnId) receipt.status = status;
        }
      };
      state.bridge = {
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async start() { return { initialize: {}, cwd: folder, models, executable: 'fixture', account: {}, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async request(method, params = {}) {
          const call = { sessionId: id, method, params: structuredClone(params) };
          f.calls.push(call);
          if (method === 'thread/list') return { data: known().map(thread => ({ ...thread, name: titles()[thread.id] || thread.name })), nextCursor: null };
          if (method === 'thread/start') {
            const thread = { id: `thread-${++threads}`, cwd: folder, historyMode: 'legacy', turns: [] };
            state.threadId = thread.id;
            write('auto-threads', [...known(), thread]);
            return { thread, model: params.model };
          }
          if (method === 'thread/resume' || method === 'thread/read') {
            const thread = known().find(thread => thread.id === params.threadId);
            if (!thread) throw new Error('Fixture thread not found');
            state.threadId = thread.id;
            return { thread: { ...thread, name: titles()[thread.id] || thread.name, status: { type: 'idle' } }, model: 'fixture', reasoningEffort: 'high' };
          }
          if (method === 'message/status') return f.receipts[params.clientUserMessageId] || { accepted: false, rejected: false };
          if (method === 'turn/start') {
            const text = params.input.find(part => part.type === 'text')?.text || '';
            const automatic = text.startsWith('Авто · результаты исполнителей');
            if (automatic) {
              const snapshot = read('auto-workspace', null);
              const saved = snapshot?.tabs.find(tab => tab.thread?.id === params.threadId)?.executorAutoReview?.delivery;
              f.timeline.push({ kind: 'auto-rpc', id: params.clientUserMessageId, persisted: saved && { id: saved.id, status: saved.status } });
              // Reserved snapshots restore as uncertain, so either durable form
              // fences the exact ID against replay after a crash.
              if (saved?.id !== params.clientUserMessageId || !['reserved', 'uncertain'].includes(saved.status)) throw new Error('Auto delivery reached RPC without its durable reservation');
            }
            state.turnId = crypto.randomUUID();
            const receipt = { accepted: true, turnId: state.turnId, status: 'inProgress' };
            if (automatic && f.timeoutNext) {
              f.timeoutNext = false;
              f.timedOut = { sessionId: id, messageId: params.clientUserMessageId, receipt };
              f.receipts[params.clientUserMessageId] = { accepted: false, rejected: false };
              throw new Error('Request timed out');
            }
            f.receipts[params.clientUserMessageId] = receipt;
            state.notify('turn/started', { turn: { id: state.turnId, status: 'inProgress', items: [] } });
            state.notify('item/completed', { turnId: state.turnId, item: { id: `user-${params.clientUserMessageId}`, type: 'userMessage', clientUserMessageId: params.clientUserMessageId, content: params.input } });
            return { turn: { id: state.turnId, status: 'inProgress', items: [] } };
          }
          if (method === 'turn/interrupt') { state.complete('interrupted'); return {}; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        onEvent(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); },
        async respond(id) { state.notify('serverRequest/resolved', { requestId: id }); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      f.sessions[id] = state;
      return { id, cwd: folder };
    };
    const restore = stored ? { kind: 'workspace', activeIndex: stored.activeIndex, tabs: stored.tabs.map(tab => {
      const folder = tab.cwd || tab.thread?.cwd || cwd;
      const session = create(folder, tab.settings, tab.sessionId);
      return { ...tab, id: session.id, cwd: folder };
    }) } : null;
    if (!restore) create(cwd);
    window.codex = {
      ...Object.values(f.sessions)[0].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: Object.values(f.sessions).map(({ id, cwd }) => ({ id, cwd })), ...(restore ? { restore } : {}) }; },
      async listProjectThreads() { return { data: known().map(thread => ({ ...thread, name: titles()[thread.id] || thread.name })), nextCursor: null }; },
      async listThreadChildLinks() { return links(); },
      async createThreadChildLink(options) { const link = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...options }; write('auto-links', [...links(), link]); return { link }; },
      async manageThreadChildLink(options) { const next = links().filter(link => options.action !== 'unlink' || link.childThreadId !== options.childThreadId); write('auto-links', next); return { changed: true }; },
      async manageThread(options) { if (options.action !== 'rename') throw new Error(`Unexpected ${options.action}`); write('auto-titles', { ...titles(), [options.threadId]: options.name }); return { thread: { id: options.threadId, cwd: options.cwd, name: options.name }, affectedThreadIds: [] }; },
      async createSession({ cwd: folder, fromSessionId, settings } = {}) { return create(folder || cwd, { ...f.sessions[fromSessionId]?.settings, ...settings }); },
      async closeSession(id) { f.sessions[id].closed = true; f.sessions[id].listeners.clear(); },
      forSession(id) { return f.sessions[id].bridge; },
      async saveWorkspaceState(snapshot) {
        if (f.failSave) throw new Error('Fixture disk unavailable');
        if (f.holdReservation && snapshot.tabs.some(tab => tab.executorAutoReview?.delivery?.status === 'reserved')) {
          f.holdReservation = false;
          f.heldReservation = structuredClone(snapshot);
          await new Promise(resolve => { f.releaseReservation = resolve; });
        }
        f.snapshots.push(structuredClone(snapshot));
        f.timeline.push({ kind: 'save', deliveries: snapshot.tabs.flatMap(tab => tab.executorAutoReview?.delivery ? [tab.executorAutoReview.delivery] : []) });
        write('auto-workspace', snapshot);
      },
      async completeUpdateRestore() {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const row = () => view().locator('.child-tabs-row');
  const toggle = () => view().getByRole('switch', { name: 'Авто: проверка результатов исполнителей', exact: true });
  const marker = (thread, label = 'Исполнитель завершил работу') => row().locator(`.child-tab[data-thread-id="${thread}"]`).getByLabel(label, { exact: true });
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]')?.dataset.sessionId || '');
  const ready = () => page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]')?.getAttribute('data-value') === 'fixture');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const threadOf = id => page.evaluate(id => window.__auto.sessions[id].threadId, id);
  const turnOf = id => page.evaluate(id => window.__auto.sessions[id].turnId, id);
  const autos = () => page.evaluate(() => window.__auto.calls.filter(call => call.method === 'turn/start' && call.params.input[0]?.text.startsWith('Авто · результаты исполнителей')));
  const waitAutos = count => page.waitForFunction(count => window.__auto.calls.filter(call => call.method === 'turn/start' && call.params.input[0]?.text.startsWith('Авто · результаты исполнителей')).length === count, count);
  const waitSent = () => page.waitForFunction(() => {
    const latest = window.__auto.calls.filter(call => call.method === 'turn/start' && call.params.input[0]?.text.startsWith('Авто · результаты исполнителей')).at(-1);
    return latest && JSON.parse(localStorage.getItem('auto-workspace') || '{}').tabs?.some(tab => tab.executorAutoReview?.delivery?.id === latest.params.clientUserMessageId && tab.executorAutoReview.delivery.status === 'sent');
  });
  const complete = (id, text = '', state = 'completed', turnId) => page.evaluate(({ id, text, state, turnId }) => window.__auto.sessions[id].complete(state, text, turnId), { id, text, state, turnId });
  const selectParent = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const selectThread = async thread => { await row().locator(`.child-tab[data-thread-id="${thread}"]`).click(); await ready(); return activeId(); };
  const begin = async text => { await input().fill(text); await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click(); await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor(); };

  await ready();
  const parent = await activeId();
  await begin('Родитель: исходная задача');
  await complete(parent, 'Начальный ответ родителя');
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor({ state: 'hidden' });
  const parentThread = await threadOf(parent);
  await begin('Родитель занят до готовности исполнителей');
  await input().fill('Пользовательская очередь имеет приоритет');
  await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click();
  await input().fill('Личный черновик родителя');
  await page.locator(`.session-tab[data-session-id="${parent}"] .session-tab-child`).click();
  await ready();
  const agentA = await activeId();
  assert.equal(await toggle().getAttribute('aria-checked'), 'false', 'Auto defaults off');
  assert.equal(await page.locator('.executor-review-status').count(), 0, 'No additional status panel is drawn');
  await begin('Задание A');
  const threadA = await threadOf(agentA);
  await selectParent(parent);
  await row().locator('.child-tab-create').click(); await ready();
  const agentB = await activeId();
  await input().fill('Черновик задания B');
  await toggle().click();
  assert.equal(await toggle().getAttribute('aria-checked'), 'true');
  assert.equal(await marker(threadA).count(), 0, 'Running executor has no completion marker');
  await complete(agentA, 'Отчёт A: проверка реализована.');
  await marker(threadA).waitFor();
  assert.equal((await autos()).length, 0, 'Draft B is still a participant');
  const completedA = await turnOf(agentA);
  await complete(agentA, 'Не подменять старым повтором', 'completed', completedA);
  await row().getByRole('button', { name: 'Закрыть вкладку Агент A', exact: true }).click();
  await page.waitForFunction(id => window.__auto.sessions[id].closed, agentA);
  await begin('Задание B');
  const threadB = await threadOf(agentB);
  await complete(agentB, 'Отчёт B: интерфейс проверен.');
  await marker(threadB).waitFor();
  await settle();
  assert.equal((await autos()).length, 0, 'Busy parent receives no steer or premature start');
  await complete(parent, 'Родитель освободился');
  await page.waitForFunction(parent => window.__auto.calls.some(call => call.sessionId === parent && call.method === 'turn/start' && call.params.input[0]?.text === 'Пользовательская очередь имеет приоритет'), parent);
  assert.equal((await autos()).length, 0, 'User queue starts before automatic review');
  await complete(parent, 'Очередь пользователя завершена');
  await waitAutos(1);
  assert.equal(await activeId(), agentB, 'Parent sends in the background without stealing focus');
  let auto = (await autos())[0];
  assert.equal(auto.sessionId, parent);
  assert.equal(auto.params.threadId, parentThread);
  assert.equal(auto.params.model, 'fixture');
  assert.equal(auto.params.effort, 'high');
  assert.match(auto.params.input[0].text, /Отчёт A: проверка реализована/);
  assert.match(auto.params.input[0].text, /Отчёт B: интерфейс проверен/);
  assert.doesNotMatch(auto.params.input[0].text, /Не подменять старым повтором/);
  await complete(agentB, 'Повтор B'); await settle();
  assert.equal((await autos()).length, 1, 'Duplicate completion does not send again');
  await selectParent(parent);
  assert.equal(await input().inputValue(), 'Личный черновик родителя', 'Auto preserves parent draft');
  await waitSent();
  await page.screenshot({ path: resolve(screenshotDirectory, 'sent.png') });

  // A fresh task starts another round; the closed, idle A does not block it.
  await selectThread(threadB); await begin('Повторное задание B');
  assert.equal(await marker(threadB).count(), 0, 'A new task clears its previous completion marker');
  await complete(agentB, 'Второй отчёт B');
  await marker(threadB).waitFor();
  await toggle().click();
  assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await complete(parent, 'Первая проверка завершена'); await settle();
  assert.equal((await autos()).length, 1, 'Disabling cancels the waiting delivery');

  // Reopen A, then include both failure and interruption in one honest summary.
  const reopenedA = await selectThread(threadA);
  assert.notEqual(reopenedA, agentA);
  await selectParent(parent); await begin('Родитель снова занят');
  await input().fill('Личный черновик родителя');
  await toggle().click();
  await selectThread(threadA); await begin('Задание A завершится ошибкой');
  await selectThread(threadB); await begin('Задание B будет остановлено');
  await complete(reopenedA, 'A: обнаружен сбой', 'failed');
  await complete(agentB, '', 'interrupted');
  await marker(threadA, 'Исполнитель завершился с ошибкой').waitFor();
  await marker(threadB, 'Исполнитель остановлен').waitFor();
  await complete(parent, 'Готов проверить исходы');
  await waitAutos(2);
  auto = (await autos())[1];
  assert.match(auto.params.input[0].text, /Агент A — Ошибка/);
  assert.match(auto.params.input[0].text, /Агент B — Остановлен/);
  assert.match(auto.params.input[0].text, /Fixture execution failed/);
  assert.match(auto.params.input[0].text, /Итоговый отчёт не получен/);

  // Timeout retains one ID and needs receipt reconciliation, never an automatic retry.
  await begin('Задание для проверки поздней квитанции');
  await complete(agentB, 'Отчёт для timeout');
  await page.evaluate(() => { window.__auto.timeoutNext = true; });
  await complete(parent, 'Вторая проверка завершена');
  await waitAutos(3);
  await settle();
  assert.equal((await autos()).length, 3);
  await selectParent(parent);
  await row().getByRole('button', { name: 'Проверить отправку сводки', exact: true }).waitFor();
  await page.evaluate(() => {
    const f = window.__auto, late = f.timedOut;
    f.receipts[late.messageId] = { ...late.receipt, status: 'completed' };
    f.sessions[late.sessionId].notify('message/receipt', { clientUserMessageId: late.messageId, accepted: true, turnId: late.receipt.turnId, status: 'completed' });
  });
  await row().getByRole('button', { name: 'Проверить отправку сводки', exact: true }).click();
  await waitSent();
  assert.equal((await autos()).length, 3, 'Late acknowledgement does not repeat the request');

  // A child can invalidate the result while the durable reservation is being
  // saved. Releasing that write must discard its frozen text, then try the new
  // round without waiting for another unrelated UI event.
  await toggle().click();
  await selectThread(threadA); await begin('Подготовка A к гонке сохранения');
  await complete(reopenedA, 'Актуальный отчёт A для гонки');
  await selectThread(threadB); await begin('B: первый результат перед записью');
  await page.evaluate(() => { window.__auto.holdReservation = true; });
  await complete(agentB, 'УСТАРЕВШИЙ ОТЧЁТ ДО ПОВТОРНОГО ЗАДАНИЯ');
  await page.waitForFunction(() => Boolean(window.__auto.releaseReservation));
  assert.equal((await autos()).length, 3, 'RPC waits for its checkpoint');
  await begin('B: новое задание пока сохранение ждёт');
  await complete(agentB, 'НОВЫЙ ОТЧЁТ ПОСЛЕ ПОВТОРНОГО ЗАДАНИЯ');
  await page.evaluate(() => window.__auto.releaseReservation());
  await waitAutos(4);
  auto = (await autos())[3];
  assert.match(auto.params.input[0].text, /НОВЫЙ ОТЧЁТ ПОСЛЕ ПОВТОРНОГО ЗАДАНИЯ/);
  assert.doesNotMatch(auto.params.input[0].text, /УСТАРЕВШИЙ ОТЧЁТ ДО ПОВТОРНОГО ЗАДАНИЯ/);
  await complete(agentB, 'Повтор не должен поменять отправленное'); await settle();
  assert.equal((await autos()).length, 4, 'The invalidated reservation resumes once, without hanging or duplication');
  await selectParent(parent);
  await waitSent();
  await complete(parent, 'Проверка нового результата завершена');
  const timeline = await page.evaluate(() => window.__auto.timeline);
  for (const call of timeline.filter(item => item.kind === 'auto-rpc')) {
    assert.equal(call.persisted?.id, call.id, 'The matching durable reservation exists before every auto RPC');
    assert.ok(['reserved', 'uncertain'].includes(call.persisted.status), 'The checkpoint prevents replay after a crash');
    assert.ok(timeline.slice(0, timeline.indexOf(call)).some(item => item.kind === 'save' && item.deliveries.some(delivery => delivery.id === call.id && delivery.status === 'reserved')), 'Reservation was persisted before RPC');
  }
  assert.equal(await page.evaluate(() => window.__auto.calls.filter(call => call.method === 'turn/steer').length), 0);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('auto-workspace')).tabs.some(tab => tab.executorAutoReview?.delivery?.status === 'sent'));
  await page.screenshot({ path: resolve(screenshotDirectory, 'reconciled.png') });
  for (const theme of ['', 'kuzmich']) {
    await page.evaluate(theme => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }, theme);
    await page.screenshot({ path: resolve(screenshotDirectory, `${theme || 'default'}.png`) });
  }
  await page.setViewportSize({ width: 960, height: 800 });
  await page.screenshot({ path: resolve(screenshotDirectory, 'narrow.png') });
  const bounds = await row().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 960, 'The compact executor row fits the narrow window');
  assert.equal(await page.locator('.executor-review-status').count(), 0, 'No status panel replaces the compact row');
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.reload(); await ready();
  await toggle().waitFor();
  assert.equal(await toggle().getAttribute('aria-checked'), 'false', 'Restore never authorizes automatic model work');
  assert.equal(await input().inputValue(), 'Личный черновик родителя');
  assert.deepEqual(await row().locator('.child-tab-label').allTextContents(), ['Агент A', 'Агент B']);
  await settle();
  assert.equal((await autos()).length, 0, 'Restored results produce no new request');
  assert.equal(await page.locator('.executor-review-status').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: executor auto review default off; running task and draft roster; exact reports, closed result retained; busy/background parent; user queue priority and draft preservation; duplicate events; next round/off cancellation; failed/interrupted; durable reservation before RPC; timeout/late ACK without retry; new child task during delayed checkpoint drops the stale report and resumes once; both themes/narrow layout; saved workspace/links restore with Auto off. Fixture only, no models.');
  console.log(`Screenshots: ${screenshotDirectory}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(screenshotDirectory, 'failure.png') });
    console.error(await page.locator('body').innerText());
    console.error(JSON.stringify(await page.evaluate(() => ({ calls: window.__auto?.calls.filter(call => call.method === 'turn/start'), saved: JSON.parse(localStorage.getItem('auto-workspace') || 'null') })), null, 2));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(done => server.close(done));
}
