import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ClaudeHistory, claudeSessionId, claudeThreadId, claudeHistoryTurns, claudeHistoryUsage } from '../electron/claude-history.mjs';

const execFileAsync = promisify(execFile);
const firstId = '00000000-1111-4222-8333-000000000001';
const secondId = '00000000-1111-4222-8333-000000000002';
const thirdId = '00000000-1111-4222-8333-000000000003';
const cwd = path.resolve('fixture-project');
const otherCwd = path.resolve('other-fixture-project');
const info = (sessionId = firstId, extra = {}) => ({ sessionId, summary: 'Диалог', firstPrompt: 'Проверь файл', lastModified: 1_800_000_123_456, cwd, ...extra });
const frame = (type, uuid, content, extra = {}) => ({ type, uuid, session_id: firstId, parent_tool_use_id: null, message: { role: type, content }, ...extra });

test('history adapts public task updates and ignores other sessions and nested output', () => {
  const turns = claudeHistoryTurns([
    frame('user', 'user-1', 'Review'),
    { type: 'system', subtype: 'task_started', session_id: firstId, task_id: 't1', description: 'Review task', tool_use_id: 'agent-1' },
    { type: 'system', subtype: 'task_progress', session_id: firstId, task_id: 't1', summary: 'Reading files' },
    frame('assistant', 'nested', 'Private nested frame', { parent_tool_use_id: 'agent-1' }),
    { type: 'system', subtype: 'task_notification', session_id: secondId, task_id: 't1', status: 'failed', summary: 'Other session' },
    { type: 'system', subtype: 'task_notification', session_id: firstId, task_id: 't1', status: 'completed', summary: 'Review complete', output_file: '/result' },
  ], { cwd, sessionId: firstId });
  const tasks = turns.flatMap(turn => turn.items).filter(item => item.type === 'subAgentTask');
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].description, 'Review task'); assert.equal(tasks[0].result, 'Review complete');
  assert.equal(turns.flatMap(turn => turn.items).some(item => item.text === 'Private nested frame'), false);
});

test('copied fork timestamps never imply fresh model work; a later real answer restores timing', () => {
  const messages = [
    frame('user', 'copied-user', 'Original', { timestamp: '2026-09-19T10:00:00Z' }),
    frame('assistant', 'copied-answer', 'Copied answer', { timestamp: '2026-09-20T10:00:00Z' }),
    frame('user', 'new-user', 'Continue', { timestamp: '2026-09-20T11:00:00Z' }),
    frame('assistant', 'new-answer', 'New answer', { timestamp: '2026-09-20T11:00:01Z' }),
  ];
  const turns = claudeHistoryTurns(messages, { copiedMessageIds: new Set(['copied-user', 'copied-answer']) });
  assert.equal(turns[0].completedAt, undefined); assert.equal(turns[0].startedAt, undefined);
  assert.equal(turns[1].completedAt, Date.parse('2026-09-20T11:00:01Z') / 1000);
});

function fixture(overrides = {}) {
  const calls = [];
  let imports = 0;
  const sdk = {
    async listSessions(options) { calls.push(['list', options]); return [info()]; },
    async getSessionInfo(id, options) { calls.push(['info', id, options]); return info(id); },
    async getSessionMessages(id, options) { calls.push(['messages', id, options]); return []; },
    ...overrides,
  };
  const history = new ClaudeHistory({ sdk: async () => { imports++; return sdk; }, resolveDirectory: async value => path.normalize(value) });
  return { history, calls, imports: () => imports };
}

test('Claude history is lazy, project scoped, namespaced and paginated in seconds', async () => {
  const pages = [[info(firstId, { customTitle: 'Название' }), info(secondId), info(thirdId)], [info(thirdId)]];
  const calls = [];
  const { history, imports } = fixture({ async listSessions(options) { calls.push(options); return pages.shift(); } });
  assert.equal(imports(), 0);
  const first = await history.list({ cwd, limit: 2 });
  assert.equal(imports(), 1);
  assert.deepEqual(calls[0], { dir: cwd, limit: 3, offset: 0, includeWorktrees: false, includeProgrammatic: true });
  assert.equal(first.data[0].id, `claude:${firstId}`);
  assert.equal(first.data[0].name, 'Название');
  assert.equal(first.data[0].provider, 'claude');
  assert.equal(first.data[0].updatedAt, 1_800_000_123);
  assert.equal(first.data[0].historyMode, 'legacy');
  const second = await history.list({ cwd, limit: 2, cursor: first.nextCursor });
  assert.equal(calls[1].offset, 2);
  assert.equal(second.data.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(imports(), 1);
  await assert.rejects(history.list({ cwd: otherCwd, cursor: first.nextCursor }), /другой папке/);
  assert.equal(calls.length, 2);
});

test('Claude history rejects unscoped reads, invalid UUIDs and malformed cursors before SDK calls', async () => {
  const { history, calls } = fixture();
  for (const id of ['../../auth', 'codex:123', `claude:${firstId}/other`, '']) await assert.rejects(history.read({ cwd, threadId: id }), /идентификатор/);
  await assert.rejects(history.list(), /папку/);
  await assert.rejects(history.list({ cwd, cursor: '../../../file' }), /страница|страницы|страницы|папке/);
  await assert.rejects(history.list({ cwd, limit: 500 }), /размер/);
  assert.equal(calls.length, 0);
  assert.equal(claudeSessionId(`claude:${firstId.toUpperCase()}`), firstId);
  assert.equal(claudeThreadId(firstId), `claude:${firstId}`);
});

test('Claude history checks native session project before requesting transcript', async () => {
  const { history, calls } = fixture({ async getSessionInfo() { return info(firstId, { cwd: otherCwd }); } });
  await assert.rejects(history.read({ cwd, threadId: firstId }), /не найден/);
  assert.equal(calls.length, 0);
  const listing = fixture({ async listSessions() { return [info(), info(secondId, { cwd: otherCwd })]; } });
  assert.equal((await listing.history.list({ cwd })).data.length, 1);
});

test('Claude history supports metadata-only reads and rejects oversized histories before loading them', async () => {
  const { history, calls } = fixture({ async getSessionInfo() { return info(firstId, { fileSize: 129 * 1024 * 1024 }); } });
  const { thread } = await history.read({ cwd, threadId: firstId, includeTurns: false });
  assert.equal(thread.id, `claude:${firstId}`);
  assert.equal(thread.turns, undefined);
  await assert.rejects(history.read({ cwd, threadId: firstId }), /128 МиБ/);
  assert.equal(calls.length, 0);
});

test('Claude history retains text, images, public reasoning, commands, edits and results without system or encrypted content', async () => {
  const messages = [
    frame('system', 'system', 'SECRET_SYSTEM'),
    frame('user', 'hidden-meta', 'SECRET_META', { is_meta: true }),
    frame('user', 'user-one', [{ type: 'text', text: 'Исправь файл' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }]),
    frame('assistant', 'assistant-one', [
      { type: 'thinking', thinking: 'Проверяю доступный файл', signature: 'SECRET_SIGNATURE' },
      { type: 'redacted_thinking', data: 'SECRET_ENCRYPTED' },
      { type: 'text', text: 'Сначала посмотрю файл' },
      { type: 'tool_use', id: 'read-command', name: 'Bash', input: { command: 'cat file.txt' } },
    ], { message: { id: 'msg-api-one', role: 'assistant', content: [
      { type: 'thinking', thinking: 'Проверяю доступный файл', signature: 'SECRET_SIGNATURE' },
      { type: 'redacted_thinking', data: 'SECRET_ENCRYPTED' },
      { type: 'text', text: 'Сначала посмотрю файл' },
      { type: 'tool_use', id: 'read-command', name: 'Bash', input: { command: 'cat file.txt' } },
    ] } }),
    frame('user', 'result-one', [{ type: 'tool_result', tool_use_id: 'read-command', content: [{ type: 'text', text: 'old contents' }] }]),
    frame('assistant', 'edit-one', [{ type: 'tool_use', id: 'edit-tool', name: 'Edit', input: { file_path: '/project/file.txt', old_string: 'old', new_string: 'new' } }]),
    frame('user', 'result-two', [{ type: 'tool_result', tool_use_id: 'edit-tool', content: 'permission denied', is_error: true }]),
    frame('assistant', 'answer-one', [{ type: 'text', text: 'Нужен доступ' }]),
    frame('user', 'user-two', 'Теперь повтори'),
    frame('assistant', 'answer-two', [{ type: 'text', text: 'Готово' }]),
    frame('assistant', 'subagent', [{ type: 'text', text: 'SECRET_SUBAGENT' }], { parent_tool_use_id: 'other' }),
    frame('assistant', 'wrong-session', [{ type: 'text', text: 'SECRET_OTHER_PROJECT' }], { session_id: secondId }),
  ];
  const { history, calls } = fixture({ async getSessionMessages(id, options) { calls.push(['messages', id, options]); return messages; } });
  const { thread } = await history.read({ cwd, threadId: `claude:${firstId}` });
  assert.equal(thread.turns.length, 2);
  const items = thread.turns[0].items;
  assert.equal(items[0].content[1].url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(items.find(item => item.type === 'reasoning').summary[0], 'Проверяю доступный файл');
  assert.equal(items.find(item => item.type === 'commandExecution').aggregatedOutput, 'old contents');
  assert.equal(items.find(item => item.type === 'fileChange').status, 'failed');
  assert.equal(items.find(item => item.type === 'fileChange').changes[0].diff, '-old\n+new');
  assert.equal(items.find(item => item.text === 'Сначала посмотрю файл').phase, 'commentary');
  assert.equal(items.at(-1).phase, 'final_answer');
  assert.equal(items.at(-1).turnId, 'user-one');
  assert.equal(JSON.stringify(thread).includes('SECRET_'), false);
  assert.deepEqual(calls.at(-1), ['messages', firstId, { dir: cwd, includeSystemMessages: true, limit: 100_001 }]);
});

test('Claude history keeps assistant sibling blocks sharing message id and tool results do not create prompts', () => {
  const assistant = (uuid, content) => frame('assistant', uuid, content, { message: { id: 'shared-id', role: 'assistant', content } });
  const turns = claudeHistoryTurns([
    frame('user', 'prompt', 'Посмотри'),
    assistant('a1', [{ type: 'text', text: 'Первый фрагмент' }]),
    assistant('a2', [{ type: 'text', text: 'Второй фрагмент' }]),
    assistant('a3', [{ type: 'tool_use', id: 'tool-id', name: 'Read', input: { file_path: 'test.txt' } }]),
    frame('user', 'tool-result', [{ type: 'tool_result', tool_use_id: 'tool-id', content: 'result' }]),
  ], { cwd });
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items.filter(item => item.type === 'agentMessage').map(item => [item.text, item.phase]), [
    ['Первый фрагмент', 'commentary'], ['Второй фрагмент', 'commentary'],
  ]);
  assert.equal(new Set(turns[0].items.map(item => item.id)).size, 4);
  assert.equal(turns[0].items.at(-1).aggregatedOutput, 'result');
});

test('Claude history turns carry frame timestamps; a synthetic API error fails the turn without a completion time', () => {
  const at = (uuid, timestamp, type, content, extra = {}) => frame(type, uuid, content, { timestamp, ...extra, ...(extra.message ? { message: { ...extra.message, content } } : {}) });
  const usage = { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 20 };
  const turns = claudeHistoryTurns([
    at('prompt', '2026-09-20T10:00:00Z', 'user', 'Посмотри'),
    at('a1', '2026-09-20T10:00:05Z', 'assistant', [{ type: 'tool_use', id: 'tool-id', name: 'Read', input: { file_path: 'test.txt' } }], { message: { id: 'm1', role: 'assistant', usage, content: [] } }),
    at('tool-result', '2026-09-20T10:00:06Z', 'user', [{ type: 'tool_result', tool_use_id: 'tool-id', content: 'result' }]),
    at('a2', '2026-09-20T10:00:09.700Z', 'assistant', [{ type: 'text', text: 'Готово' }], { message: { id: 'm2', role: 'assistant', usage, content: [] } }),
    at('prompt2', '2026-09-20T11:00:00Z', 'user', 'Ещё'),
    at('err', '2026-09-20T11:00:01Z', 'assistant', [{ type: 'text', text: 'Failed to authenticate' }], { isApiErrorMessage: true, message: { id: 'syn', model: '<synthetic>', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } }),
    frame('user', 'prompt3', 'Без времени'),
    frame('assistant', 'a3', [{ type: 'text', text: 'Ответ без метки' }]),
  ], { cwd });
  assert.equal(turns.length, 3);
  assert.equal(turns[0].startedAt, Date.parse('2026-09-20T10:00:00Z') / 1000);
  assert.equal(turns[0].completedAt, Math.floor(Date.parse('2026-09-20T10:00:09.700Z') / 1000));
  assert.equal(turns[0].status, 'completed');
  assert.equal(turns[1].status, 'failed');
  assert.equal(turns[1].completedAt, undefined);
  assert.match(turns[1].error.message, /authenticate/);
  assert.equal(turns[2].startedAt, undefined);
  assert.equal(turns[2].completedAt, undefined, 'no timestamp is never replaced by now');
});

test('Claude history usage: last real call is the context proxy, totals count each API message once, synthetic frames are ignored', async () => {
  const call = (uuid, id, usage, extra = {}) => frame('assistant', uuid, [{ type: 'text', text: 'x' }], { message: { id, role: 'assistant', usage, content: [{ type: 'text', text: 'x' }] }, ...extra });
  const messages = [
    frame('user', 'prompt', 'Посмотри'),
    call('a1', 'm1', { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 20 }),
    call('a1b', 'm1', { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 20 }),
    call('a2', 'm2', { input_tokens: 5, cache_read_input_tokens: 4500, cache_creation_input_tokens: 0, output_tokens: 7 }),
    call('sub', 'm3', { input_tokens: 999, output_tokens: 999 }, { parent_tool_use_id: 'other' }),
    call('syn', 'm4', { input_tokens: 0, output_tokens: 0 }, { isApiErrorMessage: true }),
  ];
  const usage = claudeHistoryUsage(messages, { sessionId: firstId });
  assert.deepEqual(usage.last, { inputTokens: 4505, cachedInputTokens: 4500, cacheWriteInputTokens: 0, outputTokens: 7, totalTokens: 4512 });
  assert.equal(usage.total.totalTokens, 4530 + 4512);
  assert.deepEqual(usage.messageIds, ['m1', 'm2']);
  assert.equal(claudeHistoryUsage([frame('user', 'p', 'a'), frame('assistant', 'b', [{ type: 'text', text: 'x' }])]), null, 'no usage yields null, not zeros');
  const { history } = fixture({ async getSessionMessages() { return messages; } });
  const read = await history.read({ cwd, threadId: firstId });
  assert.equal(read.tokenUsage.last.inputTokens, 4505);
  assert.deepEqual(read.usageMessageIds, ['m1', 'm2']);
  const empty = fixture();
  assert.equal((await empty.history.read({ cwd, threadId: firstId })).tokenUsage, undefined);
});

test('Claude history official SDK reconstructs native branch and does not modify isolated files', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-claude-history-'));
  const fixtureRoot = await realpath(temporary);
  try {
    const project = path.join(fixtureRoot, 'project');
    const config = path.join(fixtureRoot, 'claude');
    await mkdir(project);
    const projectPath = await realpath(project);
    const transcriptFolder = path.join(config, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(transcriptFolder, { recursive: true });
    const native = (type, uuid, parentUuid, content, extra = {}) => ({
      type, uuid, parentUuid, sessionId: firstId, cwd: projectPath, timestamp: '2026-09-19T10:00:00Z',
      isSidechain: false, message: { role: type, ...(type === 'assistant' ? { id: `api-${uuid}`, stop_reason: 'end_turn' } : {}), content }, ...extra,
    });
    const transcript = [
      native('user', 'prompt', null, 'First visible prompt'),
      native('assistant', 'old-answer', 'prompt', [{ type: 'text', text: 'Abandoned branch' }]),
      native('assistant', 'answer', 'prompt', [{ type: 'text', text: 'Current answer' }]),
      native('user', 'followup', 'answer', 'Followup'),
      native('assistant', 'final', 'followup', [{ type: 'text', text: 'Final answer' }], { message: {
        role: 'assistant', id: 'api-final', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Final answer' }],
        usage: { input_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 8 },
      } }),
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
    const filename = path.join(transcriptFolder, `${firstId}.jsonl`);
    await writeFile(filename, transcript);
    await writeFile(path.join(transcriptFolder, `${secondId}.jsonl`), JSON.stringify(native('user', 'sidechain', null, 'Excluded', { sessionId: secondId, isSidechain: true })) + '\n');
    const beforeFiles = await readdir(transcriptFolder);
    const moduleUrl = new URL('../electron/claude-history.mjs', import.meta.url).href;
    const script = `import { ClaudeHistory } from ${JSON.stringify(moduleUrl)};
      const history = new ClaudeHistory();
      const result = await history.list({cwd:process.argv[1]});
      const read = await history.read({cwd:process.argv[1],threadId:process.argv[2]});
      const fork = await history.fork({cwd:process.argv[1],threadId:process.argv[2],title:'Fork timing regression'});
      const copied = await new ClaudeHistory().read({cwd:process.argv[1],threadId:fork.threadId});
      const reread = await new ClaudeHistory().read({cwd:process.argv[1],threadId:process.argv[2]});
      console.log(JSON.stringify({result,read,fork,copied,reread}));`;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, projectPath, firstId], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '' }, windowsHide: true, timeout: 15_000,
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.result.data.length, 1);
    assert.equal(parsed.result.data[0].id, `claude:${firstId}`);
    assert.equal(parsed.read.thread.turns.length, 2);
    const content = JSON.stringify(parsed.read.thread.turns);
    assert.equal(content.includes('Current answer'), true);
    assert.equal(content.includes('Final answer'), true);
    assert.equal(content.includes('Abandoned branch'), false);
    assert.equal(content.includes('Excluded'), false);
    const sourceTime = Date.parse('2026-09-19T10:00:00Z') / 1000;
    assert.ok(parsed.read.thread.turns.every(turn => turn.startedAt === sourceTime && turn.completedAt === sourceTime), 'ordinary SDK export must not silently suppress source timing');
    assert.equal(parsed.read.tokenUsage.last.inputTokens, 4512);
    assert.equal(parsed.read.tokenUsage.last.totalTokens, 4520);
    assert.equal(parsed.copied.thread.turns.length, 2);
    assert.ok(parsed.copied.thread.turns.every(turn => turn.startedAt === undefined && turn.completedAt === undefined), 'fresh reader identifies copied UUIDs through the real SDK export API');
    assert.equal(parsed.copied.tokenUsage.last.totalTokens, 4520, 'copied historical usage remains visible without implying fresh cache');
    assert.deepEqual(parsed.reread, parsed.read, 'reading the fork cannot alter source counters or timing');
    assert.equal(await readFile(filename, 'utf8'), transcript);
    const copiedFilename = `${parsed.fork.threadId.replace(/^claude:/, '')}.jsonl`;
    assert.deepEqual((await readdir(transcriptFolder)).sort(), [...beforeFiles, copiedFilename].sort());
  } finally {
    assert.equal(path.dirname(fixtureRoot), await realpath(os.tmpdir()));
    assert.equal(path.basename(fixtureRoot).startsWith('codex-desk-claude-history-'), true);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
