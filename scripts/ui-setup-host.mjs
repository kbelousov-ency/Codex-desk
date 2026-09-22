import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'setup-host-'));
const home = path.join(run, 'home'), profile = path.join(run, 'profile'), config = path.join(run, 'codex-home');
const claudeHome = path.join(run, 'claude-home');
const bin = path.join(home, '.local', 'bin');
await Promise.all([mkdir(bin, { recursive: true }), mkdir(profile), mkdir(config), mkdir(claudeHome)]);
await Promise.all(['Local', 'Roaming'].map(name => mkdir(path.join(home, 'AppData', name), { recursive: true })));
await writeFile(path.join(run, 'isolated.fixture'), 'local only');
const source = path.join(run, 'portal.toml');
const original = '# existing\r\nmodel = "old-fixture"\r\n';
const imported = '# portal fixture\nmodel = "fixture"\n';
await writeFile(path.join(config, 'config.toml'), original);
await writeFile(source, imported);
const memoryFixtures = {
  codex: { directory: config, instructionPath: path.join(config, 'AGENTS.override.md'), original: Buffer.from('\uFEFF# Codex user rules\r\nPreserve override instructions and decisions.') },
  claude: { directory: claudeHome, instructionPath: path.join(claudeHome, 'CLAUDE.md'), original: Buffer.from('# Claude user rules\nPreserve user instructions.\n') },
};
const baseInstructions = '# Base Codex instructions must remain untouched.\r\n';
await writeFile(path.join(config, 'AGENTS.md'), baseInstructions);
for (const fixture of Object.values(memoryFixtures)) await writeFile(fixture.instructionPath, fixture.original);
const initialMemoryFiles = Object.fromEntries(await Promise.all(Object.entries(memoryFixtures).map(async ([provider, fixture]) => [provider, (await readdir(fixture.directory)).sort()])));
const memoryEnabled = {};

const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:SETUP_SOURCE -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:SETUP_EXE -OutputType ConsoleApplication";
await promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, env: { ...process.env, SETUP_SOURCE: path.join(root, 'scripts', 'fixtures', 'setup-cli.cs'), SETUP_EXE: path.join(bin, 'codex.exe') },
});
await copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile, USERPROFILE: home, HOME: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
  CODEX_HOME: config, CLAUDE_CONFIG_DIR: claudeHome, SETUP_FIXTURE_ROOT: run,
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
async function openMemoryStep() {
  for (let step = 1; step <= 3; step++) {
    await page.locator('.setup-footer-actions > .is-primary').click();
    await page.locator(`.setup-dialog[data-step="${step}"]`).waitFor();
  }
  for (const provider of Object.keys(memoryFixtures)) {
    await page.locator(`[data-memory-provider="${provider}"] .memory-rules-text pre`).first().waitFor({ state: 'attached' });
  }
}
async function assertMemoryPreviewUnchanged() {
  for (const [provider, fixture] of Object.entries(memoryFixtures)) {
    const preview = await page.evaluate(provider => window.codex.memoryRules.preview(provider), provider);
    assert.equal(preview.provider, provider);
    assert.equal(preview.enabled, false);
    assert.equal(preview.conflict, null);
    assert.equal(preview.instructionPath, fixture.instructionPath);
    assert.equal(preview.procedurePath, path.join(fixture.directory, 'codex-desk', 'memory-compact.md'));
    assert.ok(preview.rulesText.length > 100);
    assert.ok(preview.procedureText.length > 100);
    assert.match(preview.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(fixture.instructionPath), fixture.original);
    assert.deepEqual((await readdir(fixture.directory)).sort(), initialMemoryFiles[provider], 'Preview must not create files or directories');
    await assert.rejects(readFile(preview.procedurePath), { code: 'ENOENT' });
  }
  assert.equal(await readFile(path.join(config, 'AGENTS.md'), 'utf8'), baseInstructions);
}
try {
  await launch();
  await page.locator('.setup-dialog').waitFor();
  const scan = await page.evaluate(() => window.codex.setup.scan());
  assert.equal(scan.components.find(c => c.id === 'codex').status, 'installed');
  assert.equal(scan.components.find(c => c.id === 'claude').status, 'installed');
  assert.equal(scan.config.customHome, true);
  assert.equal((await page.evaluate(() => window.codex.getWorkspace())).sessions.length, 0, 'Fresh install must not open installation directory as a project');
  await assertMemoryPreviewUnchanged();
  const rejected = await page.evaluate(async () => {
    const result = [];
    for (const action of [
      () => window.codex.setup.install('unknown'), () => window.codex.setup.authStatus('unknown'),
      () => window.codex.setup.applyConfig({ previewId: 'fake', replaceExisting: true }),
      () => window.codex.memoryRules.preview('unknown'), () => window.codex.memoryRules.apply({ provider: 'unknown', enabled: true, revision: 'fake' }),
      () => window.codex.memoryRules.apply({ provider: 'codex', enabled: 'true', revision: 'fake' }),
      () => window.codex.memoryRules.apply({ provider: 'claude', enabled: true, revision: '0'.repeat(64) }),
    ]) {
      try { await action(); result.push(false); } catch { result.push(true); }
    }
    return result;
  });
  assert.deepEqual(rejected, Array(7).fill(true));
  await assertMemoryPreviewUnchanged();
  const frameRejected = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const rejected = [];
    for (const channel of ['setup:scan', 'memoryRules:preview', 'memoryRules:apply']) {
      const handler = ipcMain._invokeHandlers.get(channel);
      if (!handler) { rejected.push(false); continue; }
      try { await handler({ sender: win.webContents, senderFrame: {} }, channel.endsWith('apply') ? { provider: 'codex', enabled: true, revision: '0'.repeat(64) } : 'codex'); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  });
  assert.deepEqual(frameRejected, [true, true, true]);
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
  await openMemoryStep();
  for (const [provider, fixture] of Object.entries(memoryFixtures)) {
    const card = page.locator(`[data-memory-provider="${provider}"]`);
    const preview = await page.evaluate(provider => window.codex.memoryRules.preview(provider), provider);
    assert.equal(preview.enabled, false, 'Opening the memory step must not silently enable rules');
    const texts = card.locator('.memory-rules-text');
    await texts.nth(0).locator('summary').click();
    assert.equal(await texts.nth(0).locator('pre').textContent(), preview.rulesText);
    await texts.nth(1).locator('summary').click();
    assert.equal(await texts.nth(1).locator('pre').textContent(), preview.procedureText);
    await texts.nth(0).locator('summary').click();
    await texts.nth(1).locator('summary').click();
    await card.getByRole('button', { name: `Включить для ${provider === 'codex' ? 'Codex' : 'Claude'}`, exact: true }).click();
    await card.getByRole('button', { name: `Отключить для ${provider === 'codex' ? 'Codex' : 'Claude'}`, exact: true }).waitFor();
    const current = await page.evaluate(provider => window.codex.memoryRules.preview(provider), provider);
    assert.equal(current.enabled, true);
    assert.equal(current.conflict, null);
    const changed = await readFile(fixture.instructionPath);
    assert.deepEqual(changed.subarray(0, fixture.original.length), fixture.original);
    assert.equal(await readFile(current.procedurePath, 'utf8'), preview.procedureText);
    const backups = await card.locator('.memory-rules-result li code').allTextContents();
    assert.equal(backups.length, 1);
    assert.equal(path.dirname(backups[0]), fixture.directory);
    assert.deepEqual(await readFile(backups[0]), fixture.original);
    memoryEnabled[provider] = { contents: changed, procedurePath: current.procedurePath, backupPaths: backups };
    if (provider === 'codex') {
      assert.deepEqual(await readFile(memoryFixtures.claude.instructionPath), memoryFixtures.claude.original, 'Codex rules must not change Claude instructions');
    }
  }
  assert.equal(await readFile(path.join(config, 'AGENTS.md'), 'utf8'), baseInstructions);
  await page.screenshot({ path: path.join(run, 'setup-host.png') });
  await page.evaluate(() => window.codex.setup.complete({ provider: 'claude' }));
  assert.equal((await page.evaluate(() => window.codex.setup.state())).show, false);
  await close();
  await launch();
  await page.getByRole('button', { name: 'Настроить агентов', exact: true }).waitFor();
  assert.equal(await page.locator('.setup-dialog').count(), 0);
  for (const [provider, fixture] of Object.entries(memoryFixtures)) {
    const preview = await page.evaluate(provider => window.codex.memoryRules.preview(provider), provider);
    assert.equal(preview.enabled, true, 'Rules must remain enabled across app restarts');
    assert.equal(preview.conflict, null);
    assert.deepEqual(await readFile(fixture.instructionPath), memoryEnabled[provider].contents);
  }
  await page.getByRole('button', { name: 'Настроить агентов', exact: true }).click();
  await page.locator('.setup-dialog').waitFor();
  await openMemoryStep();
  for (const [provider, fixture] of Object.entries(memoryFixtures)) {
    const card = page.locator(`[data-memory-provider="${provider}"]`);
    await card.getByRole('button', { name: `Отключить для ${provider === 'codex' ? 'Codex' : 'Claude'}`, exact: true }).click();
    await card.getByRole('button', { name: `Включить для ${provider === 'codex' ? 'Codex' : 'Claude'}`, exact: true }).waitFor();
    assert.equal((await page.evaluate(provider => window.codex.memoryRules.preview(provider), provider)).enabled, false);
    assert.deepEqual(await readFile(fixture.instructionPath), fixture.original, 'Disabling must preserve the original user instructions byte for byte');
    const backups = await card.locator('.memory-rules-result li code').allTextContents();
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(backups[0]), memoryEnabled[provider].contents);
    assert.deepEqual(await readFile(memoryEnabled[provider].backupPaths[0]), fixture.original, 'Earlier backups must be retained');
    assert.ok((await readFile(memoryEnabled[provider].procedurePath)).length > 100, 'Disabling must retain the local reference');
    if (provider === 'codex') assert.equal((await page.evaluate(() => window.codex.memoryRules.preview('claude'))).enabled, true);
  }
  assert.equal(await readFile(path.join(config, 'AGENTS.md'), 'utf8'), baseInstructions);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).provider, 'claude');
  const rpc = await readFile(path.join(run, 'rpc.jsonl'), 'utf8');
  assert.ok(rpc.trim().split('\n').every(method => ['initialize', 'account/read'].includes(method)));
  const calls = (await readFile(path.join(run, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(({ args }) => args[0] === '--version' || args[0] === 'app-server' || (args[0] === 'auth' && ['status', 'login'].includes(args[1]))), 'Only version, authentication and app-server fixture operations are allowed');
  assert.deepEqual(errors, []);
  console.log(`PASS: setup first launch/restart/manual entry, real IPC, frame and input guards, native fixture detection, custom CODEX_HOME, preview/backup/import, provider auth, native Claude login, memory preview/text/enable/restart/disable for both agents, exact instruction backups, no model/install/network. Artifacts: ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  console.error(`Setup host artifacts: ${run}`); throw error;
} finally { if (app) await close().catch(() => app.close()); }
