import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Production UI/preload/IPC and the real visible Windows launcher, with a safe
// compiled CLI fixture. No installed Claude, browser, credentials or model calls.
assert.equal(process.platform, 'win32', 'Native Claude auth regression requires Windows');
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'claude-auth-host-'));
const project = path.join(runDir, "PROJECT O'Brien $() ` &"), profile = path.join(runDir, 'profile'), config = path.join(runDir, 'isolated-claude');
await Promise.all([mkdir(project), mkdir(profile), mkdir(config)]);
await writeFile(path.join(config, 'isolated.fixture'), 'local test only');
const executable = path.join(runDir, 'claude-auth-fixture.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:AUTH_FIXTURE_SOURCE -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:AUTH_FIXTURE_EXE -OutputType ConsoleApplication";
await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, timeout: 30_000, env: { ...process.env, AUTH_FIXTURE_SOURCE: path.join(root, 'scripts', 'fixtures', 'claude-auth.cs'), AUTH_FIXTURE_EXE: executable },
});
const settings = { provider: 'claude', executable, cwd: project, model: 'fixture-claude', effort: 'medium', access: 'auto' };
await Promise.all([
  writeFile(path.join(profile, 'settings.json'), JSON.stringify({ cwd: project, providers: { claude: settings, codex: { executable, cwd: project } } })),
  writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] })),
  writeFile(path.join(profile, 'workspace-state.json'), JSON.stringify({ version: 1, activeIndex: 0, tabs: [{ cwd: project, settings, draft: 'Черновик до входа', attachments: [] }] })),
]);
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile, CODEX_DESK_TEST: '1', CLAUDE_CONFIG_DIR: config };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
const until = async (check, label) => { const deadline = Date.now() + 20_000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const logs = async () => (await Promise.all((await readdir(config)).filter(name => /^fixture-\d+\.jsonl$/.test(name)).map(name => readFile(path.join(config, name), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
const errors = [];
let app, page, consoleInfo;
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const model = () => view().getByRole('combobox', { name: 'Модель', exact: true });
  await view().getByText(/Fixture: login required before bootstrap/).waitFor();
  assert.equal(await model().isDisabled(), true, 'Initial stream bootstrap deliberately fails');
  const sessionId = await page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const other = await page.evaluate(async ({ sessionId, project }) => {
    const codex = await window.codex.createSession({ fromSessionId: sessionId, provider: 'codex', cwd: project });
    const claude = await window.codex.createSession({ fromSessionId: sessionId, provider: 'claude', cwd: project });
    window.__authHostEvents = [];
    for (const id of [sessionId, codex.id, claude.id]) window.codex.forSession(id).onEvent(event => { if (event.type === 'auth') window.__authHostEvents.push({ id, ...event.data }); });
    const rejected = [];
    for (const id of ['unknown-session', codex.id]) for (const method of ['getClaudeAuthStatus', 'loginClaude']) {
      try { await window.codex.forSession(id)[method](); rejected.push(false); } catch { rejected.push(true); }
    }
    return { codexId: codex.id, claudeId: claude.id, rejected };
  }, { sessionId, project });
  assert.deepEqual(other.rejected, [true, true, true, true]);
  const frameRejected = await app.evaluate(async ({ ipcMain, BrowserWindow }, sessionId) => {
    const window = BrowserWindow.getAllWindows()[0];
    const handler = ipcMain._invokeHandlers.get('host:loginClaude');
    try { await handler({ sender: window.webContents, senderFrame: {} }, sessionId); return false; } catch { return true; }
  }, sessionId);
  assert.equal(frameRejected, true, 'Non-main frame cannot invoke auth');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  const auth = view().getByRole('region', { name: 'Авторизация Claude Code', exact: true });
  await auth.getByText('Вход не выполнен', { exact: true }).waitFor();
  assert.equal(await auth.getByRole('button', { name: 'Войти через браузер', exact: true }).isEnabled(), true, 'Recovery button works without connection');
  const signedOut = await page.evaluate(id => window.codex.forSession(id).getClaudeAuthStatus(), sessionId);
  assert.equal(signedOut.loggedIn, false); assert.equal(signedOut.configDirectory, config);
  assert.equal(signedOut.accessToken, undefined, 'Unexpected secret fields never cross IPC');
  await auth.getByRole('button', { name: 'Войти через браузер', exact: true }).click();
  await auth.getByText('Вход выполняется в Claude CLI…', { exact: true }).waitFor();
  await until(async () => { try { consoleInfo = JSON.parse(await readFile(path.join(config, 'console.json'), 'utf8')); return true; } catch { return false; } }, 'visible native login console');
  assert.deepEqual(consoleInfo.args, ['auth', 'login', '--claudeai']);
  assert.equal(consoleInfo.cwd, project); assert.equal(consoleInfo.configDirectory, config);
  for (const name of ['stdin', 'stdout', 'stderr']) assert.equal(consoleInfo[name], true, `${name} is a native console handle`);
  assert.equal(alive(consoleInfo.pid), true);
  assert.equal(await auth.getByRole('button', { name: 'Войти через браузер', exact: true }).isDisabled(), true);
  const blocked = await page.evaluate(async ({ sessionId, other }) => {
    const results = [];
    for (const call of [() => window.codex.forSession(sessionId).loginClaude(), () => window.codex.forSession(other.claudeId).start(), () => window.codex.closeSession(sessionId)]) {
      try { await call(); results.push(false); } catch { results.push(true); }
    }
    return results;
  }, { sessionId, other });
  assert.deepEqual(blocked, [true, true, true], 'Second login, Claude bootstrap and tab close are blocked');
  assert.equal((await logs()).filter(entry => entry.type === 'user').length, 0);
  await writeFile(path.join(config, 'release.fixture'), 'test permits fixture login completion');
  await auth.getByText('Вход выполнен', { exact: true }).waitFor();
  await until(() => model().isEnabled(), 'fresh Claude bootstrap after login');
  assert.equal(alive(consoleInfo.pid), false);
  assert.equal(await model().getAttribute('data-value'), 'fixture-claude');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'medium');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'auto');
  const events = await page.evaluate(() => window.__authHostEvents);
  assert.deepEqual(events.filter(event => event.id === sessionId).map(({ id, ...event }) => event), [{ state: 'opened' }, { state: 'opened' }, { state: 'closed', loggedIn: true }]);
  assert.equal(events.some(event => event.id === other.codexId), false, 'Codex receives no Claude auth events');
  assert.equal(events.filter(event => event.id === other.claudeId && event.state === 'closed').length, 1);
  const final = await logs();
  assert.equal(final.filter(entry => entry.type === 'spawn' && entry.args[0] === 'auth' && entry.args[1] === 'login').length, 1);
  assert.equal(final.filter(entry => entry.type === 'spawn' && entry.args[0] === '-p').length, 2, 'Exactly one new stream bootstrap after successful login');
  assert.equal(final.filter(entry => entry.type === 'user').length, 0, 'No user/model input was sent');
  assert.equal(final.filter(entry => entry.type === 'spawn' && entry.tokenSet).length, 0, 'No token variable before one is configured');

  // Long-lived token: encrypted host storage, CLI environment only, idle tabs relaunch, consoles stay token-free.
  const sampleToken = `sk-ant-oat01-${'FiXtUrE9'.repeat(12)}`;
  const tokenRegion = auth.locator('.claude-token');
  await tokenRegion.getByText('Токен не настроен', { exact: true }).waitFor();
  const tokenIpc = await page.evaluate(async ({ sessionId, other, sampleToken }) => {
    const before = await window.codex.forSession(sessionId).getClaudeToken();
    const rejected = [];
    for (const call of [() => window.codex.forSession(other.codexId).getClaudeToken(), () => window.codex.forSession(sessionId).setClaudeToken('not-a-token'), () => window.codex.forSession(other.codexId).setClaudeToken(sampleToken)]) {
      try { await call(); rejected.push(false); } catch { rejected.push(true); }
    }
    return { before, rejected };
  }, { sessionId, other, sampleToken });
  assert.deepEqual(tokenIpc.before, { configured: false, encryptionAvailable: true });
  assert.deepEqual(tokenIpc.rejected, [true, true, true], 'Codex sessions and malformed tokens are rejected');
  await page.evaluate(() => { window.__authHostEvents.length = 0; });
  await tokenRegion.getByLabel('Токен Claude Code', { exact: true }).fill(sampleToken);
  await tokenRegion.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await tokenRegion.getByText('Токен сохранён', { exact: true }).waitFor();
  await until(() => model().isEnabled(), 'Claude relaunch with the token');
  const stored = await readFile(path.join(profile, 'claude-token.json'), 'utf8');
  assert.doesNotMatch(stored, /sk-ant-oat/, 'Token is encrypted at rest');
  const tokenEvents = await page.evaluate(() => window.__authHostEvents);
  assert.deepEqual(tokenEvents.filter(event => event.id === sessionId).map(({ id, ...event }) => event), [{ state: 'opened' }, { state: 'closed', message: 'Настройка токена Claude Code изменена. Подключение обновлено.' }]);
  assert.equal(tokenEvents.some(event => event.id === other.codexId), false);
  const withToken = await page.evaluate(id => window.codex.forSession(id).getClaudeToken(), sessionId);
  assert.equal(withToken.configured, true); assert.ok(withToken.savedAt); assert.equal(withToken.error, undefined);
  await until(async () => (await logs()).some(entry => entry.type === 'spawn' && entry.args[0] === '-p' && entry.tokenSet), 'stream bootstrap receives CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal((await logs()).filter(entry => entry.type === 'spawn' && entry.args[0] === 'auth' && entry.tokenSet).length > 0, true, 'auth status runs with the token environment');
  await tokenRegion.getByRole('button', { name: 'Получить токен: claude setup-token', exact: true }).click();
  let setupInfo;
  await until(async () => { try { setupInfo = JSON.parse(await readFile(path.join(config, 'setup-console.json'), 'utf8')); return true; } catch { return false; } }, 'visible native setup-token console');
  assert.deepEqual(setupInfo.args, ['setup-token']); assert.equal(setupInfo.cwd, project);
  assert.equal(setupInfo.tokenSet, false, 'setup-token console never inherits the stored token');
  for (const name of ['stdin', 'stdout', 'stderr']) assert.equal(setupInfo[name], true, `${name} is a native console handle`);
  await until(() => !alive(setupInfo.pid), 'setup-token console exits');
  assert.equal((await logs()).filter(entry => entry.type === 'spawn' && entry.args[0] === 'auth' && entry.args[1] === 'login').length, 1, 'setup-token does not trigger a login');
  await tokenRegion.getByRole('button', { name: 'Удалить токен', exact: true }).click();
  await tokenRegion.getByText('Токен не настроен', { exact: true }).waitFor();
  await until(() => model().isEnabled(), 'Claude relaunch without the token');
  await assert.rejects(readFile(path.join(profile, 'claude-token.json')), { code: 'ENOENT' });
  const afterClear = await logs();
  const streams = afterClear.filter(entry => entry.type === 'spawn' && entry.args[0] === '-p');
  // Per-process log files are read in pid order, so compare counts rather than sequence.
  assert.equal(streams.length, 4, 'Failed start, login relaunch, token relaunch, removal relaunch');
  assert.equal(streams.filter(entry => entry.tokenSet).length, 1, 'Only the token-phase bootstrap carried the variable');
  assert.equal(afterClear.filter(entry => entry.type === 'user').length, 0, 'Still no user/model input');
  await view().getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  assert.equal(await view().locator('.composer textarea').inputValue(), 'Черновик до входа');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(runDir, 'claude-auth-host.png') });
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ nativeConsole: consoleInfo, setupConsole: setupInfo, events, tokenEvents, modelCalls: 0, bootstrapCount: streams.length }, null, 2));
  console.log(`PASS: production Electron/preload/IPC, auth recovery after failed bootstrap, signed-out code1, public status only, session/frame guards, exact native console args/cwd/env/handles/lifetime, one login, Claude-only events and reconnect, draft/settings preserved, encrypted setup-token storage with CLI-only environment, setup-token console, token removal, no model/browser/credentials. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Claude auth host artifacts: ${runDir}`); throw error;
} finally {
  await writeFile(path.join(config, 'release.fixture'), 'cleanup fixture');
  if (consoleInfo) await until(() => !alive(consoleInfo.pid), 'fixture console cleanup');
  if (app) await app.close();
  for (const entry of (await logs()).filter(entry => entry.type === 'spawn' && entry.args[0] === '-p')) await until(() => !alive(entry.pid), 'fixture stream cleanup');
}
