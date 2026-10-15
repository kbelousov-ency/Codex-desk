import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotStore } from '../electron/update-checkpoint.mjs';
import ts from 'typescript';
import * as turnWork from '../src/turn-work.ts';
import * as cacheHistory from '../src/cache-history.ts';

// Run the actual hooks with deterministic React scheduling. The bridge below is
// entirely in memory: no Electron, CLI, Telegram or model requests are made.
const sources = new Map(await Promise.all(['useCodex', 'useMessageQueue'].map(async name => [name,
  ts.transpileModule(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
])));
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
function hookHarness(name, argumentsForRender) {
  const slots = [];
  let cursor = 0, scheduled = false, mounted = true, effects = [], value;
  const schedule = () => {
    if (scheduled || !mounted) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (mounted) render(); });
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      const set = next => {
        const previous = slots[index].value;
        const result = typeof next === 'function' ? next(previous) : next;
        if (!Object.is(previous, result)) { slots[index].value = result; schedule(); }
      };
      return [slots[index].value, set];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.dependencies, dependencies)) slots[index] = { dependencies, callback };
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (sameDeps(slots[index]?.dependencies, dependencies)) return;
      const cleanup = slots[index]?.cleanup;
      slots[index] = { dependencies };
      effects.push(() => { cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const module = { exports: {} };
  const dependencies = { react, './AgentContext': { agentName: provider => provider === 'claude' ? 'Claude Code' : 'Codex' }, './turn-work': turnWork, './cache-history': cacheHistory };
  new Function('require', 'module', 'exports', sources.get(name))(key => {
    assert.ok(key in dependencies, `Unexpected hook dependency ${key}`);
    return dependencies[key];
  }, module, module.exports);
  function render() {
    cursor = 0; effects = [];
    value = module.exports[name](...argumentsForRender());
    for (const effect of effects) effect();
    return value;
  }
  render();
  return { get current() { return value; }, render, dispose() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const targetFor = provider => ({ grantId: 'grant-1', generation: 2, provider, threadId: provider === 'claude' ? 'claude:thread-1' : 'thread-1', projectKey: 'project-1', sessionId: 'session-1', runtimeId: 'runtime-1' });
const context = (kind = 'send', fields = {}) => ({ operationId: crypto.randomUUID(), target: targetFor('codex'), kind, clientUserMessageId: kind === 'stop' ? null : crypto.randomUUID(), ...fields });

async function codexFixture(t, { provider = 'codex', restorePendingMessage } = {}) {
  const target = targetFor(provider), calls = [], persisted = [], listeners = new Set();
  const thread = { id: target.threadId, provider, cwd: 'E:/fixtures/remote', turns: [] };
  let hook;
  const fixture = { calls, persisted, thread, target, allow: true, flush: async () => {}, request: null };
  const emit = (method, params) => { for (const listener of listeners) listener({ type: 'notification', data: { method, params: { threadId: thread.id, ...params } } }); };
  const bridge = {
    getSettings: async () => ({ provider, cwd: thread.cwd, model: 'effective-model', effort: 'high', access: 'auto' }),
    setSettings: async () => {},
    start: async () => ({ provider, cwd: thread.cwd, capabilities: { steer: true }, models: [], executable: 'fixture', config: {} }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (fixture.request) { const result = await fixture.request(method, params); if (result !== undefined) return result; }
      if (method === 'thread/list') return { data: [thread] };
      if (method === 'thread/resume' || method === 'thread/read') return { thread: structuredClone(thread), model: 'actual-resumed-model', reasoningEffort: 'max' };
      if (method === 'usage/read') return { available: false };
      if (method === 'message/status') return { accepted: false, rejected: false };
      if (method === 'turn/start') { emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } }); return { turn: { id: 'turn-1', status: 'inProgress' } }; }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId, userMessageId: params.clientUserMessageId };
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected fixture method ${method}`);
    },
    saveImages: async images => fixture.saveImages ? fixture.saveImages(images) : images,
    openTerminal: async () => ({ threadId: thread.id }),
  };
  const options = {
    restorePendingMessage,
    canDispatchRemote: remote => fixture.allow && JSON.stringify(remote.target) === JSON.stringify(target),
    canStartMessage: id => !fixture.queueHead || fixture.queueHead === id,
    async flushPendingMessage() { persisted.push(structuredClone(hook.current.getRemoteSnapshot().pendingMessage)); await fixture.flush(); },
  };
  hook = hookHarness('useCodex', () => [bridge, options]);
  t.after(() => hook.dispose());
  await settle();
  assert.equal(hook.current.connection, 'ready');
  assert.equal(await hook.current.resume(thread), true);
  await settle();
  fixture.emit = emit;
  fixture.serverRequest = method => { for (const listener of listeners) listener({ type: 'serverRequest', data: { id: 'request-1', method, params: { threadId: thread.id } } }); };
  fixture.begin = (id = 'turn-A') => emit('turn/started', { turn: { id, status: 'inProgress' } });
  fixture.complete = (id = 'turn-A') => emit('turn/completed', { turn: { id, status: 'completed', items: [] } });
  Object.defineProperty(fixture, 'current', { get: () => hook.current });
  return fixture;
}

test('remote preflight reserves the same sender against PC, FIFO and pings, persists exact UUID, and reads live settings', async t => {
  const f = await codexFixture(t), gate = deferred(), remote = context();
  f.flush = () => gate.promise;
  const sending = f.current.send('Телефон', [], false, undefined, remote);
  assert.equal(f.current.getRemoteSnapshot().busy, true);
  assert.equal(f.current.getRemoteSnapshot().dispatching, true);
  assert.equal(await f.current.send('ПК', []), false);
  assert.equal(await f.current.sendPing('ping'), false);
  assert.equal(f.current.canSendQueued(), false);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(f.persisted[0].clientUserMessageId, remote.clientUserMessageId);
  assert.equal(f.persisted[0].origin, 'remote');
  f.current.selectEffort('low');
  await settle();
  gate.resolve();
  assert.equal(await sending, true);
  const [start] = f.calls.filter(call => call.method === 'turn/start');
  assert.equal(start.params.clientUserMessageId, remote.clientUserMessageId);
  assert.equal(start.params.model, 'actual-resumed-model');
  assert.equal(start.params.effort, 'low');
  assert.equal(start.params.approvalsReviewer, 'auto_review');
  assert.deepEqual(start.params._remote, remote);
  assert.equal(f.current.getRemoteSnapshot().pendingMessage, null);
  assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
});

test('failed durability or revocation during flush prevents model RPC and releases preflight', async t => {
  for (const failure of ['disk', 'revoked']) {
    const f = await codexFixture(t), remote = context();
    f.flush = async () => { if (failure === 'disk') throw new Error('disk unavailable'); f.allow = false; };
    assert.equal(await f.current.send('same', [], false, undefined, remote), false);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
    assert.equal(f.current.getRemoteSnapshot().pendingMessage, null);
    assert.equal(f.current.getRemoteSnapshot().busy, false);
    assert.equal((await f.current.getMessageReceipt(remote.clientUserMessageId)).rejected, true);
  }
});

test('the synchronous FIFO gate prevents PC sends and pings from passing a newly enqueued phone message', async t => {
  const f = await codexFixture(t), queue = queueFixture(t), remote = context('enqueue');
  // No render occurs between enqueue and the attempted direct composer send.
  queue.session.busy = true;
  assert.equal(queue.current.enqueue('phone first', [], { remote }), true);
  f.queueHead = queue.current.snapshot().items[0].id;
  assert.equal(await f.current.send('PC second', []), false);
  assert.equal(await f.current.sendPing('ping'), false);
  assert.equal(await f.current.send('phone first', [], false, remote.clientUserMessageId, remote), true);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  const g = await codexFixture(t), images = deferred();
  g.saveImages = () => images.promise;
  const preparing = g.current.send('PC preparing images', [{ name: 'fixture', dataUrl: 'fixture' }]);
  g.queueHead = remote.clientUserMessageId;
  images.resolve([]);
  assert.equal(await preparing, false);
  assert.equal(g.current.getRemoteSnapshot().busy, false, 'A cancelled preflight releases the shared reservation');
  assert.equal(g.calls.some(call => call.method === 'turn/start'), false);
});

test('ambiguous remote failure retains origin and exact identity; matching text is no receipt and late ACK resolves without retry', async t => {
  const f = await codexFixture(t), remote = context();
  f.request = async (method, params) => {
    if (method === 'turn/start') {
      f.begin('turn-unknown');
      f.emit('item/completed', { turnId: 'turn-unknown', item: { id: 'other', clientId: 'different-id', type: 'userMessage', content: params.input } });
      throw new Error('unclassified pipe failure after possible write');
    }
  };
  assert.equal(await f.current.send('same', [], false, undefined, remote), false);
  assert.equal(f.current.getRemoteSnapshot().pendingMessage.origin, 'remote');
  assert.equal(f.current.getRemoteSnapshot().pendingMessage.clientUserMessageId, remote.clientUserMessageId);
  assert.equal((await f.current.getMessageReceipt(remote.clientUserMessageId)).accepted, false);
  assert.equal(await f.current.send('same', []), false);
  f.emit('message/receipt', { clientUserMessageId: remote.clientUserMessageId, accepted: true, turnId: 'turn-unknown', status: 'inProgress' });
  const receipt = await f.current.reconcileMessage();
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.message.origin, 'remote', 'App can preserve an identical PC draft');
  assert.equal(f.current.getRemoteSnapshot().pendingMessage, null);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('known host pre-dispatch denial is rejected, while restored uncertain cannot auto-send', async t => {
  const f = await codexFixture(t), remote = context();
  f.request = async method => { if (method === 'turn/start') throw new Error('REMOTE_BLOCKED: stale runtime'); };
  assert.equal(await f.current.send('x', [], false, undefined, remote), false);
  assert.equal(f.current.getRemoteSnapshot().pendingMessage, null);
  assert.equal((await f.current.getMessageReceipt(remote.clientUserMessageId)).rejected, true);
  const raced = await codexFixture(t), racedRemote = context();
  raced.request = async method => {
    if (method === 'turn/start') { raced.begin('native-background-turn'); throw new Error('REMOTE_BLOCKED: another native turn appeared'); }
  };
  assert.equal(await raced.current.send('x', [], false, undefined, racedRemote), false);
  assert.equal(raced.current.getRemoteSnapshot().activeTurnId, 'native-background-turn');
  assert.equal(raced.current.getRemoteSnapshot().busy, true, 'Rejecting an unissued command never fails a different native turn');
  const denied = await codexFixture(t), deniedRemote = context();
  denied.request = async method => {
    if (method === 'turn/start') throw new Error('Native server rejected this exact request');
    if (method === 'message/status') return { accepted: false, rejected: true };
  };
  assert.equal(await denied.current.send('x', [], false, undefined, deniedRemote), false);
  assert.equal(denied.current.getRemoteSnapshot().pendingMessage, null);
  assert.equal(denied.current.getRemoteSnapshot().busy, false);
  assert.equal((await denied.current.getMessageReceipt(deniedRemote.clientUserMessageId)).rejected, true);
  const saved = { threadId: remote.target.threadId, clientUserMessageId: remote.clientUserMessageId, kind: 'start', text: 'x', attachments: [], origin: 'remote', remote };
  const restored = await codexFixture(t, { restorePendingMessage: saved });
  assert.equal(restored.current.getRemoteSnapshot().pendingMessage.origin, 'remote');
  assert.equal(await restored.current.send('x', [], false, undefined, context()), false);
  assert.equal(restored.calls.some(call => call.method === 'turn/start'), false);
});

test('wrong recipient, approval/question and unfinished restoration block remote send', async t => {
  for (const method of ['item/tool/requestUserInput', 'item/commandExecution/requestApproval']) {
    const f = await codexFixture(t);
    assert.equal(await f.current.send('x', [], false, undefined, context('send', { target: { ...f.target, threadId: 'other' } })), false);
    f.serverRequest(method);
    assert.equal(await f.current.send('x', [], false, undefined, context()), false);
    assert.equal(f.current.getRemoteSnapshot().pendingRequests, 1);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  }
  const f = await codexFixture(t), gate = deferred();
  f.request = async method => method === 'thread/resume' ? gate.promise : undefined;
  const resume = f.current.resume(f.thread);
  assert.equal(f.current.getRemoteSnapshot().restoring, true);
  assert.equal(await f.current.send('x', [], false, undefined, context()), false);
  gate.resolve({ thread: f.thread }); await resume;
  const terminal = await codexFixture(t);
  assert.equal(await terminal.current.openTerminal(), true);
  assert.equal(terminal.current.getRemoteSnapshot().terminal, true);
  assert.equal(await terminal.current.send('x', [], false, undefined, context()), false);
  assert.equal(await terminal.current.steer('x', [], context('steer', { expectedTurnId: 'turn-A' })), false);
  assert.equal(await terminal.current.stop(context('stop', { expectedTurnId: 'turn-A' })), false);
});

test('steer and stop revalidate expected turn after durability and never target a successor', async t => {
  for (const kind of ['steer', 'stop']) {
    const f = await codexFixture(t), gate = deferred();
    f.begin(); await settle();
    const remote = context(kind, { expectedTurnId: 'turn-A' });
    f.flush = () => gate.promise;
    const sending = kind === 'steer' ? f.current.steer('уточнение', [], remote) : f.current.stop(remote);
    f.complete(); f.begin('turn-B');
    gate.resolve();
    assert.equal(await sending, false);
    assert.equal(f.current.getRemoteSnapshot().activeTurnId, 'turn-B');
    assert.equal(f.calls.some(call => ['turn/steer', 'turn/interrupt', 'turn/start'].includes(call.method)), false);
  }
});

test('Claude ACKed steer UUID can move to provider-owned follow-up without another prompt', async t => {
  const f = await codexFixture(t, { provider: 'claude' });
  f.begin(); await settle();
  const remote = context('steer', { target: f.target, expectedTurnId: 'turn-A' });
  assert.equal(await f.current.steer('позднее уточнение', [], remote), true);
  assert.equal((await f.current.getMessageReceipt(remote.clientUserMessageId)).accepted, true);
  f.complete();
  f.begin(remote.clientUserMessageId);
  f.emit('item/completed', { turnId: remote.clientUserMessageId, item: { id: remote.clientUserMessageId, clientId: remote.clientUserMessageId, type: 'userMessage', content: [{ type: 'text', text: 'позднее уточнение' }] } });
  const receipt = await f.current.getMessageReceipt(remote.clientUserMessageId);
  assert.equal(receipt.turnId, remote.clientUserMessageId);
  assert.equal(f.current.getRemoteSnapshot().activeTurnId, remote.clientUserMessageId);
  assert.equal(f.calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

function queueFixture(t, initial) {
  const calls = [], snapshots = [];
  let hook;
  const session = { busy: false, blocked: false, completion: 0, pause: { revision: 0, reason: '' },
    canSend: () => !session.busy, canRemote: () => true,
    async send(text, attachments, silent, id) { calls.push({ source: 'local', text, id }); session.busy = true; return true; },
    async sendRemote(text, attachments, remote) { calls.push({ source: 'remote', text, id: remote.clientUserMessageId }); session.busy = true; return true; },
    async flush() { snapshots.push(structuredClone(hook.current.snapshot())); },
    async reconcile() { return { accepted: false, rejected: false }; },
  };
  hook = hookHarness('useMessageQueue', () => [initial, session]);
  t.after(() => hook.dispose());
  return { session, calls, snapshots, get current() { return hook.current; }, render: () => hook.render(),
    async complete() { session.busy = false; session.completion++; hook.render(); await settle(); } };
}

test('one FIFO shares the 50 item limit, starts idle, orders same text with distinct UUIDs and preserves remote origin', async t => {
  const f = queueFixture(t), first = context('enqueue'), second = context('enqueue');
  assert.equal(f.current.enqueue('same', [], { remote: first }), true);
  assert.equal(f.current.enqueue('same', [], { remote: second }), true);
  assert.equal(f.current.enqueue('same', [], { remote: first }), false, 'Duplicate native IDs are not enqueued twice');
  for (let i = 0; i < 48; i++) assert.equal(f.current.enqueue('ПК', []), true);
  assert.equal(f.current.enqueue('51', []), false);
  await settle();
  assert.deepEqual(f.calls.map(call => call.id), [first.clientUserMessageId]);
  assert.equal(f.snapshots[0].items[0].state, 'uncertain');
  assert.deepEqual(f.snapshots[0].items[0].remote, first);
  await f.complete();
  assert.deepEqual(f.calls.map(call => call.id), [first.clientUserMessageId, second.clientUserMessageId]);
  await f.complete();
  assert.equal(f.calls[2].source, 'local');
});

test('queue cancellation removes only waiting remote records and a revoked flush cannot dispatch', async t => {
  const remote = context('enqueue'), uncertain = context('enqueue');
  const f = queueFixture(t, { paused: true, items: [
    { id: 'local', text: 'PC', attachments: [], state: 'waiting' },
    { id: remote.clientUserMessageId, text: 'waiting', attachments: [], state: 'waiting', remote },
    { id: uncertain.clientUserMessageId, text: 'uncertain', attachments: [], state: 'uncertain', remote: uncertain },
  ] });
  f.current.edit(remote.clientUserMessageId, 'mutated immutable command', []);
  f.current.remove(remote.clientUserMessageId);
  assert.equal(f.current.snapshot().items.find(item => item.id === remote.clientUserMessageId).text, 'waiting');
  assert.deepEqual(f.current.cancelRemote(() => true), [remote.clientUserMessageId]);
  assert.deepEqual(f.current.snapshot().items.map(item => item.id), ['local', uncertain.clientUserMessageId]);
  f.current.resume(); await settle();
  assert.equal(f.calls.length, 0, 'Restored uncertain keeps the shared FIFO paused');
  const g = queueFixture(t), gate = deferred();
  g.session.flush = () => gate.promise;
  assert.equal(g.current.enqueue('remote', [], { remote }), true);
  await settle();
  g.session.canRemote = () => false;
  gate.resolve(); await settle();
  assert.equal(g.calls.length, 0);
  assert.equal(g.current.snapshot().items.length, 0);
  assert.equal(g.current.snapshot().paused, true);
});

test('queue durability failure prevents sending; ambiguous remote result stays uncertain without timer retry', async t => {
  const f = queueFixture(t), remote = context('enqueue');
  f.session.flush = async () => { throw new Error('disk failure'); };
  assert.equal(f.current.enqueue('remote', [], { remote }), true);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.current.snapshot().items[0].state, 'waiting');
  assert.equal(f.current.snapshot().paused, true);
  const g = queueFixture(t);
  g.session.sendRemote = async () => false;
  assert.equal(g.current.enqueue('remote', [], { remote }), true);
  await settle();
  assert.equal(g.current.snapshot().items[0].state, 'uncertain');
  g.current.resume(); await g.complete();
  assert.equal(g.current.snapshot().paused, true);
  assert.equal(g.snapshots.length, 1);
  g.session.reconcile = async () => ({ accepted: false, rejected: true });
  await g.current.markWaiting(remote.clientUserMessageId);
  assert.equal(g.current.snapshot().items.length, 0, 'A proven rejection is discarded, not converted to a retry with the same remote ID');
  assert.equal(g.current.snapshot().paused, true);
  assert.equal(g.snapshots.length, 1);
});

test('remote enqueue admission barrier prevents an idle queue from sending before persistence succeeds', async t => {
  const f = queueFixture(t), remote = context('enqueue');
  assert.equal(f.current.enqueue('hold until admission', [], { remote, holdUntilPersisted: true }), true);
  await settle();
  assert.equal(f.calls.length, 0, 'The held head cannot race the controller flush');
  assert.equal(f.current.snapshot().items[0].state, 'waiting');

  // A failed controller/workspace admission removes the held item and leaves no
  // side effect for the queue effect to discover later.
  f.current.cancelRemote(value => value.operationId === remote.operationId);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.current.snapshot().items.length, 0);

  const committed = queueFixture(t), second = context('enqueue');
  assert.equal(committed.current.enqueue('release after admission', [], { remote: second, holdUntilPersisted: true }), true);
  await settle();
  assert.equal(committed.calls.length, 0);
  assert.equal(committed.current.releaseRemote(second.clientUserMessageId), true);
  await settle();
  assert.deepEqual(committed.calls.map(call => call.id), [second.clientUserMessageId]);
});

// Exercise the real writer beneath the real sender/FIFO hooks. Only the native
// transport is a fixture; filesystem errors are injected at the rename boundary.
async function writerForHooks(t, f, permanent, code) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-remote-writer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'workspace-state.json');
  const snapshot = queue => ({ version: 1, activeIndex: 0, tabs: [{
    cwd: f.thread.cwd, settings: { provider: 'codex' }, thread: f.thread, draft: 'PC draft', attachments: [],
    ...(queue ? { queue } : {}), ...(f.current.getRemoteSnapshot().pendingMessage ? { pendingMessage: f.current.getRemoteSnapshot().pendingMessage } : {}),
  }] });
  const previous = JSON.stringify(snapshot());
  await fs.writeFile(filename, previous);
  let attempts = 0;
  const store = createSnapshotStore(directory, { basename: 'workspace-state.json', platform: 'win32', sleep: async () => {},
    io: { ...fs, rename: async (...args) => {
      if (++attempts === 1 || permanent) throw Object.assign(new Error(`injected ${code}`), { code });
      await fs.rename(...args);
    } },
  });
  const save = async queue => { await store.save(snapshot(queue)); await store.flush(); };
  return { filename, previous, save, store, get attempts() { return attempts; } };
}

for (const code of ['EPERM', 'EBUSY']) for (const permanent of [false, true]) {
  test(`remote send with ${permanent ? 'permanent' : 'temporary'} writer ${code} makes ${permanent ? 0 : 1} native requests`, async t => {
    const f = await codexFixture(t), remote = context();
    const writer = await writerForHooks(t, f, permanent, code);
    f.flush = writer.save;
    f.request = async (method, params) => {
      if (method !== 'turn/start') return;
      const saved = JSON.parse(await fs.readFile(writer.filename, 'utf8')).tabs[0].pendingMessage;
      assert.equal(saved.clientUserMessageId, params.clientUserMessageId);
      assert.deepEqual(saved.remote, remote);
    };
    assert.equal(await f.current.send('phone', [], false, undefined, remote), !permanent);
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, permanent ? 0 : 1);
    assert.equal(writer.attempts, permanent ? 10 : 2);
    if (permanent) {
      await assert.rejects(writer.store.flush(), { code });
      assert.equal(await fs.readFile(writer.filename, 'utf8'), writer.previous);
      assert.equal((await f.current.getMessageReceipt(remote.clientUserMessageId)).rejected, true);
    } else {
      f.complete('turn-1'); await settle();
      assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    }
  });

  test(`FIFO with ${permanent ? 'permanent' : 'temporary'} writer ${code} preserves the native send barrier`, async t => {
    const f = await codexFixture(t), queue = queueFixture(t), remote = context('enqueue');
    const writer = await writerForHooks(t, f, permanent, code);
    f.flush = () => writer.save(queue.current.snapshot());
    queue.session.flush = () => writer.save(queue.current.snapshot());
    queue.session.sendRemote = (text, attachments, remote) => f.current.send(text, attachments, false, remote.clientUserMessageId, remote);
    f.request = async (method, params) => {
      if (method !== 'turn/start') return;
      const tab = JSON.parse(await fs.readFile(writer.filename, 'utf8')).tabs[0];
      assert.equal(tab.queue.items[0].state, 'uncertain');
      assert.equal(tab.pendingMessage.clientUserMessageId, params.clientUserMessageId);
    };
    assert.equal(queue.current.enqueue('phone FIFO', [], { remote }), true);
    assert.equal(queue.current.enqueue('phone FIFO', [], { remote }), false);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(permanent ? queue.current.snapshot().paused : !queue.current.snapshot().items.length)) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, permanent ? 0 : 1);
    assert.equal(writer.attempts, permanent ? 10 : 3, 'FIFO and pendingMessage each save once; only failed rename repeats');
    if (permanent) {
      const state = queue.current.snapshot();
      assert.equal(state.paused, true);
      assert.equal(state.items[0].state, 'waiting');
      assert.match(state.reason, /сохран/i);
      assert.equal(await fs.readFile(writer.filename, 'utf8'), writer.previous);
    } else {
      assert.equal(queue.current.snapshot().items.length, 0);
      f.complete('turn-1'); await queue.complete();
      assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    }
  });
}
