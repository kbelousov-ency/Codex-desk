import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeClient, normalizeUsage } from '../electron/claude-client.mjs';

const nativeId = 'aaaaaaaa-1111-2222-3333-444444444444';
const model = { value: 'sonnet', resolvedModel: 'claude-sonnet-test', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] };
const usageSample = { session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 37.4, resets_at: '2030-01-01T10:00:00Z' }, seven_day: { utilization: 12, resets_at: '2030-01-05T00:00:00Z' }, seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: null }] } };
const mcpSample = { mcpServers: [{ name: 'plane', status: 'connected', scope: 'user' }, { name: 'atlassian', status: 'failed', error: 'Version negotiation probe timed out; token sk-abcdefghijklmnop123' }], error_count: 1 };
function harness({ onFrame, initialize = true, requestTimeoutMs = 300, slowExit = false, usageAnswer = usageSample, mcpAnswer = mcpSample, ...options } = {}) {
  const children = [], spawns = [], frames = [], events = [], requests = [];
  const client = new ClaudeClient({ executable: 'claude.exe', cwd: process.cwd(), requestTimeoutMs, ...options,
    spawnImpl(executable, args, spawnOptions) {
      spawns.push({ executable, args, options: spawnOptions });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killed = false; child.kill = () => { if (!child.killed) { child.killed = true; if (slowExit) setTimeout(() => child.emit('exit', null, 'SIGTERM'), 30); else child.emit('exit', null, 'SIGTERM'); } return true; };
      child.send = frame => child.stdout.write(`${JSON.stringify(frame)}\n`);
      let selected = model.resolvedModel, effort = 'medium';
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        const frame = JSON.parse(chunk.toString()); frames.push(frame);
        if (onFrame?.(frame, child) === false) { callback(); return; }
        if (frame.type === 'control_request') {
          const request = frame.request;
          let response = {};
          if (request.subtype === 'initialize') {
            if (!initialize) { callback(); return; }
            response = { models: [model], account: { email: 'user@example.test', subscriptionType: 'Test', tokenSource: 'secret' }, current_permission_mode: 'default',
              commands: [{ name: 'compact', description: 'Compact', argumentHint: '', builtin: true }, { name: 'ency-extension', description: 'Build ENCY extensions', argumentHint: '', builtin: false }], agents: [{ name: 'Explore', description: 'Read-only search' }] };
          }
          if (request.subtype === 'set_model') selected = request.model;
          if (request.subtype === 'apply_flag_settings') effort = request.settings.effortLevel;
          if (request.subtype === 'get_settings') response = { effective: { env: { API_KEY: 'DO NOT EXPORT' } }, sources: [], applied: { model: selected, effort } };
          if (request.subtype === 'get_binary_version') response = { version: '2.1.278' };
          if (request.subtype === 'mcp_status') { if (mcpAnswer === 'error') { child.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'nope' } }); callback(); return; } response = mcpAnswer; }
          if (request.subtype === 'get_usage') { if (usageAnswer === 'error') { child.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unknown request subtype' } }); callback(); return; } response = usageAnswer; }
          child.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        }
        callback();
      } });
      children.push(child); return child;
    },
  });
  client.on('notification', e => events.push(structuredClone(e))); client.on('serverRequest', e => requests.push(e));
  return { client, frames, spawns, children, events, requests, get child() { return children.at(-1); } };
}
async function running(t, options) {
  const h = harness(options); t.after(() => h.client.stop()); await h.client.start();
  h.thread = (await h.client.request('thread/start')).thread;
  h.turn = (await h.client.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'Привет' }] })).turn;
  return h;
}
const result = (id, extra = {}) => ({ type: 'result', subtype: 'success', user_message_uuid: id, is_error: false, usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 7 }, ...extra });

test('Claude boot is shared, uses local streaming CLI, preserves native prompt/settings and sends no model turn', async t => {
  const h = harness(); t.after(() => h.client.stop());
  const p = h.client.start(); assert.equal(h.client.start(), p);
  const boot = await p;
  assert.equal(boot.provider, 'claude'); assert.equal(boot.capabilities.steer, true); assert.equal(boot.capabilities.compact, true); assert.equal(boot.capabilities.archive, false);
  assert.deepEqual(h.frames.map(f => f.request?.subtype), ['initialize', 'get_settings', 'get_binary_version']);
  assert.equal(boot.version, '2.1.278');
  assert.deepEqual(h.frames[0].request, { subtype: 'initialize' });
  const { args, options } = h.spawns[0];
  assert.ok(args.includes('--permission-prompt-tool')); assert.ok(args.includes('stdio')); assert.ok(args.includes('--permission-prompts'));
  assert.ok(!args.some(v => /system-prompt|bare|setting-sources|dangerously/.test(v)));
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.env, undefined);
  assert.equal((await h.client.request('model/list')).data[0].model, model.resolvedModel);
  assert.deepEqual((await h.client.request('config/read')).config, { model: model.resolvedModel, model_reasoning_effort: 'medium' });
  assert.ok(!JSON.stringify(await h.client.request('config/read')).includes('DO NOT EXPORT'));
  assert.ok(!JSON.stringify(await h.client.request('account/read')).includes('secret'));
});

test('model and effort are applied only to session via control requests before user send', async t => {
  const h = harness(); t.after(() => h.client.stop()); await h.client.start();
  const { thread } = await h.client.request('thread/start');
  await h.client.request('turn/start', { threadId: thread.id, model: 'sonnet', effort: 'high', input: [{ type: 'text', text: 'Hello' }], sandboxPolicy: { type: 'workspaceWrite' }, approvalsReviewer: 'auto_review' });
  const requests = h.frames.filter(f => f.type === 'control_request').map(f => f.request);
  assert.ok(requests.some(r => r.subtype === 'set_model' && r.model === 'sonnet'));
  assert.ok(requests.some(r => r.subtype === 'apply_flag_settings' && r.settings.effortLevel === 'high'));
  assert.ok(requests.some(r => r.subtype === 'set_permission_mode' && r.mode === 'acceptEdits'));
  assert.equal(h.frames.at(-1).type, 'user'); assert.equal(h.frames.at(-1).message.content[0].text, 'Hello');
  assert.equal(h.spawns.length, 1);
});

test('streamed UTF-8, final message and tool results normalize without duplicate final text', async t => {
  const h = await running(t);
  const events = [
    { type: 'message_start', message: { id: 'msg-1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Проверяю' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Привет 👋' } },
  ];
  for (const event of events) {
    const bytes = Buffer.from(JSON.stringify({ type: 'stream_event', event }) + '\r\n');
    for (let i = 0; i < bytes.length; i++) h.child.stdout.write(bytes.subarray(i, i + 1));
  }
  const assistant = { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'thinking', thinking: 'Проверяю' }, { type: 'text', text: 'Привет 👋' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] } };
  h.child.send(assistant); h.child.send(assistant);
  h.child.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'clean' }] } });
  h.child.send(result(h.turn.id));
  const { thread } = await h.client.request('thread/read', { threadId: h.thread.id });
  const items = thread.turns[0].items;
  assert.equal(items.filter(i => i.type === 'agentMessage').length, 1);
  assert.equal(items.find(i => i.type === 'agentMessage').text, 'Привет 👋');
  assert.equal(items.find(i => i.type === 'reasoning').content[0], 'Проверяю');
  assert.equal(items.find(i => i.id === 'tool-1').aggregatedOutput, 'clean');
  assert.equal(items.find(i => i.type === 'userMessage').content[0].text, 'Привет');
  assert.equal(thread.turns[0].status, 'completed');
  const usage = h.events.find(e => e.method === 'thread/tokenUsage/updated').params.tokenUsage;
  assert.equal(usage.last.inputTokens, 18); assert.equal(usage.last.totalTokens, 25);
  assert.equal(usage.last.reasoningOutputTokens, undefined);
});

test('permissions require explicit one-shot approval, cancellation prevents stale answer, unknown controls fail closed', async t => {
  const h = await running(t);
  const req = { type: 'control_request', request_id: 'allow-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'bash-1', input: { command: 'git status' } } };
  h.child.send(req); h.child.send(req);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'item/commandExecution/requestApproval');
  await h.client.respond('allow-1', { decision: 'accept' });
  const response = h.frames.at(-1).response.response;
  assert.equal(response.behavior, 'allow'); assert.deepEqual(response.updatedInput, req.request.input);
  assert.equal(response.updatedPermissions, undefined);
  await assert.rejects(h.client.respond('allow-1', { decision: 'accept' }), /завершён/);
  h.child.send({ ...req, request_id: 'cancel-1' });
  h.child.send({ type: 'control_cancel_request', request_id: 'cancel-1' });
  await assert.rejects(h.client.respond('cancel-1', { decision: 'accept' }), /завершён/);
  h.child.send({ type: 'control_request', request_id: 'unsupported', request: { subtype: 'unknown' } });
  assert.equal(h.frames.at(-1).response.subtype, 'error');
});

test('AskUserQuestion translates choices and answer back into original tool input', async t => {
  const h = await running(t);
  h.child.send({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', requires_user_interaction: true,
    input: { questions: [{ header: 'Цвет', question: 'Какой цвет?', options: [{ label: 'Синий', description: 'Тёмный' }] }] } } });
  assert.equal(h.requests[0].params.questions[0].id, 'q0');
  await h.client.respond('question', { answers: { q0: { answers: ['Синий'] } } });
  assert.deepEqual(h.frames.at(-1).response.response.updatedInput.answers, { 'Какой цвет?': 'Синий' });
});

test('unsafe interaction approvals are denied rather than converted to a yes/no tool execution', async t => {
  const h = await running(t);
  h.child.send({ type: 'control_request', request_id: 'dialog', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 'exit', requires_user_interaction: true, input: {} } });
  assert.equal(h.requests.length, 0); assert.equal(h.frames.at(-1).response.response.behavior, 'deny');
});

test('stop interrupts the live turn through control without another prompt; a steer for another turn is rejected', async t => {
  const h = await running(t);
  await assert.rejects(h.client.request('turn/steer', { threadId: h.thread.id, expectedTurnId: 'other-turn', input: [{ type: 'text', text: 'more' }] }), /уже завершилась/);
  await h.client.request('turn/interrupt', { threadId: h.thread.id, turnId: h.turn.id });
  assert.equal(h.frames.at(-1).request.subtype, 'interrupt'); assert.equal(h.frames.at(-1).request.cancel_queued, true);
  h.child.send(result(h.turn.id, { is_error: true, result: 'interrupted' }));
  const stopped = h.events.find(e => e.method === 'turn/completed').params.turn;
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.error, undefined);
  assert.equal(h.frames.filter(f => f.type === 'user').length, 1);
});

for (const resultBeforeReceipt of [false, true]) test(`stop during a tool call clears approval without a CLI diagnostic error; result before receipt: ${resultBeforeReceipt}`, async t => {
  const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
  const h = await running(t, { onFrame(frame, child) {
    if (resultBeforeReceipt && frame.request?.subtype === 'interrupt') {
      child.send(result(h.turn.id, { subtype: 'error_during_execution', is_error: true, errors: [diagnostic], stop_reason: 'tool_use' }));
    }
  } });
  h.child.send({ type: 'control_request', request_id: 'stop-approval', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'stopped-tool', input: { command: 'git status' },
  } });
  await h.client.request('turn/interrupt', { threadId: h.thread.id, turnId: h.turn.id });
  if (!resultBeforeReceipt) h.child.send(result(h.turn.id, { subtype: 'error_during_execution', is_error: true, errors: [diagnostic], stop_reason: 'tool_use' }));
  const completed = h.events.filter(e => e.method === 'turn/completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].params.turn.status, 'interrupted');
  assert.equal(completed[0].params.turn.error, undefined);
  assert.ok(h.events.some(e => e.method === 'serverRequest/resolved' && e.params.requestId === 'stop-approval'));
  await assert.rejects(h.client.respond('stop-approval', { decision: 'accept' }), /завершён/);
  assert.equal(h.client.state, 'ready'); assert.equal(h.child.killed, false);
  assert.equal(h.frames.filter(f => f.type === 'user').length, 1);
  const { thread } = await h.client.request('thread/read', { threadId: h.thread.id });
  assert.equal(thread.status.type, 'idle'); assert.equal(thread.turns[0].error, undefined);
  const next = await h.client.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'Продолжить' }] });
  h.child.send(result(next.turn.id));
  assert.equal(h.events.filter(e => e.method === 'turn/completed').at(-1).params.turn.status, 'completed');
});

test('an execution error without Stop remains visible', async t => {
  const h = await running(t);
  const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
  h.child.send(result(h.turn.id, { subtype: 'error_during_execution', is_error: true, errors: [diagnostic] }));
  const failed = h.events.find(e => e.method === 'turn/completed').params.turn;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.message, diagnostic);
});

test('a rejected interrupt does not suppress the subsequent execution error', async t => {
  const h = await running(t, { onFrame(frame, child) {
    if (frame.request?.subtype !== 'interrupt') return;
    child.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Interrupt rejected' } });
    return false;
  } });
  await assert.rejects(h.client.request('turn/interrupt', { threadId: h.thread.id, turnId: h.turn.id }), /Interrupt rejected/);
  h.child.send(result(h.turn.id, { subtype: 'error_during_execution', is_error: true, errors: ['Execution failed'] }));
  const failed = h.events.find(e => e.method === 'turn/completed').params.turn;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.message, 'Execution failed');
});

test('two user sends cannot interleave while image/config resolution is pending', async t => {
  const h = harness(); t.after(() => h.client.stop()); await h.client.start(); const { thread } = await h.client.request('thread/start');
  const params = { threadId: thread.id, input: [{ type: 'text', text: 'One' }] };
  const first = h.client.request('turn/start', params);
  await assert.rejects(h.client.request('turn/start', params), /завершения/);
  await first; assert.equal(h.frames.filter(f => f.type === 'user').length, 1);
});

test('only images under the attachment root can become base64 inputs; mixed invalid input sends nothing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = path.join(directory, 'image.png'); await writeFile(image, Buffer.from([137, 80, 78, 71]));
  const h = harness({ attachmentsDirectory: directory }); t.after(() => h.client.stop()); await h.client.start(); const { thread } = await h.client.request('thread/start');
  await assert.rejects(h.client.request('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: path.resolve('package.json') }] }), /изображение/);
  await assert.rejects(h.client.request('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: image }, { type: 'unsupported' }] }), /вложения/);
  assert.equal(h.frames.filter(f => f.type === 'user').length, 0);
  await h.client.request('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: image }] });
  assert.equal(h.frames.at(-1).message.content[0].source.media_type, 'image/png');
});

test('native resume uses UUID only, preserves transcript, and rejects cross-provider/cross-project IDs', async t => {
  const history = { async read({ threadId, cwd }) { return { thread: { id: threadId, cwd, turns: [{ id: 'old', status: 'completed', items: [] }] } }; } };
  const h = harness({ history }); t.after(() => h.client.stop()); await h.client.start();
  const { thread } = await h.client.request('thread/resume', { threadId: `claude:${nativeId}` });
  assert.equal(thread.turns[0].id, 'old'); assert.ok(h.children[0].killed);
  assert.equal(h.spawns.at(-1).args[h.spawns.at(-1).args.indexOf('--resume') + 1], nativeId);
  assert.equal(h.frames.filter(f => f.type === 'user').length, 0);
  await assert.rejects(h.client.request('thread/resume', { threadId: nativeId }), /идентификатор/);
  await assert.rejects(h.client.request('thread/read', { threadId: thread.id, cwd: path.dirname(process.cwd()) }), /папке/);
});

test('resume returns the transcript token snapshot and seeds session totals without a model call', async t => {
  const last = { inputTokens: 4505, cachedInputTokens: 4500, cacheWriteInputTokens: 0, outputTokens: 7, totalTokens: 4512 };
  const total = { inputTokens: 9015, cachedInputTokens: 8500, cacheWriteInputTokens: 500, outputTokens: 27, totalTokens: 9042, reasoningOutputTokens: undefined };
  const history = { async read({ threadId, cwd }) { return { thread: { id: threadId, cwd, turns: [{ id: 'old', status: 'completed', items: [], completedAt: 1_700_000_000 }] }, tokenUsage: { last, total }, usageMessageIds: ['m1', 'm2'] }; } };
  const h = harness({ history }); t.after(() => h.client.stop()); await h.client.start();
  const resumed = await h.client.request('thread/resume', { threadId: `claude:${nativeId}` });
  assert.deepEqual(resumed.tokenUsage, { last, total, modelContextWindow: undefined });
  assert.equal(resumed.thread.turns[0].completedAt, 1_700_000_000);
  assert.equal(h.events.filter(e => e.method === 'thread/tokenUsage/updated').length, 0, 'the snapshot is a response field, not a live event');
  assert.equal(h.frames.filter(f => f.type === 'user').length, 0);
  const turn = (await h.client.request('turn/start', { threadId: resumed.thread.id, input: [{ type: 'text', text: 'ещё' }] })).turn;
  h.child.send({ type: 'assistant', uuid: 'a3', session_id: nativeId, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'дубль' }], usage: { input_tokens: 5, cache_read_input_tokens: 4500, cache_creation_input_tokens: 0, output_tokens: 7 } } });
  h.child.send({ type: 'assistant', uuid: 'a4', session_id: nativeId, message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 5 } } });
  const next = h.events.filter(e => e.method === 'thread/tokenUsage/updated').at(-1).params;
  assert.equal(next.turnId, turn.id);
  assert.equal(next.tokenUsage.total.totalTokens, 9042 + 9015, 'restored totals continue; a message id already counted in history is not added twice');
  assert.equal(next.tokenUsage.last.inputTokens, 9010);
  h.child.send(result(turn.id));
  const again = await h.client.request('thread/resume', { threadId: resumed.thread.id });
  assert.equal(again.tokenUsage, undefined, 'a same-thread resume has no stale snapshot');
});

test('full access requires explicit process flag and restart; ordinary boot never enables bypass', async t => {
  const h = harness(); t.after(() => h.client.stop()); await h.client.start();
  assert.ok(!h.spawns[0].args.includes('--allow-dangerously-skip-permissions'));
  await h.client.request('thread/start', { sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.equal(h.spawns.length, 2); assert.ok(h.children[0].killed);
  assert.ok(h.spawns[1].args.includes('--allow-dangerously-skip-permissions'));
  assert.equal(h.frames.filter(f => f.type === 'user').length, 0);
});

test('malformed output and stderr never expose secrets, crashed process rejects active turn and ignores late data', async t => {
  const h = await running(t); const diagnostics = []; h.client.on('diagnostic', e => diagnostics.push(e));
  h.child.stderr.write('authorization: Bearer secret\n'); h.child.stdout.write('{secret broken json}\n');
  assert.ok(!diagnostics.join('').includes('secret'));
  const old = h.child; old.emit('exit', 7, null);
  assert.equal(h.events.find(e => e.method === 'turn/completed').params.turn.status, 'failed');
  await h.client.start(); old.send(result(h.turn.id)); old.emit('error', new Error('late'));
  assert.equal(h.client.state, 'ready');
});

test('stop during initialization rejects and kills only its process', async () => {
  const h = harness({ initialize: false }); const p = h.client.start(); await Promise.resolve(); h.client.stop();
  await assert.rejects(p, /остановлен/); assert.ok(h.child.killed);
});

test('initialization timeout fails clearly and terminates owned process', async () => {
  const h = harness({ initialize: false, requestTimeoutMs: 20 });
  await assert.rejects(h.client.start(), /не ответил: initialize/); assert.ok(h.child.killed); assert.equal(h.client.state, 'error');
});

test('stopAndWait after stop waits for every owned native process, not only the latest transport', async () => {
  const h = harness(); await h.client.start();
  const first = h.child; first.kill = () => { first.killed = true; return true; };
  h.client.stop(); await h.client.start();
  const second = h.child; second.kill = () => { second.killed = true; return true; };
  h.client.stop();
  let settled = false;
  const waiting = h.client.stopAndWait(300).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  second.emit('exit', 0, null);
  await Promise.resolve(); assert.equal(settled, false, 'an older transport still owns its exiting process');
  first.emit('exit', 0, null);
  await waiting;
  assert.equal(settled, true); assert.equal(h.client.state, 'stopped');
  assert.equal(h.frames.some(frame => frame.type === 'user'), false, 'shutdown sends no model prompts');
  await h.client.stopAndWait(20);
});

test('stopAndWait cancels a pending relaunch and waits for the old process to exit', async () => {
  const h = harness(); await h.client.start(); await h.client.request('thread/start');
  const old = h.child; old.kill = () => { old.killed = true; return true; };
  const restart = h.client.request('thread/start');
  const cancelled = assert.rejects(restart, /Переподключение Claude остановлено/);
  assert.equal(old.killed, true);
  const waiting = h.client.stopAndWait(300);
  old.emit('exit', 0, null);
  await Promise.all([waiting, cancelled]);
  assert.equal(h.spawns.length, 1, 'no replacement process starts after stop');
});

test('stopAndWait has a bounded failure, cleans listeners and can retry after actual exit', async () => {
  const h = harness(); await h.client.start();
  const child = h.child; child.kill = () => { child.killed = true; return true; };
  const exitListeners = child.listenerCount('exit'), closeListeners = child.listenerCount('close');
  await assert.rejects(h.client.stopAndWait(20), /Claude CLI ещё завершает процесс/);
  assert.equal(child.listenerCount('exit'), exitListeners);
  assert.equal(child.listenerCount('close'), closeListeners);
  child.emit('exit', 0, null);
  await h.client.stopAndWait(20);
  await assert.rejects(h.client.stopAndWait(0), /timeoutMs must be positive/);
});

test('stopAndWait handles synchronous exit and a failed spawn ending in close', async () => {
  const synchronous = harness(); await synchronous.client.start(); await synchronous.client.stopAndWait(20);
  assert.equal(synchronous.child.killed, true);
  const failed = harness({ initialize: false });
  const starting = assert.rejects(failed.client.start(), /spawn failed/);
  await Promise.resolve();
  failed.child.kill = () => false;
  failed.child.emit('error', new Error('spawn failed'));
  await starting;
  const waiting = failed.client.stopAndWait(300);
  failed.child.emit('close', -1, null);
  await waiting;
});

test('assistant sibling frames sharing API message id keep text and tool blocks', async t => {
  const h = await running(t);
  h.child.send({ type: 'assistant', uuid: 'record-1', message: { id: 'shared', content: [{ type: 'text', text: 'Сейчас проверю' }] } });
  h.child.send({ type: 'assistant', uuid: 'record-2', message: { id: 'shared', content: [{ type: 'tool_use', id: 'tool-sibling', name: 'Read', input: { file_path: 'test.txt' } }] } });
  h.child.send({ type: 'assistant', uuid: 'record-3', message: { id: 'shared', content: [{ type: 'text', text: 'Продолжаю' }] } });
  h.child.send(result(h.turn.id));
  const { thread } = await h.client.request('thread/read', { threadId: h.thread.id });
  const items = thread.turns[0].items;
  assert.ok(items.some(i => i.id === 'tool-sibling'));
  assert.deepEqual(items.filter(i => i.type === 'agentMessage').map(i => i.text), ['Сейчас проверю', 'Продолжаю']);
  assert.equal(items.find(i => i.text === 'Сейчас проверю').phase, 'commentary');
});

test('single-block assistant records replace their streamed global block index', async t => {
  const h = await running(t);
  h.child.send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'with-thinking' } } });
  h.child.send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  h.child.send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ответ' } } });
  h.child.send({ type: 'assistant', uuid: 'one-block', message: { id: 'with-thinking', content: [{ type: 'text', text: 'Ответ' }] } });
  h.child.send(result(h.turn.id));
  const { thread } = await h.client.request('thread/read', { threadId: h.thread.id });
  assert.equal(thread.turns[0].items.filter(i => i.type === 'agentMessage').length, 1);
});

test('real subprocess JSONL carries image input, permission decision and a subsequent turn', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-wire-'));
  const image = path.join(directory, 'input.png'); await writeFile(image, Buffer.from([137, 80, 78, 71]));
  let child, closed;
  const client = new ClaudeClient({ executable: 'fixture', cwd: directory, attachmentsDirectory: directory, requestTimeoutMs: 3000,
    spawnImpl(executable, args, options) { child = spawn(process.execPath, [path.resolve('tests/fixtures/claude-stream.mjs')], options); closed = new Promise(resolve => child.once('exit', resolve)); return child; },
  });
  t.after(async () => { client.stop(); await closed; await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const events = [], approvals = []; client.on('notification', e => events.push(e));
  client.on('serverRequest', e => { approvals.push(e); void client.respond(e.id, { decision: 'accept' }); });
  await client.start(); const { thread } = await client.request('thread/start');
  const complete = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('notification', listener); reject(new Error('fixture turn timeout')); }, 3000);
    const listener = e => { if (e.method !== 'turn/completed') return; clearTimeout(timer); client.off('notification', listener); resolve(e.params.turn); };
    client.on('notification', listener);
  });
  let finished = complete();
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Первый' }, { type: 'localImage', path: image }] });
  const first = await finished;
  assert.equal(first.status, 'completed'); assert.equal(approvals.length, 1);
  assert.ok(first.items.some(i => i.text === 'Изображение получено'));
  assert.ok(first.items.some(i => i.type === 'commandExecution' && i.aggregatedOutput === 'Разрешено'));
  finished = complete();
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Второй' }] });
  const second = await finished;
  assert.equal(second.status, 'completed'); assert.notEqual(first.id, second.id);
  assert.ok(second.items.some(i => i.text === 'Следующий запрос получен'));
  assert.equal(events.filter(e => e.method === 'turn/completed').length, 2);
});

const steerId = 'bbbbbbbb-1111-2222-3333-444444444444';
test('steer writes a mid-turn user frame with the client uuid, shows it once, and the folded result completes one turn', async t => {
  const h = await running(t);
  const before = h.frames.length;
  const reply = await h.client.request('turn/steer', { threadId: h.thread.id, expectedTurnId: h.turn.id, clientUserMessageId: steerId, input: [{ type: 'text', text: 'и ещё тесты' }] });
  assert.deepEqual(reply, { turnId: h.turn.id, userMessageId: steerId });
  const written = h.frames.slice(before);
  assert.equal(written.length, 1, 'exactly one user frame, no control request or restart');
  assert.equal(written[0].type, 'user'); assert.equal(written[0].uuid, steerId); assert.equal(written[0].message.content[0].text, 'и ещё тесты');
  assert.equal(h.spawns.length, 1, 'steer never respawns the CLI');
  const shown = h.events.filter(e => e.method === 'item/completed' && e.params.item.id === steerId);
  assert.equal(shown.length, 1); assert.equal(shown[0].params.turnId, h.turn.id); assert.deepEqual(shown[0].params.item.content, [{ type: 'text', text: 'и ещё тесты' }]);
  h.child.send({ type: 'user', uuid: steerId, session_id: h.thread.id.slice(7), message: { role: 'user', content: [{ type: 'text', text: 'и ещё тесты' }] } });
  assert.equal(h.events.filter(e => e.method === 'item/completed' && e.params.item.id === steerId).length, 1, 'the CLI echo does not duplicate the shown steer');
  await assert.rejects(h.client.request('turn/steer', { threadId: h.thread.id, expectedTurnId: 'stale', input: [{ type: 'text', text: 'x' }] }), /уже завершилась/);
  h.child.send(result(steerId, { user_message_uuids: [h.turn.id, steerId], queued_turn_count: 0, result: 'готово' }));
  const completed = h.events.filter(e => e.method === 'turn/completed');
  assert.equal(completed.length, 1); assert.equal(completed[0].params.turn.id, h.turn.id); assert.equal(completed[0].params.turn.status, 'completed');
  assert.ok(completed[0].params.turn.items.some(item => item.id === steerId && item.type === 'userMessage'));
  assert.equal(h.client._active, null);
});

test('a steer the CLI could not fold becomes the next turn without a second prompt; a dropped steer is reported', async t => {
  const h = await running(t);
  await h.client.request('turn/steer', { threadId: h.thread.id, expectedTurnId: h.turn.id, clientUserMessageId: steerId, input: [{ type: 'text', text: 'поздно' }] });
  const before = h.frames.length;
  h.child.send(result(h.turn.id, { user_message_uuids: [h.turn.id], queued_turn_count: 1, result: 'первый ответ' }));
  const completed = h.events.filter(e => e.method === 'turn/completed');
  assert.equal(completed.length, 1); assert.equal(completed[0].params.turn.id, h.turn.id);
  assert.ok(!completed[0].params.turn.items.some(item => item.id === steerId), 'the unconsumed steer leaves the finished turn');
  const started = h.events.filter(e => e.method === 'turn/started');
  assert.equal(started.length, 2); assert.equal(started[1].params.turn.id, steerId, 'the follow-up turn is keyed by the queued message uuid');
  const moved = h.events.filter(e => e.method === 'item/completed' && e.params.item.id === steerId).at(-1);
  assert.equal(moved.params.turnId, steerId);
  assert.equal(h.frames.length, before, 'no new frame is written: the CLI already holds the queued message');
  await assert.rejects(h.client.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'x' }] }), /Дождитесь/);
  h.child.send({ type: 'assistant', uuid: 'a2', session_id: h.thread.id.slice(7), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'второй ответ' }] } });
  h.child.send(result(steerId, { user_message_uuids: [steerId], queued_turn_count: 0, result: 'второй ответ' }));
  assert.equal(h.events.filter(e => e.method === 'turn/completed').length, 2);
  assert.equal(h.client._active, null);
  const turn2 = (await h.client.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'ещё' }] })).turn;
  await h.client.request('turn/steer', { threadId: h.thread.id, expectedTurnId: turn2.id, input: [{ type: 'text', text: 'потеряно' }] });
  h.child.send(result(turn2.id, { user_message_uuids: [turn2.id], queued_turn_count: 0 }));
  assert.equal(h.events.filter(e => e.method === 'turn/started').length, 3, 'no follow-up turn without a queued count');
  assert.match(h.events.find(e => e.method === 'error')?.params.error.message || '', /не учёл уточнение/);
  assert.equal(h.client._active, null);
});

test('compact sends the documented /compact command as its own turn and surfaces the boundary, no hidden instructions', async t => {
  const h = harness(); t.after(() => h.client.stop()); await h.client.start();
  const thread = (await h.client.request('thread/start')).thread;
  await assert.rejects(h.client.request('thread/compact/start', { threadId: thread.id }), /пуст/);
  const turn = (await h.client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Привет' }] })).turn;
  await assert.rejects(h.client.request('thread/compact/start', { threadId: thread.id }), /Дождитесь/);
  h.child.send(result(turn.id));
  const before = h.frames.length;
  await h.client.request('thread/compact/start', { threadId: thread.id });
  const written = h.frames.slice(before);
  assert.equal(written.length, 1); assert.equal(written[0].type, 'user'); assert.deepEqual(written[0].message.content, [{ type: 'text', text: '/compact' }]);
  const compactTurn = h.events.filter(e => e.method === 'turn/started').at(-1).params.turn;
  assert.equal(compactTurn.id, written[0].uuid);
  assert.equal(h.events.filter(e => e.method === 'item/completed' && e.params.turnId === compactTurn.id && e.params.item.type === 'userMessage').length, 0, 'the command is not shown as a user message');
  await assert.rejects(h.client.request('turn/steer', { threadId: thread.id, expectedTurnId: compactTurn.id, input: [{ type: 'text', text: 'x' }] }), /сжатия/);
  h.child.send({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1', session_id: thread.id.slice(7), compact_metadata: { trigger: 'manual', pre_tokens: 5000, post_tokens: 900 } });
  const boundary = h.events.find(e => e.method === 'item/completed' && e.params.item.type === 'contextCompaction');
  assert.equal(boundary.params.turnId, compactTurn.id); assert.equal(boundary.params.item.preTokens, 5000);
  h.child.send({ type: 'system', subtype: 'local_command_output', uuid: 'lc1', session_id: thread.id.slice(7), content: 'Compacted conversation' });
  assert.equal(h.events.find(e => e.method === 'item/completed' && e.params.item.id === 'lc1').params.item.text, 'Compacted conversation');
  h.child.send(result(compactTurn.id, { queued_turn_count: 0 }));
  const done = h.events.filter(e => e.method === 'turn/completed').at(-1);
  assert.equal(done.params.turn.id, compactTurn.id); assert.equal(done.params.turn.status, 'completed');
  assert.equal(h.spawns.length, 1);
});

test('rename of the open session uses the rename_session control request and updates the thread', async t => {
  const h = await running(t);
  h.child.send(result(h.turn.id));
  await assert.rejects(h.client.request('thread/name/set', { threadId: h.thread.id, name: '  ' }), /Название/);
  await assert.rejects(h.client.request('thread/name/set', { threadId: 'claude:' + steerId, name: 'x' }), /Откройте/);
  const before = h.frames.length;
  const pending = h.client.request('thread/name/set', { threadId: h.thread.id, name: ' План миграции ' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const request = h.frames.slice(before).find(f => f.type === 'control_request');
  assert.deepEqual(request.request, { subtype: 'rename_session', title: 'План миграции', source: 'host', session_id: h.thread.id.slice(7) });
  h.child.send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
  const reply = await pending;
  assert.equal(reply.thread.name, 'План миграции');
  assert.deepEqual(h.events.find(e => e.method === 'thread/name/updated').params, { threadId: h.thread.id, name: 'План миграции' });
  assert.equal((await h.client.request('thread/read', { threadId: h.thread.id })).thread.name, 'План миграции');
});

test('history reads stay available while the CLI process is being replaced for a resume; other requests wait for the new process', async t => {
  const other = 'claude:cccccccc-1111-2222-3333-444444444444';
  const history = { async list() { return { data: [{ id: other, provider: 'claude' }], nextCursor: null }; }, async read({ threadId }) { return { thread: { id: threadId, provider: 'claude', cwd: process.cwd(), turns: [] } }; } };
  const h = harness({ slowExit: true, history }); t.after(() => h.client.stop()); await h.client.start();
  const thread = (await h.client.request('thread/start')).thread;
  const turn = (await h.client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Привет' }] })).turn;
  h.child.send(result(turn.id));
  const resume = h.client.request('thread/resume', { threadId: other });
  await new Promise(resolve => setTimeout(resolve, 5)); // the old process is ending, the new one is not spawned yet
  assert.equal(h.spawns.length, 1);
  assert.equal(h.children[0].killed, true);
  const listed = await h.client.request('thread/list', {});
  assert.equal(listed.data[0].id, other, 'thread/list is served from native history during the restart window');
  const read = await h.client.request('thread/read', { threadId: other });
  assert.equal(read.thread.id, other);
  const config = h.client.request('config/read', {});
  const resumed = await resume;
  assert.equal(resumed.thread.id, other); assert.equal(h.spawns.length, 2);
  assert.ok(await config, 'a live-session request issued mid-restart resolves against the new process');
  assert.ok(h.spawns[1].args.includes('--resume'));
});

test('tool-less narration mid-turn stays commentary until result, so the work timer does not stop early', async t => {
  const h = await running(t);
  const sid = h.thread.id.slice(7);
  h.child.send({ type: 'assistant', uuid: 'n1', session_id: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Разбираюсь: проверяю запрос.' }] } });
  h.child.send({ type: 'assistant', uuid: 'n2', session_id: sid, message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] } });
  h.child.send({ type: 'assistant', uuid: 'n3', session_id: sid, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Готово: причина найдена.' }] } });
  const phases = () => h.events.filter(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage').map(e => [e.params.item.text, e.params.item.phase]);
  assert.deepEqual(phases(), [['Разбираюсь: проверяю запрос.', 'commentary'], ['Готово: причина найдена.', 'commentary']], 'no final_answer is announced while the turn still runs');
  h.child.send(result(h.turn.id, { result: 'Готово: причина найдена.' }));
  assert.deepEqual(phases().at(-1), ['Готово: причина найдена.', 'final_answer'], 'the last text is promoted to the answer exactly once at result');
  const items = h.events.find(e => e.method === 'turn/completed').params.turn.items.filter(i => i.type === 'agentMessage');
  assert.deepEqual(items.map(i => i.phase), ['commentary', 'final_answer']);
  assert.equal(items.filter(i => i.id.endsWith(':result')).length, 0, 'no duplicate synthesized answer');
});

test('usage/read normalizes plan windows, treats API-key accounts and old CLIs as unavailable, and rate_limit_event updates live', async t => {
  const h = await running(t);
  const usage = await h.client.request('usage/read', {});
  assert.equal(h.frames.at(-1).request.subtype, 'get_usage'); assert.equal(h.frames.at(-1).request.skip_behaviors, true);
  assert.equal(usage.available, true); assert.equal(usage.subscription, 'max');
  assert.deepEqual(usage.windows.map(w => [w.key, w.label, w.utilization, w.resetsAt]), [
    ['five_hour', 'Сессия 5 часов', 37.4, '2030-01-01T10:00:00.000Z'.replace('.000Z', 'Z')],
    ['seven_day', 'Неделя, все модели', 12, '2030-01-05T00:00:00Z'],
    ['model:0', 'Неделя, Fable', 5, null],
  ]);
  assert.deepEqual(normalizeUsage({ rate_limits_available: false, rate_limits: null, subscription_type: null }, 'now'), { available: false, subscription: null, windows: [], updatedAt: 'now', message: 'Лимиты плана не применяются к этому способу входа (API-ключ или сторонний провайдер).' });
  assert.equal(normalizeUsage(null).available, false);
  assert.equal(normalizeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 250, resets_at: 'bad' } } }).windows[0].utilization, 100, 'utilization is clamped');
  h.child.send({ type: 'rate_limit_event', uuid: 'r1', session_id: h.thread.id.slice(7), rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 81, resetsAt: 1893456000 } });
  const live = h.events.find(e => e.method === 'usage/updated');
  assert.equal(live.params.window.key, 'five_hour'); assert.equal(live.params.window.utilization, 81); assert.equal(live.params.window.resetsAt, '2030-01-01T00:00:00.000Z'); assert.equal(live.params.status, 'allowed_warning');
  const old = await running(t, { usageAnswer: 'error' });
  const unavailable = await old.client.request('usage/read', {});
  assert.equal(unavailable.available, false); assert.match(unavailable.message, /не сообщил лимиты/);
  assert.equal(old.client.state, 'ready', 'an unsupported control request never ends the session');
});

test('token usage is reported per model call: live from stream usage, counted once per message, last call is the context proxy, totals from cumulative modelUsage', async t => {
  const h = await running(t);
  const sid = h.thread.id.slice(7);
  const usageEvents = () => h.events.filter(e => e.method === 'thread/tokenUsage/updated').map(e => e.params.tokenUsage);
  h.child.send({ type: 'stream_event', session_id: sid, event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 1 } } } });
  h.child.send({ type: 'stream_event', session_id: sid, event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } } });
  let usage = usageEvents();
  assert.equal(usage.length, 1, 'message_delta yields a live estimate');
  assert.equal(usage[0].last.inputTokens, 4600); assert.equal(usage[0].last.cachedInputTokens, 4000); assert.equal(usage[0].last.outputTokens, 40); assert.equal(usage[0].total, undefined);
  h.child.send({ type: 'assistant', uuid: 'a1', session_id: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 } } });
  h.child.send({ type: 'assistant', uuid: 'a1b', session_id: sid, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'читаю' }], usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 } } });
  usage = usageEvents();
  assert.equal(usage.at(-1).last.outputTokens, 42);
  assert.equal(usage.at(-1).total.totalTokens, 4642, 'sibling records with one message id are counted once');
  h.child.send({ type: 'assistant', uuid: 'a2', session_id: sid, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Готово' }], usage: { input_tokens: 50, cache_read_input_tokens: 4700, cache_creation_input_tokens: 0, output_tokens: 10 } } });
  usage = usageEvents();
  assert.equal(usage.at(-1).last.inputTokens, 4750, 'last reflects the latest call, the context proxy');
  assert.equal(usage.at(-1).total.totalTokens, 4642 + 4760);
  h.child.send(result(h.turn.id, { usage: { input_tokens: 150, cache_read_input_tokens: 8700, cache_creation_input_tokens: 500, output_tokens: 52 }, modelUsage: { 'claude-x': { inputTokens: 150, cacheReadInputTokens: 8700, cacheCreationInputTokens: 500, outputTokens: 52, contextWindow: 200000 } } }));
  const final = usageEvents().at(-1);
  assert.equal(final.last.inputTokens, 4750, 'result does not replace last with the whole-turn sum');
  assert.equal(final.total.totalTokens, 9402, 'result totals come from cumulative modelUsage');
  assert.equal(final.modelContextWindow, 200000);
  const turn2 = (await h.client.request('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'ещё' }] })).turn;
  h.child.send({ type: 'assistant', uuid: 'a3', session_id: sid, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 5 } } });
  const next = h.events.filter(e => e.method === 'thread/tokenUsage/updated').at(-1).params;
  assert.equal(next.turnId, turn2.id);
  assert.equal(next.tokenUsage.total.totalTokens, 9402 + 9015); assert.equal(next.tokenUsage.modelContextWindow, 200000); assert.equal(next.tokenUsage.last.inputTokens, 9010);
  h.child.send(result(turn2.id));
});

test('agent/capabilities lists commands, agents and MCP status from documented control data; MCP failures degrade to a message', async t => {
  const h = await running(t);
  const details = await h.client.request('agent/capabilities', {});
  assert.deepEqual(details.commands, [{ name: 'compact', description: 'Compact', builtin: true }, { name: 'ency-extension', description: 'Build ENCY extensions', builtin: false }]);
  assert.deepEqual(details.agents, [{ name: 'Explore', description: 'Read-only search' }]);
  assert.equal(details.mcpServers.length, 2); assert.equal(details.mcpServers[0].status, 'connected'); assert.equal(details.mcpServers[1].status, 'failed');
  assert.doesNotMatch(details.mcpServers[1].error, /sk-abcdef/, 'secrets in MCP errors are redacted');
  assert.equal(h.frames.at(-1).request.subtype, 'mcp_status');
  const failing = await running(t, { mcpAnswer: 'error' });
  const degraded = await failing.client.request('agent/capabilities', {});
  assert.equal(degraded.mcpServers, null); assert.match(degraded.mcpError, /недоступно/); assert.equal(degraded.commands.length, 2);
});


test('ordinary Claude sends preserve the client UUID in the native frame and user echo', async t => {
  const h = harness(); t.after(() => h.client.stop()); await h.client.start();
  const { thread } = await h.client.request('thread/start');
  const id = 'bbbbbbbb-1111-2222-3333-444444444444';
  await h.client.request('turn/start', { threadId: thread.id, clientUserMessageId: id, input: [{ type: 'text', text: 'Exact delivery ID' }] });
  assert.equal(h.frames.at(-1).uuid, id);
  const echo = h.events.find(event => event.params.item?.type === 'userMessage').params.item;
  assert.equal(echo.id, id); assert.equal(echo.clientId, id);
});

test('public task status updates survive main turn completion without exposing nested agent frames', async t => {
  const h = await running(t);
  h.child.send({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-tool', description: 'Review files' });
  h.child.send({ type: 'system', subtype: 'task_progress', task_id: 'task-1', summary: 'Reading files' });
  h.child.send(result(h.turn.id));
  h.child.send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'failed', summary: 'Tool error', output_file: '/task-output' });
  const task = h.events.filter(event => event.params.item?.type === 'subAgentTask').at(-1);
  assert.equal(task.params.turnId, h.turn.id); assert.equal(task.params.item.status, 'failed');
  assert.equal(task.params.item.description, 'Review files'); assert.equal(task.params.item.result, 'Tool error');
  const itemCount = h.events.length;
  h.child.send({ type: 'assistant', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'text', text: 'nested content' }] } });
  assert.equal(h.events.length, itemCount);
});
