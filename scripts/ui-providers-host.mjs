import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real installed Codex/Claude CLI bootstrap, production Electron/preload/IPC.
// Only an isolated Desk profile and empty project are changed. No model turns.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'providers-host-'));
const project = path.join(runDir, 'PROJECT');
const profile = path.join(runDir, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
const settingsPath = path.join(profile, 'settings.json');
const workspacePath = path.join(profile, 'workspace-state.json');
await writeFile(settingsPath, JSON.stringify({ cwd: project }));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [];
const calls = [];
const checks = [];
const view = () => page.locator('.session-view:visible');
const draft = () => view().locator('.composer textarea');
const selector = label => view().getByRole('combobox', { name: label, exact: true });
const disk = filename => readFile(filename, 'utf8').then(JSON.parse);
const sameDirectory = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function until(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(100); }
}
async function ready(provider) {
  await until(async () => await selector('Агент').getAttribute('data-value').catch(() => '') === provider
    && await selector('Модель').isEnabled().catch(() => false), `${provider} CLI bootstrap`);
}
async function choose(label, value) {
  await selector(label).click();
  await page.getByRole('listbox', { name: label, exact: true }).locator(`[role="option"][data-value="${value}"]`).click();
}
async function activeId() { return page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId); }
async function activate(id, provider) { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(provider); }
async function bootstrap(id) {
  return page.evaluate(async id => {
    const bridge = window.codex.forSession(id);
    const boot = await bridge.start();
    const settings = await bridge.getSettings();
    // Plan limits are a read-only control request; API-key accounts legitimately answer "unavailable".
    const usage = boot.provider === 'claude' ? await bridge.request('usage/read', {}).catch(error => ({ error: String(error?.message || error) })) : null;
    return { provider: boot.provider, model: boot.config.model, effort: boot.config.model_reasoning_effort || '',
      models: boot.models.map(model => ({ model: model.model, supportedEfforts: model.supportedReasoningEfforts.map(level => level.reasoningEffort) })),
      cwd: boot.cwd, executable: boot.executable, capabilities: boot.capabilities, cliVersion: boot.cliVersion, settings, usage };
  }, id);
}
async function launch() {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(45_000);
  page.on('pageerror', error => errors.push(error.message));
  // Reject any accidental model turn at the real IPC boundary. Reads and local
  // settings changes continue through the unmodified production handler.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('codex:request');
    if (!handler) throw new Error('Production codex:request handler missing');
    globalThis.__providersHostCalls = [];
    ipcMain.removeHandler('codex:request');
    ipcMain.handle('codex:request', (event, method, ...args) => {
      globalThis.__providersHostCalls.push(method);
      if (['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start'].includes(method)) throw new Error('Provider host smoke forbids model input');
      return handler(event, method, ...args);
    });
  });
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
}
async function closeWindow() {
  calls.push(...await app.evaluate(() => globalThis.__providersHostCalls));
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  app = null;
}
async function rememberCurrent(boot) {
  await choose('Модель', boot.model);
  if (boot.effort && await selector('Глубина размышлений').isEnabled()
    && boot.models.some(model => model.model === boot.model && model.supportedEfforts.includes(boot.effort))) {
    await choose('Глубина размышлений', boot.effort);
  }
}

try {
  await launch(); await ready('codex');
  const codexId = await activeId();
  const codex = await bootstrap(codexId);
  assert.equal(codex.provider, 'codex');
  assert.ok(codex.models.length > 0);
  assert.ok(sameDirectory(codex.cwd, project));
  assert.equal(await selector('Модель').getAttribute('data-value'), codex.model);
  await rememberCurrent(codex);
  await draft().fill('Черновик Codex сохраняется отдельно');

  await choose('Агент', 'claude'); await ready('claude');
  const claudeId = await activeId();
  const claude = await bootstrap(claudeId);
  assert.notEqual(claudeId, codexId);
  assert.equal(claude.provider, 'claude');
  assert.ok(claude.models.length > 0);
  assert.ok(claude.models.every(model => !model.model.startsWith('gpt-')));
  assert.ok(sameDirectory(claude.cwd, project));
  assert.match(path.basename(claude.executable), /^claude(?:\.exe)?$/i);
  assert.notEqual(claude.executable.toLowerCase(), codex.executable.toLowerCase());
  assert.equal(claude.settings.model, undefined, 'Codex model does not seed Claude settings');
  assert.equal(claude.settings.effort, undefined, 'Codex effort does not seed Claude settings');
  assert.equal(claude.settings.executable, undefined, 'Codex executable does not seed Claude settings');
  assert.equal(await selector('Модель').getAttribute('data-value'), claude.model);
  assert.equal(await draft().inputValue(), '');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(claude.capabilities.steer, true);
  assert.equal(claude.capabilities.compact, true);
  assert.equal(claude.capabilities.archive, false);
  assert.equal(claude.capabilities.usage, true);
  assert.ok(claude.usage && typeof claude.usage.available === 'boolean', 'usage/read answers through the real CLI without a model turn');
  assert.equal(claude.capabilities.terminal, true);
  await rememberCurrent(claude);
  await draft().fill('Черновик Claude сохраняется отдельно');
  await until(async () => {
    const settings = await disk(settingsPath);
    return settings.providers?.claude?.model === claude.model && settings.providers?.codex?.model === codex.model;
  }, 'provider settings saved separately');
  const settings = await disk(settingsPath);
  assert.equal(settings.model, codex.model, 'Legacy top-level Codex default is unchanged');
  assert.equal(settings.providers.claude.model, claude.model);
  assert.equal(settings.providers.codex.model, codex.model);
  checks.push('real installed CLI bootstrap and separate models/efforts/settings');

  const rejectCrossProvider = await page.evaluate(async ({ codexId, claudeId }) => {
    const id = '00000000-1111-4222-8333-000000000001';
    const results = [];
    for (const [sessionId, threadId] of [[codexId, `claude:${id}`], [claudeId, id]]) {
      try { await window.codex.forSession(sessionId).request('thread/read', { threadId }); results.push('accepted'); }
      catch (error) { results.push(error.message); }
    }
    return results;
  }, { codexId, claudeId });
  assert.ok(rejectCrossProvider.every(message => /другому агенту/.test(message)));
  const history = await page.evaluate(async folder => {
    const result = await window.codex.listProjectThreads(folder);
    return { count: result.data.length, nextCursor: result.nextCursor };
  }, project);
  assert.equal(history.count, 0, 'Bootstrap did not create a persisted conversation');
  checks.push('scoped provider IDs rejected across agents and no implicit history');

  await activate(codexId, 'codex');
  assert.equal(await draft().inputValue(), 'Черновик Codex сохраняется отдельно');
  assert.equal(await selector('Модель').getAttribute('data-value'), codex.model);
  await activate(claudeId, 'claude');
  assert.equal(await draft().inputValue(), 'Черновик Claude сохраняется отдельно');
  await page.screenshot({ path: path.join(runDir, 'claude-cli-ready.png') });
  await closeWindow();
  const snapshot = await disk(workspacePath);
  assert.equal(snapshot.tabs.length, 2);
  assert.deepEqual(snapshot.tabs.map(tab => tab.settings.provider || 'codex'), ['codex', 'claude']);
  assert.equal(snapshot.activeIndex, 1);
  assert.ok(snapshot.tabs.every(tab => !tab.thread), 'Saving an empty Claude tab does not invent a resumable UUID');

  await launch(); await ready('claude');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await draft().inputValue(), 'Черновик Claude сохраняется отдельно');
  assert.equal(await selector('Модель').getAttribute('data-value'), claude.model);
  const restoredClaude = await bootstrap(await activeId());
  assert.equal(restoredClaude.provider, 'claude');
  assert.equal(restoredClaude.model, claude.model);
  await page.getByRole('tab').first().click(); await ready('codex');
  assert.equal(await draft().inputValue(), 'Черновик Codex сохраняется отдельно');
  assert.equal(await selector('Модель').getAttribute('data-value'), codex.model);
  await closeWindow();
  checks.push('normal close and restart restore two agents, selection and drafts');
  assert.deepEqual(errors, []);
  assert.equal(calls.filter(method => ['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start'].includes(method)).length, 0);
  const result = { checks, modelCalls: 0, codex: { model: codex.model, effort: codex.effort, modelCount: codex.models.length, cliVersion: codex.cliVersion },
    claude: { model: claude.model, effort: claude.effort, modelCount: claude.models.length, cliVersion: claude.cliVersion, usage: claude.usage && { available: claude.usage.available, subscription: claude.usage.subscription, windows: (claude.usage.windows || []).map(w => [w.key, w.utilization, w.resetsAt]), message: claude.usage.message, error: claude.usage.error } }, runDir };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`Provider host artifacts: ${runDir}`);
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
