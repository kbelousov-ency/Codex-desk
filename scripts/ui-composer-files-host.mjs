import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Actual Electron/main/preload IPC, with only the native file chooser replaced.
// Every selected file and the App Servers belong to this disposable fixture.
// No installed Codex, model request, document opening, or user profile is used.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'composer-files-host-'));
const projectA = path.join(runDir, 'PROJECT_A'), projectB = path.join(runDir, 'PROJECT_B');
const outside = path.join(runDir, 'OUTSIDE_PROJECTS'), dataDir = path.join(runDir, 'profile');
await Promise.all([projectA, projectB, outside, dataDir].map(directory => mkdir(directory)));
for (const directory of [projectA, projectB]) {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(directory, 'app-server'));
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const textPath = path.join(projectA, 'заметки и $символы.txt');
const pdfPath = path.join(outside, 'инструкция [1].pdf');
const zipPath = path.join(outside, 'archive.zip');
const pngPath = path.join(projectA, 'картинка.PNG');
const otherPngPath = path.join(projectB, 'another.png');
const invalidPngPath = path.join(outside, 'invalid.png');
await Promise.all([
  writeFile(textPath, 'Visible reference only; never inserted as hidden instructions.\n'),
  writeFile(pdfPath, '%PDF-1.7\nFixture document, kept at its original path.\n'),
  writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])),
  writeFile(pngPath, png), writeFile(otherPngPath, png),
  writeFile(invalidPngPath, 'This is a text file with a misleading extension.'),
]);
const settings = { executable: process.execPath, cwd: projectA, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' };
const settingsPath = path.join(dataDir, 'settings.json');
await writeFile(settingsPath, JSON.stringify(settings));
const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [], results = [];
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const choose = (id, options = { imageSlots: 10, imagesSupported: true }) => page.evaluate(
  ({ id, options }) => window.codex.forSession(id).chooseComposerFiles(options), { id, options },
);
async function waitUntil(check, label) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50); }
}
async function nativeDialog(filePaths, { canceled = false, deferred = false } = {}) {
  await app.evaluate(({ dialog }, response) => {
    globalThis.composerChooserCalls = [];
    globalThis.finishComposerChooser = null;
    dialog.showOpenDialog = (owner, options) => {
      globalThis.composerChooserCalls.push({ ownerId: owner.id, options });
      return response.deferred
        ? new Promise(resolve => { globalThis.finishComposerChooser = () => resolve({ canceled: response.canceled, filePaths: response.filePaths }); })
        : Promise.resolve({ canceled: response.canceled, filePaths: response.filePaths });
    };
  }, { filePaths, canceled, deferred });
}
const dialogCalls = () => app.evaluate(() => globalThis.composerChooserCalls);
const finishDialog = () => app.evaluate(() => { globalThis.finishComposerChooser(); globalThis.finishComposerChooser = null; });
async function rejected(id, options, label) {
  const result = await page.evaluate(async ({ id, options }) => {
    try { return { accepted: true, value: await window.codex.forSession(id).chooseComposerFiles(options) }; }
    catch (error) { return { accepted: false, message: error.message }; }
  }, { id, options });
  assert.equal(result.accepted, false, label);
  assert.ok(result.message?.length, `${label}: useful error`);
  return result.message;
}
async function startPending(id) {
  await page.evaluate(id => {
    window.pendingComposerChoice = window.codex.forSession(id).chooseComposerFiles({ imageSlots: 10, imagesSupported: true })
      .then(value => ({ accepted: true, value }), error => ({ accepted: false, message: error.message }));
  }, id);
  await waitUntil(async () => (await dialogCalls()).length === 1, 'native dialog pending');
}
async function pendingRejected(label) {
  const result = await page.evaluate(() => window.pendingComposerChoice);
  assert.equal(result.accepted, false, label);
  assert.ok(result.message?.length, `${label}: useful error`);
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
const attachments = () => snapshot(path.join(dataDir, 'attachments')).catch(error => {
  if (error.code === 'ENOENT') return {};
  throw error;
});

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
  const first = (await page.evaluate(() => window.codex.getWorkspace())).sessions[0].id;
  const second = (await page.evaluate(cwd => window.codex.createSession({ cwd }), projectB)).id;
  await page.evaluate(id => window.codex.forSession(id).start(), second);
  const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  assert.equal((await page.evaluate(() => window.codex.getNotificationSettings())).supported, false, 'Test profile does not initialize Windows notifications or real shortcut identity');
  await app.evaluate(({ shell }) => {
    globalThis.composerShellCalls = [];
    for (const method of ['openPath', 'openExternal', 'showItemInFolder']) shell[method] = (...args) => {
      globalThis.composerShellCalls.push({ method, args });
      throw new Error('File selection must not open or execute files.');
    };
  });
  const before = await Promise.all([projectA, projectB, outside].map(snapshot));
  const attachmentsBefore = await attachments();
  const settingsBefore = await readFile(settingsPath, 'utf8');

  await nativeDialog([textPath, pdfPath, zipPath, pngPath]);
  const mixed = await choose(first);
  assert.deepEqual(mixed.paths, [textPath, pdfPath, zipPath]);
  assert.deepEqual(mixed.images, [{ name: path.basename(pngPath), dataUrl: `data:image/png;base64,${png.toString('base64')}` }]);
  const [picked] = await dialogCalls();
  assert.equal(picked.ownerId, windowId);
  assert.ok(samePath(picked.options.defaultPath, projectA));
  assert.deepEqual(picked.options.properties, ['openFile', 'multiSelections']);
  assert.ok(picked.options.filters.some(filter => filter.extensions.includes('*')), 'Any file is selectable');
  assert.deepEqual(await attachments(), attachmentsBefore, 'Selection does not copy documents or persist unsubmitted images');
  assert.equal(await readFile(settingsPath, 'utf8'), settingsBefore, 'Selecting files leaves default Codex settings intact');
  results.push('real chooser IPC returns mixed TXT/PDF/ZIP paths and exact PNG bytes; owning window/cwd and any-file multiselect');

  await nativeDialog([otherPngPath]);
  const secondChoice = await choose(second);
  assert.equal(secondChoice.images.length, 1);
  assert.ok(samePath((await dialogCalls())[0].options.defaultPath, projectB), 'Background session uses its own cwd');
  await nativeDialog([textPath, textPath, pngPath, pngPath]);
  const deduplicated = await choose(first);
  assert.deepEqual(deduplicated.paths, [textPath]);
  assert.equal(deduplicated.images.length, 1);
  await nativeDialog([pngPath, pdfPath, invalidPngPath]);
  const textOnly = await choose(first, { imageSlots: 0, imagesSupported: false });
  assert.deepEqual(textOnly.images, []);
  assert.deepEqual(textOnly.paths, [pngPath, pdfPath, invalidPngPath]);
  assert.ok(textOnly.message, 'Text-only model receives an explicit explanation of path references');
  results.push('independent session default paths, deduplication, and images as visible paths for text-only models');

  await nativeDialog([pdfPath], { canceled: true });
  assert.equal(await choose(first), null, 'Cancelled selection exposes no files');
  await nativeDialog([]);
  assert.equal(await choose(first), null, 'Empty selection is equivalent to cancel');
  await nativeDialog([pdfPath]);
  for (const options of [
    null, [], 'file', 1, { imageSlots: -1 }, { imageSlots: 11 }, { imageSlots: 1.5 },
    { imageSlots: '1' }, { imagesSupported: 1 }, { paths: [pdfPath] }, { filePaths: [pdfPath] },
    { imageSlots: 10, imagesSupported: true, path: pdfPath },
  ]) await rejected(first, options, `Malformed or raw-path options rejected: ${JSON.stringify(options)}`);
  assert.deepEqual(await dialogCalls(), [], 'Invalid renderer options never invoke the native picker');
  await rejected('not-owned-by-this-window', {}, 'Unknown session is rejected before native selection');
  assert.deepEqual(await dialogCalls(), []);
  results.push('cancel/empty result, malformed limits and types, arbitrary renderer file paths and wrong session rejected');

  await nativeDialog([pngPath]);
  await rejected(first, { imageSlots: 0, imagesSupported: true }, 'No remaining image slots rejects the batch');
  await nativeDialog([pngPath, otherPngPath]);
  await rejected(first, { imageSlots: 1, imagesSupported: true }, 'Remaining composer capacity is enforced across IPC');
  await nativeDialog([pdfPath, invalidPngPath]);
  await rejected(first, { imageSlots: 10, imagesSupported: true }, 'Invalid PNG rejects the batch instead of partly inserting references');
  await nativeDialog(Array.from({ length: 21 }, (_, index) => path.join(outside, `file-${index}.txt`)));
  await rejected(first, { imageSlots: 10, imagesSupported: true }, 'Native multiselect count is bounded before processing');
  results.push('host enforces remaining image slots, valid image content, and bounded total file selection');

  await nativeDialog([pdfPath], { deferred: true });
  await startPending(first);
  await rejected(first, {}, 'A session cannot open a second simultaneous picker');
  assert.equal((await dialogCalls()).length, 1);
  await page.evaluate(({ id, cwd }) => window.codex.forSession(id).start({ cwd }), { id: first, cwd: projectB });
  await finishDialog();
  await pendingRejected('Changing the owning cwd while the dialog is open discards its result');
  await nativeDialog([pdfPath]);
  assert.deepEqual((await choose(first)).paths, [pdfPath], 'A stale dialog releases the picker guard');
  assert.ok(samePath((await dialogCalls())[0].options.defaultPath, projectB));

  await nativeDialog([otherPngPath], { deferred: true });
  await startPending(second);
  await page.evaluate(id => window.codex.closeSession(id), second);
  await finishDialog();
  await pendingRejected('Disposing the owning session invalidates the pending picker generation');
  await nativeDialog([otherPngPath]);
  await rejected(second, {}, 'Closed session cannot request another picker');
  assert.deepEqual(await dialogCalls(), []);
  results.push('duplicate picker blocked; cwd changes and disposed session generations invalidate pending results; guard recovers');

  assert.deepEqual(await Promise.all([projectA, projectB, outside].map(snapshot)), before, 'Every project and outside file retains bytes, size, and mtime');
  assert.deepEqual(await attachments(), attachmentsBefore, 'No selections were copied into the attachment store');
  const settingsAfter = await page.evaluate(id => window.codex.forSession(id).getSettings(), first);
  assert.equal(settingsAfter.model, settings.model);
  assert.equal(settingsAfter.effort, settings.effort);
  assert.deepEqual(await app.evaluate(() => globalThis.composerShellCalls), [], 'Files were never opened or executed');
  const logs = (await Promise.all([projectA, projectB].map(directory => readFile(path.join(directory, 'server.jsonl'), 'utf8'))))
    .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const modelCalls = logs.filter(entry => ['turn/start', 'turn/steer'].includes(entry.method));
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(errors, []);
  results.push('original files untouched, no attachment copies, unchanged model/effort, no shell opening or model requests');
  const report = { runDir, packaged: Boolean(process.env.CODEX_DESK_PACKAGED), results, modelCalls: 0 };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
