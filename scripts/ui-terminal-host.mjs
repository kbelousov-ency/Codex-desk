import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC and the actual Windows console launcher, with a
// harmless compiled fixture. No installed Codex, model, or user history is used.
assert.equal(process.platform, 'win32', 'This native terminal regression runs on Windows');
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'terminal-host-'));
const project = path.join(runDir, 'PROJECT_TERMINAL');
const profile = path.join(runDir, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
const executable = path.join(runDir, 'terminal-fixture.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compile = "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:TERMINAL_FIXTURE_SOURCE -Raw -Encoding UTF8) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:TERMINAL_FIXTURE_EXE -OutputType ConsoleApplication";
await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], {
  windowsHide: true, timeout: 30000, env: { ...process.env, TERMINAL_FIXTURE_SOURCE: path.join(root, 'scripts', 'fixtures', 'terminal-server.cs'), TERMINAL_FIXTURE_EXE: executable },
});
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'auto' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
const threadId = '01965001-a55b-71da-bf8f-e23a3337ad7f';
const errors = [];
let app, page;
const logs = async () => {
  const files = (await readdir(project)).filter(file => /^server-\d+\.jsonl$/.test(file));
  return (await Promise.all(files.map(file => readFile(path.join(project, file), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const waitFor = async (check, label) => { const deadline = Date.now() + 15000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const terminal = () => view().getByRole('button', { name: 'Открыть текущую сессию в терминале', exact: true });
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'bootstrap ready');
  await input().fill('/resume'); await input().press('Enter');
  await page.getByRole('dialog', { name: 'История диалогов', exact: true }).getByRole('button', { name: 'Terminal fixture history', exact: true }).click();
  await view().getByText('History before terminal.', { exact: true }).waitFor();
  await waitFor(() => terminal().isEnabled(), 'resumed conversation ready');
  const before = await logs();
  const beforeBoots = before.filter(entry => entry.method === 'initialize').length;
  const beforeResumes = before.filter(entry => entry.method === 'thread/resume').length;
  const draft = 'Черновик после возвращения из терминала';
  await input().fill(draft);
  await view().locator('input[type="file"]').setInputFiles({ name: 'terminal-draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить terminal-draft.png', exact: true }).waitFor();
  const sessionId = await page.locator('.session-tab').filter({ has: page.getByRole('tab', { selected: true }) }).getAttribute('data-session-id');
  await page.evaluate(id => { window.__terminalHostEvents = []; window.codex.forSession(id).onEvent(event => { if (event.type === 'terminal') window.__terminalHostEvents.push(event.data); }); }, sessionId);
  await terminal().click();
  await waitFor(async () => (await page.evaluate(() => window.__terminalHostEvents)).some(event => event.state === 'opened'), 'terminal opened IPC');
  assert.equal(await terminal().isDisabled(), true);
  assert.equal(await input().inputValue(), draft);
  await waitFor(async () => { try { await readFile(path.join(project, 'terminal.json')); return true; } catch { return false; } }, 'actual native console started');
  const terminalInfo = JSON.parse(await readFile(path.join(project, 'terminal.json'), 'utf8'));
  assert.equal(terminalInfo.cwd.toLowerCase(), project.toLowerCase());
  assert.deepEqual(terminalInfo.args, ['resume', threadId, '--cd', project, '--model', 'fixture-alpha', '-c', 'model_reasoning_effort=high', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer=auto_review']);
  assert.equal(terminalInfo.stdin, true, 'Native CLI receives console input');
  assert.equal(terminalInfo.stdout, true, 'Native CLI receives console output');
  assert.equal(terminalInfo.stderr, true, 'Native CLI receives console error output');
  assert.equal(alive(terminalInfo.pid), true, 'Native terminal stays alive after launch acknowledgement');
  assert.equal(await terminal().isDisabled(), true, 'App ownership remains transferred during native console lifetime');
  const closeAttempt = await page.evaluate(async id => {
    try { await window.codex.closeSession(id); return { closed: true }; }
    catch (error) { return { closed: false, error: error.message }; }
  }, sessionId);
  assert.equal(closeAttempt.closed, false, 'Host forbids closing a tab that owns a live terminal');
  assert.match(closeAttempt.error, /терминал/i);
  await view().getByText('History updated by terminal fixture.', { exact: true }).waitFor();
  await waitFor(() => terminal().isEnabled(), 'terminal closes and conversation reloads');
  assert.equal(alive(terminalInfo.pid), false);
  assert.equal(await input().inputValue(), draft);
  assert.equal(await view().getByRole('button', { name: 'Удалить terminal-draft.png', exact: true }).count(), 1);
  const final = await logs();
  assert.equal(final.filter(entry => entry.method === 'turn/start').length, 0, 'Terminal action never sends a prompt');
  assert.equal(final.filter(entry => entry.method === 'thread/start').length, 0, 'Existing conversation is resumed without creating one');
  assert.equal(final.filter(entry => entry.method === 'initialize').length, beforeBoots + 1, 'Exactly one fresh App Server follows terminal exit');
  assert.equal(final.filter(entry => entry.method === 'thread/resume').length, beforeResumes + 1);
  for (const request of final.filter(entry => entry.method === 'thread/read' || entry.method === 'thread/resume')) assert.equal(request.params.threadId, threadId);
  assert.deepEqual(await page.evaluate(() => window.__terminalHostEvents), [{ state: 'opened', threadId }, { state: 'closed', threadId }]);
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-alpha');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'auto');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(runDir, 'terminal-host.png') });
  console.log(`PASS: actual Electron/preload/scoped IPC, native visible console handles and lifetime, exact CLI resume UUID/cwd/model/effort/access, no prompt or new thread, fresh App Server and updated history after terminal close, draft/image preserved. Harmless compiled fixture only, no Codex/provider/user history. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Terminal host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  for (const entry of (await logs()).filter(entry => entry.type === 'spawn')) await waitFor(() => !alive(entry.pid), 'fixture App Server cleanup');
}
