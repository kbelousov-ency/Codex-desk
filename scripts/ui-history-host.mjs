import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Production Electron/preload/IPC plus synthetic native Codex and Claude history.
// No model turns or personal history; standalone app-owned bookmarks persist.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await realpath(await mkdtemp(path.join(root, 'artifacts', 'history-host-')));
const project = path.join(runDir, 'PROJECT'), outside = path.join(runDir, 'OUTSIDE'), profile = path.join(runDir, 'profile'), claudeConfig = path.join(runDir, 'claude');
await Promise.all([project, outside, profile].map(directory => mkdir(directory)));
const ids = { live: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', archived: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', claude: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const state = {
  [ids.live]: { id: ids.live, cwd: project, name: 'Обычная беседа', archived: false, historyMode: 'paginated', status: { type: 'idle' } },
  [ids.archived]: { id: ids.archived, cwd: project, name: 'Архив', archived: true, historyMode: 'legacy', status: { type: 'idle' },
    turns: [{ id: 'archived-turn', status: 'completed', items: [{ id: 'archived-answer', type: 'agentMessage', text: 'Искомая фраза из архива', phase: 'final_answer' }] }] },
};
const stateFile = path.join(runDir, 'state.json');
await writeFile(stateFile, JSON.stringify(state));
const source = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.dirname(process.cwd());
const log = data => appendFileSync(path.join(root, 'server.jsonl'), JSON.stringify({ pid: process.pid, ...data }) + '\n');
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
const reply = (id, result) => send({ id, result });
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Content history fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture', model_reasoning_effort: 'high' } });
  const state = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'));
  if (method === 'thread/list') return reply(id, { data: Object.values(state).filter(thread => thread.archived === Boolean(params.archived) && (!params.cwd || thread.cwd === params.cwd)), nextCursor: null });
  const thread = state[params.threadId];
  if (method === 'thread/read' && thread) { const { archived, ...metadata } = thread; return reply(id, { thread: { ...metadata, turns: params.includeTurns ? thread.turns : [] } }); }
  if (method === 'thread/items/list' && thread) {
    const items = params.cursor ? [{ id: 'older-answer', type: 'agentMessage', phase: 'final_answer', text: 'Искомая фраза на старой странице' }]
      : [{ id: 'live-user', type: 'userMessage', content: [{ type: 'text', text: 'ИСКОМАЯ ФРАЗА пользователя' }] },
         { id: 'live-answer', type: 'agentMessage', phase: 'final_answer', text: 'Искомая фраза ответа' },
         { id: 'reasoning', type: 'reasoning', summary: ['СЕКРЕТНЫЙ_МАРКЕР'], encrypted_content: 'СЕКРЕТНЫЙ_МАРКЕР' }];
    return reply(id, { data: items.map(item => ({ turnId: 'live-turn', item })), nextCursor: params.cursor ? null : 'older' });
  }
  send({ id, error: { code: -32601, message: 'Unexpected fixture method ' + method } });
});
input.on('close', () => process.exit());
`;
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(project, 'app-server'), source);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture', effort: 'high', access: 'workspace-write' }));
await writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ projects: [project] }));
const transcriptFolder = path.join(claudeConfig, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
await mkdir(transcriptFolder, { recursive: true });
const native = (type, uuid, parentUuid, content, extra = {}) => ({ type, uuid, parentUuid, sessionId: ids.claude, cwd: project, timestamp: '2026-09-19T10:00:00Z',
  isSidechain: false, message: { role: type, ...(type === 'assistant' ? { id: `api-${uuid}`, stop_reason: 'end_turn' } : {}), content }, ...extra });
const transcript = [native('user', 'claude-user', null, 'Искомая фраза Claude пользователя'),
  native('assistant', 'abandoned', 'claude-user', [{ type: 'text', text: 'СЕКРЕТНЫЙ_МАРКЕР отброшенной ветки' }]),
  native('assistant', 'claude-answer', 'claude-user', [{ type: 'text', text: 'Искомая фраза Claude ответа' }, { type: 'thinking', thinking: 'СЕКРЕТНЫЙ_МАРКЕР мысли', signature: 'signature' }]),
].map(frame => JSON.stringify(frame)).join('\n') + '\n';
const transcriptFile = path.join(transcriptFolder, `${ids.claude}.jsonl`);
await writeFile(transcriptFile, transcript);
const env = { ...process.env, CODEX_DESK_TEST: '1', CODEX_DESK_DATA_DIR: profile, CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_CODE_PROJECT_DIR_NAME: '' };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
const logs = async () => (await readFile(path.join(runDir, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const until = async (check, label) => { const deadline = Date.now() + 15000; while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(50); } };
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await until(() => page.locator('.session-view:visible').getByRole('combobox', { name: 'Модель', exact: true }).isEnabled().catch(() => false), 'Fixture bootstrap');
}
try {
  await launch();
  const result = await page.evaluate(async cwd => window.codex.searchHistory({ query: 'ИСКОМАЯ ФРАЗА', cwd, provider: 'all' }), project);
  assert.equal(result.matches.length, 6);
  assert.equal(result.scannedThreads, 3);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.warnings, []);
  const codex = result.matches.find(match => match.itemId === 'older-answer');
  assert.equal(codex.thread.id, ids.live); assert.equal(codex.turnId, 'live-turn');
  assert.ok(result.matches.some(match => match.thread.archived && match.itemId === 'archived-answer'));
  const claude = result.matches.find(match => match.itemId === 'api-claude-answer:text:0');
  assert.equal(claude.thread.id, `claude:${ids.claude}`); assert.equal(claude.turnId, 'claude-user');
  const resolveTarget = (provider, threadId, cwd = project) => page.evaluate(options => window.codex.resolveHistoryTarget(options), { cwd, provider, threadId });
  assert.equal((await resolveTarget('claude', `claude:${ids.claude}`)).archived, false);
  assert.equal((await resolveTarget('codex', ids.live)).archived, false);
  assert.equal((await resolveTarget('codex', ids.archived)).archived, true);
  state[ids.live].archived = true;
  state[ids.archived].archived = false;
  await writeFile(stateFile, JSON.stringify(state));
  assert.equal((await resolveTarget('codex', ids.live)).archived, true, 'A live bookmark follows later archival');
  assert.equal((await resolveTarget('codex', ids.archived)).archived, false, 'An archived bookmark follows later restoration');
  await assert.rejects(resolveTarget('codex', `claude:${ids.claude}`), /другому агенту/);
  await assert.rejects(resolveTarget('claude', ids.claude), /другому агенту/);
  await assert.rejects(resolveTarget('codex', ids.live, outside), /рабочую область/);
  await assert.rejects(resolveTarget('codex', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), /удалён|недоступным/);
  state[ids.live].cwd = outside;
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(resolveTarget('codex', ids.live), /другой папке/);
  state[ids.live].cwd = project; state[ids.live].archived = false; state[ids.archived].archived = true;
  await writeFile(stateFile, JSON.stringify(state));
  const hidden = await page.evaluate(async cwd => window.codex.searchHistory({ query: 'СЕКРЕТНЫЙ_МАРКЕР', cwd, provider: 'all' }), project);
  assert.deepEqual(hidden.matches, []);
  const invalidScope = await page.evaluate(async cwd => { try { await window.codex.searchHistory({ query: 'Искомая', cwd, provider: 'all' }); return false; } catch { return true; } }, outside);
  assert.equal(invalidScope, true);
  const saved = await page.evaluate(async target => window.codex.saveBookmark({ provider: target.provider, cwd: target.cwd, threadId: target.thread.id, itemId: target.itemId, turnId: target.turnId, threadName: target.thread.name, excerpt: target.snippet, label: 'Сохранённое решение' }), claude);
  assert.equal(saved.label, 'Сохранённое решение');
  assert.deepEqual(await page.evaluate(cwd => window.codex.listBookmarks({ cwd, provider: 'codex' }), project), []);
  await app.close(); app = undefined;
  await launch();
  const restored = await page.evaluate(cwd => window.codex.listBookmarks({ cwd, provider: 'claude' }), project);
  assert.deepEqual(restored, [saved]);
  await page.evaluate(async item => { await window.codex.saveBookmark({ ...item, label: 'Обновлённая подпись' }); }, saved);
  assert.equal((await page.evaluate(() => window.codex.listBookmarks()))[0].label, 'Обновлённая подпись');
  const missingProject = path.join(runDir, 'OUTSIDE_RENAMED');
  const missingBookmark = { ...saved, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', cwd: outside, itemId: 'another-source' };
  await writeFile(path.join(profile, 'bookmarks.json'), JSON.stringify({ version: 1, bookmarks: [saved, missingBookmark] }));
  assert.equal(path.dirname(outside), runDir); assert.equal(path.dirname(missingProject), runDir);
  await rename(outside, missingProject);
  try {
    await page.evaluate(async item => { await window.codex.saveBookmark({ ...item, label: 'Подпись после удаления папки' }); }, missingBookmark);
    assert.equal((await page.evaluate(() => window.codex.listBookmarks())).find(item => item.id === missingBookmark.id).label, 'Подпись после удаления папки');
  } finally { await rename(missingProject, outside); }
  await page.evaluate(id => window.codex.removeBookmark(id), missingBookmark.id);
  await page.evaluate(id => window.codex.removeBookmark(id), saved.id);
  assert.deepEqual(await page.evaluate(() => window.codex.listBookmarks()), []);
  const all = await logs();
  assert.ok(all.some(entry => entry.method === 'thread/items/list' && entry.params.cursor === 'older'));
  assert.equal(all.some(entry => ['turn/start', 'thread/resume', 'thread/start', 'thread/name/set', 'thread/archive', 'thread/delete', 'thread/unarchive', 'config/write', 'config/batchWrite'].includes(entry.method)), false);
  assert.equal(await readFile(transcriptFile, 'utf8'), transcript);
  assert.equal(await readFile(stateFile, 'utf8'), JSON.stringify(state));
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron/preload/IPC content history search for Codex pages + archive and native Claude SDK; hidden/abandoned content excluded, project scope, exact source IDs, bookmarks restart/edit/remove, no resume/model/history mutation. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`History host artifacts: ${runDir}`); throw error;
} finally { await app?.close(); }
