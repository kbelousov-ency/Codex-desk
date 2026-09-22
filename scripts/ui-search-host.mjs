import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC; only disposable JSONL fixture servers, never the
// user's Codex home, model, or history. Also accepts CODEX_DESK_PACKAGED.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'search-host-'));
const project = path.join(runDir, 'PROJECT_A'), outside = path.join(runDir, 'OTHER_PROJECT'), profile = path.join(runDir, 'profile');
await Promise.all([project, outside, profile].map(directory => mkdir(directory)));
const ids = { live: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outside: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', archive: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const fixtureThread = (id, name, cwd, archived) => ({ id, name, cwd, archived, preview: name, historyMode: 'legacy', updatedAt: 1789644000, status: { type: 'idle' }, turns: [{ id: `turn-${id}`, status: 'completed', items: [{ id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Вопрос: ${name}` }] }, { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Ответ: ${name}` }] }] });
await writeFile(path.join(runDir, 'state.json'), JSON.stringify({
  [ids.live]: fixtureThread(ids.live, 'Поиск основной истории', project, false),
  [ids.outside]: fixtureThread(ids.outside, 'Поиск внешнего проекта', outside, false),
  [ids.archive]: fixtureThread(ids.archive, 'Поиск архивной истории', outside, true),
}));
const source = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.dirname(process.cwd());
const log = data => appendFileSync(path.join(root, 'server.jsonl'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...data }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Search fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  const threads = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'));
  if (method === 'thread/list') {
    const data = Object.values(threads).filter(t => t.archived === Boolean(params.archived) && (!params.cwd || t.cwd === params.cwd) && (!params.searchTerm || t.name.toLowerCase().includes(params.searchTerm.toLowerCase())));
    return reply(id, { data: params.searchTerm ? data.slice(params.cursor ? 1 : 0, params.cursor ? 2 : 1) : data, nextCursor: params.searchTerm && data.length > 1 && !params.cursor ? 'search-next' : null });
  }
  const thread = threads[params.threadId];
  if (method === 'thread/read' && thread) return reply(id, { thread: { ...thread, turns: params.includeTurns ? thread.turns : [] } });
  if (method === 'thread/resume' && thread && !thread.archived) return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  send({ id, error: { code: -32601, message: 'Unexpected fixture method ' + method } });
});
input.on('close', () => process.exit());
`;
await Promise.all([project, outside].map(async directory => { await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n'); await writeFile(path.join(directory, 'app-server'), source); }));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }));
await writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
const logs = async () => (await readFile(path.join(runDir, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const requests = async method => (await logs()).filter(entry => entry.method === method);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const until = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
let app, page;
const errors = [];
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const sidebar = () => view().locator('.sidebar');
  const results = () => sidebar().getByRole('navigation', { name: 'Результаты поиска диалогов', exact: true });
  await until(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  await sidebar().getByRole('textbox', { name: 'Поиск диалогов', exact: true }).fill('Поиск');
  await results().locator(`[data-thread-id="${ids.live}"]`).waitFor();
  await results().getByRole('button', { name: 'Загрузить ещё', exact: true }).click();
  await results().locator(`[data-thread-id="${ids.outside}"]`).waitFor();
  const searchCalls = (await requests('thread/list')).filter(r => r.params.searchTerm);
  assert.equal(searchCalls.length, 2);
  for (const entry of searchCalls) {
    assert.equal(entry.params.searchTerm, 'Поиск'); assert.equal(entry.params.archived, false);
    assert.equal(entry.params.cwd, undefined, 'Global search cannot be restricted to current folder');
    assert.deepEqual(entry.params.modelProviders, []);
    assert.deepEqual(entry.params.sourceKinds, ['appServer', 'cli', 'vscode']);
  }
  assert.equal(searchCalls[1].params.cursor, 'search-next');
  assert.equal((await requests('thread/resume')).length, 0, 'Listing results does not load writable sessions');
  await results().locator(`[data-thread-id="${ids.outside}"]`).click();
  await view().locator(`[data-item-id="answer-${ids.outside}"]`).waitFor();
  assert.equal((await requests('thread/resume')).at(-1).params.threadId, ids.outside);
  assert.equal((await requests('thread/resume')).at(-1).params.cwd, outside);
  const currentInput = view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  await currentInput.fill('Черновик после поиска');
  await currentInput.press('Control+f');
  const find = () => view().getByRole('textbox', { name: 'Найти в чате', exact: true });
  await find().fill('внешнего');
  await until(async () => (await view().locator('.chat-search-count').innerText()).includes('1 из 2'), 'host current chat search');
  await find().press('Enter');
  await until(async () => (await view().locator('.chat-search-count').innerText()).includes('2 из 2'), 'host search navigation');
  await find().press('Escape');
  assert.equal(await currentInput.inputValue(), 'Черновик после поиска');
  await sidebar().getByRole('button', { name: 'Архив', exact: true }).click();
  await sidebar().getByRole('textbox', { name: 'Поиск в архиве', exact: true }).fill('архивной');
  await results().locator(`[data-thread-id="${ids.archive}"]`).waitFor();
  const archiveQuery = (await requests('thread/list')).filter(r => r.params.searchTerm === 'архивной').at(-1);
  assert.equal(archiveQuery.params.archived, true); assert.equal(archiveQuery.params.cwd, undefined);
  const beforeArchive = (await page.evaluate(() => window.codex.getWorkspace())).sessions;
  const beforeResumes = await requests('thread/resume');
  await results().locator(`[data-thread-id="${ids.archive}"]`).click();
  await view().locator(`[data-item-id="answer-${ids.archive}"]`).waitFor();
  assert.deepEqual((await page.evaluate(() => window.codex.getWorkspace())).sessions, beforeArchive);
  assert.deepEqual(await requests('thread/resume'), beforeResumes);
  assert.equal(await view().getByRole('textbox', { name: 'Сообщение Codex', exact: true }).count(), 0);
  await page.keyboard.press('Control+f'); await find().fill('архивной');
  await until(async () => (await view().locator('.chat-search-count').innerText()).includes('1 из 2'), 'archive search');
  await page.screenshot({ path: path.join(runDir, 'archive-search.png') });
  assert.ok((await requests('thread/read')).some(r => r.params.threadId === ids.archive && r.params.includeTurns));
  const invalid = await page.evaluate(async () => {
    const attempt = async params => { try { await window.codex.searchThreads(params); return false; } catch { return true; } };
    return Promise.all([attempt({ query: 'x', archived: 'yes' }), attempt({ query: 'x', archived: false, cursor: 99 }), attempt({ query: {}, archived: false })]);
  });
  assert.ok(invalid.every(Boolean), 'Preload manager validates query/archive/cursor types');
  assert.equal((await requests('turn/start')).length, 0);
  assert.equal((await requests('thread/start')).length, 0);
  assert.equal((await logs()).filter(r => ['thread/name/set', 'thread/archive', 'thread/delete', 'thread/unarchive'].includes(r.method)).length, 0);
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron/preload/IPC title search, native searchTerm/archived/global cwd/pagination, exact external-folder resume, Ctrl+F navigation with draft preservation, archive read-only, invalid payload guards, no model or history mutation. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`Search host artifacts: ${runDir}`); throw error;
} finally {
  const pids = new Set((await logs().catch(() => [])).filter(entry => entry.type === 'spawn').map(entry => entry.pid));
  await app?.close();
  for (const pid of pids) await until(() => !alive(pid), 'fixture process cleanup');
}
