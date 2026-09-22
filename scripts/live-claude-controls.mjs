// Explicit opt-in real model check: steer during an approved Read, native compact, rename.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeClient } from '../electron/claude-client.mjs';
import { ClaudeHistory } from '../electron/claude-history.mjs';

if (!process.argv.includes('--run')) { console.log('Use --run with authorization for real model requests.'); process.exit(0); }
await mkdir('artifacts', { recursive: true });
const output = await mkdtemp(path.resolve('artifacts/live-claude-controls-'));
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-desk-claude-controls-')));
const file = path.join(cwd, 'marker.txt');
await writeFile(file, 'ORANGE-728\n');
const report = { startedAt: new Date().toISOString(), kind: 'real-model-controls', cwd, requestsSent: 0, modelTurns: 0, checks: {} };
const history = new ClaudeHistory();
let stage = 'boot', childExit, thread, steerSent = false, approvalError;
const completed = [], waiters = [];
const client = new ClaudeClient({ cwd, executable: process.env.CLAUDE_EXE || path.join(os.homedir(), '.local/bin/claude.exe'), settings: { access: 'workspace-write' }, history, requestTimeoutMs: 30_000,
  spawnImpl(command, args, options) {
    const child = spawn(command, [...args, '--tools', 'Read', '--settings', JSON.stringify({ permissions: { ask: ['Read'], deny: ['mcp__*'] } })], options);
    childExit = new Promise(resolve => child.once('exit', resolve));
    return child;
  },
});
function bounded(promise, label, ms = 120_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms); })]).finally(() => clearTimeout(timer));
}
client.on('notification', event => {
  if (event.method === 'turn/completed') { completed.push(event.params.turn); waiters.splice(0).forEach(resolve => resolve()); console.log(`${stage}: ${event.params.turn.status}`); }
  if (event.method === 'item/completed' && event.params.item.type === 'contextCompaction') report.checks.compactBoundary = true;
  if (event.method === 'item/completed' && event.params.item.type === 'agentMessage') report.modelTurns++;
});
client.on('serverRequest', request => {
  void (async () => {
    const raw = client._session.requests.get(request.id);
    const allow = raw?.tool_name === 'Read' && path.resolve(raw.input.file_path).toLowerCase() === file.toLowerCase();
    if (allow && !steerSent) {
      steerSent = true;
      report.requestsSent++;
      const id = randomUUID(); report.steerMessageId = id;
      const accepted = await client.request('turn/steer', { threadId: thread.id, expectedTurnId: request.params.turnId, clientUserMessageId: id,
        input: [{ type: 'text', text: 'Уточнение: запомни второй маркер BLUE-419. После чтения ответь ровно STEER_OK ORANGE-728 BLUE-419.' }] });
      assert.equal(accepted.userMessageId, id);
      report.checks.steerAccepted = true;
    }
    await client.respond(request.id, { decision: allow ? 'accept' : 'decline' });
  })().catch(error => { approvalError = error; });
});
async function finishAfter(index) {
  while (completed.length <= index) await bounded(new Promise(resolve => waiters.push(resolve)), stage);
  if (approvalError) throw approvalError;
  const turn = completed[index]; assert.equal(turn.status, 'completed', turn.error?.message); return turn;
}
try {
  await client.start(); report.settings = (await client.request('config/read')).config;
  thread = (await client.request('thread/start')).thread; report.threadId = thread.id;
  stage = 'steer'; report.requestsSent++;
  await client.request('turn/start', { threadId: thread.id, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: `Проверка интеграции. Прочитай только ${file} инструментом Read. На подтверждении чтения придёт уточнение: обязательно выполни его после чтения. Никаких других файлов, инструментов, сети или навыков. Запомни маркер из файла для следующих сообщений.` }] });
  const steered = await finishAfter(0);
  assert.ok(report.checks.steerAccepted);
  assert.ok(steered.items.some(item => item.type === 'agentMessage' && item.text.includes('STEER_OK') && item.text.includes('BLUE-419')));
  assert.ok(steered.items.some(item => item.type === 'userMessage' && item.id === report.steerMessageId));
  report.checks.steerApplied = true;
  stage = 'rename';
  const title = `Codex Desk controls ${path.basename(cwd)}`;
  await client.request('thread/name/set', { threadId: thread.id, name: title });
  assert.equal((await client.request('thread/read', { threadId: thread.id })).thread.name, title);
  report.checks.renameLive = true;
  stage = 'compact'; report.requestsSent++;
  const index = completed.length;
  await client.request('thread/compact/start', { threadId: thread.id });
  await finishAfter(index); assert.ok(report.checks.compactBoundary);
  stage = 'after-compact'; report.requestsSent++;
  const afterIndex = completed.length;
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Не используй инструменты. Ответь только двумя маркерами контекста, которые я просил запомнить ранее.' }] });
  const after = await finishAfter(afterIndex);
  assert.ok(after.items.some(item => item.type === 'agentMessage' && item.text.includes('ORANGE-728') && item.text.includes('BLUE-419')));
  report.checks.contextAfterCompact = true;
  assert.deepEqual((await client.request('config/read')).config, report.settings); report.checks.settingsPreserved = true;
  client.stop(); await bounded(childExit, 'process exit', 10_000);
  stage = 'native-history';
  const stored = await history.read({ threadId: thread.id, cwd, includeTurns: true });
  assert.equal(stored.thread.name, title); report.checks.renamePersisted = true;
  assert.ok(stored.thread.turns.some(turn => turn.items.some(item => item.id === report.steerMessageId)));
  report.checks.steerIdPersisted = true;
  report.passed = true;
} catch (error) {
  report.passed = false; report.failedStage = stage; report.error = String(error.message).replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 1500); process.exitCode = 1;
} finally {
  client.stop(); if (childExit) await bounded(childExit, 'exit', 10_000).catch(() => {});
  report.completedAt = new Date().toISOString(); await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, report: path.join(output, 'result.json') }, null, 2));
}
