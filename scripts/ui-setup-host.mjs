import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'setup-host-'));
const home = path.join(run, 'home'), profile = path.join(run, 'profile'), config = path.join(run, 'codex-home');
const bin = path.join(home, '.local', 'bin');
await Promise.all([mkdir(bin, { recursive: true }), mkdir(profile), mkdir(config)]);
await Promise.all(['Local', 'Roaming'].map(name => mkdir(path.join(home, 'AppData', name), { recursive: true })));
await writeFile(path.join(run, 'isolated.fixture'), 'local only');
const source = path.join(run, 'portal.toml');
const original = '# existing\r\nmodel = "old-fixture"\r\n';
const imported = '# portal fixture\nmodel = "fixture"\n';
await writeFile(path.join(config, 'config.toml'), original);
await writeFile(source, imported);
const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:SETUP_SOURCE -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:SETUP_EXE -OutputType ConsoleApplication";
await promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, env: { ...process.env, SETUP_SOURCE: path.join(root, 'scripts', 'fixtures', 'setup-cli.cs'), SETUP_EXE: path.join(bin, 'codex.exe') },
});
await copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile, USERPROFILE: home, HOME: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
  CODEX_HOME: config, CLAUDE_CONFIG_DIR: path.join(run, 'claude-home'), SETUP_FIXTURE_ROOT: run,
  PATH: `${bin};${process.env.SystemRoot}\\System32;${path.dirname(ps)}` };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CODEX_DESK_DEV_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_INSTALL_DIR']) delete env[key];
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
}
async function close() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed; app = null;
}
try {
  await launch();
  await page.locator('.setup-dialog').waitFor();
  const scan = await page.evaluate(() => window.codex.setup.scan());
  assert.equal(scan.components.find(c => c.id === 'codex').status, 'installed');
  assert.equal(scan.components.find(c => c.id === 'claude').status, 'installed');
  assert.equal(scan.config.customHome, true);
  assert.equal((await page.evaluate(() => window.codex.getWorkspace())).sessions.length, 0, 'Fresh install must not open installation directory as a project');
  const rejected = await page.evaluate(async () => {
    const result = [];
    for (const action of [() => window.codex.setup.install('unknown'), () => window.codex.setup.authStatus('unknown'), () => window.codex.setup.applyConfig({ previewId: 'fake', replaceExisting: true })]) {
      try { await action(); result.push(false); } catch { result.push(true); }
    }
    return result;
  });
  assert.deepEqual(rejected, [true, true, true]);
  const frameRejected = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    try { await ipcMain._invokeHandlers.get('setup:scan')({ sender: win.webContents, senderFrame: {} }); return false; } catch { return true; }
  });
  assert.equal(frameRejected, true);
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  const preview = await page.evaluate(() => window.codex.setup.previewConfig());
  assert.equal(preview.exists, true);
  assert.doesNotMatch(JSON.stringify(preview), /old-fixture|portal fixture/);
  await assert.rejects(page.evaluate(previewId => window.codex.setup.applyConfig({ previewId, replaceExisting: false }), preview.previewId));
  const applied = await page.evaluate(previewId => window.codex.setup.applyConfig({ previewId, replaceExisting: true }), preview.previewId);
  assert.equal(await readFile(applied.configPath, 'utf8'), imported);
  assert.equal(await readFile(applied.backupPath, 'utf8'), original);
  assert.equal((await page.evaluate(() => window.codex.setup.authStatus('codex'))).state, 'provider');
  assert.equal((await page.evaluate(() => window.codex.setup.authStatus('claude'))).state, 'signed-out');
  await page.evaluate(() => window.codex.setup.login('claude'));
  for (let attempt = 0; ; attempt++) {
    if ((await page.evaluate(() => window.codex.setup.authStatus('claude'))).state === 'signed-in') break;
    assert.ok(attempt < 50, 'Fixture login must complete');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const auth = await page.evaluate(() => window.codex.setup.authStatus('claude'));
  assert.doesNotMatch(JSON.stringify(auth), /SECRET_FIXTURE/);
  await page.screenshot({ path: path.join(run, 'setup-host.png') });
  await page.evaluate(() => window.codex.setup.complete({ provider: 'claude' }));
  assert.equal((await page.evaluate(() => window.codex.setup.state())).show, false);
  await close();
  await launch();
  await page.getByRole('button', { name: 'Настроить агентов', exact: true }).waitFor();
  assert.equal(await page.locator('.setup-dialog').count(), 0);
  await page.getByRole('button', { name: 'Настроить агентов', exact: true }).click();
  await page.locator('.setup-dialog').waitFor();
  assert.equal(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).provider, 'claude');
  const rpc = await readFile(path.join(run, 'rpc.jsonl'), 'utf8');
  assert.ok(rpc.trim().split('\n').every(method => ['initialize', 'account/read'].includes(method)));
  assert.deepEqual(errors, []);
  console.log(`PASS: setup first launch/restart/manual entry, real IPC, frame and input guards, native fixture detection, custom CODEX_HOME, preview/backup/import, provider auth, native Claude login, no model/install/network. Artifacts: ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  console.error(`Setup host artifacts: ${run}`); throw error;
} finally { if (app) await close().catch(() => app.close()); }
