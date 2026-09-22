import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Isolated Electron/preload/IPC test with a local JSONL child. No model/provider.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'diagnostics-host-'));
const profile = path.join(runDir, 'profile');
const project = path.join(runDir, 'PRIVATE_PROJECT_NAME');
await Promise.all([mkdir(profile), mkdir(project)]);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await writeFile(path.join(project, 'app-server'), String.raw`
import readline from 'node:readline';
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialized') return;
  if (method === 'initialize') return reply({ userAgent: 'codex-cli/0.154.0' });
  if (method === 'model/list') return reply({ data: [{ id: 'fixture', model: 'fixture', displayName: 'fixture', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply({ account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply({ config: { model: 'fixture', model_reasoning_effort: 'high', api_key: 'PRIVATE_CONFIG_SECRET' } });
  if (method === 'thread/list') return reply({ data: [], nextCursor: null });
  if (method === 'thread/resume') {
    process.stderr.write('ERROR writer conflict PRIVATE_STDERR_SECRET Authorization: Bearer fake-private-token\n');
    return send({ id, error: { code: -32000, message: 'writer already active PRIVATE_RPC_SECRET ' + params.threadId, data: { secret: 'PRIVATE_ERROR_DATA' } } });
  }
  send({ id, error: { code: -32601, message: 'Fixture unsupported operation' } });
});
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project }));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
let app;
const open = async () => {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.codex?.getDiagnosticsStatus));
  await page.evaluate(() => window.codex.start());
  return page;
};
const exportTo = async (page, filePath) => {
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  return page.evaluate(() => window.codex.exportDiagnostics());
};
try {
  let page = await open();
  const status = await page.evaluate(() => window.codex.getDiagnosticsStatus());
  assert.equal(status.enabled, true);
  assert.equal(status.directory, path.join(profile, 'logs'));
  await page.evaluate(async () => {
    try { await window.codex.request('thread/resume', { threadId: 'PRIVATE_THREAD_ID', input: 'PRIVATE_CHAT_MESSAGE' }); } catch { /* Expected fixture failure. */ }
    try { await window.codex.openPath('PRIVATE_MISSING_FILE.txt'); } catch { /* Missing link failure. */ }
    window.codex.reportRendererError({ kind: 'error', name: 'TypeError', message: 'PRIVATE_RENDERER_SECRET', stack: 'TypeError: PRIVATE_RENDERER_SECRET\n at file:///C:/Users/PRIVATE_USER/app.asar/dist/assets/index-Abc123.js:12:34' });
  });
  await page.evaluate(() => {
    const bundle = [...document.scripts].find(script => script.type === 'module')?.src;
    window.codex.reportRendererError({ kind: 'react', name: 'TypeError', message: 'PRIVATE_REACT_SECRET', stack: `TypeError: PRIVATE_REACT_SECRET\n at ${bundle}:12:34` });
  });
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.deepEqual(await page.evaluate(() => window.codex.exportDiagnostics()), { canceled: true });
  const target = path.join(runDir, 'report.json');
  assert.deepEqual(await exportTo(page, target), { canceled: false, path: target });
  const firstReport = await readFile(target, 'utf8');
  const report = JSON.parse(firstReport);
  assert.ok(firstReport.includes('rpc.failed'), 'RPC error survives export');
  assert.ok(firstReport.includes('renderer.error'), 'Renderer error survives export');
  assert.ok(report.logs.some(entry => entry.event === 'renderer.error' && entry.data.error.frames.some(frame => frame.line === 12 && frame.column === 34)), 'Shipped renderer stack locations retained');
  assert.ok(report.logs.some(entry => entry.event === 'ipc.failed' && entry.data.error.frames.length > 0), 'Native host stack locations retained');
  assert.ok(firstReport.includes('host:openPath'), 'Host file-link operation survives export');
  for (const sentinel of ['PRIVATE_', 'fake-private-token', project, root]) assert.ok(!firstReport.includes(sentinel), `No private marker: ${sentinel}`);
  assert.ok(report, 'Export is one valid JSON document');
  const rpcFailure = report.logs.find(entry => entry.event === 'rpc.failed' && entry.data.method === 'thread/resume');
  assert.ok(rpcFailure?.data.clientId && rpcFailure.data.threadId, 'Failure has opaque client/thread correlation');
  assert.equal(typeof rpcFailure.data.durationMs, 'number');
  assert.ok(report.logs.some(entry => entry.event === 'codex.version' && entry.data.codexVersion === '0.154.0'));
  if (process.env.CODEX_DESK_PACKAGED) {
    assert.match(report.environment.buildId, /^[a-f0-9]{64}$/);
    assert.equal(report.environment.packaged, true);
  }
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path.join(runDir, 'absent-directory', 'cannot-save.json'));
  const failedExport = await page.evaluate(() => window.codex.exportDiagnostics().then(() => false, () => true));
  assert.equal(failedExport, true, 'Export failure propagates and unlocks retry');
  await exportTo(page, path.join(runDir, 'retry.json'));
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  await page.getByRole('dialog', { name: 'Диагностика', exact: true }).waitFor();
  await page.screenshot({ path: path.join(runDir, 'diagnostics.png') });
  await app.close(); app = null;
  page = await open();
  const next = path.join(runDir, 'after-restart.json');
  await exportTo(page, next);
  const combined = await readFile(next, 'utf8');
  assert.ok(combined.includes('renderer.error'), 'Logs of previous launch survive restart');
  // Export remains usable when every tab is closed.
  await page.evaluate(async () => { const workspace = await window.codex.getWorkspace(); for (const session of workspace.sessions) await window.codex.closeSession(session.id); });
  assert.equal((await page.evaluate(() => window.codex.getDiagnosticsStatus())).enabled, true);
  await exportTo(page, path.join(runDir, 'zero-tabs.json'));
  // A renderer crash still leaves host diagnostics for the next launch.
  await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.once('render-process-gone', () => resolve());
    contents.forcefullyCrashRenderer();
  }));
  await app.close(); app = null;
  page = await open();
  await exportTo(page, path.join(runDir, 'renderer-crash.json'));
  assert.ok((await readFile(path.join(runDir, 'renderer-crash.json'), 'utf8')).includes('window.rendererGone'));
  await app.close(); app = null;
  const logs = await readdir(path.join(profile, 'logs'));
  assert.ok(logs.length >= 2, 'Unique run logs persist');
  console.log(`PASS: automatic disk logs, RPC/host/renderer errors, native-save cancel/export, secret omission, restart history, zero-tab export. ${runDir}`);
} finally { if (app) await app.close(); }
