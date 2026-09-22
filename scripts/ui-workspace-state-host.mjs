import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC lifecycle, isolated profile and fixture child. No model calls.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'workspace-state-host-'));
const projectA = path.join(runDir, 'PROJECT_A'), projectB = path.join(runDir, 'PROJECT_B');
const dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, dataDir].map(directory => mkdir(directory)));
for (const directory of [projectA, projectB]) {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
}
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
const image = { name: 'draft.png', dataUrl: png };
const statePath = path.join(dataDir, 'workspace-state.json');
let app, page;
const errors = [], results = [];
const view = () => page.locator('.session-view:visible');
const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
const disk = () => readFile(statePath, 'utf8').then(JSON.parse);
async function waitUntil(check, label) {
  const deadline = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Timed out: ' + label); await delay(50); }
}
async function launch() {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor({ state: 'attached' });
}
async function ready() {
  await waitUntil(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'active connection ready');
}
async function closeWindow() {
  const exited = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited; app = null;
}
async function logs() {
  return (await Promise.all([projectA, projectB].map(folder => readFile(path.join(folder, 'server.jsonl'), 'utf8').catch(() => ''))))
    .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
try {
  await launch(); await ready();
  await input().fill('Draft from autosave');
  await waitUntil(async () => (await disk().catch(() => null))?.tabs[0]?.draft === 'Draft from autosave', 'debounced native autosave');
  // The close handshake must capture text edited less than one debounce period ago.
  await input().fill('Final draft at close');
  // Attempt mutations from the very same close notification. The host has frozen it already.
  await page.evaluate(() => {
    window.codex.onWorkspaceSave(async () => {
      const workspace = await window.codex.getWorkspace();
      const failures = [];
      try { await window.codex.saveWorkspaceState({ version: 1, activeIndex: 0, tabs: [] }); } catch (error) { failures.push(error.message); }
      try { await window.codex.forSession(workspace.sessions[0].id).request('turn/start', { threadId: 'must-not-run', input: [] }); } catch (error) { failures.push(error.message); }
      console.log('CLOSE_FROZEN:' + JSON.stringify(failures));
    });
  });
  let closeFrozen;
  page.on('console', message => { if (message.text().startsWith('CLOSE_FROZEN:')) closeFrozen = JSON.parse(message.text().slice(13)); });
  await closeWindow();
  assert.equal(closeFrozen?.length, 2, 'Late autosave and turn/start are rejected during the final save');
  assert.ok(closeFrozen.every(message => /закрывается/.test(message)));
  assert.equal((await disk()).tabs[0].draft, 'Final draft at close');
  await launch(); await ready();
  assert.equal(await input().inputValue(), 'Final draft at close');
  results.push('normal close captures latest draft and ordinary startup restores it');

  await view().locator('input[type="file"]').setInputFiles({ name: image.name, mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await view().locator('.attachment img').waitFor();
  await waitUntil(async () => (await disk()).tabs[0].attachments.length === 1, 'attachment persisted');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, projectB);
  await view().getByRole('button', { name: 'Новый проект', exact: true }).click();
  await waitUntil(async () => {
    const workspace = await page.evaluate(() => window.codex.getWorkspace());
    const id = await page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
    return workspace.sessions.find(session => session.id === id)?.cwd === projectB;
  }, 'second project selected');
  await ready();
  await input().fill('Draft B');
  await waitUntil(async () => (await disk()).tabs.length === 2 && (await disk()).tabs[1].draft === 'Draft B', 'second tab persisted');
  await closeWindow();
  await launch(); await ready();
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await input().inputValue(), 'Draft B');
  await page.getByRole('tab').first().click(); await ready();
  assert.equal(await input().inputValue(), 'Final draft at close');
  assert.equal(await view().locator('.attachment img').getAttribute('alt'), image.name);
  results.push('tabs, active selection, and attachment restore');
  await input().fill('Draft at app.quit');
  const quitExit = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await quitExit; app = null;
  assert.equal((await disk()).tabs[0].draft, 'Draft at app.quit');
  await launch(); await ready();
  assert.equal(await input().inputValue(), 'Draft at app.quit');
  results.push('app.quit handshake saves before disposing live sessions');

  await input().fill('Crash survives this');
  await waitUntil(async () => (await disk()).tabs[0].draft === 'Crash survives this', 'draft saved before renderer crash');
  const crashExit = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.once('render-process-gone', () => win.close());
    win.webContents.forcefullyCrashRenderer();
  }).catch(() => {});
  await crashExit; app = null;
  assert.equal((await disk()).tabs[0].draft, 'Crash survives this');
  await launch(); await ready();
  assert.equal(await input().inputValue(), 'Crash survives this');
  results.push('renderer crash preserves previous autosave without an empty overwrite');
  await closeWindow();

  // Seed a validated on-disk shape to exercise less common restoration fields.
  const stored = await disk();
  stored.tabs[0].settings.access = 'danger-full-access';
  stored.tabs[0].scrollTop = 314;
  stored.tabs[0].queue = { paused: false, items: [{ id: 'waiting-work', text: 'Must wait for user', attachments: [image], state: 'waiting' }] };
  stored.tabs[0].preservedDraft = { text: 'Original text before edit', attachments: [] };
  stored.tabs[0].draft = 'An unfinished edit';
  stored.tabs.push({ archivedThread: { id: 'archived-fixture', cwd: projectA, name: 'Archived fixture' }, draft: '', attachments: [], scrollTop: 22 });
  stored.activeIndex = 0;
  await writeFile(statePath, JSON.stringify(stored));
  await launch(); await ready();
  assert.equal(await page.getByRole('tab').count(), 3);
  assert.equal(await input().inputValue(), 'An unfinished edit');
  assert.equal(await view().getByRole('combobox', { name: 'Режим доступа', exact: true }).getAttribute('data-value'), 'workspace-write');
  await waitUntil(async () => (await disk()).tabs[0].queue?.paused === true, 'restored queue is paused');
  assert.ok(!(await logs()).some(entry => ['turn/start', 'turn/steer'].includes(entry.method)), 'Queue restoration must never call the model');
  await closeWindow();
  assert.equal((await disk()).tabs[0].preservedDraft.text, 'Original text before edit');
  results.push('queued work paused, full access reduced, archived tab and original edit draft preserved');

  await writeFile(statePath, JSON.stringify({ version: 1, activeIndex: 0, tabs: [] }));
  await launch();
  await waitUntil(async () => (await page.evaluate(() => window.codex.getWorkspace())).sessions.length === 0, 'intentionally empty state restored');
  assert.equal(await page.getByRole('tab').count(), 0);
  await closeWindow();
  assert.deepEqual(await disk(), { version: 1, activeIndex: 0, tabs: [] });
  results.push('empty tab list stays empty across close and launch');

  assert.deepEqual(errors, []);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ results, modelCalls: (await logs()).filter(entry => ['turn/start', 'turn/steer'].includes(entry.method)).length }, null, 2));
  console.log(JSON.stringify({ runDir, results }, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
}
