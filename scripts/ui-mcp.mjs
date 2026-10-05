import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with local, scoped fixtures. No real Codex or MCP server,
// no user config reads/writes, and no credentials leave this browser process.
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
const fixtureSecret = 'fixture-mcp-token-not-a-real-credential';
const toml = `[mcp_servers.company]\nurl = "http://127.0.0.1:9999/mcp"\n[mcp_servers.company.http_headers]\nAuthorization = "Bearer ${fixtureSecret}"`;
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/MCP_PROJECT';
    const configPath = 'C:/Fixtures/CODEX_HOME/config.toml';
    const calls = [];
    const listeners = new Set();
    const state = window.__mcp = { calls, failSave: false, failPreview: false, holdSave: false, failRemovalPreview: false, failRemoval: false, holdRemovalPreview: false, holdRemoval: false, busy: false, previewSequence: 0, pendingPreview: '', turns: 0, threadId: 'mcp-thread' };
    const existing = { name: 'existing', transport: 'stdio', address: 'fixture-tool', enabled: true, headerNames: [], envNames: ['FIXTURE_TOKEN'] };
    const servers = [existing];
    const emit = (type, data) => { for (const listener of listeners) listener({ type, data }); };
    state.finish = () => {
      state.busy = false;
      emit('notification', { method: 'turn/completed', params: { threadId: state.threadId, turn: { id: `turn-${state.turns}`, status: 'completed', items: [], error: null } } });
    };
    const bridge = {
      async start() {
        calls.push({ method: 'start' });
        return { initialize: {}, cwd, executable: 'C:/Fixture/codex.exe', models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'fixture-model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-model', model_reasoning_effort: 'high' } };
      },
      async getSettings() { return { cwd, model: 'fixture-model', effort: 'high', access: 'workspace-write' }; },
      async setSettings() {},
      async request(method, params = {}) {
        calls.push({ method, params });
        if (method === 'thread/list') return { data: [], nextCursor: null };
        if (method === 'thread/start') return { thread: { id: state.threadId, cwd, turns: [] }, model: 'fixture-model' };
        if (method === 'turn/start') {
          state.busy = true;
          const turn = { id: `turn-${++state.turns}`, status: 'inProgress', items: [] };
          emit('notification', { method: 'turn/started', params: { threadId: state.threadId, turn } });
          return { turn };
        }
        if (method === 'turn/interrupt') { state.finish(); return {}; }
        throw new Error(`Unexpected model method: ${method}`);
      },
      async getMcpConfig() { calls.push({ method: 'getMcpConfig' }); return { configPath, servers: structuredClone(servers) }; },
      async previewMcpImport(text) {
        calls.push({ method: 'previewMcpImport', text });
        if (state.failPreview || !text.includes('[mcp_servers.')) throw new Error('Некорректный TOML. Проверьте синтаксис.');
        const names = [...text.matchAll(/\[mcp_servers\.([a-z_]+)\]/g)].map(match => match[1]);
        state.pendingPreview = `preview-${++state.previewSequence}`;
        state.previewServers = names.map(name => ({ name, transport: 'http', address: 'http://127.0.0.1:9999/mcp', enabled: true, headerNames: ['Authorization'], envNames: [], exists: servers.some(server => server.name === name) }));
        return { previewId: state.pendingPreview, configPath, servers: structuredClone(state.previewServers), conflicts: state.previewServers.filter(server => server.exists).map(server => server.name) };
      },
      async saveMcpImport(params) {
        calls.push({ method: 'saveMcpImport', params });
        if (state.holdSave) await new Promise(resolve => { state.resolveSave = resolve; });
        if (state.failSave) throw new Error('Конфигурация изменилась после проверки. Проверьте текст повторно.');
        if (params.previewId !== state.pendingPreview) throw new Error('Предварительная проверка устарела.');
        if (state.previewServers.some(server => server.exists) && !params.replaceExisting) throw new Error('Подтвердите обновление существующих серверов.');
        for (const server of state.previewServers) { const index = servers.findIndex(current => current.name === server.name); if (index >= 0) servers.splice(index, 1); servers.push(server); }
        return { configPath, backupPath: 'C:/Fixtures/CODEX_HOME/config.toml.backup-fixture', servers: state.previewServers.map(server => server.name) };
      },
      async previewMcpRemoval(name) {
        calls.push({ method: 'previewMcpRemoval', name });
        if (state.holdRemovalPreview) await new Promise(resolve => { state.resolveRemovalPreview = resolve; });
        if (state.failRemovalPreview) throw new Error('Не удалось прочитать конфигурацию MCP.');
        const server = servers.find(server => server.name === name);
        if (!server) throw new Error('Сервер больше не настроен. Обновите список.');
        state.pendingRemoval = { previewId: `removal-${++state.previewSequence}`, configPath, server: structuredClone(server) };
        return structuredClone(state.pendingRemoval);
      },
      async removeMcpServer(params) {
        calls.push({ method: 'removeMcpServer', params });
        if (state.holdRemoval) await new Promise(resolve => { state.resolveRemoval = resolve; });
        if (state.failRemoval) throw new Error('Конфигурация изменилась после проверки. Подтвердите удаление повторно.');
        if (params.previewId !== state.pendingRemoval?.previewId) throw new Error('Предварительная проверка устарела.');
        const name = state.pendingRemoval.server.name;
        servers.splice(servers.findIndex(server => server.name === name), 1);
        state.pendingRemoval = null;
        return { configPath, backupPath: 'C:/Fixtures/CODEX_HOME/config.toml.backup-removal', servers: [name] };
      },
      async reloadMcp() { calls.push({ method: 'reloadMcp' }); return state.busy ? { status: 'deferred', message: 'Применение отложено до завершения текущей задачи.' } : { status: 'applied', message: 'MCP применены к текущим сессиям.' }; },
      async checkMcp() { calls.push({ method: 'checkMcp' }); return { servers: servers.map(server => ({ name: server.name, authStatus: 'bearerToken', status: 'ready', toolCount: server.name === 'company' ? 4 : 2 })) }; },
      async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
      async respond() {}, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {}, async saveImages() { return []; }, async readAttachment() { return null; },
    };
    window.codex = {
      ...bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [{ id: 'session-1', cwd }] }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async listArchivedThreads() { return { data: [], nextCursor: null }; },
      forSession() { return bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const settings = () => page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  const text = () => settings().getByRole('textbox', { name: 'Конфигурация MCP', exact: true });
  const button = name => settings().getByRole('button', { name, exact: true });
  const tab = name => settings().getByRole('tab', { name, exact: true });
  const selectedTab = async name => {
    assert.equal(await tab(name).getAttribute('aria-selected'), 'true');
    assert.equal(await settings().getByRole('tabpanel').count(), 1, 'Only the selected topic is exposed to assistive technology');
  };
  const checkLayout = async () => {
    const geometry = await settings().evaluate(element => {
      const bounds = node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; };
      const footer = element.querySelector('.modal-footer');
      const done = footer.querySelector('button');
      const button = done.getBoundingClientRect();
      return { modal: bounds(element), tabs: bounds(element.querySelector('[role="tablist"]')), footer: bounds(footer), width: innerWidth, height: innerHeight, doneReachable: done.contains(document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2)) };
    });
    for (const region of [geometry.modal, geometry.tabs, geometry.footer]) assert.ok(region.top >= 0 && region.left >= 0 && region.bottom <= geometry.height + 1 && region.right <= geometry.width + 1, 'Settings navigation and actions fit the viewport');
    assert.equal(geometry.doneReachable, true, 'The Done button is visible and clickable without scrolling the whole window');
    return geometry;
  };
  const flush = () => page.waitForTimeout(100);
  const calls = () => page.evaluate(() => window.__mcp.calls);
  const count = async method => (await calls()).filter(call => call.method === method).length;
  const noSecret = async () => {
    assert.ok(!(await page.locator('body').innerText()).includes(fixtureSecret), 'Secrets never appear in visible preview, errors or status');
    assert.ok(!(await page.locator('body').innerHTML()).includes(fixtureSecret), 'Raw input is removed from the rendered DOM after preview');
  };
  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await input().fill('Черновик остаётся на месте');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await selectedTab('Агент');
  await tab('Агент').focus();
  await tab('Агент').press('End');
  await selectedTab('Память');
  assert.equal(await tab('Память').evaluate(element => element === document.activeElement), true);
  await tab('Память').press('Home');
  await selectedTab('Агент');
  await tab('Агент').press('ArrowRight');
  await selectedTab('Подключение');
  await tab('Подключение').press('ArrowLeft');
  await selectedTab('Агент');
  await tab('Агент').press('ArrowRight');
  await tab('Подключение').press('ArrowRight');
  await selectedTab('MCP');
  assert.equal(await tab('MCP').evaluate(element => element === document.activeElement), true);
  await tab('MCP').press('Tab');
  assert.equal(await settings().getByRole('tabpanel').evaluate(element => element.contains(document.activeElement)), true, 'Tab moves from the selected topic into its contents');
  await settings().getByText('MCP-серверы', { exact: true }).waitFor();
  await settings().getByText('existing', { exact: true }).waitFor();
  assert.match(await settings().innerText(), /C:\/Fixtures\/CODEX_HOME\/config.toml/);
  await button('Добавить из текста').click();
  await text().fill('not valid TOML'); await button('Проверить текст').click();
  await settings().getByText(/Некорректный TOML/).waitFor();
  assert.equal(await count('saveMcpImport'), 0, 'Validation errors cannot write configuration');
  assert.equal(await text().inputValue(), '', 'Rejected input is cleared rather than retaining credentials');
  await text().fill(toml);
  const readsBeforeSwitch = await count('getMcpConfig');
  await tab('Агент').click();
  assert.equal(await text().count(), 0, 'A hidden MCP draft is not exposed as an active textbox');
  await tab('MCP').click();
  assert.equal(await text().inputValue(), toml, 'Changing topics preserves the unsaved MCP draft');
  assert.equal(await count('getMcpConfig'), readsBeforeSwitch, 'Changing topics does not reload and clear the MCP editor');
  await button('Проверить текст').click();
  await button('Сохранить MCP').waitFor(); await noSecret();
  const previewsBeforeSwitch = await count('previewMcpImport');
  await tab('Память').click();
  await tab('MCP').click();
  await button('Сохранить MCP').waitFor();
  assert.equal(await count('previewMcpImport'), previewsBeforeSwitch, 'A prepared import remains available without repeating preview');
  await noSecret();
  assert.equal(await count('turn/start'), 0, 'Pasted TOML is never forwarded as a model message');
  assert.equal(await count('saveMcpImport'), 0, 'Preview does not write the config');
  assert.match(await settings().innerText(), /Authorization/);
  await button('Сохранить MCP').click();
  await settings().getByText(/config.toml.backup-fixture/).waitFor();
  await noSecret();
  assert.deepEqual((await calls()).find(call => call.method === 'saveMcpImport').params, { previewId: 'preview-1', replaceExisting: false });
  assert.equal(await input().inputValue(), 'Черновик остаётся на месте');
  await page.screenshot({ path: 'artifacts/mcp-settings.png' });
  await tab('Агент').click();
  await selectedTab('Агент');
  await checkLayout();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/settings-tabs-agent.png' });
  for (const viewport of [{ width: 940, height: 620 }, { width: 560, height: 700 }]) {
    await page.setViewportSize(viewport);
    const before = await checkLayout();
    await settings().getByRole('tabpanel').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const after = await checkLayout();
    assert.equal(after.tabs.top, before.tabs.top, 'Topic navigation remains visible while reading long settings');
    assert.equal(after.footer.bottom, before.footer.bottom, 'Done stays in place while scrolling a topic');
    await page.screenshot({ animations: 'disabled', path: 'artifacts/settings-tabs-' + viewport.width + '.png' });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await tab('MCP').click();

  // A duplicate server cannot be replaced by an unconfirmed save.
  await button('Добавить из текста').click();
  await text().fill(toml); await button('Проверить текст').click();
  const replace = settings().getByRole('checkbox', { name: 'Обновить существующие серверы', exact: true });
  await replace.waitFor();
  assert.equal(await button('Сохранить MCP').isDisabled(), true);
  assert.equal(await replace.isChecked(), false);
  await noSecret();
  await button('Отмена').click();
  assert.equal(await count('saveMcpImport'), 1, 'Cancelling duplicate import keeps the current server');
  await button('Добавить из текста').click();
  await text().fill(toml); await button('Проверить текст').click(); await replace.waitFor();
  await replace.check();
  await page.evaluate(() => { window.__mcp.failSave = true; });
  await button('Сохранить MCP').click();
  await settings().getByText(/Конфигурация изменилась после проверки/).waitFor();
  await noSecret();
  assert.equal((await calls()).filter(call => call.method === 'saveMcpImport').at(-1).params.replaceExisting, true);
  await button('Закрыть настройки').click();
  assert.equal(await input().inputValue(), 'Черновик остаётся на месте');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await tab('MCP').click();
  assert.equal(await text().count(), 0, 'Closing settings discards pasted text and preview');
  await button('Добавить из текста').click();
  await text().fill(toml); await button('Проверить текст').click(); await replace.waitFor();
  assert.equal(await replace.isChecked(), false, 'Replacement confirmation is not retained between imports');
  await replace.check();
  await tab('Подключение').click();
  await tab('MCP').click();
  assert.equal(await replace.isChecked(), true, 'An explicit replacement decision survives changing topics');
  await page.evaluate(() => { window.__mcp.failSave = false; window.__mcp.holdSave = true; });
  await button('Сохранить MCP').click();
  const writesPending = await count('saveMcpImport');
  assert.equal(await button('Сохраняем…').isDisabled(), true, 'Save remains locked until the write completes');
  await tab('Агент').click();
  await tab('MCP').click();
  assert.equal(await button('Сохраняем…').isDisabled(), true, 'Changing topics cannot start a second write');
  await tab('Память').click();
  await page.evaluate(() => { window.__mcp.resolveSave(); window.__mcp.holdSave = false; });
  await tab('MCP').click();
  await settings().getByText(/config.toml.backup-fixture/).waitFor();
  assert.equal(await count('saveMcpImport'), writesPending);
  await noSecret();
  await button('Проверить подключение').click();
  await settings().getByRole('list', { name: 'Подключения MCP текущей сессии', exact: true }).waitFor();
  assert.match(await settings().getByRole('list', { name: 'Подключения MCP текущей сессии', exact: true }).innerText(), /инструментов: 4/);
  await button('Применить в этой сессии').click();
  await settings().getByText('MCP применены к текущим сессиям.', { exact: true }).waitFor();
  assert.equal(await count('turn/start'), 0);
  assert.equal(await count('thread/start'), 0);
  assert.equal(await count('start'), 1, 'Configuration import does not restart or replace the session');
  await button('Закрыть настройки').click();
  await input().fill('Задача для проверки отложенного применения'); await input().press('Enter'); await flush();
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await tab('MCP').click();
  await button('Применить в этой сессии').click();
  await settings().getByText('Применение отложено до завершения текущей задачи.', { exact: true }).waitFor();
  assert.equal(await count('turn/interrupt'), 0, 'Applying MCP never stops an active task');
  await page.evaluate(() => window.__mcp.finish()); await flush();
  await button('Применить в этой сессии').click();
  await settings().getByText('MCP применены к текущим сессиям.', { exact: true }).waitFor();
  assert.equal(await count('thread/start'), 1, 'MCP reload keeps the current conversation');
  assert.equal(await count('start'), 1, 'MCP reload keeps the existing server');

  // Deletion is a separate, explicit confirmation; its pending operations cannot
  // be duplicated or lose their result when switching settings topics.
  await button('Закрыть настройки').click();
  await input().fill('Черновик сохраняется при удалении MCP');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await tab('MCP').click();
  const configured = () => settings().getByRole('list', { name: 'Настроенные MCP-серверы', exact: true });
  const removal = () => settings().getByRole('group', { name: 'Удаление MCP company', exact: true });
  const turnsBeforeRemoval = await count('turn/start');
  const reloadsBeforeRemoval = await count('reloadMcp');
  await button('Удалить MCP company').click();
  await removal().waitFor();
  await noSecret();
  assert.equal(await count('removeMcpServer'), 0, 'Preparing deletion does not remove the configured server');
  assert.match(await configured().innerText(), /company/);
  const cancelRemoval = removal().getByRole('button', { name: 'Отмена', exact: true });
  assert.equal(await cancelRemoval.evaluate(element => element === document.activeElement), true, 'Confirmation initially focuses Cancel');
  await cancelRemoval.press('Enter');
  assert.equal(await removal().count(), 0);
  assert.equal(await button('Удалить MCP company').evaluate(element => element === document.activeElement), true, 'Cancelling restores focus to the selected server');
  assert.equal(await count('removeMcpServer'), 0, 'Cancelling deletion performs no write');
  assert.match(await configured().innerText(), /company/);

  await page.evaluate(() => { window.__mcp.failRemovalPreview = true; });
  await button('Удалить MCP company').click();
  await settings().getByRole('alert').filter({ hasText: /Не удалось прочитать конфигурацию MCP/ }).waitFor();
  assert.equal(await removal().count(), 0, 'Failed preview cannot expose an unverified delete action');
  assert.equal(await count('removeMcpServer'), 0);
  await page.evaluate(() => { window.__mcp.failRemovalPreview = false; window.__mcp.failRemoval = true; });
  await button('Удалить MCP company').click();
  await removal().getByRole('button', { name: 'Удалить сервер', exact: true }).click();
  await settings().getByRole('alert').filter({ hasText: /Конфигурация изменилась после проверки/ }).waitFor();
  assert.match(await configured().innerText(), /company/, 'Failed removal leaves the configured row visible');
  assert.match(await configured().innerText(), /existing/);
  await noSecret();

  await page.evaluate(() => { window.__mcp.failRemoval = false; window.__mcp.holdRemovalPreview = true; });
  const previewsBeforeRemoval = await count('previewMcpRemoval');
  await button('Удалить MCP company').evaluate(element => { element.click(); element.click(); });
  assert.equal(await count('previewMcpRemoval'), previewsBeforeRemoval + 1, 'Double click prepares deletion only once');
  assert.equal(await button('Добавить из текста').isDisabled(), true, 'Import cannot replace a pending removal preview');
  await page.evaluate(() => { window.__mcp.holdRemovalPreview = false; window.__mcp.resolveRemovalPreview(); });
  await removal().waitFor();
  const pendingRemovalId = await page.evaluate(() => window.__mcp.pendingRemoval.previewId);
  await tab('Агент').click();
  await tab('MCP').click();
  await removal().waitFor();
  assert.equal(await count('previewMcpRemoval'), previewsBeforeRemoval + 1, 'Changing topics retains removal confirmation');
  await page.screenshot({ path: 'artifacts/mcp-removal-confirmation.png' });
  await page.evaluate(() => { window.__mcp.holdRemoval = true; });
  const removalsBeforeConfirm = await count('removeMcpServer');
  await removal().getByRole('button', { name: 'Удалить сервер', exact: true }).evaluate(element => { element.click(); element.click(); });
  assert.equal(await count('removeMcpServer'), removalsBeforeConfirm + 1, 'Double click submits deletion only once');
  assert.equal(await removal().getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true);
  assert.equal(await button('Удалить MCP existing').isDisabled(), true, 'A second server cannot be removed while a write is pending');
  assert.equal(await button('Применить в этой сессии').isDisabled(), true);
  await tab('Память').click();
  await tab('MCP').click();
  assert.equal(await removal().getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true, 'Changing topics preserves pending removal');
  await tab('Агент').click();
  await page.evaluate(() => { window.__mcp.holdRemoval = false; window.__mcp.resolveRemoval(); });
  await tab('MCP').click();
  await settings().getByText(/config.toml.backup-removal/).waitFor();
  assert.equal(await configured().getByText('company', { exact: true }).count(), 0, 'Successful removal refreshes the configured list');
  assert.equal(await configured().getByText('existing', { exact: true }).count(), 1, 'Unselected server remains configured');
  assert.equal(await removal().count(), 0);
  assert.equal(await count('removeMcpServer'), removalsBeforeConfirm + 1);
  assert.deepEqual((await calls()).filter(call => call.method === 'removeMcpServer').at(-1).params, { previewId: pendingRemovalId });
  assert.equal(await count('reloadMcp'), reloadsBeforeRemoval, 'Removal does not implicitly reconnect the current session');
  assert.equal(await count('turn/start'), turnsBeforeRemoval, 'Removing MCP sends no model request');
  assert.equal(await count('thread/start'), 1, 'Removing MCP preserves the existing thread');
  assert.equal(await count('start'), 1, 'Removing MCP preserves the running App Server');
  assert.equal(await input().inputValue(), 'Черновик сохраняется при удалении MCP');
  assert.match(await view().getByRole('combobox', { name: 'Модель', exact: true }).innerText(), /fixture-model/);
  await noSecret();
  assert.deepEqual(errors, []);
  console.log('PASS: thematic settings tabs with keyboard focus, compact viewport navigation/footer, MCP draft/preview/confirmation/pending-write preservation between topics, import and removal confirmation/cancel/errors, duplicate-click prevention, backup, refreshed server list and preserved chat draft/thread/model. All bridges are fixtures; no real config or model requests.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/mcp-settings-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
