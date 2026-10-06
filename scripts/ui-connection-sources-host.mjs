import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Production Electron/main/preload with compiled local Claude protocol and HTTPS fixtures.
// No personal credentials, real portal request, user authentication or model turn is used.
assert.equal(process.platform, 'win32', 'The host regression requires Windows safeStorage.');
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'connection-sources-host-'));
const project = path.join(run, 'PROJECT'), profile = path.join(run, 'profile'), home = path.join(run, 'home');
const config = path.join(home, '.claude'), codexHome = path.join(home, '.codex'), temp = path.join(run, 'temp');
await Promise.all([project, profile, config, codexHome, temp, path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming')].map(folder => mkdir(folder, { recursive: true })));
await writeFile(path.join(config, 'isolated.fixture'), 'Fixture process guard');
const nativeConfig = '{"env":{"UNRELATED_SETTING":"keep"},"permissions":{"allow":["Read"]}}\n';
const nativeCredentials = '{"fixture":"unchanged; no real credentials"}\n';
const nativeCodex = '# Isolated terminal Codex configuration\nmodel = "fixture-unchanged"\n';
await Promise.all([
  writeFile(path.join(config, 'settings.json'), nativeConfig),
  writeFile(path.join(config, '.credentials.json'), nativeCredentials),
  writeFile(path.join(codexHome, 'config.toml'), nativeCodex),
]);
const executable = path.join(run, 'claude-sources-fixture.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:SOURCE_FIXTURE_CS -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:SOURCE_FIXTURE_EXE -OutputType ConsoleApplication";
await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, timeout: 30_000, env: { ...process.env, SOURCE_FIXTURE_CS: path.join(root, 'scripts', 'fixtures', 'claude-connection-sources.cs'), SOURCE_FIXTURE_EXE: executable },
});
const nativeIds = ['11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-000000000000'];
const transcriptFolder = path.join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
await mkdir(transcriptFolder, { recursive: true });
const transcripts = nativeIds.map((sessionId, index) => [
  { type: 'user', uuid: `fixture-user-${index}`, parentUuid: null, sessionId, cwd: project, isSidechain: false, timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: `Stored fixture question ${index}` } },
  { type: 'assistant', uuid: `fixture-answer-${index}`, parentUuid: `fixture-user-${index}`, sessionId, cwd: project, isSidechain: false, timestamp: '2026-10-05T10:00:01Z', message: { role: 'assistant', id: `fixture-api-${index}`, stop_reason: 'end_turn', content: [{ type: 'text', text: `Stored fixture answer ${index}` }] } },
].map(frame => JSON.stringify(frame)).join('\n') + '\n');
await Promise.all(nativeIds.map((id, index) => writeFile(path.join(transcriptFolder, `${id}.jsonl`), transcripts[index])));
const settings = { provider: 'claude', executable, cwd: project, model: 'fixture-claude', effort: 'high', access: 'workspace-write', connectionSource: 'account' };
await Promise.all([
  writeFile(path.join(profile, 'settings.json'), JSON.stringify({ cwd: project, providers: { claude: settings, codex: { cwd: project, executable } } })),
  writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] })),
  writeFile(path.join(profile, 'workspace-state.json'), JSON.stringify({ version: 1, activeIndex: 0, tabs: nativeIds.map((id, index) => ({ cwd: project, settings,
    thread: { id: `claude:${id}`, provider: 'claude', cwd: project, name: `Fixture ${index}`, historyMode: 'legacy' }, draft: `Preserved draft ${index}`, attachments: [] })) })),
]);
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile, CODEX_DESK_TEST: '1', CLAUDE_CONFIG_DIR: config,
  CODEX_HOME: codexHome, USERPROFILE: home, HOME: home, TEMP: temp, TMP: temp,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), CLAUDE_CODE_PROJECT_DIR_NAME: '' };
for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_SESSION_ACCESS_TOKEN$)/i.test(key)
  || ['ELECTRON_RUN_AS_NODE', 'CODEX_DESK_DEV_URL'].includes(key)) delete env[key];
const ticket = 'fixture_ticket_ABCDEFGHIJKLMNOPQRSTUVWXYZ12', apiKey = 'sk-claude-router-fixture-only';
const installer = path.join(run, `claude-connect-${ticket}.exe`);
// This file is only selected by the mocked dialog. Production import never executes its bytes.
await writeFile(installer, 'fixture, deliberately not an executable');
const installerScript = `$envJson = @'\n${JSON.stringify({ ANTHROPIC_BASE_URL: 'https://router.example.test', ANTHROPIC_AUTH_TOKEN: apiKey,
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/fixture-opus[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Fixture Opus', UNRELATED_SETTING: 'must-not-apply' })}\n'@\nthrow 'must-never-execute'\n`;
const errors = [];
let app, page;
const until = async (check, label) => { const deadline = Date.now() + 25000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(60); } };
const logs = async () => (await Promise.all((await readdir(config)).filter(name => /^source-\d+\.jsonl$/.test(name)).map(name => readFile(path.join(config, name), 'utf8'))))
  .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(JSON.parse));
const view = () => page.locator('.session-view:visible');
const source = () => view().getByRole('combobox', { name: 'Источник', exact: true });
const storedPath = path.join(profile, 'router-connections.json');
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', cause => errors.push(cause.message));
  await app.evaluate(({ ipcMain, dialog, net }, fixture) => {
    globalThis.__sourceHost = { calls: [], downloads: 0 };
    const rpc = ipcMain._invokeHandlers.get('codex:request');
    ipcMain.removeHandler('codex:request');
    ipcMain.handle('codex:request', (event, method, ...args) => {
      globalThis.__sourceHost.calls.push({ method, threadId: args[0]?.threadId, sessionId: args[1] });
      if (['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start'].includes(method)) throw new Error('Host source test forbids model input');
      return rpc(event, method, ...args);
    });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.installer] });
    net.fetch = async (url, options) => {
      if (url !== `https://coder-portal.encycam.com/api/connect/claude/${fixture.ticket}.ps1`) throw new Error('Unexpected network request in host fixture');
      if (options.redirect !== 'error' || options.credentials !== 'omit' || options.headers.Authorization) throw new Error('Unsafe importer request');
      globalThis.__sourceHost.downloads++;
      return new Response(fixture.installerScript, { headers: { 'Content-Type': 'text/plain' } });
    };
  }, { installer, ticket, installerScript });
  await view().getByText('Stored fixture answer 0', { exact: true }).waitFor();
  await until(() => source().isEnabled(), 'restored native Claude session');
  assert.equal(await source().getAttribute('data-value'), 'account');
  const ids = await page.locator('.session-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.sessionId));
  assert.equal(ids.length, 2);
  await until(async () => (await logs()).filter(entry => entry.type === 'spawn' && entry.args.includes('--resume')).length >= 2, 'both native sessions restored');
  const otherResumes = (await logs()).filter(entry => entry.type === 'spawn' && entry.args.includes(nativeIds[1])).length;
  const beforeInfo = await page.evaluate(id => window.codex.forSession(id).getRouterConnection(), ids[0]);
  assert.equal(beforeInfo.configured, false);
  assert.equal(beforeInfo.encryptionAvailable, true);
  const preview = await page.evaluate(id => window.codex.forSession(id).previewRouterInstaller(), ids[0]);
  assert.equal(preview.agent, 'claude'); assert.equal(preview.baseUrl, 'https://router.example.test');
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(`${apiKey}|${ticket}|ANTHROPIC_AUTH_TOKEN|envJson`));
  await assert.rejects(readFile(storedPath), { code: 'ENOENT' });
  const denied = await page.evaluate(async ({ ids, previewId }) => {
    const rejected = [];
    for (const id of [ids[1], 'unowned-session']) {
      try { await window.codex.forSession(id).applyRouterConnection({ previewId }); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, { ids, previewId: preview.previewId });
  assert.deepEqual(denied, [true, true], 'preview belongs to exactly its originating session');
  const badFrame = await app.evaluate(async ({ ipcMain, BrowserWindow }, sessionId) => {
    const win = BrowserWindow.getAllWindows()[0];
    try { await ipcMain._invokeHandlers.get('host:getRouterConnection')({ sender: win.webContents, senderFrame: {} }, sessionId); return false; } catch { return true; }
  }, ids[0]);
  assert.equal(badFrame, true);
  const info = await page.evaluate(({ id, previewId }) => window.codex.forSession(id).applyRouterConnection({ previewId }), { id: ids[0], previewId: preview.previewId });
  assert.equal(info.configured, true); assert.ok(info.savedAt);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(`${apiKey}|${ticket}|ANTHROPIC_AUTH_TOKEN`));
  await assert.rejects(page.evaluate(({ id, previewId }) => window.codex.forSession(id).applyRouterConnection({ previewId }), { id: ids[0], previewId: preview.previewId }));
  const stored = await readFile(storedPath, 'utf8'), envelope = JSON.parse(stored);
  assert.doesNotMatch(stored, new RegExp(`${apiKey}|${ticket}|router.example|cc/fixture`), 'whole entry is encrypted');
  assert.equal(envelope.version, 1); assert.equal(typeof envelope.entries.claude, 'string');
  const decryptedFlags = await app.evaluate(({ safeStorage }, encrypted) => {
    const entry = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    return { saved: Boolean(entry.savedAt), bearer: entry.connection.authScheme === 'bearer', aliases: Object.keys(entry.connection.modelAliases),
      isolated: !Object.hasOwn(entry.connection, 'env') && !Object.hasOwn(entry.connection, 'UNRELATED_SETTING') };
  }, envelope.entries.claude);
  assert.deepEqual(decryptedFlags, { saved: true, bearer: true, aliases: ['opus'], isolated: true });
  for (const value of ['router', 'account']) {
    await source().click();
    await page.getByRole('listbox', { name: 'Источник', exact: true }).locator(`[data-value="${value}"]`).click();
    await until(async () => await source().getAttribute('data-value') === value && await source().isEnabled(), `source ${value} ready`);
    await view().getByText('Stored fixture answer 0', { exact: true }).waitFor();
    assert.equal(await view().locator('.composer textarea').inputValue(), 'Preserved draft 0');
    assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-claude');
    assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
    const settingsNow = await page.evaluate(id => window.codex.forSession(id).getSettings(), ids[0]);
    assert.equal(settingsNow.connectionSource, value);
    assert.doesNotMatch(JSON.stringify(settingsNow), new RegExp(apiKey));
    const boot = await page.evaluate(id => window.codex.forSession(id).start(), ids[0]);
    assert.doesNotMatch(JSON.stringify(boot), new RegExp(apiKey), `${value} effective secret settings never escape in bootstrap`);
  }
  const actualLogs = await logs();
  assert.equal(actualLogs.some(entry => entry.type === 'forbidden_model_input'), false);
  const resumes = actualLogs.filter(entry => entry.type === 'spawn' && entry.args.includes('--resume') && entry.args.includes(nativeIds[0]))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.equal(resumes.length, 3, 'initial account, router and account all restore the same native UUID');
  assert.deepEqual(resumes.map(entry => [entry.baseUrl, entry.bearerSet, entry.settingsBearerSet, entry.oauthSet]), [
    ['https://api.anthropic.com', false, false, false], ['https://router.example.test', true, true, false], ['https://api.anthropic.com', false, false, false],
  ]);
  assert.equal(resumes[1].opus, 'cc/fixture-opus[1m]');
  assert.ok(resumes.every(entry => entry.helperDisabled && entry.settingsFile && entry.configDirectory === config));
  assert.equal(actualLogs.filter(entry => entry.type === 'spawn' && entry.args.includes(nativeIds[1])).length, otherResumes, 'other account session never restarts');
  const otherSettings = await page.evaluate(id => window.codex.forSession(id).getSettings(), ids[1]);
  assert.equal(otherSettings.connectionSource, 'account');
  assert.equal(await readFile(path.join(config, 'settings.json'), 'utf8'), nativeConfig);
  assert.equal(await readFile(path.join(config, '.credentials.json'), 'utf8'), nativeCredentials);
  assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), nativeCodex);
  for (const [index, id] of nativeIds.entries()) assert.equal(await readFile(path.join(transcriptFolder, `${id}.jsonl`), 'utf8'), transcripts[index]);
  const host = await app.evaluate(() => globalThis.__sourceHost);
  assert.equal(host.downloads, 1);
  assert.equal(host.calls.some(call => ['thread/start', 'turn/start', 'turn/steer', 'thread/compact/start'].includes(call.method)), false);
  for (const file of await readdir(path.join(profile, 'logs'))) if (file.endsWith('.jsonl')) {
    assert.doesNotMatch(await readFile(path.join(profile, 'logs', file), 'utf8'), new RegExp(`${apiKey}|${ticket}`));
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(run, 'sources-host.png') });
  await writeFile(path.join(run, 'result.json'), JSON.stringify({ scopedPreview: true, encryptedStore: true, nativeResumeSources: resumes.map(entry => entry.baseUrl),
    nativeUuidPreserved: true, isolatedOtherSession: true, unchangedNativeSettings: true, modelCalls: 0, portalDownloads: host.downloads }, null, 2));
  console.log(`PASS: real main/preload/scoped IPC; installer preview/Apply and DPAPI store; two isolated Claude sessions; account/router/account preserve native UUID, draft/model/effort; correct process env and temporary settings; no global config/history changes, secret logging or model calls. ${run}`);
} catch (cause) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  console.error(`Connection sources host artifacts: ${run}`);
  throw cause;
} finally {
  if (app) await app.close().catch(() => {});
}
