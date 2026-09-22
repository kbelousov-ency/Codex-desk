import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC with disposable Git repositories and fixture App
// Servers. Git initialization/commits/staging happen only inside these fixtures.
// The tested application only reads Git; no installed CLI or model turn is used.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'git-host-'));
const projectA = path.join(runDir, 'PROJECT_A');
const projectB = path.join(runDir, 'PROJECT_B');
const childProject = path.join(projectA, 'child');
// A folder beneath the source checkout would inherit its .git directory.
const noGit = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-desk-no-git-')));
const dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, childProject, dataDir].map(directory => mkdir(directory, { recursive: true })));
const fixtureDirectories = [projectA, projectB, childProject, noGit];
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
  assert.ok([projectA, projectB].includes(cwd), 'Fixture Git commands never target the source repository');
  const { stdout } = await exec('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Codex Desk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  return stdout;
}
for (const directory of [projectA, projectB]) {
  await git(directory, 'init', '-b', 'fixture-main');
  await writeFile(path.join(directory, '.gitignore'), 'server.jsonl\n');
}
const sharedPath = 'общий файл.txt';
await writeFile(path.join(projectA, sharedPath), 'Первая строка\nИсходное значение\nПоследняя строка\n');
await writeFile(path.join(projectA, 'deleted.txt'), 'Deleted only inside a fixture.\n');
await writeFile(path.join(childProject, 'inside.txt'), 'Inside before\n');
await writeFile(path.join(projectB, 'only-b.txt'), 'Project B before\n');
for (const directory of [projectA, projectB]) {
  await git(directory, 'add', '--', '.');
  await git(directory, 'commit', '-m', 'Fixture baseline');
}
await writeFile(path.join(projectA, sharedPath), 'Первая строка\nПодготовленное изменение\nПоследняя строка\n');
await git(projectA, 'add', '--', sharedPath);
await writeFile(path.join(projectA, sharedPath), 'Первая строка\nРабочее изменение 🧪\nПоследняя строка\n');
await unlink(path.join(projectA, 'deleted.txt'));
await writeFile(path.join(projectA, 'новый файл.txt'), 'Новый файл без индекса\n');
await writeFile(path.join(projectA, 'binary.bin'), Buffer.from([0, 1, 2, 255, 0, 128]));
await writeFile(path.join(childProject, 'inside.txt'), 'Inside after\n');
await writeFile(path.join(projectB, 'only-b.txt'), 'Project B after\n');

const settings = { executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
const settingsPath = path.join(dataDir, 'settings.json');
await writeFile(settingsPath, JSON.stringify(settings));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [], results = [];
const workspace = () => page.evaluate(() => window.codex.getWorkspace());
const status = id => page.evaluate(id => window.codex.forSession(id).getGitStatus(), id);
const diff = (id, options) => page.evaluate(({ id, options }) => window.codex.forSession(id).getGitDiff(options), { id, options });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}
async function session(cwd) {
  const created = await page.evaluate(cwd => window.codex.createSession({ cwd }), cwd);
  assert.ok(created?.id);
  const bootstrap = await page.evaluate(id => window.codex.forSession(id).start(), created.id);
  assert.ok(samePath(bootstrap.cwd, cwd));
  return created.id;
}
async function rejection(id, method, options, label) {
  const rejected = await page.evaluate(async ({ id, method, options }) => {
    try { await window.codex.forSession(id)[method](options); return { accepted: true }; }
    catch (error) { return { accepted: false, message: error.message }; }
  }, { id, method, options });
  assert.equal(rejected.accepted, false, label);
  assert.ok(rejected.message?.length, `${label}: useful IPC error`);
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
async function logs() {
  return (await Promise.all(fixtureDirectories.map(directory => readFile(path.join(directory, 'server.jsonl'), 'utf8').catch(() => ''))))
    .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

try {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  await waitUntil(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'fixture bootstrap');
  const first = (await workspace()).sessions[0].id;
  const second = await session(projectB);
  const nested = await session(childProject);
  const plain = await session(noGit);
  assert.equal((await workspace()).sessions.length, 4);
  assert.equal((await page.evaluate(() => window.codex.getNotificationSettings())).supported, false, 'Test profile does not initialize native Windows notifications');

  // Include the entire .git tree: even a same-content index rewrite is detected
  // by mtime. Fixture JSONL protocol logs are the only intentionally mutable files.
  const before = await Promise.all([projectA, projectB, noGit].map(snapshot));
  const settingsBefore = await readFile(settingsPath, 'utf8');
  const [a, b, child, outsideGit] = await Promise.all([first, second, nested, plain].map(status));
  assert.equal(a.available, true);
  assert.ok(samePath(a.root, projectA));
  assert.equal(a.branch, 'fixture-main');
  assert.equal(a.detached, false);
  assert.equal(a.unborn, false);
  assert.match(a.head, /^[a-f0-9]{40,64}$/i);
  const shared = a.entries.find(entry => entry.path === sharedPath);
  assert.ok(shared, 'Unicode and spaces survive status IPC');
  assert.equal(shared.staged, true);
  assert.equal(shared.unstaged, true);
  assert.equal(shared.indexStatus, 'M');
  assert.equal(shared.worktreeStatus, 'M');
  assert.ok(a.entries.some(entry => entry.path === 'deleted.txt'));
  assert.ok(a.entries.some(entry => entry.path === 'новый файл.txt' && entry.untracked));
  assert.ok(samePath(b.root, projectB));
  assert.deepEqual(b.entries.map(entry => entry.path), ['only-b.txt']);
  assert.ok(!a.entries.some(entry => entry.path === 'only-b.txt'));
  assert.ok(!b.entries.some(entry => entry.path === sharedPath));
  results.push('real scoped status: branch/head, Unicode paths, staged and unstaged same file, independent sessions');

  assert.ok(samePath(child.root, projectA));
  assert.deepEqual(child.entries.map(entry => entry.path), ['inside.txt']);
  assert.equal(outsideGit.available, false);
  assert.deepEqual(outsideGit.entries, []);
  assert.ok(outsideGit.reason, 'Folder without Git has a useful explanation');
  results.push('subfolder status remains within the selected project; folder without Git is explicit');

  const [staged, unstaged, untracked, binary, childDiff, otherDiff] = await Promise.all([
    diff(first, { path: sharedPath, area: 'staged' }),
    diff(first, { path: sharedPath, area: 'unstaged' }),
    diff(first, { path: 'новый файл.txt', area: 'untracked' }),
    diff(first, { path: 'binary.bin', area: 'untracked' }),
    diff(nested, { path: 'inside.txt', area: 'unstaged' }),
    diff(second, { path: 'only-b.txt', area: 'unstaged' }),
  ]);
  assert.equal(staged.path, sharedPath);
  assert.equal(staged.area, 'staged');
  assert.match(staged.diff, /-Исходное значение/);
  assert.match(staged.diff, /\+Подготовленное изменение/);
  assert.ok(!staged.diff.includes('Рабочее изменение'));
  assert.equal(unstaged.area, 'unstaged');
  assert.match(unstaged.diff, /-Подготовленное изменение/);
  assert.match(unstaged.diff, /\+Рабочее изменение 🧪/);
  assert.match(untracked.diff, /\+Новый файл без индекса/);
  assert.equal(binary.binary, true);
  assert.match(childDiff.diff, /\+Inside after/);
  assert.match(otherDiff.diff, /\+Project B after/);
  results.push('real diff IPC separates HEAD/index/worktree, untracked UTF-8, binary, and nested project files');

  for (const options of [
    { path: '../only-b.txt', area: 'unstaged' },
    { path: '..\\only-b.txt', area: 'unstaged' },
    { path: path.join(projectB, 'only-b.txt'), area: 'unstaged' },
    { path: ':(top)**', area: 'unstaged' },
    { path: ':!safe', area: 'unstaged' },
    { path: '.git/config', area: 'unstaged' },
    { path: sharedPath, area: 'discard' },
    { path: sharedPath, area: 'untracked' },
    { path: 'missing.txt', area: 'unstaged' },
    { path: 'bad\0path', area: 'unstaged' },
    { path: sharedPath },
    null,
  ]) await rejection(first, 'getGitDiff', options, `Invalid diff request rejected: ${JSON.stringify(options)}`);
  await rejection(nested, 'getGitDiff', { path: `../${sharedPath}`, area: 'staged' }, 'Nested project cannot read parent file');
  await rejection(nested, 'getGitDiff', { path: sharedPath, area: 'staged' }, 'Repository-root relative name cannot bypass nested scope');
  await rejection(second, 'getGitDiff', { path: sharedPath, area: 'staged' }, 'Session A path cannot be requested through session B');
  await rejection('not-owned-by-this-window', 'getGitStatus', undefined, 'Unknown session rejected');
  results.push('IPC rejects traversal, absolute paths, pathspec magic, .git data, malformed requests and other-project paths');

  await page.evaluate(id => window.codex.closeSession(id), nested);
  await rejection(nested, 'getGitStatus', undefined, 'Closed-session status rejected');
  await rejection(nested, 'getGitDiff', { path: 'inside.txt', area: 'unstaged' }, 'Closed-session diff rejected');
  assert.ok((await status(first)).available && (await status(second)).available, 'Closing a session leaves other Git readers usable');
  const after = await Promise.all([projectA, projectB, noGit].map(snapshot));
  assert.deepEqual(after, before, 'Read operations preserve every fixture file, Git index/config/object and mtime');
  assert.equal(await readFile(settingsPath, 'utf8'), settingsBefore, 'Git reads preserve Codex settings');
  assert.deepEqual(await page.evaluate(id => window.codex.forSession(id).getSettings(), first), settings);
  const modelCalls = (await logs()).filter(entry => ['turn/start', 'turn/steer'].includes(entry.method));
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(errors, []);
  results.push('closed sessions reject IPC; files/index/config/settings remain byte-identical; no model requests');
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ runDir, noGit, packaged: Boolean(process.env.CODEX_DESK_PACKAGED), results, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ runDir, results, modelCalls: 0 }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
