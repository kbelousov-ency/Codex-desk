import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

// Real Electron main/preload/scoped IPC. Only native shell/Menu actions and
// the App Server executable are substituted; no model or external app runs.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'links host-'));
const project = path.join(runDir, 'Рабочие проекты', 'Проект А');
const otherProject = path.join(runDir, 'Другой проект');
const dataDir = path.join(runDir, 'profile');
await Promise.all([path.join(project, 'src'), otherProject, dataDir].map(directory => mkdir(directory, { recursive: true })));
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));
const filename = path.join(project, 'src', 'пример файла.txt');
await writeFile(filename, 'File link IPC fixture.\n');
const resolvedFile = await realpath(filename);
await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
  executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write',
}));

// Markdown's rendered href encodes spaces in ancestors outside the project too.
const markdownHref = filename => encodeURI(`${process.platform === 'win32' ? '/' : ''}${filename.replaceAll('\\', '/')}`);
const encodedTarget = markdownHref(filename);
let reportedFile = path.join(root, 'artifacts', 'tabs-aligned.png');
try { await access(reportedFile); }
catch { reportedFile = path.join(root, 'README.md'); }
const reportedTarget = markdownHref(reportedFile);
const resolvedReported = await realpath(reportedFile);
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
delete env.CODEX_DESK_TEST;
let app;
let page;
let fixturePid;
const errors = [];
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const actions = () => app.evaluate(() => globalThis.__linkActions);
const invoke = (id, method, target) => page.evaluate(({ id, method, target }) => window.codex.forSession(id)[method](target), { id, method, target });

try {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  await app.evaluate(({ shell, Menu }) => {
    globalThis.__linkActions = [];
    globalThis.__linkMenus = [];
    globalThis.__linkMenuSelection = true;
    shell.openPath = async target => { globalThis.__linkActions.push({ kind: 'open', target }); return ''; };
    shell.openExternal = async target => { globalThis.__linkActions.push({ kind: 'external', target }); };
    shell.showItemInFolder = target => { globalThis.__linkActions.push({ kind: 'reveal', target }); };
    Menu.buildFromTemplate = template => ({
      popup({ window, callback }) {
        globalThis.__linkMenus.push({ owner: window.id, labels: template.map(item => item.label) });
        if (globalThis.__linkMenuSelection) template[0].click();
        callback();
      },
    });
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
  const workspace = await page.evaluate(() => window.codex.getWorkspace());
  assert.equal(workspace.sessions.length, 1);
  const id = workspace.sessions[0].id;
  const bootstrap = await page.evaluate(id => window.codex.forSession(id).start(), id);
  fixturePid = bootstrap.initialize.fixturePid;
  assert.equal(bootstrap.initialize.fixtureCwd, project);
  assert.ok(fixturePid, 'The isolated fixture process supplies the bootstrap');

  // This crosses the production contextBridge and session-bound IPC handlers.
  assert.deepEqual(await actions(), [], 'Loading the renderer must not open files');
  const files = (sessionId, relativePath, cursor) => page.evaluate(({ sessionId, relativePath, cursor }) => window.codex.forSession(sessionId).listFiles(relativePath, cursor), { sessionId, relativePath, cursor });
  const rootFiles = await files(id);
  assert.equal(rootFiles.path, '');
  assert.equal(rootFiles.nextCursor, null);
  assert.equal(rootFiles.entries[0].name, 'src');
  assert.equal(rootFiles.entries[0].type, 'directory');
  assert.deepEqual(await files(id, 'src'), {
    path: 'src', entries: [{ name: 'пример файла.txt', path: 'src/пример файла.txt', type: 'file' }], nextCursor: null,
  });
  await assert.rejects(files(id, '../'), /за пределами/);
  await assert.rejects(files(id, filename), /Нужен путь внутри/);
  await assert.rejects(files(id, '', -1), /Некорректная страница/);
  for (const target of [encodedTarget, `${encodedTarget}:8:3`, pathToFileURL(filename).href, 'src/пример%20файла.txt']) {
    await invoke(id, 'openPath', target);
    assert.deepEqual((await actions()).at(-1), { kind: 'open', target: resolvedFile });
    await invoke(id, 'showPathMenu', target);
    assert.deepEqual((await actions()).at(-1), { kind: 'reveal', target: resolvedFile });
  }
  const menus = await app.evaluate(() => globalThis.__linkMenus);
  const owner = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  assert.equal(menus.length, 4);
  for (const menu of menus) assert.deepEqual(menu, { owner, labels: ['Открыть в проводнике'] });

  const beforeCancel = await actions();
  await app.evaluate(() => { globalThis.__linkMenuSelection = false; });
  await invoke(id, 'showPathMenu', encodedTarget);
  assert.deepEqual(await actions(), beforeCancel, 'Cancelling the context menu must not reveal the file');
  await app.evaluate(() => { globalThis.__linkMenuSelection = true; });

  // Reproduce the screenshot's exact href in this checkout. Creating these
  // sessions through IPC does not start their App Servers or any model turn.
  const rootSession = await page.evaluate(cwd => window.codex.createSession({ cwd }), root);
  await invoke(rootSession.id, 'openPath', reportedTarget);
  assert.deepEqual((await actions()).at(-1), { kind: 'open', target: resolvedReported });
  await invoke(rootSession.id, 'showPathMenu', reportedTarget);
  assert.deepEqual((await actions()).at(-1), { kind: 'reveal', target: resolvedReported });

  const otherSession = await page.evaluate(cwd => window.codex.createSession({ cwd }), otherProject);
  assert.deepEqual(await files(otherSession.id), { path: '', entries: [], nextCursor: null }, 'The second session sees its own empty project');
  await assert.rejects(files(otherSession.id, 'src'), /Папка не найдена/);
  const beforeRejected = await actions();
  for (const method of ['openPath', 'showPathMenu']) {
    await assert.rejects(invoke(otherSession.id, method, encodedTarget), /за пределами выбранного проекта/);
    await assert.rejects(invoke(otherSession.id, method, reportedTarget), /за пределами выбранного проекта/);
    await assert.rejects(invoke(id, method, 'javascript:alert(1)'), /только локальные файлы/);
  }
  assert.deepEqual(await actions(), beforeRejected, 'Rejected paths must not reach native file actions');
  await page.evaluate(id => window.codex.closeSession(id), otherSession.id);
  await assert.rejects(invoke(otherSession.id, 'openPath', encodedTarget), /закрытая сессия/);
  await assert.rejects(files(otherSession.id), /закрытая сессия/);

  await invoke(id, 'openPath', 'https://example.test/docs?q=codex');
  assert.deepEqual((await actions()).at(-1), { kind: 'external', target: 'https://example.test/docs?q=codex' });
  const log = (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(entry => entry.method === 'turn/start').length, 0, 'No model turns are sent, even to the fixture');
  assert.equal(app.windows().length, 1);
  assert.deepEqual(errors, []);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ reportedTarget, encodedTarget, actions: await actions(), menus }, null, 2));
  console.log(`PASS: real Electron preload/IPC resolves encoded ancestors, Unicode, source suffixes and file URLs; open/reveal/cancel and lazy directory listings, session isolation and closed-session checks. Native shell/Menu substituted; no model requests. Exact reported href: ${reportedTarget}. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`File link IPC test artifacts: ${runDir}`);
  throw error;
} finally {
  if (app) await app.close();
  if (fixturePid) {
    const deadline = Date.now() + 10_000;
    while (alive(fixturePid) && Date.now() < deadline) await delay(80);
    assert.equal(alive(fixturePid), false, 'The isolated fixture process exits with its test window');
  }
}
