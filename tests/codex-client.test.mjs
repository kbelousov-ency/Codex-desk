import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexClient } from '../electron/codex-client.mjs';
import { createDiagnostics } from '../electron/diagnostics.mjs';

function harness({ onRequest, requestTimeoutMs = 200, initialize = true, userAgent = 'test-server', diagnostics, diagnosticContext } = {}) {
  const processes = [];
  const frames = [];
  const spawns = [];
  const spawnImpl = (...args) => {
    spawns.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const message = JSON.parse(chunk.toString());
        frames.push(message);
        if (message.method === 'initialize' && initialize) child.send({ id: message.id, result: { userAgent } });
        else onRequest?.(message, child);
        callback();
      },
    });
    processes.push(child);
    return child;
  };
  const client = new CodexClient({ executable: 'codex.exe', cwd: 'C:/project with spaces', spawnImpl, requestTimeoutMs, diagnostics, diagnosticContext });
  return { client, frames, spawns, processes, get child() { return processes.at(-1); } };
}

test('startup is shared and initializes before ready using a hidden shell-free process', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  const states = [];
  h.client.on('status', (event) => states.push(event.state));
  const first = h.client.start();
  assert.equal(h.client.start(), first);
  assert.deepEqual(await first, { userAgent: 'test-server' });
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0], ['codex.exe', ['app-server', '--listen', 'stdio://'], {
    cwd: 'C:/project with spaces', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  }]);
  assert.deepEqual(h.frames.map((frame) => frame.method), ['initialize', 'initialized']);
  assert.deepEqual(h.frames[0].params.clientInfo, { name: 'codex_desk', title: 'Codex Desk', version: '0.1.0' });
  assert.equal(h.frames[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(states, ['starting', 'ready']);
});

test('JSONL framing preserves split UTF-8 and multiple notifications per chunk', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const notifications = [];
  h.client.on('notification', (message) => notifications.push(message));
  const message = { method: 'item/agentMessage/delta', params: { delta: 'Привет 👋' } };
  const bytes = Buffer.from(`${JSON.stringify(message)}\r\n${JSON.stringify({ method: 'turn/completed', params: {} })}\n`);
  for (let i = 0; i < bytes.length; i += 1) h.child.stdout.write(bytes.subarray(i, i + 1));
  assert.deepEqual(notifications, [message, { method: 'turn/completed', params: {} }]);
});

test('requests correlate concurrent out-of-order replies and preserve protocol errors', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const first = h.client.request('model/list');
  const second = h.client.request('thread/start');
  const [a, b] = h.frames.slice(-2);
  h.child.send({ id: b.id, error: { code: -32602, message: 'Invalid cwd', data: { field: 'cwd' } } });
  h.child.send({ id: a.id, result: { data: ['model'] } });
  assert.deepEqual(await first, { data: ['model'] });
  await assert.rejects(second, (error) => error.code === -32602 && error.message === 'Invalid cwd' && error.data.field === 'cwd');
});

test('server permission responses retain string IDs and cannot be sent twice', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const requests = [];
  h.client.on('serverRequest', (message) => requests.push(message));
  const request = { id: 'permission-7', method: 'item/commandExecution/requestApproval', params: { command: 'git status' } };
  h.child.send(request);
  assert.deepEqual(requests, [request]);
  const first = h.client.respond(request.id, { decision: 'decline' });
  await assert.rejects(h.client.respond(request.id, { decision: 'accept' }), /no longer pending/);
  await first;
  assert.deepEqual(h.frames.at(-1), { id: request.id, result: { decision: 'decline' } });
});

test('timeout rejects only the affected request and late replies are ignored', async (t) => {
  const h = harness({ requestTimeoutMs: 25 });
  t.after(() => h.client.stop());
  await h.client.start();
  await assert.rejects(h.client.request('slow'), /timed out: slow/);
  h.child.send({ id: h.frames.at(-1).id, result: 'late' });
  const next = h.client.request('fast');
  h.child.send({ id: h.frames.at(-1).id, result: 'ok' });
  assert.equal(await next, 'ok');
  assert.equal(h.client.state, 'ready');
});

test('exit rejects pending requests and old child events cannot stop a restarted session', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const oldChild = h.child;
  const pending = h.client.request('thread/read');
  oldChild.emit('exit', 7, null);
  await assert.rejects(pending, /exited \(7\)/);
  assert.equal(h.client.state, 'stopped');
  await h.client.start();
  oldChild.emit('error', new Error('late old-process error'));
  assert.equal(h.client.state, 'ready');
  assert.equal(h.spawns.length, 2);
});

test('stopping during initialization rejects startup and kills the process', async () => {
  const h = harness({ initialize: false });
  const startup = h.client.start();
  await Promise.resolve();
  h.client.stop();
  await assert.rejects(startup, /stopped/);
  assert.equal(h.child.killed, true);
  assert.equal(h.client.state, 'stopped');
});

test('spawn and stream failures become status events instead of unhandled error events', async (t) => {
  const failedSpawn = new CodexClient({ spawnImpl() { throw new Error('ENOENT codex'); } });
  await assert.rejects(failedSpawn.start(), /ENOENT/);
  assert.equal(failedSpawn.state, 'error');
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const pending = h.client.request('thread/read');
  h.child.stdin.emit('error', new Error('EPIPE'));
  await assert.rejects(pending, /EPIPE/);
  assert.equal(h.client.state, 'error');
  assert.equal(h.child.killed, true);
});

test('malformed output is ignored without echoing secrets and stderr is redacted across chunks', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const diagnostics = [];
  h.client.on('diagnostic', (value) => diagnostics.push(value));
  h.child.stdout.write('oops sk-secretsecretsecret\n');
  h.child.stderr.write('Authorization: Bearer sec');
  h.child.stderr.write('ret-value\napi_key="sk-verysecretkey123456789"\n');
  assert.equal(diagnostics.length, 3);
  assert.match(diagnostics[1], /\[redacted\]/);
  assert.match(diagnostics[2], /\[redacted\]/);
  assert.doesNotMatch(diagnostics.join('\n'), /secret|ret-value/);
});

test('serialization failure does not poison the transport', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(h.client.request('invalid', cycle), /circular/i);
  const next = h.client.request('ok');
  h.child.send({ id: h.frames.at(-1).id, result: true });
  assert.equal(await next, true);
});


test('immediate stop cancels scheduled startup before spawning a worker', async () => {
  const h = harness();
  const startup = h.client.start();
  h.client.stop();
  await assert.rejects(startup, /stopped/);
  assert.equal(h.spawns.length, 0);
});

test('a synchronous status listener can cancel startup safely', async () => {
  const h = harness();
  h.client.on('status', ({ state }) => { if (state === 'starting') h.client.stop(); });
  await assert.rejects(h.client.start(), /stopped/);
  assert.equal(h.spawns.length, 0);
});

test('stdout closure rejects outstanding requests even when process exit is delayed', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  const pending = h.client.request('thread/read');
  h.child.stdout.end();
  await assert.rejects(pending, /output stream closed/);
  assert.equal(h.client.state, 'stopped');
  assert.equal(h.child.killed, true);
});


test('server-side resolved approvals can no longer receive a response', async (t) => {
  const h = harness();
  t.after(() => h.client.stop());
  await h.client.start();
  h.child.send({ id: 81, method: 'item/commandExecution/requestApproval', params: {} });
  h.child.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 81 } });
  await assert.rejects(h.client.respond(81, { decision: 'accept' }), /no longer pending/);
});

function diagnosticHarness() {
  const entries = [];
  const errors = [];
  const diagnostics = {
    id: value => createHash('sha256').update(value).digest('hex').slice(0, 16),
    record(level, event, data) { entries.push({ level, event, ...data }); },
    error(event, error, data, level = 'error') {
      errors.push(error);
      // The production logger separately tests classification/privacy. This spy
      // confirms raw errors enter only its classifier, never record/data fields.
      entries.push({ level, event, ...data, ...(Number.isInteger(error?.code) ? { code: error.code } : {}) });
    },
  };
  return { diagnostics, entries, errors };
}

test('diagnostics correlate request completion/failure, durations and immutable opaque session context', async (t) => {
  const d = diagnosticHarness();
  const context = { sessionId: d.diagnostics.id('private-session'), projectId: d.diagnostics.id('C:/private-project') };
  const originalSession = context.sessionId;
  const h = harness({ diagnostics: d.diagnostics, diagnosticContext: context, userAgent: 'codex-cli/0.154.0-alpha.6.2 (private machine)' });
  t.after(() => h.client.stop());
  context.sessionId = 'changed-session';
  await h.client.start();
  const first = h.client.request('thread/read', { threadId: 'secret-thread', instructions: 'secret-prompt' });
  const second = h.client.request('config/read', { secret: 'password' });
  const [a, b] = h.frames.slice(-2);
  h.child.send({ id: b.id, error: { code: -32602, message: 'private-project Bearer secret-bearer', data: { token: 'secret-token' } } });
  h.child.send({ id: a.id, result: { text: 'secret-answer' } });
  await first;
  await assert.rejects(second, /secret-bearer/);
  const success = d.entries.find(entry => entry.event === 'rpc.complete' && entry.requestId === a.id);
  const failed = d.entries.find(entry => entry.event === 'rpc.failed' && entry.requestId === b.id);
  assert.equal(success.method, 'thread/read');
  assert.equal(success.threadId, d.diagnostics.id('secret-thread'));
  assert.ok(success.durationMs >= 0);
  assert.equal(failed.code, -32602);
  assert.ok(failed.durationMs >= 0);
  assert.ok(d.entries.every(entry => entry.sessionId === originalSession && /^[a-f0-9]{16}$/.test(entry.clientId)));
  assert.equal(d.entries.find(entry => entry.event === 'codex.version').codexVersion, '0.154.0-alpha.6.2');
  assert.ok(d.errors[0] instanceof Error);
  assert.equal(d.errors[0].data.token, 'secret-token');
  assert.doesNotMatch(JSON.stringify(d.entries), /secret-|password|private machine|private-project|changed-session/);
});

test('diagnostics record lifecycle metadata, omit streamed content and suppress duplicate/burst notifications', async (t) => {
  const d = diagnosticHarness();
  const h = harness({ diagnostics: d.diagnostics });
  t.after(() => h.client.stop());
  await h.client.start();
  const notifications = [];
  h.client.on('notification', message => notifications.push(message));
  for (let i = 0; i < 250; i++) {
    h.child.send({ method: 'item/agentMessage/delta', params: { delta: 'secret-reply' } });
    h.child.send({ method: 'thread/status/changed', params: { threadId: `thread-${i}`, status: { type: 'active', private: 'secret-state' } } });
  }
  for (let i = 0; i < 20; i++) h.child.send({ method: 'thread/status/changed', params: { threadId: 'thread-0', status: { type: 'active' } } });
  h.child.send({ method: 'error', params: { threadId: 'thread-0', turnId: 'turn-0', error: { message: 'secret-failure', codexErrorInfo: 'unauthorized' }, willRetry: true } });
  h.child.send({ method: 'turn/completed', params: { threadId: 'thread-0', turn: { id: 'turn-0', status: 'failed', error: { message: 'secret-failure' }, items: ['secret-reply'] } } });
  for (let i = 0; i < 50; i++) {
    h.child.send({ method: 'error', params: { threadId: 'thread-0', turnId: 'turn-0', error: { message: 'secret-failure', codexErrorInfo: 'unauthorized' }, willRetry: true } });
    h.child.send({ method: 'error', params: { threadId: 'thread-0', turnId: 'turn-0', error: { message: `secret-new-failure-${i}` }, willRetry: true } });
  }
  h.child.send({ id: 'secret-approval-id', method: 'item/commandExecution/requestApproval', params: { command: 'secret-command' } });
  h.child.send({ id: 7, method: 'secret-method', params: { password: 'secret-password' } });
  assert.equal(notifications.length, 622, 'logging never suppresses application notifications');
  assert.equal(d.entries.filter(entry => entry.event === 'rpc.notification' && entry.level === 'info').length, 100);
  assert.equal(d.entries.filter(entry => entry.reason === 'throttled').length, 2);
  assert.equal(d.entries.filter(entry => entry.event === 'rpc.notification' && entry.level === 'error').length, 20);
  const error = d.entries.find(entry => entry.method === 'error');
  assert.equal(error.retry, true);
  assert.equal(error.turnId, d.diagnostics.id('turn-0'));
  assert.equal(d.entries.find(entry => entry.method === 'turn/completed').status, 'failed');
  assert.equal(d.entries.filter(entry => entry.event === 'rpc.serverRequest').at(-1).method, 'unknown');
  assert.doesNotMatch(JSON.stringify(d.entries), /secret-|thread-0|turn-0|agentMessage/);
});

test('diagnostics classify only warning/error stderr and rate-limit it without suppressing UI diagnostics', async (t) => {
  const d = diagnosticHarness();
  const h = harness({ diagnostics: d.diagnostics });
  t.after(() => h.client.stop());
  await h.client.start();
  const displayed = [];
  h.client.on('diagnostic', line => displayed.push(line));
  h.child.stderr.write('INFO secret-user-message\n');
  h.child.stderr.write('WARN private-path failed Authorization: Bearer secret');
  h.child.stderr.write('-credential\n');
  for (let i = 0; i < 200; i++) h.child.stderr.write(`ERROR private-command-${i} failed\n`);
  h.child.stdout.write('secret-malformed-json\nsecret-malformed-json\n');
  assert.equal(displayed.length, 204);
  assert.equal(d.entries.filter(entry => entry.reason === 'stderr').length, 10);
  assert.equal(d.entries.filter(entry => entry.reason === 'malformed_frame').length, 1);
  assert.equal(d.errors[0].message, 'WARN private-path failed Authorization: Bearer secret-credential');
  assert.equal(d.entries.find(entry => entry.reason === 'stderr').level, 'warn');
  assert.doesNotMatch(JSON.stringify(d.entries), /secret|private-|Authorization|Bearer/);
});

test('diagnostics report timeouts and pending requests on process exit exactly once', async (t) => {
  const d = diagnosticHarness();
  const h = harness({ diagnostics: d.diagnostics, requestTimeoutMs: 25 });
  t.after(() => h.client.stop());
  await h.client.start();
  await assert.rejects(h.client.request('thread/read'), /timed out/);
  const timeoutId = h.frames.at(-1).id;
  h.child.send({ id: timeoutId, result: 'secret-late-result' });
  const pending = h.client.request('thread/list');
  const exitId = h.frames.at(-1).id;
  h.child.emit('exit', 7, null);
  await assert.rejects(pending, /exited/);
  assert.equal(d.entries.filter(entry => entry.event === 'rpc.failed' && entry.requestId === timeoutId).length, 1);
  assert.equal(d.entries.filter(entry => entry.event === 'rpc.failed' && entry.requestId === exitId).length, 1);
  assert.equal(d.entries.find(entry => entry.event === 'transport.exit').exitCode, 7);
  assert.equal(d.entries.find(entry => entry.event === 'transport.end').reason, 'exit');
});

test('broken diagnostics never break transport startup, requests, notifications or stop', async () => {
  const broken = () => { throw new Error('broken logger'); };
  const h = harness({ diagnostics: { id: broken, record: broken, error: broken } });
  await h.client.start();
  const request = h.client.request('model/list');
  h.child.send({ id: h.frames.at(-1).id, result: { data: [] } });
  assert.deepEqual(await request, { data: [] });
  h.child.send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } });
  h.child.send({ method: 'error', params: { error: { message: 'unauthorized' } } });
  h.child.stderr.write('ERROR simulated failure\n');
  h.client.stop();
  assert.equal(h.client.state, 'stopped');
});

test('unrecognized method names and user-agent values never enter diagnostic records', async (t) => {
  const d = diagnosticHarness();
  const h = harness({ diagnostics: d.diagnostics, userAgent: 'codex-cli/0.154.0-secret-credential private-host' });
  t.after(() => h.client.stop());
  await h.client.start();
  const request = h.client.request('secret-payload-method');
  h.child.send({ id: h.frames.at(-1).id, result: 'ok' });
  await request;
  assert.equal(d.entries.at(-1).method, 'unknown');
  assert.equal(d.entries.some(entry => entry.event === 'codex.version'), false);
  assert.doesNotMatch(JSON.stringify(d.entries), /secret-|private-host/);
});

test('real diagnostic files/export keep correlations and classified failures but never transport content', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-transport-diagnostics-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const logDirectory = path.join(temporary, 'logs');
  const diagnostics = createDiagnostics({ directory: logDirectory });
  const privateProject = 'C:/Users/private-person/private-project';
  const h = harness({ diagnostics, diagnosticContext: { sessionId: diagnostics.id('private-session'), projectId: diagnostics.id(privateProject) }, userAgent: 'codex_desk/0.154.0 (Windows 10.0.26200; x86_64) dumb (codex_desk; 0.1.0)' });
  t.after(() => h.client.stop());
  await h.client.start();
  const secret = 'credential-canary-Qz781';
  const threadId = 'private-thread-id';
  const failed = h.client.request('thread/resume', { threadId, cwd: privateProject, instructions: `private prompt ${secret}` });
  const requestId = h.frames.at(-1).id;
  h.child.send({ id: requestId, error: { message: `thread already has an active writer: ${privateProject} ${secret}`, code: -32001, data: { Authorization: `Bearer ${secret}` } } });
  await assert.rejects(failed, /active writer/);
  h.child.send({ method: 'error', params: { threadId, turnId: 'private-turn-id', error: { message: `private failure ${secret}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, additionalDetails: secret }, willRetry: true } });
  h.child.send({ method: 'item/agentMessage/delta', params: { delta: `private answer ${secret}` } });
  h.child.send({ id: 54, method: 'item/commandExecution/requestApproval', params: { command: `echo ${secret}`, cwd: privateProject } });
  h.child.stderr.write(`ERROR authorization failed Bearer ${secret} ${privateProject}\n`);
  h.client.stop();
  const exported = path.join(temporary, 'report.json');
  await diagnostics.exportReport(exported);
  const reportText = await readFile(exported, 'utf8');
  const fileText = (await Promise.all((await readdir(logDirectory)).map(file => readFile(path.join(logDirectory, file), 'utf8')))).join('\n');
  for (const text of [reportText, fileText]) {
    assert.doesNotMatch(text, /credential-canary|private-|Bearer|Authorization|instructions|additionalDetails|echo /);
    assert.match(text, /writer_conflict/);
    assert.match(text, /httpConnectionFailed/);
  }
  const report = JSON.parse(reportText);
  const failure = report.logs.find(entry => entry.event === 'rpc.failed' && entry.data.requestId === requestId);
  assert.equal(failure.data.error.category, 'writer_conflict');
  assert.equal(failure.data.method, 'thread/resume');
  assert.equal(failure.data.threadId, diagnostics.id(threadId));
  assert.ok(failure.data.durationMs >= 0);
  const errorNotification = report.logs.find(entry => entry.data.method === 'error');
  assert.equal(errorNotification.data.error.httpStatusCode, 503);
  assert.equal(errorNotification.data.retry, true);
  assert.equal(report.logs.find(entry => entry.event === 'codex.version').data.codexVersion, '0.154.0');
});


test('late turn ACK after timeout reports the exact client message without resending', async t => {
  const h = harness({ requestTimeoutMs: 15 }); t.after(() => h.client.stop());
  await h.client.start();
  const events = []; h.client.on('notification', event => events.push(event));
  const clientUserMessageId = 'aaaaaaaa-1111-2222-3333-444444444444';
  await assert.rejects(h.client.request('turn/start', { threadId: 'thread-a', clientUserMessageId, input: [] }), /timed out/);
  const sent = h.frames.at(-1);
  h.child.send({ id: sent.id, result: { turn: { id: 'turn-a', status: 'inProgress' } } });
  assert.deepEqual(events.at(-1), { method: 'message/receipt', params: { threadId: 'thread-a', clientUserMessageId, accepted: true, rejected: false, turnId: 'turn-a', status: 'inProgress' } });
  assert.equal(h.frames.filter(frame => frame.method === 'turn/start').length, 1);
});
