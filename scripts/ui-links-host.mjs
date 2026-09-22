import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

// Real Electron main/preload/scoped IPC. Native shell/Menu/clipboard actions and
// the App Server executable are substituted; no model, external app or real clipboard is used.
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
const lastMenu = () => app.evaluate(() => globalThis.__linkMenus.at(-1));
const waitForMain = async (key, value) => {
  const deadline = Date.now() + 15_000;
  while (!await app.evaluate((_, { key, value }) => globalThis[key].length === value, { key, value })) {
    if (Date.now() >= deadline) throw new Error(`The native link action did not arrive: ${JSON.stringify({ actions: await actions(), menu: await lastMenu(), alerts: await page.getByRole('alert').allTextContents() })}`);
    await delay(20);
  }
};
const invoke = (id, method, target, options) => page.evaluate(({ id, method, target, options }) => window.codex.forSession(id)[method](target, options), { id, method, target, options });

try {
  app = await electron.launch({
    ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 30_000,
  });
  await app.evaluate(({ shell, Menu, clipboard }) => {
    globalThis.__linkActions = [];
    globalThis.__linkMenus = [];
    globalThis.__linkMenuSelection = 'Открыть в проводнике';
    shell.openPath = async target => { globalThis.__linkActions.push({ kind: 'open', target }); return ''; };
    shell.openExternal = async target => { globalThis.__linkActions.push({ kind: 'external', target }); };
    shell.showItemInFolder = target => { globalThis.__linkActions.push({ kind: 'reveal', target }); };
    clipboard.writeText = target => { globalThis.__linkActions.push({ kind: 'copy', target }); };
    Menu.buildFromTemplate = template => ({
      popup({ window, callback }) {
        globalThis.__linkMenus.push({ owner: window.id, items: template.map(item => ({ label: item.label, enabled: item.enabled !== false })) });
        template.find(item => item.label === globalThis.__linkMenuSelection && item.enabled !== false)?.click();
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
  for (const menu of menus) assert.deepEqual(menu, { owner, items: [
    { label: 'Копировать ссылку', enabled: true }, { label: 'Открыть в проводнике', enabled: true },
  ] });

  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Копировать ссылку'; });
  const webTarget = 'https://example.test/docs?q=codex%20desk&lang=ru#part-2';
  for (const target of [encodedTarget, `${encodedTarget}:8:3`, `${encodedTarget}#L8`, pathToFileURL(filename).href, 'src/пример%20файла.txt', webTarget]) {
    const beforeCopy = await actions();
    assert.equal(await invoke(id, 'showPathMenu', target), undefined);
    assert.deepEqual(await actions(), [...beforeCopy, { kind: 'copy', target }], 'Copy preserves the raw link without opening it');
  }
  assert.deepEqual(await lastMenu(), { owner, items: [{ label: 'Копировать ссылку', enabled: true }] }, 'HTTP(S) menus contain only Copy link');

  const beforeCancel = await actions();
  await app.evaluate(() => { globalThis.__linkMenuSelection = false; });
  await invoke(id, 'showPathMenu', encodedTarget);
  await invoke(id, 'showPathMenu', webTarget);
  assert.deepEqual(await actions(), beforeCancel, 'Cancelling local or web menus must not copy or open anything');
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Спросить Codex'; });
  const beforeAsk = await actions();
  assert.deepEqual(await invoke(id, 'showPathMenu', encodedTarget, { askCodex: true }), { action: 'askCodex', path: resolvedFile });
  const resolvedDirectory = await realpath(path.join(project, 'src'));
  assert.deepEqual(await invoke(id, 'showPathMenu', 'src', { askCodex: true }), { action: 'askCodex', path: resolvedDirectory });
  assert.deepEqual(await actions(), beforeAsk, 'Asking Codex returns the path without opening it or showing Explorer');
  const askMenus = await app.evaluate(() => globalThis.__linkMenus.slice(-2));
  for (const menu of askMenus) {
    assert.equal(menu.owner, owner);
    assert.deepEqual(menu.items, [
      { label: 'Копировать ссылку', enabled: true }, { label: 'Спросить Codex', enabled: true }, { label: 'Открыть в проводнике', enabled: true },
    ]);
  }
  await app.evaluate(() => { globalThis.__linkMenuSelection = false; });
  assert.equal(await invoke(id, 'showPathMenu', encodedTarget, { askCodex: true }), undefined, 'Cancelling an Ask-enabled menu returns no composer action');
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Открыть в проводнике'; });
  assert.equal(await invoke(id, 'showPathMenu', encodedTarget, { askCodex: true }), undefined, 'Explorer choice returns no composer action');
  assert.deepEqual((await actions()).at(-1), { kind: 'reveal', target: resolvedFile });

  // Exercise the whole renderer -> scoped preload -> native Menu -> composer path.
  const fileTree = page.locator('.session-view:visible .file-browser');
  const composer = page.locator('.session-view:visible').getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const sourceDirectory = fileTree.getByRole('button', { name: 'Раскрыть папку src', exact: true });
  await sourceDirectory.click();
  const selectedFile = fileTree.getByRole('button', { name: 'Открыть файл пример файла.txt', exact: true });
  await selectedFile.waitFor();
  await composer.fill('Расскажи о выбранном файле:');
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Спросить Codex'; });
  await selectedFile.click({ button: 'right' });
  const expectedDraft = `Расскажи о выбранном файле:\n${resolvedFile}\n`;
  await page.waitForFunction(expected => document.querySelector('.session-view:not([hidden]) textarea[aria-label="Сообщение Codex"]')?.value === expected, expectedDraft);
  assert.deepEqual(await composer.evaluate(node => ({ focused: node === document.activeElement, start: node.selectionStart, end: node.selectionEnd })), { focused: true, start: expectedDraft.length, end: expectedDraft.length });
  await sourceDirectory.focus();
  await page.keyboard.press('Shift+F10');
  const expectedWithFolder = `${expectedDraft}${resolvedDirectory}\n`;
  await page.waitForFunction(expected => document.querySelector('.session-view:not([hidden]) textarea[aria-label="Сообщение Codex"]')?.value === expected, expectedWithFolder);
  assert.deepEqual(await actions(), [...beforeAsk, { kind: 'reveal', target: resolvedFile }]);
  await page.screenshot({ path: path.join(runDir, 'ask-codex.png') });
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Открыть в проводнике'; });

  // A completed agent message crosses the real preload event channel, then
  // Markdown -> context menu -> scoped IPC -> the substituted native clipboard.
  // The synthetic notification is scoped to the current session; no turn is sent.
  await app.evaluate(({ BrowserWindow }, { id, encodedTarget, webTarget }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('codex:event', {
      sessionId: id, defaultSession: true, type: 'notification', data: {
        method: 'item/completed', params: { turnId: 'link-history-turn', item: {
          id: 'link-history-answer', type: 'agentMessage', phase: 'final_answer',
          text: `[Локальная ссылка для копирования](${encodedTarget}:8:3) и [Веб-ссылка для копирования](${webTarget})`,
        } },
      },
    });
  }, { id, encodedTarget, webTarget });
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Копировать ссылку'; });
  for (const [label, target] of [['Локальная ссылка для копирования', `${encodedTarget}:8:3`], ['Веб-ссылка для копирования', webTarget]]) {
    const beforeCopy = await actions();
    await page.getByRole('link', { name: label, exact: true }).click({ button: 'right' });
    await waitForMain('__linkActions', beforeCopy.length + 1);
    assert.deepEqual(await actions(), [...beforeCopy, { kind: 'copy', target }]);
  }
  const beforeMarkdownCancel = await actions();
  await app.evaluate(() => { globalThis.__linkMenuSelection = false; });
  await page.getByRole('link', { name: 'Веб-ссылка для копирования', exact: true }).focus();
  const menuCount = await app.evaluate(() => globalThis.__linkMenus.length);
  await page.keyboard.press('Shift+F10');
  await waitForMain('__linkMenus', menuCount + 1);
  assert.deepEqual(await actions(), beforeMarkdownCancel, 'Cancelling Markdown keyboard menu leaves the clipboard untouched');
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Открыть в проводнике'; });

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
  await assert.rejects(invoke(otherSession.id, 'openPath', encodedTarget), /за пределами выбранного проекта/);
  await assert.rejects(invoke(otherSession.id, 'openPath', reportedTarget), /за пределами выбранного проекта/);
  await assert.rejects(invoke(id, 'openPath', 'javascript:alert(1)'), /только локальные файлы/);
  const unavailableLinks = [[otherSession.id, encodedTarget], [otherSession.id, reportedTarget], [id, 'src/missing%20file.txt:9'], [id, 'javascript:alert(1)']];
  for (const selection of ['Открыть в проводнике', 'Спросить Codex']) {
    await app.evaluate((_, selection) => { globalThis.__linkMenuSelection = selection; }, selection);
    for (const [sessionId, target] of unavailableLinks) {
      assert.equal(await invoke(sessionId, 'showPathMenu', target, { askCodex: true }), undefined);
      assert.deepEqual(await lastMenu(), { owner, items: [
        { label: 'Копировать ссылку', enabled: true }, { label: 'Спросить Codex', enabled: false }, { label: 'Открыть в проводнике', enabled: false },
      ] });
    }
  }
  assert.deepEqual(await actions(), beforeRejected, 'Unavailable paths cannot reach native file actions or return an Ask action');
  await app.evaluate(() => { globalThis.__linkMenuSelection = 'Копировать ссылку'; });
  for (const [sessionId, target] of unavailableLinks) {
    const beforeCopy = await actions();
    assert.equal(await invoke(sessionId, 'showPathMenu', target, { askCodex: true }), undefined);
    assert.deepEqual(await actions(), [...beforeCopy, { kind: 'copy', target }], 'Copy remains available for missing and inaccessible paths');
  }
  await page.evaluate(id => window.codex.closeSession(id), otherSession.id);
  await assert.rejects(invoke(otherSession.id, 'openPath', encodedTarget), /закрытая сессия/);
  await assert.rejects(invoke(otherSession.id, 'showPathMenu', encodedTarget), /закрытая сессия/);
  await assert.rejects(files(otherSession.id), /закрытая сессия/);

  await invoke(id, 'openPath', 'https://example.test/docs?q=codex');
  assert.deepEqual((await actions()).at(-1), { kind: 'external', target: 'https://example.test/docs?q=codex' });
  const log = (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(entry => entry.method === 'turn/start').length, 0, 'No model turns are sent, even to the fixture');
  assert.equal(app.windows().length, 1);
  assert.deepEqual(errors, []);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ reportedTarget, encodedTarget, actions: await actions(), menus: await app.evaluate(() => globalThis.__linkMenus) }, null, 2));
  console.log(`PASS: real Electron preload/IPC resolves encoded ancestors, Unicode, source suffixes and file URLs; Ask Codex file/folder menu choices append paths to the focused draft via renderer and scoped IPC, cancel/reveal produce no composer action; lazy directory listings, session isolation and closed-session checks. Native shell/Menu/clipboard substituted; Markdown right-click copies raw local/web links, unavailable files keep Copy and disable file actions; no model requests. Exact reported href: ${reportedTarget}. Artifacts: ${runDir}`);
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
