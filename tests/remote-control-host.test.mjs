import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteControl } from '../electron/remote-control.mjs';
import { createRemoteControlHost } from '../electron/remote-control-host.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const idle = (provider, threadId) => ({ provider, threadId, ready: true, title: 'Fixture conversation', revision: 1,
  phase: 'idle', activeTurnId: null, blockers: [], queue: { count: 0, limit: 50, paused: false },
  actions: { send: true, enqueue: true, steer: false, stop: false }, lastAnswer: null });

async function fixture(t, { provider = 'codex', timeoutMs = 1500 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-remote-host-'));
  const controller = createRemoteControl({ userData: directory });
  await controller.start();
  const id = 'background-tab', threadId = provider === 'claude' ? 'claude:fixture-thread' : 'fixture-thread';
  const calls = [], messages = [], waiters = [];
  const session = { settings: { provider, model: 'actual-model', effort: 'high', access: 'rules' },
    remoteRuntimeId: 'fixture-runtime', currentThreadId: threadId, currentCwd: path.join(directory, 'project'),
    client: {}, bootstrap: {}, requests: new Map(), activeThreadTurns: new Map(), disposed: false,
    request: async (method, params) => {
      if (method === 'message/status') return { accepted: false, rejected: false };
      calls.push({ method, params: structuredClone(params) });
      return { turn: { id: params.expectedTurnId || params.turnId || 'turn-new', status: 'inProgress' } };
    } };
  const selectedSession = { request: () => { throw new Error('Active tab must never receive the remote request'); } };
  const record = { defaultSessionId: 'selected-tab', rendererGone: false,
    sessions: new Map([[id, session], ['selected-tab', selectedSession]]),
    window: { isDestroyed: () => false, webContents: { send: (channel, data) => {
      messages.push({ channel, data });
      if (channel === 'remoteControl:dispatch') waiters.shift()?.(data);
    } } } };
  let localBlocked = false;
  const host = createRemoteControlHost({ controller, windows: new Map([[1, record]]), timeoutMs,
    assertAllowed: () => { if (localBlocked) throw new Error('PC owns this session'); } });
  t.after(async () => { await host.stop(); await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  const snapshot = idle(provider, threadId);
  await host.publish(record, id, snapshot);
  const enable = async enabled => {
    const access = await host.getAccess(record, id);
    return host.setAccess(record, id, { enabled,
      expected: { provider: access.provider, threadId: access.threadId, accessRevision: access.accessRevision } });
  };
  const { target } = await enable(true);
  const begin = async (kind = 'send', requestId = 'request-one', extra = {}) => {
    const next = new Promise(resolve => waiters.push(resolve));
    const command = { requestId, target, kind, ...(kind === 'stop' ? {} : { text: '  fixture input  ' }), ...extra };
    const result = controller.remote.execute(command);
    const dispatch = await next;
    return { command, dispatch, result };
  };
  const native = dispatch => {
    const { operation, command } = dispatch;
    const context = { operationId: operation.operationId, target: structuredClone(command.target), kind: command.kind,
      clientUserMessageId: operation.clientUserMessageId, ...('expectedTurnId' in command ? { expectedTurnId: command.expectedTurnId } : {}) };
    const params = { threadId, _remote: context, ...(command.kind === 'stop' ? { turnId: command.expectedTurnId }
      : { clientUserMessageId: operation.clientUserMessageId, input: [{ type: 'text', text: command.text.trim(), text_elements: [] }],
        ...(command.kind === 'steer' ? { expectedTurnId: command.expectedTurnId } : { model: session.settings.model, effort: session.settings.effort, approvalPolicy: 'on-request' }) }) };
    return { method: command.kind === 'stop' ? 'turn/interrupt' : command.kind === 'steer' ? 'turn/steer' : 'turn/start', params };
  };
  const complete = (dispatch, result) => host.complete(record, id, { dispatchId: dispatch.dispatchId, result });
  const operation = requestId => controller.remote.getOperation({ target, requestId });
  return { controller, host, record, id, session, snapshot, directory, calls, messages, target, begin, native, complete,
    operation, enable, publish: () => host.publish(record, id, snapshot), blockLocal: () => { localBlocked = true; } };
}

async function eventually(read, check) {
  const until = Date.now() + 1500;
  let result;
  do { result = await read(); if (check(result)) return result; await new Promise(resolve => setTimeout(resolve, 5)); } while (Date.now() < until);
  assert.fail(`Expected asynchronous receipt, got ${JSON.stringify(result)}`);
}

test('host dispatches to the granted background tab, preserves immutable input and existing native settings, and consumes once', async t => {
  const f = await fixture(t), run = await f.begin(), { method, params } = f.native(run.dispatch);
  assert.equal(run.dispatch.sessionId, f.id);
  const durable = JSON.parse(await readFile(path.join(f.directory, 'remote-control.json'), 'utf8'));
  assert.equal(durable.operations[0].operationId, run.dispatch.operation.operationId);
  assert.equal(durable.operations[0].stage, 'delegated');
  const result = await f.host.request(f.record, f.id, method, params);
  f.complete(run.dispatch, { phase: 'accepted', turnId: result.turn.id });
  assert.equal((await run.result).value.phase, 'accepted');
  assert.equal(f.calls.length, 1);
  const { _remote, ...expected } = params;
  assert.deepEqual(f.calls[0], { method, params: expected });
  await assert.rejects(f.host.request(f.record, f.id, method, params), /REMOTE_BLOCKED/);
  const replay = await f.controller.remote.execute(run.command);
  assert.equal(replay.value.operationId, run.dispatch.operation.operationId);
  assert.equal(f.messages.filter(item => item.channel === 'remoteControl:dispatch').length, 1);
  assert.equal(f.calls.length, 1);
});

test('host rejects altered immutable destination, operation, kind, UUID, text, attachments and generic RPC before native transport', async t => {
  const f = await fixture(t), run = await f.begin(), original = f.native(run.dispatch);
  const mutations = [
    p => { p.threadId = 'other'; }, p => { p._remote.operationId = 'other'; },
    p => { p._remote.kind = 'enqueue'; }, p => { p._remote.clientUserMessageId = 'other'; },
    p => { p.clientUserMessageId = 'other'; }, p => { p.input[0].text = 'changed'; },
    p => { p.input.push({ type: 'localImage', path: 'secret.png' }); },
    ...Object.keys(f.target).map(key => p => { p._remote.target[key] = key === 'generation' ? 999 : 'other'; }),
  ];
  for (const mutate of mutations) {
    const params = structuredClone(original.params); mutate(params);
    await assert.rejects(f.host.request(f.record, f.id, original.method, params), /REMOTE_BLOCKED/);
  }
  await assert.rejects(f.host.request(f.record, f.id, 'thread/start', original.params), /REMOTE_BLOCKED/);
  assert.equal(f.calls.length, 0);
  await f.host.request(f.record, f.id, original.method, original.params);
  f.complete(run.dispatch, { phase: 'accepted', turnId: 'turn-new' });
  await run.result;
  assert.equal(f.calls.length, 1, 'invalid attempts must not consume the valid operation');
});

test('revoke between awaited authorization and synchronous permit consumption prevents native RPC', async t => {
  const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch), authorized = deferred(), resume = deferred();
  const authorize = f.controller.authorizeTransport;
  f.controller.authorizeTransport = async context => { const permit = await authorize(context); authorized.resolve(); await resume.promise; return permit; };
  const sending = f.host.request(f.record, f.id, native.method, native.params);
  await authorized.promise;
  await f.enable(false);
  resume.resolve();
  await assert.rejects(sending, /REMOTE_BLOCKED/);
  f.complete(run.dispatch, { phase: 'blocked' }); await run.result;
  assert.equal(f.calls.length, 0);
});

test('identical text under distinct request IDs keeps distinct native UUIDs', async t => {
  const f = await fixture(t), ids = [];
  for (const requestId of ['first-text', 'second-text']) {
    const run = await f.begin('send', requestId), native = f.native(run.dispatch);
    await f.host.request(f.record, f.id, native.method, native.params);
    f.complete(run.dispatch, { phase: 'accepted', turnId: 'turn-new' }); await run.result;
    ids.push(native.params.clientUserMessageId);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].params.input[0].text, f.calls[1].params.input[0].text);
});

test('concurrent duplicate transport cannot mark an already dispatched operation rejected or discard its late ACK', async t => {
  const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch), entered = deferred(), ack = deferred();
  f.session.request = async method => {
    if (method === 'message/status') return { accepted: false, rejected: false };
    f.calls.push({ method }); entered.resolve(); return ack.promise;
  };
  const first = f.host.request(f.record, f.id, native.method, native.params);
  await entered.promise;
  await assert.rejects(f.host.request(f.record, f.id, native.method, structuredClone(native.params)), /REMOTE_BLOCKED/);
  const during = await f.operation(run.command.requestId);
  assert.notEqual(during.value.phase, 'rejected', 'a duplicate refusal proves nothing about the first dispatched RPC');
  ack.resolve({ turn: { id: 'accepted-original-turn', status: 'inProgress' } }); await first;
  f.complete(run.dispatch, { phase: 'accepted', turnId: 'accepted-original-turn' });
  const final = await run.result;
  assert.equal(final.value.phase, 'accepted');
  assert.equal(final.value.executionTurnId, 'accepted-original-turn');
  assert.equal(f.calls.length, 1);
});

test('host rechecks native busy/request state, runtime and PC-only barriers after renderer dispatch', async t => {
  for (const barrier of ['busy', 'request', 'runtime', 'local']) await t.test(barrier, async t => {
    const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch);
    if (barrier === 'busy') f.session.activeThreadTurns.set(f.session.currentThreadId, 'local-turn');
    if (barrier === 'request') f.session.requests.set(1, { method: 'item/tool/requestUserInput' });
    if (barrier === 'runtime') f.session.remoteRuntimeId = 'replacement-runtime';
    if (barrier === 'local') f.blockLocal();
    await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /REMOTE_BLOCKED/);
    if (barrier === 'runtime') await f.host.invalidate(f.id); else f.complete(run.dispatch, { phase: 'blocked' });
    await run.result;
    assert.equal(f.calls.length, 0);
  });
});

test('stale stop and steer never interrupt or feed a newer native turn, even before state refresh', async t => {
  for (const kind of ['stop', 'steer']) await t.test(kind, async t => {
    const f = await fixture(t);
    Object.assign(f.snapshot, { phase: 'running', activeTurnId: 'turn-old', actions: { send: false, enqueue: true, steer: true, stop: true } });
    f.session.activeThreadTurns.set(f.session.currentThreadId, 'turn-old'); await f.publish();
    const run = await f.begin(kind, kind, { expectedTurnId: 'turn-old' }), native = f.native(run.dispatch);
    const wrongExpected = structuredClone(native.params); wrongExpected._remote.expectedTurnId = 'turn-new';
    await assert.rejects(f.host.request(f.record, f.id, native.method, wrongExpected), /REMOTE_BLOCKED/);
    const wrongTurn = structuredClone(native.params); wrongTurn[kind === 'stop' ? 'turnId' : 'expectedTurnId'] = 'turn-new';
    await assert.rejects(f.host.request(f.record, f.id, native.method, wrongTurn), /REMOTE_BLOCKED/);
    f.session.activeThreadTurns.set(f.session.currentThreadId, 'turn-new');
    await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /REMOTE_BLOCKED/);
    f.complete(run.dispatch, { phase: 'stale' }); await run.result;
    assert.equal(f.calls.length, 0);
  });
});

test('wrong renderer acknowledgements are rejected and closed runtime invalidates pending dispatch', async t => {
  const f = await fixture(t), run = await f.begin();
  assert.throws(() => f.host.complete({ ...f.record }, f.id, { dispatchId: run.dispatch.dispatchId, result: { phase: 'accepted' } }), /REMOTE_BLOCKED/);
  assert.throws(() => f.host.complete(f.record, 'selected-tab', { dispatchId: run.dispatch.dispatchId, result: { phase: 'accepted' } }), /REMOTE_BLOCKED/);
  await f.host.invalidate(f.id);
  assert.equal((await run.result).value.phase, 'uncertain');
  assert.throws(() => f.complete(run.dispatch, { phase: 'accepted' }), /REMOTE_BLOCKED/);
  const native = f.native(run.dispatch);
  await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /REMOTE_BLOCKED/);
  assert.equal(f.calls.length, 0);
});

test('lost ACK remains uncertain; only exact scoped live echo and completion settle it without resend', async t => {
  const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch);
  f.session.request = async method => { if (method === 'message/status') return { accepted: false, rejected: false }; f.calls.push({ method }); throw new Error('ACK timeout'); };
  await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /ACK timeout/);
  f.complete(run.dispatch, { phase: 'uncertain' });
  assert.equal((await run.result).value.phase, 'uncertain');
  const notify = (threadId, clientId) => f.host.observe(f.id, 'notification', { method: 'item/started',
    params: { threadId, turnId: 'turn-late', item: { type: 'userMessage', id: 'provider-id', clientId, text: run.command.text } } });
  notify(f.session.currentThreadId, 'same-text-wrong-id');
  notify('wrong-thread', run.dispatch.operation.clientUserMessageId);
  assert.equal((await f.operation(run.command.requestId)).value.phase, 'uncertain');
  notify(f.session.currentThreadId, run.dispatch.operation.clientUserMessageId);
  await eventually(() => f.operation(run.command.requestId), value => value.value?.phase === 'accepted');
  f.host.observe(f.id, 'notification', { method: 'turn/completed', params: { threadId: f.session.currentThreadId,
    turn: { id: 'turn-late', status: 'completed', items: [] } } });
  const finished = await eventually(() => f.operation(run.command.requestId), value => value.value?.phase === 'completed');
  assert.equal(finished.value.outcome, 'succeeded');
  assert.equal((await f.controller.remote.execute(run.command)).value.operationId, run.dispatch.operation.operationId);
  assert.equal(f.calls.length, 1);
});

test('numeric provider rejection is durable and a generic transport error is not a rejection', async t => {
  for (const rejected of [true, false]) await t.test(String(rejected), async t => {
    const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch);
    f.session.request = async method => {
      if (method === 'message/status') return { accepted: false, rejected: false };
      f.calls.push({ method }); throw Object.assign(new Error('fixture failure'), rejected ? { code: -32602 } : {});
    };
    await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /fixture failure/);
    f.complete(run.dispatch, { phase: 'uncertain' });
    assert.equal((await run.result).value.phase, rejected ? 'rejected' : 'uncertain');
    assert.equal(f.calls.length, 1);
  });
});

test('numeric timeout remains uncertain just like the existing native message-status semantics', async t => {
  const f = await fixture(t), run = await f.begin(), native = f.native(run.dispatch);
  f.session.request = async method => {
    if (method === 'message/status') return { accepted: false, rejected: false };
    f.calls.push({ method }); throw Object.assign(new Error('stream closed after timeout'), { code: -32000 });
  };
  await assert.rejects(f.host.request(f.record, f.id, native.method, native.params), /timeout/);
  f.complete(run.dispatch, { phase: 'uncertain' });
  assert.equal((await run.result).value.phase, 'uncertain');
  assert.equal((await f.controller.remote.execute(run.command)).value.phase, 'uncertain');
  assert.equal(f.calls.length, 1);
});

test('native ACK arriving after dispatch timeout updates the original operation without renderer ACK or resend', async t => {
  const f = await fixture(t, { timeoutMs: 70 }), run = await f.begin(), native = f.native(run.dispatch), ack = deferred();
  f.session.request = async method => {
    if (method === 'message/status') return { accepted: false, rejected: false };
    f.calls.push({ method }); return ack.promise;
  };
  const sent = f.host.request(f.record, f.id, native.method, native.params);
  assert.equal((await run.result).value.phase, 'uncertain');
  ack.resolve({ turn: { id: 'late-turn', status: 'inProgress' } });
  await sent;
  const result = await f.operation(run.command.requestId);
  assert.equal(result.value.phase, 'accepted');
  assert.equal(result.value.operationId, run.dispatch.operation.operationId);
  assert.equal(result.value.executionTurnId, 'late-turn');
  assert.throws(() => f.complete(run.dispatch, { phase: 'accepted', turnId: 'late-turn' }), /REMOTE_BLOCKED/);
  assert.equal((await f.controller.remote.execute(run.command)).value.phase, 'accepted');
  assert.equal(f.calls.length, 1);
});

test('restoring an existing runtime retains local permission controls but invalidates the old remote target', async t => {
  const f = await fixture(t);
  f.snapshot.ready = false; f.snapshot.phase = 'unavailable'; f.snapshot.blockers = ['restoring'];
  const unavailable = await f.publish();
  assert.equal(unavailable.enabled, true);
  assert.equal(unavailable.canEnable, false);
  assert.equal(unavailable.target, null);
  assert.equal((await f.controller.remote.execute({ requestId: 'during-restore', kind: 'send', target: f.target, text: 'must not run' })).ok, false);
  f.snapshot.ready = true; f.snapshot.phase = 'idle'; f.snapshot.blockers = [];
  const restored = await f.publish();
  assert.ok(restored.target.generation > f.target.generation);
  assert.equal((await f.controller.remote.getThreadState(f.target)).error.code, 'stale_target');
  assert.equal(f.calls.length, 0);
});

test('Claude steer ACK does not complete on the original turn; exact follow-up UUID completes once', async t => {
  const f = await fixture(t, { provider: 'claude' });
  Object.assign(f.snapshot, { phase: 'running', activeTurnId: 'turn-A', actions: { send: false, enqueue: true, steer: true, stop: true } });
  f.session.activeThreadTurns.set(f.session.currentThreadId, 'turn-A'); await f.publish();
  const run = await f.begin('steer', 'claude-steer', { expectedTurnId: 'turn-A' }), native = f.native(run.dispatch);
  await f.host.request(f.record, f.id, native.method, native.params);
  f.complete(run.dispatch, { phase: 'accepted', turnId: 'turn-A' }); await run.result;
  const completed = (turnId, ids) => f.host.observe(f.id, 'notification', { method: 'turn/completed', params: { threadId: f.session.currentThreadId,
    turn: { id: turnId, status: 'completed', items: ids.map(id => ({ id, type: 'userMessage' })) } } });
  completed('turn-A', ['unrelated']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.operation('claude-steer')).value.phase, 'accepted');
  completed('turn-B', [run.dispatch.operation.clientUserMessageId]);
  const result = await eventually(() => f.operation('claude-steer'), value => value.value?.phase === 'completed');
  assert.equal(result.value.executionTurnId, 'turn-B');
  assert.equal(result.value.expectedTurnId, 'turn-A');
  assert.equal(f.calls.length, 1);
});

test('approval/question signals and answers contain only permitted text, and revoke blocks event rereads', async t => {
  const f = await fixture(t), notices = [];
  f.controller.remote.subscribe(notice => notices.push(notice));
  for (const reason of ['approval', 'question']) {
    f.snapshot.blockers = [reason]; f.snapshot.phase = 'blocked';
    f.snapshot.rawToolArguments = { secret: 'tool argument must stay local' };
    await f.publish();
  }
  const answer = { answerId: 'answer-final', turnId: 'turn-final', text: 'Permitted final answer', completedAt: null, truncated: false };
  await f.host.publishAnswer(f.record, f.id, { ...answer, tools: ['private-command'] });
  await new Promise(resolve => setImmediate(resolve));
  const events = await Promise.all(notices.map(notice => f.controller.remote.readEvent(notice.eventId)));
  assert.equal(events.filter(event => event.value?.kind === 'computer_action_required').length, 2);
  const emitted = events.find(event => event.value?.kind === 'answer_ready');
  assert.deepEqual(emitted.value.answer, answer);
  assert.equal(JSON.stringify(events).includes('tool argument must stay local'), false);
  assert.equal(JSON.stringify(events).includes('private-command'), false);
  await f.enable(false);
  assert.equal((await f.controller.remote.readEvent(emitted.value.eventId)).error.code, 'access_denied');
});

test('Claude steer reconciliation uses exact completed history UUID without requiring item.turnId', async t => {
  const f = await fixture(t, { provider: 'claude' });
  Object.assign(f.snapshot, { phase: 'running', activeTurnId: 'turn-A', actions: { send: false, enqueue: true, steer: true, stop: true } });
  f.session.activeThreadTurns.set(f.session.currentThreadId, 'turn-A'); await f.publish();
  const run = await f.begin('steer', 'history-steer', { expectedTurnId: 'turn-A' }), native = f.native(run.dispatch);
  await f.host.request(f.record, f.id, native.method, native.params);
  f.complete(run.dispatch, { phase: 'accepted', turnId: 'turn-A' }); await run.result;
  const item = { id: run.dispatch.operation.clientUserMessageId, type: 'userMessage' };
  let consumed = false;
  f.session.request = async method => method === 'message/status'
    ? { accepted: true, turnId: 'turn-A', status: 'completed', item }
    : { thread: { id: f.session.currentThreadId, turns: [{ id: 'turn-B', status: 'completed', items: consumed ? [item] : [] }] } };
  assert.equal((await f.operation('history-steer')).value.phase, 'accepted', 'cached old echo is not consumption proof');
  consumed = true;
  const result = await f.operation('history-steer');
  assert.equal(result.value.phase, 'completed');
  assert.equal(result.value.executionTurnId, 'turn-B');
});
