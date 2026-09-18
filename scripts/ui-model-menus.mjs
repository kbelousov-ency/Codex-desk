import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with scoped deterministic bridges, without model requests.
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const sessions = {};
    const projects = ['C:/Fixtures/PROJECT_A', 'C:/Fixtures/PROJECT_B'];
    const makeModel = (model, displayName, efforts = ['medium', 'high'], extra = {}) => ({
      id: model, model, displayName, inputModalities: ['text', 'image'], defaultReasoningEffort: 'high',
      supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `Fixture ${reasoningEffort}` })), ...extra,
    });
    const models = [
      makeModel('fixture-alpha', 'GPT-6-Astra', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      makeModel('fixture-beta', 'GPT-5.6-Sol'),
      makeModel('fixture-hidden', 'Hidden model', ['high'], { hidden: true }),
    ];
    const longModels = Array.from({ length: 30 }, (_, i) => makeModel(`fixture-${i + 1}`, `Модель ${i + 1} — длинное название для проверки списка`));
    const make = (id, cwd, settings, available = models) => {
      const state = { id, cwd, models: available, settings: { cwd, access: 'workspace-write', ...settings }, patches: [], requests: [], listeners: new Set() };
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models: available, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: settings.model, model_reasoning_effort: settings.effort } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { state.patches.push({ ...patch }); Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: [], nextCursor: null };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async openPath() {}, async showPathMenu() {}, async respond() {},
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; },
        async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
    };
    make('session-1', projects[0], { model: 'fixture-alpha', effort: 'ultra' });
    make('session-2', projects[1], { model: 'provider-special', effort: 'provider-effort' });
    make('session-3', projects[0], { model: 'fixture-30', effort: 'high' }, longModels);
    make('session-4', projects[1], { model: 'fixture-alpha', effort: 'future-effort' });
    window.__modelMenus = { sessions, projects };
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects, sessions: Object.values(sessions).map(({ id, cwd }) => ({ id, cwd })) }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession() { throw new Error('This regression does not create sessions'); },
      async closeSession() { throw new Error('This regression does not close sessions'); },
      forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const select = name => view().getByRole('combobox', { name, exact: true });
  const model = () => select('Модель');
  const effort = () => select('Глубина размышлений');
  const menu = name => page.getByRole('listbox', { name, exact: true });
  const modelMenu = () => menu('Модель');
  const effortMenu = () => menu('Глубина размышлений');
  const value = control => control().getAttribute('data-value');
  const state = async id => page.evaluate(id => ({ settings: window.__modelMenus.sessions[id].settings, patches: window.__modelMenus.sessions[id].patches }), id);
  const ready = () => page.waitForFunction(() => {
    const control = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]');
    return control && !control.disabled;
  });
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const choose = async (name, next) => {
    await select(name).click();
    await menu(name).locator(`[role="option"][data-value="${next}"]`).click();
    await menu(name).waitFor({ state: 'hidden' });
    assert.equal(await select(name).getAttribute('data-value'), next);
  };
  const geometry = async popup => {
    const bounds = await popup.evaluate(node => {
      const box = node.getBoundingClientRect();
      const topHit = document.elementFromPoint(box.x + box.width / 2, box.y + 5);
      const bottomHit = document.elementFromPoint(box.x + box.width / 2, box.bottom - 5);
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, visibleAtTop: node.contains(topHit), visibleAtBottom: node.contains(bottomHit), inSession: Boolean(node.closest('.session-view')), tag: node.tagName };
    });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, `Popup fits viewport: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.visibleAtTop && bounds.visibleAtBottom, true, 'Popup is not clipped or covered by the composer');
    assert.equal(bounds.inSession, false, 'Popup renders in a body portal outside clipped session containers');
    assert.notEqual(bounds.tag, 'SELECT', 'Popup is styled HTML instead of a native Windows list');
  };

  await ready();
  await activate('session-1');
  assert.equal(await view().locator('select[aria-label="Модель"], select[aria-label="Глубина размышлений"]').count(), 0);
  assert.equal(await value(model), 'fixture-alpha');
  assert.equal(await value(effort), 'ultra');
  for (const id of ['session-1', 'session-2', 'session-3', 'session-4']) assert.ok((await state(id)).patches.every(patch => !('model' in patch) && !('effort' in patch)), 'Loading the UI does not overwrite model or effort');

  await model().click();
  assert.equal(await modelMenu().getByRole('option').count(), 2, 'Options come from the visible model list');
  assert.equal(await modelMenu().getByRole('option', { selected: true }).getAttribute('data-value'), 'fixture-alpha');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await modelMenu().waitFor({ state: 'hidden' });
  assert.equal(await value(model), 'fixture-beta');
  assert.equal(await value(effort), 'high', 'Unsupported ultra effort falls back to the chosen model default');
  assert.deepEqual((await state('session-1')).settings, { cwd: 'C:/Fixtures/PROJECT_A', access: 'workspace-write', model: 'fixture-beta', effort: 'high' });
  await model().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await value(model), 'fixture-alpha');
  assert.equal(await value(effort), 'high', 'Compatible effort survives model changes');

  await effort().click();
  assert.equal(await effortMenu().getByRole('option').count(), 9, 'Supported efforts plus configuration default are shown');
  assert.equal(await effortMenu().getByRole('option', { selected: true }).getAttribute('data-value'), 'high');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await value(effort), 'none');
  await effort().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await value(effort), 'max');
  await choose('Глубина размышлений', '');
  assert.equal((await state('session-1')).settings.effort, '', 'Default is stored without silently choosing a concrete effort');
  assert.match(await effort().innerText(), /По умолчанию/);
  await choose('Глубина размышлений', 'ultra');
  assert.equal((await state('session-1')).settings.effort, 'ultra');

  // Opening another control, leaving by keyboard, and clicking outside all dismiss the popup.
  await model().click();
  await effort().click();
  await modelMenu().waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('listbox').count(), 1);
  await page.keyboard.press('Escape');
  await effortMenu().waitFor({ state: 'hidden' });
  assert.equal(await effort().evaluate(node => node === document.activeElement), true, 'Escape returns focus to the trigger');
  await model().focus();
  await page.keyboard.press('ArrowDown');
  await modelMenu().waitFor();
  await page.keyboard.press('Tab');
  await modelMenu().waitFor({ state: 'hidden' });
  await effort().click();
  await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).click({ position: { x: 8, y: 8 } });
  await effortMenu().waitFor({ state: 'hidden' });

  await model().click();
  await activate('session-2');
  assert.equal(await page.getByRole('listbox').count(), 0, 'Switching tabs removes a portal belonging to the previous session');
  assert.equal(await value(model), 'provider-special');
  assert.equal(await value(effort), 'provider-effort');
  assert.equal(await effort().isDisabled(), true, 'Unknown model does not invent supported efforts');
  await model().click();
  assert.equal(await modelMenu().getByRole('option', { selected: true }).getAttribute('data-value'), 'provider-special', 'Configured model remains visible even when model/list omits it');
  await page.keyboard.press('Escape');
  assert.equal((await state('session-2')).settings.model, 'provider-special');
  await activate('session-4');
  await effort().click();
  assert.equal(await effortMenu().getByRole('option', { selected: true }).getAttribute('data-value'), 'future-effort', 'Unknown configured effort remains visible without being replaced');
  await page.keyboard.press('Escape');
  await activate('session-1');
  assert.equal(await value(model), 'fixture-alpha');
  assert.equal(await value(effort), 'ultra', 'Session selections are independent');
  assert.equal(await page.getByRole('listbox').count(), 0, 'Returning to a tab does not resurrect its dismissed menu');

  // Synthetic transport lifecycle only: no thread/start or turn/start is invoked.
  await model().click();
  await page.evaluate(() => window.__modelMenus.sessions['session-1'].emit('turn/started', { turn: { id: 'fixture-busy', status: 'inProgress', items: [] } }));
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]').disabled);
  assert.equal(await model().isDisabled(), true);
  assert.equal(await effort().isDisabled(), true);
  assert.equal(await page.getByRole('listbox').count(), 0, 'Busy transition closes open controls');
  await page.evaluate(() => window.__modelMenus.sessions['session-1'].emit('turn/completed', { turn: { id: 'fixture-busy', status: 'completed', items: [], error: null } }));
  await ready();

  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }, { width: 650, height: 600 }]) {
    await page.setViewportSize(size);
    for (const name of ['Модель', 'Глубина размышлений']) {
      await select(name).click();
      await geometry(menu(name));
      assert.equal(await menu(name).getByRole('option', { selected: true }).count(), 1);
      if (size.width === 1440) await page.screenshot({ path: `artifacts/composer-${name === 'Модель' ? 'model' : 'effort'}-menu.png` });
      await page.keyboard.press('Escape');
    }
    const screen = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
    assert.ok(screen.scrollWidth <= screen.width + 1 && screen.scrollHeight <= screen.height + 1, 'Controls do not cause page overflow');
  }

  await activate('session-3');
  await model().click();
  assert.equal(await modelMenu().getByRole('option').count(), 30);
  await geometry(modelMenu());
  const visible = await modelMenu().getByRole('option', { selected: true }).evaluate(node => {
    const box = node.getBoundingClientRect();
    const list = node.closest('[role="listbox"]').getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { inside: box.top >= list.top && box.bottom <= list.bottom, hit: node.contains(hit), box: { top: box.top, bottom: box.bottom }, list: { top: list.top, bottom: list.bottom }, scroll: node.closest('[role="listbox"]').scrollTop };
  });
  assert.equal(visible.inside && visible.hit, true, `Opening a long list scrolls the active model into view: ${JSON.stringify(visible)}`);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await value(model), 'fixture-1');
  await model().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await value(model), 'fixture-30', 'Keyboard can reach the end of an overflowing list');
  await model().click();
  await page.screenshot({ path: 'artifacts/composer-model-menu-overflow.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => Object.values(window.__modelMenus.sessions).flatMap(state => state.requests).filter(call => /^(thread|turn)\/start$/.test(call.method)).length), 0, 'Selecting models and efforts never sends a model request');
  assert.deepEqual(errors, []);
  console.log('PASS: custom model/effort menus, model-list and configured fallbacks, compatible/default effort selection, keyboard/dismissal/one-popup/busy locks, tab isolation, portal geometry at 1440/940/650px, 30-model overflow. Production renderer with fake scoped bridges; no model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/composer-menus-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
