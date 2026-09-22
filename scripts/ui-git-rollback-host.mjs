import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Real Electron/preload/scoped IPC with disposable Git repositories. All Git
// writes, rollback targets and App Server processes belong to these fixtures.
// The only turn is handled by a local Node fixture, with no model/provider call.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'git-rollback-host-'));
const projectA = path.join(runDir, 'PROJECT_A');
const projectB = path.join(runDir, 'PROJECT_B');
const childProject = path.join(projectA, 'child');
const dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, childProject, dataDir].map(directory => mkdir(directory, { recursive: true })));
const fixtureDirectories = [projectA, projectB, childProject];
for (const directory of fixtureDirectories) {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
}

const emptyGitConfig = path.join(runDir, 'empty.gitconfig');
await writeFile(emptyGitConfig, '');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_TERMINAL_PROMPT: '0' });
const exec = promisify(execFile);
async function git(cwd, ...args) {
  assert.ok([projectA, projectB].includes(cwd), 'Fixture Git writes never target the source checkout');
  const { stdout } = await exec('git', ['-c', 'user.name=Codex Desk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  return stdout;
}
for (const directory of [projectA, projectB]) {
  await git(directory, 'init', '-b', 'fixture-main');
  await git(directory, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(directory, '.gitignore'), 'server.jsonl\n');
}
const sharedPath = 'общий файл.txt';
const sharedFile = path.join(projectA, sharedPath);
const baselineText = 'Первая строка\nИсходное значение\nПоследняя строка\n';
const stagedText = 'Первая строка\nПодготовленное изменение\nПоследняя строка\n';
const worktreeText = 'Первая строка\nРабочее изменение 🧪\nПоследняя строка\n';
await writeFile(sharedFile, baselineText);
await writeFile(path.join(projectA, 'deleted.txt'), 'Restore a deleted fixture file.\n');
await writeFile(path.join(childProject, 'inside.txt'), 'Inside before\n');
await writeFile(path.join(projectB, 'only-b.txt'), 'Project B before\n');
for (const directory of [projectA, projectB]) {
  await git(directory, 'add', '--', '.');
  await git(directory, 'commit', '-m', 'Fixture baseline');
}
await writeFile(sharedFile, stagedText);
await git(projectA, 'add', '--', sharedPath);
await writeFile(sharedFile, worktreeText);
await unlink(path.join(projectA, 'deleted.txt'));
await writeFile(path.join(projectA, 'untracked.txt'), 'Never discard an untracked fixture file.\n');
await writeFile(path.join(childProject, 'inside.txt'), 'Inside after\n');
await writeFile(path.join(projectB, 'only-b.txt'), 'Project B after\n');

const settings = { executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [], results = [];
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const workspace = () => page.evaluate(() => window.codex.getWorkspace());
const call = (id, method, options) => page.evaluate(({ id, method, options }) => window.codex.forSession(id)[method](options), { id, method, options });
const preview = (id, target = sharedPath) => call(id, 'previewGitRollback', { path: target });
const apply = (id, previewId) => call(id, 'applyGitRollback', { previewId });
const list = id => call(id, 'listGitRollbacks');
const previewUndo = (id, undoId) => call(id, 'previewUndoGitRollback', { undoId });
const undo = (id, previewId) => call(id, 'undoGitRollback', { previewId });
async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}
async function launch() {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'fixture bootstrap');
}
async function session(cwd) {
  const created = await page.evaluate(cwd => window.codex.createSession({ cwd }), cwd);
  assert.ok(created?.id);
  const bootstrap = await call(created.id, 'start');
  assert.ok(samePath(bootstrap.cwd, cwd));
  return created.id;
}
async function rejection(id, method, options, label) {
  const result = await page.evaluate(async ({ id, method, options }) => {
    try { await window.codex.forSession(id)[method](options); return { accepted: true }; }
    catch (error) { return { accepted: false, message: error.message }; }
  }, { id, method, options });
  assert.equal(result.accepted, false, label);
  assert.ok(result.message?.length, `${label}: useful IPC error`);
}
async function snapshot(directory) {
  const files = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.name !== 'server.jsonl') {
        const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
        files[path.relative(directory, absolute)] = {
          sha256: createHash('sha256').update(bytes).digest('hex'), size: info.size, modified: info.mtimeMs,
        };
      }
    }
  }
  await visit(directory);
  return files;
}
const withoutFile = (files, target) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== target));
async function logs() {
  return (await Promise.all(fixtureDirectories.map(directory => readFile(path.join(directory, 'server.jsonl'), 'utf8').catch(() => ''))))
    .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function closeApp() {
  if (!app) return;
  const fixturePids = [...new Set((await logs()).filter(entry => entry.type === 'spawn').map(entry => entry.pid))];
  await app.close(); app = null; page = null;
  await waitUntil(() => fixturePids.every(pid => !alive(pid)), 'fixture process cleanup');
}

try {
  await launch();
  let first = (await workspace()).sessions[0].id;
  const twin = await session(projectA);
  const second = await session(projectB);
  const nested = await session(childProject);
  const gitBefore = await Promise.all([projectA, projectB].map(directory => snapshot(path.join(directory, '.git'))));
  const untouched = await snapshot(projectA);
  assert.deepEqual(await list(first), []);
  const cancelled = await preview(first);
  assert.equal(cancelled.path, sharedPath);
  assert.equal(cancelled.operation, 'restore');
  assert.ok(cancelled.previewId && cancelled.expiresAt);
  assert.match(cancelled.diff, /-Рабочее изменение 🧪/);
  assert.match(cancelled.diff, /\+Подготовленное изменение/);
  assert.ok(!cancelled.diff.includes('Исходное значение'), 'Restore preview targets the index, not HEAD');
  assert.deepEqual(await list(first), [], 'Preview does not create a rollback record');
  assert.deepEqual(await snapshot(projectA), untouched, 'Opening/cancelling preview leaves every file and Git object unchanged');
  results.push('real preview is worktree → index, with Unicode path and no repository writes');

  for (const options of [
    { path: '../only-b.txt' }, { path: '..\\only-b.txt' }, { path: path.join(projectB, 'only-b.txt') },
    { path: '.git/config' }, { path: ':(top)**' }, { path: 'bad\0path' }, { path: 'untracked.txt' },
    { path: 'missing.txt' }, { path: sharedPath, cwd: projectB }, { path: sharedPath, area: 'staged' }, null,
  ]) await rejection(first, 'previewGitRollback', options, `Malformed/unsafe restore rejected: ${JSON.stringify(options)}`);
  await rejection(nested, 'previewGitRollback', { path: `../${sharedPath}` }, 'Nested session cannot restore its parent files');
  await rejection(first, 'applyGitRollback', { previewId: 'unknown-preview' }, 'Unknown preview is rejected');
  await rejection(first, 'previewUndoGitRollback', { undoId: 'unknown-backup' }, 'Unknown backup is rejected');
  await rejection(twin, 'applyGitRollback', { previewId: cancelled.previewId }, 'A same-directory session cannot use another session preview');
  await rejection(second, 'applyGitRollback', { previewId: cancelled.previewId }, 'Another project cannot use the preview');
  await rejection(first, 'applyGitRollback', { previewId: cancelled.previewId, path: 'deleted.txt' }, 'Renderer cannot retarget a valid preview');
  assert.deepEqual(await snapshot(projectA), untouched);
  results.push('scoped IPC rejects unsafe paths, untracked files, malformed options and cross-session tokens');

  const restored = await apply(first, cancelled.previewId);
  assert.ok(restored.undoId && restored.createdAt);
  assert.equal(restored.path, sharedPath);
  assert.equal(await readFile(sharedFile, 'utf8'), stagedText, 'Restore keeps the staged version, not HEAD');
  assert.deepEqual(withoutFile(await snapshot(projectA), sharedPath), withoutFile(untouched, sharedPath), 'Restore only changes the selected worktree file');
  assert.ok((await list(first)).some(entry => entry.undoId === restored.undoId && entry.path === sharedPath));
  assert.deepEqual(await list(second), [], 'Backup history is scoped to the selected project');
  await rejection(first, 'applyGitRollback', { previewId: cancelled.previewId }, 'An applied preview cannot be replayed');
  const staleUndo = await previewUndo(first, restored.undoId);
  assert.equal(staleUndo.operation, 'undo');
  assert.match(staleUndo.diff, /\+Рабочее изменение 🧪/);
  await rejection(twin, 'undoGitRollback', { previewId: staleUndo.previewId }, 'Undo preview belongs to its originating session');
  const laterEdit = 'Изменение пользователя после предпросмотра\n';
  await writeFile(sharedFile, laterEdit);
  await rejection(first, 'undoGitRollback', { previewId: staleUndo.previewId }, 'Undo rejects a file changed since preview');
  assert.equal(await readFile(sharedFile, 'utf8'), laterEdit, 'Rejected undo preserves later user edits');
  // Start a fresh fixture scenario: the stale backup is retained for recovery,
  // and is never used to overwrite an edit merely because bytes match again.
  await writeFile(sharedFile, worktreeText);
  const freshRestore = await apply(first, (await preview(first)).previewId);
  const freshUndo = await previewUndo(first, freshRestore.undoId);
  await undo(first, freshUndo.previewId);
  assert.equal(await readFile(sharedFile, 'utf8'), worktreeText, 'Undo returns exact prior UTF-8 bytes');
  await rejection(first, 'undoGitRollback', { previewId: freshUndo.previewId }, 'An applied undo cannot be replayed');
  results.push('apply preserves staged data, durable backup is project-scoped, stale undo preserves user edits, exact undo succeeds');

  const staleRestore = await preview(first);
  await writeFile(sharedFile, laterEdit);
  await rejection(first, 'applyGitRollback', { previewId: staleRestore.previewId }, 'Restore rejects a file changed since preview');
  assert.equal(await readFile(sharedFile, 'utf8'), laterEdit);
  await writeFile(sharedFile, worktreeText);
  const closedPreview = await preview(twin);
  await page.evaluate(id => window.codex.closeSession(id), twin);
  await rejection(twin, 'applyGitRollback', { previewId: closedPreview.previewId }, 'Closed session cannot apply a preview');
  await rejection(first, 'applyGitRollback', { previewId: closedPreview.previewId }, 'A surviving session cannot inherit the closed session preview');
  const movedPreview = await preview(nested, 'inside.txt');
  await call(nested, 'start', { cwd: projectB });
  await rejection(nested, 'applyGitRollback', { previewId: movedPreview.previewId }, 'Changing the session directory invalidates its preview');
  await call(nested, 'start', { cwd: childProject });
  results.push('stale restore, closed sessions and changed working directories cannot apply old previews');

  const beforeBusy = await preview(first);
  const fixtureThread = await page.evaluate(id => window.codex.forSession(id).request('thread/start', {}), nested);
  const fixtureTurn = await page.evaluate(({ id, threadId }) => window.codex.forSession(id).request('turn/start', {
    threadId, input: [{ type: 'text', text: 'Local fixture busy-state check only.' }],
  }), { id: nested, threadId: fixtureThread.thread.id });
  await waitUntil(async () => (await logs()).some(entry => entry.cwd === childProject && entry.method === 'turn/start'), 'local fixture turn');
  await rejection(first, 'applyGitRollback', { previewId: beforeBusy.previewId }, 'Busy nested session blocks restoring a parent project file');
  await rejection(first, 'previewGitRollback', { path: sharedPath }, 'Busy overlapping session blocks starting rollback');
  assert.equal(await readFile(sharedFile, 'utf8'), worktreeText);
  const independentPreview = await preview(second, 'only-b.txt');
  const independentRestore = await apply(second, independentPreview.previewId);
  assert.equal(await readFile(path.join(projectB, 'only-b.txt'), 'utf8'), 'Project B before\n', 'An independent idle project remains usable');
  await undo(second, (await previewUndo(second, independentRestore.undoId)).previewId);
  assert.equal(await readFile(path.join(projectB, 'only-b.txt'), 'utf8'), 'Project B after\n');
  await page.evaluate(({ id, threadId, turnId }) => window.codex.forSession(id).request('turn/interrupt', { threadId, turnId }), {
    id: nested, threadId: fixtureThread.thread.id, turnId: fixtureTurn.turn.id,
  });
  await waitUntil(async () => {
    try { await preview(first); return true; } catch { return false; }
  }, 'overlap busy state clears after fixture interruption');
  results.push('busy/approval state in an overlapping project prevents rollback; unrelated idle project remains usable');

  const deletedRestore = await apply(first, (await preview(first, 'deleted.txt')).previewId);
  assert.equal(await readFile(path.join(projectA, 'deleted.txt'), 'utf8'), 'Restore a deleted fixture file.\n');
  await undo(first, (await previewUndo(first, deletedRestore.undoId)).previewId);
  await assert.rejects(readFile(path.join(projectA, 'deleted.txt')), { code: 'ENOENT' }, 'Undo restores original absence of a deleted tracked file');
  const durablePreview = await preview(first);
  const reserved = await page.evaluate(async ({ id, previewId }) => {
    const bridge = window.codex.forSession(id);
    const applying = bridge.applyGitRollback({ previewId });
    const changing = bridge.setSettings({ model: 'must-not-change-during-rollback' })
      .then(() => ({ accepted: true }), error => ({ accepted: false, message: error.message }));
    return { restored: await applying, change: await changing };
  }, { id: first, previewId: durablePreview.previewId });
  assert.equal(reserved.change.accepted, false, 'Active rollback reserves its session against concurrent settings changes');
  results.push('host reserves an active rollback against concurrent settings mutations');
  const durableRestore = reserved.restored;
  const preRestartUndo = await previewUndo(first, durableRestore.undoId);
  await call(first, 'setSettings', { cwd: projectA });
  await closeApp();
  await launch();
  first = (await workspace()).sessions.find(entry => samePath(entry.cwd, projectA))?.id;
  assert.ok(first, 'Project A session returns after app restart');
  const durableList = await list(first);
  assert.ok(durableList.some(entry => entry.undoId === durableRestore.undoId && entry.path === sharedPath), 'Rollback backup survives a real Electron restart');
  await rejection(first, 'undoGitRollback', { previewId: preRestartUndo.previewId }, 'Restart does not revive an old confirmation preview');
  await undo(first, (await previewUndo(first, durableRestore.undoId)).previewId);
  assert.equal(await readFile(sharedFile, 'utf8'), worktreeText, 'Persisted backup restores exact pre-rollback contents');
  results.push('tracked deletion and undo preserve file absence; persistent backup survives application restart with fresh preview');

  assert.deepEqual(await Promise.all([projectA, projectB].map(directory => snapshot(path.join(directory, '.git')))), gitBefore,
    'All rollback/undo operations leave every Git index/config/object and its mtime unchanged');
  assert.deepEqual(await call(first, 'getSettings'), settings, 'Codex model, effort, access and executable are preserved');
  const fixtureCalls = (await logs()).filter(entry => ['turn/start', 'turn/steer'].includes(entry.method));
  assert.equal(fixtureCalls.length, 1, 'Only the explicit local busy-state fixture turn was sent');
  assert.ok(fixtureCalls.every(entry => entry.cwd === childProject));
  assert.deepEqual(errors, []);
  results.push('Git data and Codex settings unchanged; real model calls: 0; one deterministic local fixture turn');
  const report = { runDir, packaged: Boolean(process.env.CODEX_DESK_PACKAGED), results, fixtureTurns: 1, modelCalls: 0 };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`Git rollback host artifacts: ${runDir}`);
  throw error;
} finally {
  await closeApp();
}
