import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with deterministic scoped bridges. No real Codex process,
// provider call, user configuration or stored history is used by this fixture.
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
const errors = [];
const choices = ['workspace-write', 'auto', 'danger-full-access'];
const labels = ['Спрашивать разрешение', 'Одобрять за меня', 'Полный доступ'];
const cwd = 'C:/Fixtures/Access Project';
const accessKeys = ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy'];
const accessFields = params => Object.fromEntries(accessKeys.filter(key => key in params).map(key => [key, params[key]]));
const expected = (mode, turn = false, path = cwd) => {
  if (mode === 'inherited') return {};
  const common = { approvalPolicy: mode === 'danger-full-access' ? 'never' : 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
  if (!turn) return { ...common, sandbox: mode === 'auto' ? 'workspace-write' : mode };
  return { ...common, sandboxPolicy: mode === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [path], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
};
const access = () => page.locator('[role="combobox"][aria-label="Режим доступа"]:visible');
const menu = () => page.getByRole('listbox', { name: 'Выберите режим доступа', exact: true });
const input = () => page.getByRole('textbox', { name: 'Сообщение Codex', exact: true });
const ready = () => page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Режим доступа"]')].some(node => node.getClientRects().length && !node.disabled));
const calls = () => page.evaluate(() => window.__access.sessions[window.__access.active || 'session-1'].requests);
const lastCall = async method => (await calls()).filter(call => call.method === method).at(-1)?.params;
const select = async value => { await access().click(); await menu().locator(`[data-value="${value}"]`).click(); };
const finish = async () => { await page.evaluate(() => window.__access.sessions[window.__access.active || 'session-1'].finish()); await ready(); };
const send = async text => { await input().fill(text); await input().press('Enter'); await page.getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor(); };

async function openFixture(savedAccess, tabs = false) {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ savedAccess, tabs }) => {
    const models = [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const sessions = {};
    const create = (id, cwd, access) => {
      const state = { id, cwd, settings: { cwd, model: 'fixture-model', effort: 'high', ...(access === undefined ? {} : { access }) }, patches: [], requests: [], listeners: new Set(), count: 0, threadId: null, activeTurn: null };
      const history = { id: `history-${id}`, name: `Сохранённый диалог ${id}`, cwd, historyMode: 'legacy' };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.finish = () => state.emit('turn/completed', { threadId: state.threadId, turn: { ...state.activeTurn, status: 'completed', items: [], error: null } });
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Fixtures/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-model', model_reasoning_effort: 'high', approval_policy: 'never', sandbox_mode: 'danger-full-access' } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { state.patches.push({ ...patch }); Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [history], nextCursor: null };
          if (method === 'thread/start') { state.threadId = `new-${id}`; return { model: 'fixture-model', thread: { id: state.threadId, cwd, turns: [] } }; }
          if (method === 'thread/resume') {
            state.threadId = params.threadId;
            return { model: 'fixture-model', reasoningEffort: 'high', thread: { ...history, status: { type: 'idle' }, turns: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-answer', type: 'agentMessage', text: 'Сохранённый ответ' }] }] } };
          }
          if (method === 'turn/start') { state.activeTurn = { id: `turn-${++state.count}`, status: 'inProgress', items: [] }; state.emit('turn/started', { threadId: state.threadId, turn: state.activeTurn }); return { turn: state.activeTurn }; }
          throw new Error(`Unexpected access fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async respond() {}, async saveImages() { return []; }, async readAttachment() { return null; },
        async openPath() {}, async showPathMenu() {}, async chooseDirectory() { return null; }, async chooseExecutable() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
      sessions[id] = state;
    };
    create('session-1', 'C:/Fixtures/Access Project', savedAccess);
    if (tabs) create('session-2', 'C:/Fixtures/Another Project', 'workspace-write');
    window.__access = { sessions, active: 'session-1' };
    window.codex = { ...sessions['session-1'].bridge };
    if (tabs) Object.assign(window.codex, {
      async getWorkspace() { return { projects: Object.values(sessions).map(state => state.cwd), sessions: Object.values(sessions).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      forSession(id) { return sessions[id].bridge; },
    });
  }, { savedAccess, tabs });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await ready();
}

async function assertMenu(mode, legacy = false) {
  await access().click();
  assert.deepEqual(await menu().getByRole('option').evaluateAll(nodes => nodes.map(node => node.dataset.value)), choices);
  assert.deepEqual(await menu().locator('strong').allTextContents(), labels);
  for (const description of await menu().locator('small').allTextContents()) assert.ok(description.length > 20, 'Each access choice explains its effect');
  assert.equal(await menu().getByRole('option', { selected: true }).count(), legacy ? 0 : 1);
  if (legacy) {
    assert.equal(await menu().locator('.highlighted').getAttribute('data-value'), 'workspace-write');
    assert.match(await page.locator('.access-current-note').innerText(), /Сейчас:.*(?:Только чтение|Как в Codex)/s);
  } else assert.equal(await menu().getByRole('option', { selected: true }).getAttribute('data-value'), mode);
  await page.keyboard.press('Escape');
  assert.equal(await access().evaluate(node => node === document.activeElement), true);
}

try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const scenario of [
    { name: 'default', saved: undefined, mode: 'workspace-write' },
    { name: 'saved-manual', saved: 'workspace-write', mode: 'workspace-write' },
    { name: 'saved-auto', saved: 'auto', mode: 'auto' },
    { name: 'saved-full', saved: 'danger-full-access', mode: 'workspace-write' },
    { name: 'confirmed-full', saved: undefined, mode: 'danger-full-access', confirm: true },
    { name: 'legacy-read', saved: 'read-only', mode: 'read-only', legacy: true },
    { name: 'legacy-inherited', saved: 'inherited', mode: 'inherited', legacy: true },
  ]) {
    await openFixture(scenario.saved);
    if (scenario.confirm) {
      await select('danger-full-access');
      assert.equal(await access().getAttribute('data-value'), 'workspace-write', 'Opening confirmation does not grant full access');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await access().getAttribute('data-value'), 'workspace-write', 'Cancelling leaves access unchanged');
      await access().focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Включить полный доступ', exact: true }).click();
    }
    assert.equal(await access().getAttribute('data-value'), scenario.mode, scenario.name);
    if (scenario.legacy) assert.match(await access().innerText(), scenario.mode === 'read-only' ? /Только чтение/ : /Как в Codex/);
    await assertMenu(scenario.mode, scenario.legacy);
    assert.equal((await calls()).filter(call => /^(thread|turn)\/start$/.test(call.method)).length, 0, 'Inspecting or changing permissions never invokes the model');
    assert.equal(await page.evaluate(() => window.__access.sessions['session-1'].patches.some(patch => 'model' in patch || 'effort' in patch)), false, 'Access controls never change configured model or effort');
    if (!scenario.confirm) assert.equal(await page.evaluate(() => window.__access.sessions['session-1'].patches.some(patch => 'access' in patch)), false, 'Bootstrap and merely opening a legacy menu do not rewrite saved access');

    await send(`Проверка режима ${scenario.name}`);
    assert.deepEqual(accessFields(await lastCall('thread/start')), expected(scenario.mode), `${scenario.name}: thread/start policy`);
    let params = await lastCall('turn/start');
    assert.deepEqual(accessFields(params), expected(scenario.mode, true), `${scenario.name}: turn/start policy`);
    assert.equal(params.model, 'fixture-model'); assert.equal(params.effort, 'high');
    assert.deepEqual(params.input, [{ type: 'text', text: `Проверка режима ${scenario.name}`, text_elements: [] }], 'Only visible user input is sent');
    assert.equal(await access().isDisabled(), true, 'Access cannot change during an active task');
    await finish();
    await page.getByRole('button', { name: 'Сохранённый диалог session-1', exact: true }).click();
    await page.getByText('Сохранённый ответ', { exact: true }).waitFor();
    assert.deepEqual(accessFields(await lastCall('thread/resume')), expected(scenario.mode), `${scenario.name}: thread/resume policy`);
    await send(`Продолжение ${scenario.name}`);
    params = await lastCall('turn/start');
    assert.equal(params.threadId, 'history-session-1');
    assert.deepEqual(accessFields(params), expected(scenario.mode, true), `${scenario.name}: resumed turn policy`);
    await finish();
    if (scenario.legacy) {
      await access().focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
      assert.equal(await access().getAttribute('data-value'), 'workspace-write');
      await send('Явно выбран ручной режим');
      assert.deepEqual(accessFields(await lastCall('turn/start')), expected('workspace-write', true), 'Leaving legacy settings explicitly applies the selected primary policy');
      await finish();
    }
  }

  await openFixture(undefined, true);
  const activate = async id => {
    await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click();
    await page.evaluate(id => { window.__access.active = id; }, id); await ready();
  };
  await access().click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await access().getAttribute('data-value'), 'auto');
  await access().click(); await activate('session-2');
  assert.equal(await menu().count(), 0, 'Switching tabs closes the previous session menu');
  assert.equal(await access().getAttribute('data-value'), 'workspace-write', 'A separate tab keeps its manual policy');
  await activate('session-1'); assert.equal(await access().getAttribute('data-value'), 'auto');
  await access().click();
  await page.evaluate(() => { const state = window.__access.sessions['session-1']; state.activeTurn = { id: 'external-turn', status: 'inProgress', items: [] }; state.emit('turn/started', { turn: state.activeTurn }); });
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) [aria-label="Режим доступа"]').disabled);
  assert.equal(await menu().count(), 0, 'An incoming task closes an already open menu');
  await finish();
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }, { width: 650, height: 600 }]) {
    await page.setViewportSize(size); await access().click();
    const box = await page.locator('.access-menu').evaluate(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: innerHeight, width: innerWidth, visible: node.contains(hit) }; });
    assert.ok(box.top >= 0 && box.left >= 0 && box.right <= box.width + 1 && box.bottom <= box.height + 1 && box.visible, `Access menu fits ${size.width}px: ${JSON.stringify(box)}`);
    await page.screenshot({ path: `artifacts/access-menu-${size.width}.png` });
    await page.keyboard.press('Escape');
  }
  await send('Автоматический режим вкладки A');
  assert.deepEqual(accessFields(await lastCall('turn/start')), expected('auto', true));
  await activate('session-2'); await send('Ручной режим вкладки B');
  assert.deepEqual(accessFields(await lastCall('turn/start')), expected('workspace-write', true, 'C:/Fixtures/Another Project'));
  assert.deepEqual(errors, []);
  console.log('PASS: three access choices; keyboard and full confirmation; explicit manual default and saved-full reset; legacy settings preserved; exact thread/start, turn/start and thread/resume policies; busy locks and tab isolation; 1440/940/650px layout. Fixture bridges only, no model or user data.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/access-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
