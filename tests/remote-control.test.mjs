import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteControl } from '../electron/remote-control.mjs';
import { createRemoteControlStore } from '../electron/remote-control-store.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const idle = () => ({ revision: 1, phase: 'idle', activeTurnId: null, queue: { count: 0, limit: 50, paused: false }, blockers: [],
  actions: { send: true, enqueue: true, steer: false, stop: false }, requiresComputer: false });
async function fixture(t, options = {}) {
  const folder = options.folder || await mkdtemp(path.join(os.tmpdir(), 'kuzmich-remote-'));
  if (!options.folder) t.after(() => rm(folder, { recursive: true, force: true }));
  const backing = createRemoteControlStore(folder), store = options.store?.(backing) || backing;
  const controller = createRemoteControl({ userData: folder, store });
  await controller.start(); t.after(() => controller.stop());
  const state = idle(), calls = [], pending = [];
  const settings = { model: 'live-model', effort: 'ultra', access: 'rules' };
  const adapter = { sessionId: 'fixture-session', runtimeId: 'fixture-runtime', provider: options.provider || 'codex',
    threadId: options.provider === 'claude' ? 'claude:aaaaaaaa-1111-2222-3333-444444444444' : 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: path.join(folder, 'project'), title: 'Разрешённая беседа', ready: true, getState: async () => state,
    dispatch: async ({ command, operation }) => {
      if (command.kind === 'enqueue') { pending.push({ command, operation }); state.queue.count++; return { phase: 'queued', queuePosition: state.queue.count }; }
      const permit = await controller.authorizeTransport({ operationId: operation.operationId, target: operation.target, kind: operation.kind,
        clientUserMessageId: operation.clientUserMessageId, expectedTurnId: operation.expectedTurnId });
      controller.consumeTransportPermit(permit);
      calls.push({ command, operation, settings: { ...settings } });
      return { phase: 'accepted', turnId: command.kind === 'stop' || command.kind === 'steer' ? command.expectedTurnId : `turn-${calls.length}` };
    },
    cancelPending: async ({ operationIds }) => { for (let i = pending.length - 1; i >= 0; i--) if (operationIds.includes(pending[i].operation.operationId)) { pending.splice(i, 1); state.queue.count--; } },
  };
  await controller.registerRuntime(adapter);
  const enable = async enabled => { const current = await controller.getThreadAccess(adapter.sessionId); return controller.setThreadAccess(adapter.sessionId, { enabled,
    expected: { provider: current.provider, threadId: current.threadId, accessRevision: current.accessRevision } }); };
  return { controller, remote: controller.remote, folder, backing, adapter, state, calls, settings, pending, enable,
    command: (target, requestId = 'request-1', kind = 'send', extra = {}) => ({ requestId, target, kind, ...(kind === 'stop' ? {} : { text: 'Проверь проект' }), ...extra }) };
}

test('access defaults off, local CAS binds exact provider/thread/project and remote facade cannot grant itself access', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.remote.listThreads()).value, []);
  assert.equal(f.remote.setThreadAccess, undefined);
  const before = await f.controller.getThreadAccess(f.adapter.sessionId);
  await assert.rejects(f.controller.setThreadAccess(f.adapter.sessionId, { enabled: true, expected: { ...before, threadId: 'different' } }), /Адрес/);
  const { target } = await f.enable(true);
  assert.equal(target.provider, 'codex'); assert.equal(target.threadId, f.adapter.threadId);
  assert.notEqual(target.projectKey, f.adapter.cwd);
  assert.equal((await f.remote.listThreads()).value[0].target.sessionId, f.adapter.sessionId);
  assert.equal((await f.remote.listThreads()).value[0].projectLabel, 'project');
  for (const field of ['provider', 'threadId', 'projectKey', 'sessionId', 'runtimeId', 'generation']) {
    const forged = { ...target, [field]: field === 'provider' ? 'claude' : field === 'generation' ? 42 : 'different' };
    assert.equal((await f.remote.getThreadState(forged)).ok, false, field);
  }
});

test('same runtime refresh preserves binding, duplicate owners and reconnect invalidate old targets', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  const same = await f.controller.registerRuntime({ ...f.adapter, getState: async () => ({ ...f.state }) });
  assert.deepEqual(same.target, target);
  await f.controller.registerRuntime({ ...f.adapter, sessionId: 'second', runtimeId: 'second-runtime' });
  assert.equal((await f.remote.getThreadState(target)).error.code, 'ambiguous_owner');
  assert.equal((await f.remote.listThreads()).value[0].availability, 'ambiguous');
  await f.controller.unregisterRuntime('second');
  const restored = await f.controller.getThreadAccess(f.adapter.sessionId);
  assert.ok(restored.target.generation > target.generation);
  assert.equal((await f.remote.execute(f.command(target))).error.code, 'stale_target');
  assert.equal(f.calls.length, 0);
  await f.controller.registerRuntime({ ...f.adapter, runtimeId: 'replacement' });
  assert.equal((await f.remote.getThreadState(restored.target)).error.code, 'stale_target');
});

test('durable reservation precedes transport; request ID duplicates never resend; identical text with new IDs is distinct', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  const dispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => {
    const persisted = JSON.parse(await readFile(f.backing.filename, 'utf8'));
    assert.equal(persisted.operations[0].operationId, payload.operation.operationId);
    assert.equal(persisted.operations[0].stage, 'delegated');
    return dispatch(payload);
  };
  await f.controller.registerRuntime(f.adapter);
  const [first, duplicate] = await Promise.all([f.remote.execute(f.command(target)), f.remote.execute(f.command(target))]);
  assert.equal(first.value.operationId, duplicate.value.operationId);
  assert.equal(f.calls.length, 1);
  const repeated = await f.remote.execute(f.command(target));
  assert.equal(repeated.value.phase, 'accepted'); assert.equal(f.calls.length, 1);
  assert.equal((await f.remote.execute(f.command(target, 'request-1', 'send', { text: 'Другой текст' }))).error.code, 'request_conflict');
  f.adapter.dispatch = dispatch; await f.controller.registerRuntime(f.adapter);
  const another = await f.remote.execute(f.command(target, 'request-2'));
  assert.notEqual(another.value.clientUserMessageId, first.value.clientUserMessageId); assert.equal(f.calls.length, 2);
  const encoded = JSON.stringify(first);
  assert.equal(encoded.includes('Проверь проект'), false); assert.equal(encoded.includes('live-model'), false);
});

test('input is strict and remote cannot override live model, effort, permissions, files or native commands', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  for (const extra of [{ model: 'replacement' }, { effort: 'none' }, { access: 'danger-full-access' }, { attachments: [] }, { text: '/compact' }, { text: ' ' }, { text: 'x'.repeat(32001) }]) {
    assert.equal((await f.remote.execute(f.command(target, 'invalid', 'send', extra))).error.code, 'invalid_command');
  }
  f.settings.model = 'changed-live-model';
  const sent = await f.remote.execute(f.command(target));
  assert.equal(sent.value.phase, 'accepted');
  assert.deepEqual(f.calls[0].settings, { model: 'changed-live-model', effort: 'ultra', access: 'rules' });
});

test('shared sender arbitrates simultaneous local and phone work without touching the local draft', async t => {
  const f = await fixture(t), { target } = await f.enable(true), local = deferred();
  let reserved = false, draft = 'Локальный черновик';
  const oldDispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => {
    if (reserved) return { phase: 'blocked', error: { code: 'blocked', reason: 'busy' } };
    reserved = true; try { return await oldDispatch(payload); } finally { reserved = false; }
  };
  await f.controller.registerRuntime(f.adapter);
  const localSend = async () => { if (reserved) return false; reserved = true; await local.promise; reserved = false; return true; };
  const pc = localSend();
  const phone = await f.remote.execute(f.command(target));
  assert.equal(phone.value.phase, 'blocked'); assert.equal(f.calls.length, 0); assert.equal(draft, 'Локальный черновик');
  local.resolve(); await pc;
  assert.equal((await f.remote.execute(f.command(target, 'next'))).value.phase, 'accepted'); assert.equal(draft, 'Локальный черновик');
});

test('one FIFO includes local entries, honors limit and pause, and remote enqueue never clears draft', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  f.state.queue.count = 49; f.state.queue.paused = true;
  f.state.actions.send = false;
  assert.equal((await f.remote.execute(f.command(target, 'direct'))).value.error.reason, 'queue_not_empty');
  const queued = await f.remote.execute(f.command(target, 'queued', 'enqueue'));
  assert.equal(queued.value.phase, 'queued'); assert.equal(queued.value.queuePosition, 50); assert.equal(f.state.queue.paused, true);
  assert.equal((await f.remote.execute(f.command(target, 'full', 'enqueue'))).value.error.code, 'queue_full');
  assert.equal(f.pending.length, 1); assert.equal(f.calls.length, 0);
  await assert.rejects(f.controller.authorizeTransport({ operationId: queued.value.operationId, target, kind: 'enqueue', clientUserMessageId: queued.value.clientUserMessageId }), /недоступно/);
});

test('approval, question, terminal and restore hold sends; approval can queue and only matching active turn can stop', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  for (const reason of ['approval', 'question', 'terminal', 'restoring', 'uncertain_delivery', 'closing']) {
    Object.assign(f.state, { ...idle(), blockers: [reason] });
    const result = await f.remote.execute(f.command(target, reason));
    assert.equal(result.value.phase, 'blocked'); assert.equal(f.calls.length, 0);
  }
  Object.assign(f.state, idle(), { phase: 'running', activeTurnId: 'turn-A', blockers: ['approval'], actions: { send: false, enqueue: true, steer: false, stop: true } });
  assert.equal((await f.remote.execute(f.command(target, 'during-approval', 'enqueue'))).value.phase, 'queued');
  const stopped = await f.remote.execute(f.command(target, 'stop', 'stop', { expectedTurnId: 'turn-A' }));
  assert.equal(stopped.value.phase, 'accepted'); assert.equal(f.calls[0].command.kind, 'stop');
  f.state.activeTurnId = 'turn-B';
  const stale = await f.remote.execute(f.command(target, 'old-button', 'stop', { expectedTurnId: 'turn-A' }));
  assert.equal(stale.value.phase, 'stale'); assert.equal(f.calls.length, 1);
});

test('revocation fences pending commands and event reads without interrupting accepted work', async t => {
  const f = await fixture(t), { target } = await f.enable(true), notices = [];
  const unsubscribe = f.remote.subscribe(notice => notices.push(notice));
  const accepted = await f.remote.execute(f.command(target, 'working'));
  const queued = await f.remote.execute(f.command(target, 'waiting', 'enqueue'));
  await f.controller.publishAnswer({ sessionId: f.adapter.sessionId, runtimeId: f.adapter.runtimeId, answer: { answerId: 'answer', turnId: 'turn-1', text: 'Разрешённый текст', completedAt: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(notices.length); assert.deepEqual(Object.keys(notices[0]), ['eventId']);
  const oldEvent = notices.at(-1).eventId;
  assert.equal((await f.remote.readEvent(oldEvent)).ok, true);
  await f.enable(false);
  assert.equal((await f.remote.readEvent(oldEvent)).error.code, 'access_denied');
  assert.equal((await f.remote.getOperation({ target, requestId: 'working' })).error.code, 'access_denied');
  assert.equal(f.pending.length, 0); assert.equal(f.calls.length, 1, 'revocation must not call interrupt');
  const ledger = JSON.parse(await readFile(f.backing.filename, 'utf8'));
  assert.equal(ledger.operations.find(value => value.operationId === queued.value.operationId).phase, 'cancelled');
  assert.equal(ledger.operations.find(value => value.operationId === accepted.value.operationId).phase, 'accepted');
  unsubscribe();
});

test('one-shot permit detects revoke or runtime change after durable authorization, before actual RPC', async t => {
  const f = await fixture(t), { target } = await f.enable(true), gotPermit = deferred(), continueDispatch = deferred();
  f.adapter.dispatch = async ({ operation }) => {
    const permit = await f.controller.authorizeTransport({ operationId: operation.operationId, target, kind: operation.kind, clientUserMessageId: operation.clientUserMessageId });
    gotPermit.resolve(permit); await continueDispatch.promise;
    f.controller.consumeTransportPermit(permit); f.calls.push('would-send'); return { phase: 'accepted' };
  };
  await f.controller.registerRuntime(f.adapter);
  const sending = f.remote.execute(f.command(target));
  const permit = await gotPermit.promise;
  await f.enable(false); continueDispatch.resolve();
  await sending;
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.controller.consumeTransportPermit(permit));
});

test('delivery timeout stays uncertain until exact late ACK; same text or absent history is not rejection', async t => {
  const f = await fixture(t), { target } = await f.enable(true), dispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => { await dispatch(payload); throw new Error('ACK lost'); };
  f.adapter.reconcile = async () => ({ accepted: false, rejected: false });
  await f.controller.registerRuntime(f.adapter);
  const result = await f.remote.execute(f.command(target));
  assert.equal(result.value.phase, 'uncertain'); assert.equal(f.calls.length, 1);
  assert.equal((await f.remote.getOperation({ target, requestId: 'request-1' })).value.phase, 'uncertain');
  await f.controller.observeReceipt({ ...f.adapter, clientUserMessageId: 'wrong-id', accepted: true, turnId: 'turn-1' });
  assert.equal((await f.remote.execute(f.command(target))).value.phase, 'uncertain'); assert.equal(f.calls.length, 1);
  await f.controller.observeReceipt({ ...f.adapter, clientUserMessageId: result.value.clientUserMessageId, accepted: true, turnId: 'turn-1' });
  assert.equal((await f.remote.getOperation({ target, requestId: 'request-1' })).value.phase, 'accepted');
  await f.controller.recordCompletion({ ...f.adapter, turnId: 'turn-1', status: 'completed' });
  assert.equal((await f.remote.getOperation({ target, requestId: 'request-1' })).value.phase, 'completed'); assert.equal(f.calls.length, 1);
});

test('restart fences old target, keeps uncertain journal and reconciles by fresh target without replay', async t => {
  const f = await fixture(t), { target } = await f.enable(true), dispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => { await dispatch(payload); throw new Error('closed connection'); };
  await f.controller.registerRuntime(f.adapter);
  const sent = await f.remote.execute(f.command(target));
  await f.controller.stop();
  const next = createRemoteControl({ userData: f.folder }); t.after(() => next.stop()); await next.start();
  let nativeCalls = 0;
  await next.registerRuntime({ ...f.adapter, sessionId: 'restored', runtimeId: 'restored-runtime', dispatch: async () => { nativeCalls++; },
    reconcile: async ({ clientUserMessageId }) => ({ accepted: clientUserMessageId === sent.value.clientUserMessageId, rejected: false, turnId: 'turn-1', status: 'completed' }) });
  const fresh = (await next.getThreadAccess('restored')).target;
  assert.ok(fresh.generation > target.generation);
  assert.equal((await next.remote.execute(f.command(target))).error.code, 'stale_target');
  const reconciled = await next.remote.getOperation({ target: fresh, requestId: 'request-1' });
  assert.equal(reconciled.value.phase, 'completed'); assert.deepEqual(reconciled.value.target, target); assert.equal(nativeCalls, 0);
});

test('save failure before operation reservation or before transport prevents native call', async t => {
  for (const failStage of ['received', 'dispatching']) {
    let armed = false;
    const f = await fixture(t, { store: backing => ({ read: () => backing.read(), flush: () => backing.flush(), save: async value => {
      if (armed && value.operations.some(item => failStage === 'received' ? item.phase === 'received' : item.stage === 'dispatching')) throw new Error('disk full');
      await backing.save(value);
    } }) });
    const { target } = await f.enable(true); armed = true;
    const result = await f.remote.execute(f.command(target));
    assert.equal(f.calls.length, 0);
    if (failStage === 'received') assert.equal(result.error.code, 'persistence_failed');
    else assert.equal(result.value.phase, 'uncertain');
  }
});

test('save failure after native ACK returns conservative uncertainty and durable dispatching survives restart', async t => {
  let armed = false;
  const f = await fixture(t, { store: backing => ({ read: () => backing.read(), flush: () => backing.flush(), save: async value => {
    if (armed && value.operations.some(item => item.phase === 'accepted')) throw new Error('disk full after write');
    await backing.save(value);
  } }) });
  const { target } = await f.enable(true); armed = true;
  const result = await f.remote.execute(f.command(target));
  assert.equal(result.value.phase, 'uncertain'); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await readFile(f.backing.filename, 'utf8')).operations[0].stage, 'dispatching');
});

test('Claude steer ACK can execute in a later turn, never completes from the old turn alone', async t => {
  const f = await fixture(t, { provider: 'claude' }), { target } = await f.enable(true);
  Object.assign(f.state, { phase: 'running', activeTurnId: 'turn-A', actions: { send: false, enqueue: true, steer: true, stop: true } });
  const result = await f.remote.execute(f.command(target, 'steer', 'steer', { expectedTurnId: 'turn-A' }));
  assert.equal(result.value.phase, 'accepted');
  await f.controller.recordCompletion({ ...f.adapter, turnId: 'turn-A', status: 'completed', clientUserMessageIds: ['unrelated'] });
  assert.equal((await f.remote.getOperation({ target, requestId: 'steer' })).value.phase, 'accepted');
  await f.controller.recordCompletion({ ...f.adapter, turnId: 'turn-B', status: 'completed', clientUserMessageIds: [result.value.clientUserMessageId] });
  const completed = (await f.remote.getOperation({ target, requestId: 'steer' })).value;
  assert.equal(completed.phase, 'completed'); assert.equal(completed.executionTurnId, 'turn-B'); assert.equal(completed.expectedTurnId, 'turn-A');
  assert.equal((await f.remote.execute(f.command(target, 'steer', 'steer', { expectedTurnId: 'turn-A' }))).value.phase, 'completed');
  assert.equal(f.calls.length, 1);
});

test('own pending reservation can authorize once but cannot mask another uncertain delivery', async t => {
  const f = await fixture(t), { target } = await f.enable(true), dispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => {
    f.state.blockers = ['uncertain_delivery']; f.state.reservationOperationId = payload.operation.operationId;
    return dispatch(payload);
  };
  await f.controller.registerRuntime(f.adapter);
  assert.equal((await f.remote.execute(f.command(target))).value.phase, 'accepted');
  assert.equal((await f.remote.getThreadState(target)).value.reservationOperationId, undefined, 'private reservation marker never leaves controller');
  delete f.state.reservationOperationId;
  assert.equal((await f.remote.execute(f.command(target, 'other'))).value.phase, 'blocked');
  assert.equal(f.calls.length, 1);
});

test('completion arriving before ACK is retained and the late ACK completes the exact operation', async t => {
  const f = await fixture(t), { target } = await f.enable(true), dispatch = f.adapter.dispatch;
  f.adapter.dispatch = async payload => {
    const result = await dispatch(payload);
    await f.controller.recordCompletion({ ...f.adapter, turnId: result.turnId, status: 'completed' });
    return result; // RPC ACK can be delivered after turn/completed
  };
  await f.controller.registerRuntime(f.adapter);
  const result = await f.remote.execute(f.command(target));
  assert.equal(result.value.phase, 'completed'); assert.equal(result.value.outcome, 'succeeded'); assert.equal(f.calls.length, 1);
});

test('live final answer remains readable while the adapter snapshot has not caught up', async t => {
  const f = await fixture(t), { target } = await f.enable(true);
  await f.controller.registerRuntime({ ...f.adapter, getLastAnswer: async () => null });
  await f.controller.publishAnswer({ ...f.adapter, answer: { answerId: 'answer', turnId: 'turn', text: 'Готово', completedAt: null } });
  assert.equal((await f.remote.getLastAnswer(target)).value.text, 'Готово');
});
