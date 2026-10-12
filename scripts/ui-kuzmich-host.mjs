import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'kuzmich-host-'));
const home = path.join(run, 'home'), profile = path.join(run, 'profile');
const codexHome = path.join(run, 'codex-home'), claudeHome = path.join(run, 'claude-home');
const bin = path.join(home, '.local', 'bin');
const local = path.join(home, 'AppData', 'Local'), roaming = path.join(home, 'AppData', 'Roaming');
const temp = path.join(run, 'temp');
await Promise.all([bin, profile, codexHome, claudeHome, local, roaming, temp].map(directory => mkdir(directory, { recursive: true })));
const protectedDirectories = [codexHome, claudeHome, path.join(home, '.codex'), path.join(home, '.claude')];
const sentinels = new Map();
for (const directory of protectedDirectories) {
  await mkdir(directory, { recursive: true });
  const isCodex = directory === codexHome || directory.endsWith('.codex');
  const fixtures = isCodex ? { 'config.toml': '# untouched smoke sentinel\r\n', 'auth.json': '{}\n' }
    : { 'settings.json': '{"permissions":{"allow":[]},"env":{"SMOKE_SENTINEL":"untouched"}}\n' };
  for (const [filename, content] of Object.entries(fixtures)) {
    const target = path.join(directory, filename);
    const bytes = Buffer.from(content);
    await writeFile(target, bytes);
    sentinels.set(target, bytes);
  }
}
const initialListings = await Promise.all(protectedDirectories.map(directory => readdir(directory).then(names => names.sort())));
await writeFile(path.join(run, 'isolated.fixture'), 'local only');
const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:SETUP_SOURCE -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:SETUP_EXE -OutputType ConsoleApplication";
await promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, env: { ...process.env, SETUP_SOURCE: path.join(root, 'scripts', 'fixtures', 'setup-cli.cs'), SETUP_EXE: path.join(bin, 'codex.exe') },
});
await copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));

const runtime = path.join(run, 'runtime'), staged = path.join(runtime, 'resources', 'app');
await cp(path.join(root, 'node_modules', 'electron', 'dist'), runtime, { recursive: true });
const executable = path.join(runtime, 'Kuzmich Host Smoke.exe');
await rename(path.join(runtime, 'electron.exe'), executable);
await mkdir(staged, { recursive: true });
await cp(path.join(root, 'electron'), path.join(staged, 'electron'), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(staged, 'package.json'), JSON.stringify({ ...manifest, main: 'smoke-bootstrap.mjs' }));
await writeFile(path.join(runtime, 'resources', 'channel.json'), JSON.stringify({ channel: 'experimental3' }));
await writeFile(path.join(staged, 'electron', 'build-info.json'), JSON.stringify({ version: manifest.version, buildId: 'a'.repeat(64), builtAt: new Date().toISOString() }));
await symlink(path.join(root, 'node_modules'), path.join(staged, 'node_modules'), 'junction');
await copyFile(path.join(root, 'scripts', 'fixtures', 'kuzmich-host-bootstrap.mjs'), path.join(staged, 'smoke-bootstrap.mjs'));
await promisify(execFile)(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', path.join(staged, 'dist')], { cwd: root, windowsHide: true });

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|ELECTRON_RUN_AS_NODE$)/i.test(name)) delete env[name];
}
Object.assign(env, { CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
  USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
  HOMEDRIVE: path.parse(home).root.slice(0, -1), HOMEPATH: home.slice(path.parse(home).root.length - 1),
  SETUP_FIXTURE_ROOT: run, PATH: bin + ';' + process.env.SystemRoot + '\\System32;' + path.dirname(ps) });
let app, page, audit, completed = false;
const errors = [];
try {
  app = await electron.launch({ executablePath: executable, args: [], cwd: staged, env, timeout: 60000 });
  app.on('window', window => window.on('pageerror', error => errors.push(error.message)));
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { title: window.getTitle(), backgroundColor: window.getBackgroundColor().toUpperCase() };
  }), { title: 'Кузьмич — Experimental 3', backgroundColor: '#171A19' });
  await page.locator('#kuzmich-title').waitFor();
  assert.deepEqual(await page.locator('.setup-steps li strong').allTextContents(), ['CLI', 'Вход', 'Подключение', 'Готово']);
  const state = await page.evaluate(() => window.codex.setup.state());
  assert.equal(state.experimental3, true);
  assert.equal(state.show, true);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
  await page.screenshot({ path: path.join(run, 'cli.png') });
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.locator('.setup-dialog[data-step="1"]').waitFor();
  const snapshot = await page.evaluate(() => window.codex.setup.portalSession());
  assert.equal(snapshot.state, 'signed-out');
  assert.equal(snapshot.keyState, 'none');
  assert.deepEqual(snapshot.products, { codex: false, claude: false });
  audit = await app.evaluate(() => globalThis.kuzmichSmoke);
  assert.equal(audit.requests.length, 1, 'Login step and bridge share one cached /api/me request');
  assert.equal(audit.requests[0].path, '/api/me');
  if (audit.requests[0].status === 401) assert.equal(snapshot.message, undefined, 'Fresh 401 must have no expired-session message');
  else {
    assert.equal(audit.requests[0].networkFailure, true, 'Only a network failure can substitute for 401');
    assert.ok(snapshot.message, 'Offline signed-out variant must explain network failure');
  }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.screenshot({ path: path.join(run, 'signed-out.png') });
  await page.getByRole('button', { name: 'Войти позже', exact: true }).click();
  await page.locator('.setup-dialog[data-step="2"]').waitFor();
  await page.getByText('Сначала нужен вход в Portal', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.codex.setup.portalConnectStatus()), { running: false, products: {} });
  await page.screenshot({ path: path.join(run, 'connection-gate.png') });
  await page.getByRole('button', { name: 'Настроить позже', exact: true }).click();
  await page.locator('.setup-dialog').waitFor({ state: 'detached' });
  const deferred = await page.evaluate(() => window.codex.setup.state());
  assert.equal(deferred.show, false);
  assert.equal(deferred.deferred, true);
  audit = await app.evaluate(() => globalThis.kuzmichSmoke);
  assert.equal(audit.windows, 1, 'No login window was opened');
  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.rendererErrors, []);
  for (const response of audit.network) {
    assert.equal(response.method, 'GET');
    assert.ok(['/api/me', '/api/key'].includes(response.path));
    assert.equal(response.status, 401, 'No authenticated or unexpected HTTP response is allowed');
  }
  assert.equal(audit.requests.length, 1, 'No portal polling or mutation');
  const child = app.process();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  assert.deepEqual(await exited, { code: 0, signal: null });
  app = null;
  assert.deepEqual(errors, []);
  completed = true;
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  console.error('Артефакты хост-проверки Кузьмича: ' + run);
  throw error;
} finally {
  if (app) {
    audit = await app.evaluate(() => globalThis.kuzmichSmoke).catch(() => audit);
    await app.close();
  }
  if (audit) {
    assert.deepEqual(audit.violations, []);
    assert.deepEqual(audit.rendererErrors, []);
  }
  for (const [filename, bytes] of sentinels) assert.deepEqual(await readFile(filename), bytes, 'Sentinel changed: ' + filename);
  for (const [index, directory] of protectedDirectories.entries()) assert.deepEqual((await readdir(directory)).sort(), initialListings[index], 'Config directory changed: ' + directory);
  const readRows = async (filename, json = true) => {
    try { return (await readFile(path.join(run, filename), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => json ? JSON.parse(line) : line); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const calls = await readRows('calls.jsonl'), rpc = await readRows('rpc.jsonl', false);
  for (const call of calls) assert.ok(call.args.join(' ') === '--version' || call.args[0] === 'app-server' || call.args.join(' ') === 'auth status', 'Only scan/read-only fixture commands allowed');
  for (const method of rpc) assert.ok(['initialize', 'initialized', 'account/read'].includes(method), 'No model/auth/config mutation RPC');
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ completed, audit, errors, calls, rpc, sentinels: 'byte-identical' }, null, 2));
}
console.log('PASS: Experimental 3 production Electron -> real preload/IPC -> CLI/Вход/Подключение/Готово; signed-out gate, deferred exit (0), zero renderer errors, CLI sentinels byte-identical. Portal: '
  + (audit.requests[0].status === 401 ? 'reachable, unauthenticated GET /api/me returned 401, no message' : 'unreachable, network-failure signed-out variant accepted')
  + '. No sign-in, mutations or model calls. Artifacts: ' + run);
