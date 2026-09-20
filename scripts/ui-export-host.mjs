import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC export against a native dialog stub and isolated profile.
// The CLI child is a JSONL fixture; no personal history or model calls.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await realpath(await mkdtemp(path.join(root, 'artifacts', 'export-host-')));
const project = path.join(runDir, 'PROJECT'), profile = path.join(runDir, 'profile'), exportsDir = path.join(runDir, 'exports');
await Promise.all([project, profile, exportsDir].map(directory => mkdir(directory)));
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
await writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] }));
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
let app, page;
const errors = [];
const select = async response => app.evaluate(({ dialog }, response) => {
  globalThis.exportDialogCalls ||= [];
  dialog.showSaveDialog = async (owner, options) => { globalThis.exportDialogCalls.push({ ownerId: owner.id, options }); return response; };
}, response);
const invoke = payload => page.evaluate(payload => window.codex.exportConversation(payload), payload);
const dialogs = () => app.evaluate(() => globalThis.exportDialogCalls || []);
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return model && !model.disabled; });
  const ownerId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const markdown = '# Беседа: русский текст\n\n## Пользователь\n\nПроверить `токены` и **кэш**.\n\n## Ассистент\n\nГотово — 😀.\n';
  const html = '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>Беседа</title></head><body><h1>Беседа</h1><p>Кэш &amp; токены — 😀</p></body></html>\n';
  const mdPath = path.join(exportsDir, 'Беседа.md'), htmlPath = path.join(exportsDir, 'Беседа.html');
  await select({ canceled: false, filePath: mdPath });
  assert.deepEqual(await invoke({ format: 'markdown', filename: '../Беседа: тест.md', content: markdown }), { canceled: false, path: mdPath });
  assert.deepEqual(await readFile(mdPath), Buffer.from(markdown, 'utf8'));
  assert.deepEqual((await dialogs()).at(-1), { ownerId, options: { title: 'Экспорт беседы', defaultPath: 'Беседа_ тест.md', filters: [{ name: 'Markdown', extensions: ['md'] }] } });
  await select({ canceled: false, filePath: htmlPath });
  assert.deepEqual(await invoke({ format: 'html', filename: 'NUL.html', content: html }), { canceled: false, path: htmlPath });
  assert.deepEqual(await readFile(htmlPath), Buffer.from(html, 'utf8'));
  assert.equal((await dialogs()).at(-1).options.defaultPath, 'Беседа.html');
  assert.deepEqual((await dialogs()).at(-1).options.filters, [{ name: 'HTML', extensions: ['html'] }]);

  await select({ canceled: true, filePath: mdPath });
  assert.deepEqual(await invoke({ format: 'markdown', filename: 'cancel.md', content: 'Must not overwrite' }), { canceled: true });
  assert.equal(await readFile(mdPath, 'utf8'), markdown);
  assert.deepEqual((await readdir(exportsDir)).sort(), ['Беседа.html', 'Беседа.md']);

  const beforeInvalid = (await dialogs()).length;
  const invalid = await page.evaluate(async () => {
    const payloads = [null, { format: 'pdf', content: 'no' }, { format: 'html', content: 42 }, { format: 'markdown', content: 'Ж'.repeat(16 * 1024 * 1024 + 1) }];
    return Promise.all(payloads.map(value => window.codex.exportConversation(value).then(() => null, error => error.message)));
  });
  assert.ok(invalid.every(message => message && /32|Некорректный/.test(message)));
  assert.equal((await dialogs()).length, beforeInvalid, 'Invalid and oversized payloads are rejected before native save dialog');

  await select({ canceled: false, filePath: path.join(exportsDir, 'missing', 'cannot-write.md') });
  const writeError = await page.evaluate(value => window.codex.exportConversation(value).then(() => null, error => error.message), { format: 'markdown', filename: 'write-error', content: markdown });
  assert.match(writeError, /ENOENT|no such file|не уда/i);
  const retryPath = path.join(exportsDir, 'retry.md');
  await select({ canceled: false, filePath: retryPath });
  assert.deepEqual(await invoke({ format: 'markdown', filename: 'retry', content: markdown }), { canceled: false, path: retryPath });
  assert.equal(await readFile(retryPath, 'utf8'), markdown);
  const logs = (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(logs.some(entry => ['turn/start', 'thread/start', 'thread/resume', 'config/write', 'config/batchWrite'].includes(entry.method)), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: native Electron/preload export IPC, exact UTF-8 Markdown/HTML bytes, native filename/filter/owner, cancel without overwrite, malformed/oversized-before-dialog rejection, filesystem error and retry. No model requests. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`Export host artifacts: ${runDir}`); throw error;
} finally { await app?.close(); }
