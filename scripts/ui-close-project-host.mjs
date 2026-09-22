import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Actual main/preload/IPC and isolated JSONL fixture children, no model calls.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'close-project-host-'));
const projectA = path.join(runDir, 'PROJECT_A'), projectB = path.join(runDir, 'PROJECT_B');
const dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, dataDir].map(directory => mkdir(directory)));
for (const directory of [projectA, projectB]) {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
  await writeFile(path.join(directory, 'user-file.txt'), 'Project content stays intact.');
}
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
let app, page;
const errors = [], fixturePids = new Set();
const view = () => page.locator('.session-view:visible');
const workspace = () => page.evaluate(() => window.codex.getWorkspace());
const activeId = () => page.getByRole('tab', { selected: true }).evaluate(node => node.closest('[data-session-id]').dataset.sessionId);
const logFor = async cwd => (await readFile(path.join(cwd, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}
async function ready() {
  await waitUntil(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'active model ready');
  const id = await activeId();
  const boot = await page.evaluate(id => window.codex.forSession(id).start(), id);
  fixturePids.add(boot.initialize.fixturePid);
  return { id, cwd: boot.cwd, pid: boot.initialize.fixturePid };
}
async function launch() {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor({ state: 'attached' });
}
async function restart() {
  await app.close(); app = null;
  await waitUntil(() => [...fixturePids].every(pid => !alive(pid)), 'fixture children stopped');
  await launch();
}
async function pick(cwd) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, cwd);
  await view().getByRole('button', { name: 'Новый проект', exact: true }).click();
  await waitUntil(async () => (await workspace()).sessions.some(session => session.cwd === cwd), 'new project session created');
  await waitUntil(async () => { const id = await activeId(); return (await workspace()).sessions.find(session => session.id === id)?.cwd === cwd; }, 'new project active');
  return ready();
}
try {
  await launch();
  const first = await ready();
  assert.equal(first.cwd, projectA);
  await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).waitFor();
  const second = await pick(projectB);
  assert.equal(await activeId(), second.id);
  await page.evaluate(({ id, cwd }) => window.codex.forSession(id).setSettings({ cwd }), { id: first.id, cwd: projectA });
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).cwd, projectA);
  const rejection = await page.evaluate(async cwd => { try { await window.codex.closeProject(cwd); return null; } catch (error) { return error.message; } }, projectA);
  assert.match(rejection, /Подтвердите закрытие/);
  assert.equal((await workspace()).sessions.length, 2);
  assert.ok(alive(first.pid) && alive(second.pid), 'Unconfirmed closing leaves both processes running');
  const closed = await page.evaluate(cwd => window.codex.closeProject(cwd, { force: true }), projectA);
  assert.deepEqual(closed.projects, [projectB]);
  assert.deepEqual(closed.closedSessionIds, [first.id]);
  assert.deepEqual((await workspace()).sessions, [{ id: second.id, cwd: projectB }]);
  await waitUntil(() => !alive(first.pid), 'only A stops');
  assert.ok(alive(second.pid), 'B remains connected while A closes');
  const disposedError = await page.evaluate(async id => { try { await window.codex.forSession(id).getSettings(); return null; } catch (error) { return error.message; } }, first.id);
  assert.match(disposedError, /закрытая сессия/);
  assert.equal(await readFile(path.join(projectA, 'user-file.txt'), 'utf8'), 'Project content stays intact.');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).cwd, projectA, 'Closing changes workspace registration without altering user defaults');
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'workspace.json'), 'utf8')).projects, [projectB]);

  // Persisted settings still point to A, but only B is registered at next launch.
  await restart();
  const restarted = await ready();
  assert.equal(restarted.cwd, projectB);
  assert.deepEqual((await workspace()).projects, [projectB]);
  assert.equal(await view().getByRole('button', { name: 'Диалоги папки PROJECT_A', exact: true }).count(), 0);
  await view().getByRole('button', { name: 'Действия проекта PROJECT_B', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Закрыть проект', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть проект', exact: true }).click();
  await waitUntil(async () => (await workspace()).sessions.length === 0, 'last project closes');
  await view().getByText('Добавьте проект, чтобы открыть диалог.', { exact: true }).waitFor();
  assert.deepEqual((await workspace()).projects, []);
  await restart();
  await view().getByText('Добавьте проект, чтобы открыть диалог.', { exact: true }).waitFor();
  assert.deepEqual(await workspace(), { projects: [], sessions: [] }, 'Empty project list stays empty after genuine host restart');
  assert.equal(await page.getByRole('tab').count(), 0);
  await pick(projectA);
  await view().getByRole('button', { name: 'История PROJECT_A', exact: true }).waitFor();
  assert.deepEqual((await workspace()).projects, [projectA]);
  assert.equal(await readFile(path.join(projectA, 'user-file.txt'), 'utf8'), 'Project content stays intact.');
  assert.equal(await readFile(path.join(projectB, 'user-file.txt'), 'utf8'), 'Project content stays intact.');
  const log = [...await logFor(projectA), ...await logFor(projectB)];
  assert.equal(log.some(entry => ['turn/start', 'thread/archive', 'thread/delete'].includes(entry.method)), false, 'Closing never calls a model or modifies Codex history');
  assert.ok(log.filter(entry => entry.method === 'thread/list' && entry.cwd === projectA).length >= 2, 'History is read again on return');
  await page.screenshot({ path: path.join(runDir, 'reopened-project.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron closeProject IPC, confirmation required, A-only disposal with B active, settings and files preserved, boot does not revive closed cwd, last project closes, empty workspace survives restart, re-add restores history. No model request. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally {
  if (app) await app.close();
  await waitUntil(() => [...fixturePids].every(pid => !alive(pid)), 'test child cleanup');
}
