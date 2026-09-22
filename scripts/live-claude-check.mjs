// Explicit opt-in: this sends three REAL requests through the installed Claude CLI.
// No model/effort override, system prompt, credentials or global settings writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeClient } from '../electron/claude-client.mjs';
import { ClaudeHistory } from '../electron/claude-history.mjs';

if (!process.argv.includes('--run')) {
  console.log('Use node scripts/live-claude-check.mjs --run only with authorization for real model requests.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = await mkdtemp(path.join(root, 'artifacts', 'live-claude-check-'));
// Match WindowSession's canonical cwd: Windows TEMP may otherwise use an 8.3 alias.
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-desk-claude-live-')));
const target = path.join(cwd, 'smoke.txt');
await writeFile(target, 'OLD\n');
const executable = process.env.CLAUDE_EXE || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const report = { kind: 'real-model-smoke', startedAt: new Date().toISOString(), cwd, checks: {}, approvals: [], requestsSent: 0 };
const history = new ClaudeHistory();
let client, stage = 'boot', processExit, interruption;
let observedTextDeltas = 0;
const waiting = [];

function bounded(promise, label, ms = 90_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function watchTurn() {
  let listener;
  const promise = bounded(new Promise(resolve => {
    listener = event => { if (event.method === 'turn/completed') resolve(event.params.turn); };
    client.on('notification', listener);
  }), stage).finally(() => client.off('notification', listener));
  // A synchronous request error must not leave an unhandled timeout rejection.
  promise.catch(() => {});
  return promise;
}

function createClient() {
  const instance = new ClaudeClient({ executable, cwd, settings: { access: 'workspace-write' }, history, requestTimeoutMs: 30_000,
    spawnImpl(command, args, options) {
      // Process-local test policy, inherited user auth/model/effort/settings are retained.
      const child = spawn(command, [...args, '--tools', 'Read,Edit,Write', '--settings', JSON.stringify({
        permissions: { ask: ['Read', 'Edit', 'Write'], deny: ['mcp__*'] },
      })], options);
      processExit = new Promise(resolve => child.once('exit', resolve));
      return child;
    },
  });
  instance.on('notification', event => {
    if (event.method === 'item/agentMessage/delta') observedTextDeltas++;
    if (event.method === 'turn/completed') console.log(`${stage}: ${event.params.turn.status}`);
  });
  instance.on('serverRequest', request => {
    const task = (async () => {
      const raw = instance._session.requests.get(request.id);
      const input = raw?.input || {};
      const exactPath = typeof input.file_path === 'string' && path.resolve(cwd, input.file_path).toLowerCase() === target.toLowerCase();
      const allowedRead = raw?.tool_name === 'Read' && exactPath;
      const allowedEdit = raw?.tool_name === 'Edit' && exactPath && input.old_string === 'OLD' && input.new_string === 'NEW' && !input.replace_all;
      const allowedWrite = raw?.tool_name === 'Write' && exactPath && input.content === 'NEW\n';
      if (stage === 'interrupt' && exactPath && ['Edit', 'Write'].includes(raw?.tool_name)) {
        report.approvals.push({ stage, tool: raw.tool_name, decision: 'interrupt-without-approval', exactPath });
        interruption = instance.request('turn/interrupt', { threadId: request.params.threadId, turnId: request.params.turnId });
        await interruption;
        return;
      }
      const allow = (stage === 'edit' && (allowedRead || allowedEdit || allowedWrite)) || (stage === 'interrupt' && allowedRead);
      report.approvals.push({ stage, tool: raw?.tool_name || 'unknown', decision: allow ? 'accept' : 'decline', exactPath });
      await instance.respond(request.id, { decision: allow ? 'accept' : 'decline' });
    })();
    waiting.push(task); task.catch(() => {});
  });
  return instance;
}

async function send(threadId, text) {
  const finished = watchTurn();
  report.requestsSent++;
  await client.request('turn/start', { threadId, input: [{ type: 'text', text }] });
  return finished;
}

try {
  client = createClient();
  await client.start();
  report.settings = (await client.request('config/read')).config;
  const { thread } = await client.request('thread/start');
  report.threadId = thread.id;
  stage = 'edit';
  const first = await send(thread.id, `Это короткая проверка интеграции Claude Code. Работай только с файлом ${target}. Сначала прочитай его инструментом Read, затем инструментом Edit замени ровно OLD на NEW, сохрани перевод строки. Не используй другие инструменты, навыки, MCP, сеть или файлы. После успешного изменения ответь ровно CLAUDE_DESK_EDIT_OK. Запомни маркер контекста ORANGE-728.`);
  report.checks.editStatus = first.status;
  assert.equal(first.status, 'completed');
  assert.equal(await readFile(target, 'utf8'), 'NEW\n');
  assert.ok(first.items.some(item => item.type === 'agentMessage' && item.text.includes('CLAUDE_DESK_EDIT_OK')));
  assert.ok(report.approvals.some(item => item.stage === 'edit' && item.decision === 'accept' && ['Edit', 'Write'].includes(item.tool)));
  report.checks.fileChangedAfterApproval = true;
  report.checks.streaming = observedTextDeltas > 0;

  client.stop();
  await bounded(processExit, 'first process exit', 10_000);
  stage = 'history';
  const loaded = await history.read({ threadId: thread.id, cwd, includeTurns: true });
  assert.ok(loaded.thread.turns.flatMap(turn => turn.items).some(item => item.type === 'agentMessage' && item.text.includes('CLAUDE_DESK_EDIT_OK')));
  report.checks.nativeHistory = true;
  client = createClient();
  await client.start();
  await client.request('thread/resume', { threadId: thread.id });
  report.resumedSettings = (await client.request('config/read')).config;
  assert.deepEqual(report.resumedSettings, report.settings);
  stage = 'resume';
  const resumed = await send(thread.id, 'Не используй инструменты. Ответь только маркером контекста, который я просил запомнить в предыдущем запросе.');
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.items.some(item => item.type === 'agentMessage' && item.text.includes('ORANGE-728')));
  report.checks.resumedContext = true;

  stage = 'interrupt';
  const interrupted = await send(thread.id, `Проверка кнопки остановки. Прочитай только ${target} через Read, затем запроси Edit для замены NEW на CANCELLED. Среда остановит запрос в момент подтверждения: не повторяй операцию. Никаких других файлов, инструментов, сети или навыков.`);
  if (interruption) await interruption;
  assert.equal(interrupted.status, 'interrupted');
  assert.ok(report.approvals.some(item => item.decision === 'interrupt-without-approval'));
  assert.equal(await readFile(target, 'utf8'), 'NEW\n');
  report.checks.interruptPendingApproval = true;
  report.checks.unapprovedEditPrevented = true;
  await Promise.all(waiting);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failedStage = stage;
  // Keep diagnostics bounded and never persist CLI stderr/settings/account payloads.
  report.error = String(error.message).replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 1500);
  process.exitCode = 1;
} finally {
  client?.stop();
  if (processExit) await bounded(processExit, 'final process exit', 10_000).catch(() => {});
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failedStage: report.failedStage, error: report.error, report: path.join(output, 'result.json'), checks: report.checks }, null, 2));
}
