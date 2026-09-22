import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC against isolated local fixtures and a test server.
// No installed CLI/model or personal files, configuration or history is used.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await realpath(await mkdtemp(path.join(root, 'artifacts', 'file-viewer-host-')));
const projectA = path.join(runDir, 'PROJECT_A'), projectB = path.join(runDir, 'PROJECT_B'), outside = path.join(runDir, 'OUTSIDE'), profile = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, outside, profile].map(directory => mkdir(directory)));
for (const directory of [projectA, projectB]) {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
}
const contentA = 'const привет = "project A";\nconsole.log(привет);\n';
const contentB = 'const привет = "project B";\n';
await Promise.all([
  writeFile(path.join(projectA, 'source.ts'), contentA),
  writeFile(path.join(projectB, 'source.ts'), contentB),
  writeFile(path.join(projectA, 'Документация.md'), '# Документация\n\n**Текст** без выполнения HTML.'),
  writeFile(path.join(projectA, 'script.svg'), '<svg onload="alert(1)" />'),
  writeFile(path.join(projectA, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255])),
  writeFile(path.join(outside, 'secret.txt'), 'Never exposed through viewer'),
]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CfkAAAAASUVORK5CYII=', 'base64');
await writeFile(path.join(projectA, 'image.png'), png);
await mkdir(path.join(projectA, 'node_modules'));
await writeFile(path.join(projectA, 'node_modules', 'secret.txt'), 'Not searched');
let links = false;
try { await symlink(outside, path.join(projectA, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir'); links = true; }
catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
const watched = [path.join(projectA, 'source.ts'), path.join(projectB, 'source.ts'), path.join(outside, 'secret.txt')];
const snapshot = async () => Promise.all(watched.map(async file => { const info = await stat(file); return { file, text: await readFile(file, 'utf8'), size: info.size, modified: info.mtimeMs }; }));
const before = await snapshot();
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
await writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [projectA, projectB] }));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [];
const waitUntil = async (check, label) => { const deadline = Date.now() + 15000; while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(50); } };
const call = (id, method, options) => page.evaluate(({ id, method, options }) => window.codex.forSession(id)[method](options), { id, method, options });
async function reject(id, method, options) {
  const message = await page.evaluate(async ({ id, method, options }) => {
    try { await window.codex.forSession(id)[method](options); return null; }
    catch (error) { return error.message; }
  }, { id, method, options });
  assert.ok(message, `${method} must reject ${JSON.stringify(options)}`);
}
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await waitUntil(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'Fixture bootstrap');
  const initial = await page.evaluate(() => window.codex.getWorkspace());
  const a = initial.sessions.find(session => pathEqual(session.cwd, projectA));
  assert.ok(a);
  const b = await page.evaluate(cwd => window.codex.createSession({ cwd }), projectB);
  assert.ok(b?.id);
  await page.evaluate(id => window.codex.forSession(id).start(), b.id);
  const first = await call(a.id, 'searchProjectFiles', { query: 'SOURCE' });
  assert.deepEqual(first.files, [{ path: 'source.ts', name: 'source.ts' }]);
  assert.equal(first.nextCursor, null);
  assert.equal((await call(a.id, 'readProjectFile', { path: 'source.ts' })).text, contentA);
  assert.equal((await call(b.id, 'readProjectFile', { path: 'source.ts' })).text, contentB);
  assert.equal((await call(a.id, 'readProjectFile', { path: 'Документация.md' })).kind, 'markdown');
  assert.equal((await call(a.id, 'readProjectFile', { path: 'script.svg' })).kind, 'text');
  assert.equal((await call(a.id, 'readProjectFile', { path: 'binary.bin' })).kind, 'unsupported');
  assert.equal((await call(a.id, 'readProjectFile', { path: 'image.png' })).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual((await call(a.id, 'searchProjectFiles', { query: 'secret' })).files, []);
  for (const options of [{ path: '../OUTSIDE/secret.txt' }, { path: path.join(outside, 'secret.txt') }, { path: 'source.ts:stream' }, { path: 'NUL' }, { path: 'source.ts', cwd: projectB }, { path: 'source.ts', sessionId: b.id }]) await reject(a.id, 'readProjectFile', options);
  if (links) await reject(a.id, 'readProjectFile', { path: 'outside-link/secret.txt' });
  await reject(a.id, 'searchProjectFiles', { query: '', cwd: projectB });
  await reject(a.id, 'searchProjectFiles', { query: '', cursor: '-1' });
  await reject(a.id, 'searchProjectFiles', { query: '\u0000' });
  await reject(b.id, 'readProjectFile', { path: 'Документация.md' });
  await page.evaluate(id => window.codex.closeSession(id), b.id);
  await reject(b.id, 'readProjectFile', { path: 'source.ts' });
  await reject(b.id, 'searchProjectFiles', { query: '' });
  assert.equal((await call(a.id, 'readProjectFile', { path: 'source.ts' })).text, contentA);
  assert.deepEqual(await snapshot(), before);
  const logs = (await Promise.all([projectA, projectB].map(directory => readFile(path.join(directory, 'server.jsonl'), 'utf8').catch(() => '')))).flatMap(raw => raw.trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.equal(logs.some(entry => ['turn/start', 'thread/start', 'thread/resume', 'config/write', 'config/batchWrite'].includes(entry.method)), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron/preload/IPC scoped file search/preview, Unicode/source/Markdown/SVG/image/binary, unchanged local files, path/ADS/device/junction/IPC override rejection, session isolation and closed-session rejection, no model requests. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`File viewer host artifacts: ${runDir}`); throw error;
} finally { await app?.close(); }

function pathEqual(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
