import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC with disposable JSONL servers and profile. Thread
// history lives only in the fixture state.json, never in the user's Codex home.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'archive-host-'));
const project = path.join(runDir, 'PROJECT_A');
const orphan = path.join(runDir, 'ARCHIVE_ONLY');
const profile = path.join(runDir, 'profile');
await Promise.all([project, orphan, profile].map(directory => mkdir(directory)));
const activeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const archivedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const paginatedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fixtureThread = (id, name, cwd, archived) => ({ id, name, cwd, archived, preview: name, historyMode: 'legacy', updatedAt: 1789644000, status: { type: 'idle' }, turns: [{ id: `turn-${id}`, status: 'completed', items: [{ id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `История ${name}` }] }] });
await writeFile(path.join(runDir, 'state.json'), JSON.stringify({
  [activeId]: fixtureThread(activeId, 'Рабочий диалог', project, false),
  [archivedId]: fixtureThread(archivedId, 'Старая история', orphan, true),
  [paginatedId]: { ...fixtureThread(paginatedId, 'История со страницами', orphan, true), historyMode: 'paginated', turns: [] },
}));
const serverSource = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.dirname(process.cwd());
const stateFile = path.join(root, 'state.json');
const log = data => appendFileSync(path.join(root, 'server.jsonl'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...data }) + '\n');
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Archive fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  const threads = read();
  if (method === 'thread/list') return reply(id, { data: Object.values(threads).filter(thread => thread.archived === Boolean(params.archived) && (!params.cwd || thread.cwd === params.cwd)), nextCursor: null });
  const thread = threads[params.threadId];
  if (!thread) return send({ id, error: { code: -32602, message: 'Fixture missing thread: ' + params.threadId } });
  if (method === 'thread/read') return reply(id, { thread: { ...thread, turns: params.includeTurns ? thread.turns : [] } });
  if (method === 'thread/items/list') {
    const item = number => ({ turnId: 'turn-page-' + number, item: { id: 'page-' + number, type: 'agentMessage', phase: 'final_answer', text: 'Сообщение страницы ' + number } });
    return reply(id, { data: params.cursor ? [item(2), item(1)] : [item(4), item(3)], nextCursor: params.cursor ? null : 'older-page' });
  }
  if (method === 'thread/resume') {
    if (thread.archived) return send({ id, error: { code: -32602, message: 'Cannot resume fixture archive' } });
    return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  }
  if (['thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete'].includes(method)) {
    if (method === 'thread/name/set') thread.name = params.name;
    if (method === 'thread/archive') thread.archived = true;
    if (method === 'thread/unarchive') thread.archived = false;
    if (method === 'thread/delete') delete threads[thread.id];
    writeFileSync(stateFile, JSON.stringify(threads));
    const event = { 'thread/name/set': 'thread/name/updated', 'thread/archive': 'thread/archived', 'thread/unarchive': 'thread/unarchived', 'thread/delete': 'thread/deleted' }[method];
    notify(event, { threadId: thread.id, ...(method === 'thread/name/set' ? { name: thread.name } : {}) });
    return reply(id, method === 'thread/unarchive' ? { thread } : {});
  }
  if (method === 'turn/start') {
    const turn = { id: 'continuation', status: 'inProgress', items: [] };
    reply(id, { turn });
    setTimeout(() => {
      notify('turn/started', { threadId: thread.id, turn });
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { id: 'continued-answer', type: 'agentMessage', phase: 'final_answer', text: 'Продолжение после восстановления' } });
      notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'completed', error: null } });
    }, 30);
    return;
  }
  send({ id, error: { code: -32601, message: 'Unexpected fixture method: ' + method } });
});
input.on('close', () => process.exit());
`;
await Promise.all([project, orphan].map(async directory => {
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(directory, 'app-server'), serverSource);
}));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
await writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
const logs = async () => (await readFile(path.join(runDir, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const requests = async method => (await logs()).filter(entry => entry.method === method);
const state = async () => JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const until = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
let app, page;
const errors = [];
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const sidebar = () => page.locator('.sidebar:visible');
  const row = id => sidebar().locator(`.folder-thread[data-thread-id="${id}"]`);
  const archive = () => sidebar().getByRole('button', { name: 'Архив', exact: true });
  const action = async (title, label) => {
    await sidebar().getByRole('button', { name: `Действия диалога ${title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  await until(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'initial ready');
  await row(activeId).click(); await view().getByText('История Рабочий диалог', { exact: true }).waitFor();
  const originalSession = await view().getAttribute('data-session-id');
  await action('Рабочий диалог', 'Переименовать');
  const rename = page.getByRole('dialog', { name: 'Переименовать диалог', exact: true });
  await rename.getByRole('textbox', { name: 'Название диалога', exact: true }).fill('Название через IPC');
  await rename.getByRole('button', { name: 'Сохранить', exact: true }).click(); await rename.waitFor({ state: 'hidden' });
  assert.equal((await state())[activeId].name, 'Название через IPC');
  await action('Название через IPC', 'В архив');
  await page.locator(`.session-tab[data-session-id="${originalSession}"]`).waitFor({ state: 'detached' });
  assert.equal((await state())[activeId].archived, true);
  await archive().click(); await row(archivedId).waitFor();
  const sessionsBefore = (await page.evaluate(() => window.codex.getWorkspace())).sessions;
  const resumesBefore = await requests('thread/resume');
  await row(archivedId).click(); await view().getByText('История Старая история', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение Codex', exact: true }).count(), 0);
  assert.deepEqual((await page.evaluate(() => window.codex.getWorkspace())).sessions, sessionsBefore);
  assert.deepEqual(await requests('thread/resume'), resumesBefore, 'Reading archive uses read requests only, never resume');
  assert.equal((await requests('turn/start')).length, 0);
  const archiveReads = (await requests('thread/read')).filter(entry => entry.params.threadId === archivedId);
  assert.ok(archiveReads.some(entry => entry.params.includeTurns === true));
  assert.ok((await requests('thread/list')).some(entry => entry.params.archived === true && !entry.params.cwd), 'Archive spans folders, including ones absent from workspace');
  await page.screenshot({ path: path.join(runDir, 'archive.png') });

  await row(paginatedId).click(); await view().getByText('Сообщение страницы 4', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'Загрузить предыдущие сообщения', exact: true }).click();
  await view().getByText('Сообщение страницы 1', { exact: true }).waitFor();
  assert.deepEqual((await view().locator('.assistant-message').allTextContents()).map(text => text.replace(/^Codex/, '').trim()), [1, 2, 3, 4].map(number => `Сообщение страницы ${number}`), 'Paginated App Server history stays chronological through host and renderer');
  assert.deepEqual((await requests('thread/items/list')).map(entry => entry.params), [
    { threadId: paginatedId, limit: 100, sortDirection: 'desc' },
    { threadId: paginatedId, limit: 100, sortDirection: 'desc', cursor: 'older-page' },
  ]);
  assert.deepEqual(await requests('thread/resume'), resumesBefore);
  const invalid = await page.evaluate(async ({ activeId, project, orphan }) => {
    const attempt = async fn => { try { await fn(); return 'UNEXPECTED_SUCCESS'; } catch (error) { return error.message; } };
    const { sessions } = await window.codex.getWorkspace();
    return [
      await attempt(() => window.codex.manageThread({ action: 'rename', threadId: activeId, cwd: orphan, name: 'Wrong scope' })),
      await attempt(() => window.codex.manageThread({ action: 'delete', threadId: 'invalid', cwd: project })),
      await attempt(() => window.codex.forSession(sessions[0].id).request('thread/delete', { threadId: activeId })),
    ];
  }, { activeId, project, orphan });
  assert.ok(invalid.every(message => message !== 'UNEXPECTED_SUCCESS'), 'Host rejects wrong folder, invalid identifier, and unrestricted lifecycle RPC from a tab');
  await action('Название через IPC', 'Восстановить');
  await until(async () => (await state())[activeId].archived === false, 'restore state');
  await archive().click(); await row(activeId).click();
  await until(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'restored ready');
  const input = view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  await input.fill('Продолжить исходный диалог'); await input.press('Enter');
  await view().getByText('Продолжение после восстановления', { exact: true }).waitFor();
  await until(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'continuation completed');
  assert.equal((await requests('turn/start'))[0].params.threadId, activeId);
  await archive().click(); await action('Старая история', 'Удалить');
  const confirmation = page.getByRole('alertdialog', { name: 'Удалить диалог', exact: true });
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal((await requests('thread/delete')).length, 0);
  await action('Старая история', 'Удалить'); await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal((await state())[archivedId], undefined);
  await row(paginatedId).click(); await view().getByText('Сообщение страницы 4', { exact: true }).waitFor();
  await view().locator('.archive-readonly-footer').getByRole('button', { name: 'Восстановить', exact: true }).click();
  await until(async () => (await state())[paginatedId].archived === false, 'restore folder outside workspace');
  await until(async () => (await page.evaluate(() => window.codex.getWorkspace())).projects.includes(orphan), 'restored folder persisted in workspace');
  await archive().click();
  await sidebar().getByRole('button', { name: 'Диалоги папки ARCHIVE_ONLY', exact: true }).waitFor();
  await row(paginatedId).waitFor();
  assert.deepEqual((await requests('thread/archive')).map(entry => entry.params), [{ threadId: activeId }]);
  assert.deepEqual((await requests('thread/unarchive')).map(entry => entry.params), [{ threadId: activeId }, { threadId: paginatedId }]);
  assert.deepEqual((await requests('thread/delete')).map(entry => entry.params), [{ threadId: archivedId }]);
  assert.deepEqual((await requests('thread/name/set')).map(entry => entry.params), [{ threadId: activeId, name: 'Название через IPC' }]);
  assert.equal((await requests('thread/start')).length, 0, 'All actions keep original thread identities');
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron/preload/IPC, isolated JSONL servers, exact native rename/archive/unarchive/delete, global read-only archive and chronological paginated history, no resume/write while reading, original thread restored and continued, delete confirmation, host scope/id/method guards. No real Codex/provider/user history. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Archive host artifacts: ${runDir}`); throw error;
} finally {
  const pids = new Set((await logs().catch(() => [])).filter(entry => entry.type === 'spawn').map(entry => entry.pid));
  await app?.close();
  for (const pid of pids) await until(() => !alive(pid), 'fixture process cleanup');
}
