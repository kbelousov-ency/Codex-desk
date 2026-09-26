import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import TOML from '@iarna/toml';
import { findCodex } from '../electron/host-utils.mjs';

// Real Electron/preload/native config writer, synthetic portal responses. No
// browser sign-in, production credential, MCP tool or model request is used.
const root = process.cwd(), executable = await findCodex();
const run = await mkdtemp(path.join(root, 'artifacts', 'portal-host-'));
const home = path.join(run, 'home'), profile = path.join(run, 'profile'), codexHome = path.join(run, 'codex-home');
await Promise.all([mkdir(home), mkdir(profile), mkdir(codexHome)]);
await Promise.all(['Local', 'Roaming'].map(name => mkdir(path.join(home, 'AppData', name), { recursive: true })));
const configPath = path.join(codexHome, 'config.toml');
const original = '# Keep this user comment.\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\n[profiles.personal]\nmodel = "gpt-5.4"\n[mcp_servers.existing]\nurl = "http://127.0.0.1:1/mcp"\nenabled = false\n';
await writeFile(configPath, original);
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile, CODEX_HOME: codexHome,
  USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CODEX_DESK_DEV_URL', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
let app, page;
const errors = [];
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.setup-dialog').waitFor();
  await app.evaluate(({ dialog, net, shell }, cli) => {
    globalThis.portalCalls = []; globalThis.portalOpened = []; globalThis.portalRound = 0; globalThis.portalDenied = false;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cli] });
    shell.openExternal = async uri => { globalThis.portalOpened.push(uri); };
    net.fetch = async (url, options) => {
      const route = new URL(url);
      if (route.origin !== 'https://coder-portal.encycam.com') throw new Error('Unexpected network request');
      globalThis.portalCalls.push({ path: route.pathname, method: options.method || 'GET' });
      if (route.pathname === '/api/device/codex') {
        globalThis.portalRound++;
        return Response.json({ device_code: 'fixture-device-secret', user_code: 'BCDF-GHJK',
          verification_uri: 'https://coder-portal.encycam.com/device', verification_uri_complete: 'https://coder-portal.encycam.com/device?code=BCDF-GHJK', expires_in: 600, interval: 1 });
      }
      if (route.pathname === '/api/device/codex/token') {
        if (globalThis.portalDenied) return Response.json({ error: 'access_denied' }, { status: 400 });
        return Response.json({ api_key: 'sk-portal-fixture-only', email: 'fixture@example.test' });
      }
      if (options.headers.Authorization !== 'Bearer sk-portal-fixture-only') throw new Error('Missing fixture bearer');
      if (route.pathname === '/api/codex/provider') return Response.json({ name: 'Fixture Router', base_url: 'https://router.example.test/v1', wire_api: 'responses', requires_openai_auth: false });
      if (route.pathname === '/api/codex/defaults') return Response.json({ model: 'gpt-5.4', model_provider: 'router', model_context_window: 1000000, model_auto_compact_token_limit: 900000, model_reasoning_summary: 'detailed', hide_agent_reasoning: false });
      throw new Error('Unexpected portal route');
    };
  }, executable);
  await page.evaluate(() => window.codex.setup.chooseExecutable('codex'));
  // Refresh the wizard after selecting the installed CLI through real IPC.
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).click();
  const skip = page.getByRole('button', { name: 'Без установки', exact: true });
  if (await skip.count()) await skip.click(); else await page.locator('.setup-footer-actions > .is-primary').click();
  await page.locator('.setup-dialog[data-step="1"]').waitFor();
  await page.getByRole('button', { name: 'Подключить через браузер', exact: true }).click();
  await page.getByLabel('Код подключения', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).waitFor();
  assert.equal(await readFile(configPath, 'utf8'), original, 'Browser approval alone cannot write config');
  assert.doesNotMatch(await page.locator('.setup-dialog').innerText(), /sk-portal-fixture-only|fixture-device-secret/);
  const opened = await app.evaluate(() => globalThis.portalOpened);
  assert.deepEqual(opened, ['https://coder-portal.encycam.com/device?code=BCDF-GHJK']);
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).click();
  await page.getByText('Конфигурация применена', { exact: true }).waitFor();
  const after = await readFile(configPath, 'utf8'), parsed = TOML.parse(after);
  assert.match(after, /# Keep this user comment/);
  assert.equal(parsed.model_provider, 'router');
  assert.equal(parsed.model_providers.router.experimental_bearer_token, 'sk-portal-fixture-only');
  assert.equal(parsed.model_reasoning_effort, 'high');
  assert.equal(parsed.profiles.personal.model, 'gpt-5.4');
  assert.equal(parsed.mcp_servers.existing.enabled, false);
  const backup = await page.locator('.setup-applied p code').textContent();
  assert.equal(await readFile(backup, 'utf8'), original);
  await page.screenshot({ path: path.join(run, 'applied.png') });

  // An external edit after preview must win, and no second write is permitted.
  const flow = await page.evaluate(() => window.codex.setup.startPortalConfig());
  let result;
  for (let i = 0; i < 40; i++) {
    result = await page.evaluate(id => window.codex.setup.pollPortalConfig(id), flow.flowId);
    if (result.state === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, result.intervalMs));
  }
  assert.equal(result.state, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /sk-portal-fixture-only|fixture-device-secret/);
  const external = after + '\n# external edit retained\n';
  await writeFile(configPath, external);
  await assert.rejects(page.evaluate(previewId => window.codex.setup.applyPortalConfig({ previewId }), result.preview.previewId));
  assert.equal(await readFile(configPath, 'utf8'), external);
  await assert.rejects(page.evaluate(() => window.codex.setup.openPortalVerification('https://evil.test')));
  const frameRejected = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    try { await ipcMain._invokeHandlers.get('setup:startPortalConfig')({ sender: win.webContents, senderFrame: {} }); return false; } catch { return true; }
  });
  assert.equal(frameRejected, true);
  const calls = await app.evaluate(() => globalThis.portalCalls);
  assert.equal(calls.filter(call => call.path.endsWith('/token')).length, 2);
  assert.equal(calls.some(call => call.path.endsWith('/mcp')), false);
  const logs = path.join(profile, 'logs');
  for (const filename of await readdir(logs)) {
    if (filename.endsWith('.jsonl')) assert.doesNotMatch(await readFile(path.join(logs, filename), 'utf8'), /sk-portal-fixture-only|fixture-device-secret/);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: browser approval -> real preload/IPC -> native config/read + batchWrite; key stays host-only, comment/effort/profile/MCP preserved, exact backup, stale config protected. No real portal/model request. ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  console.error(`Portal host artifacts: ${run}`); throw error;
} finally {
  if (app) await app.close();
}
