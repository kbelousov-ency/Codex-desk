import { EventEmitter } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadActionCoordinator, ThreadManagement } from '../electron/thread-management.mjs';
import { WindowSession } from '../electron/window-session.mjs';

const id = '01911111-1111-7111-8111-111111111111';
const childId = '01922222-2222-7222-8222-222222222222';
const otherId = '01933333-3333-7333-8333-333333333333';
const cwd = path.resolve('archive-test-project');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture() {
  const coordinator = new ThreadActionCoordinator(), calls = [], sessions = [], saved = [], restored = [];
  const threads = new Map([[id, { id, cwd, name: 'Original', historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'turn', items: [{ id: 'item', type: 'agentMessage', text: 'Hello' }] }] }]]);
  const archive = new Set([id]);
  let custom;
  class Client extends EventEmitter {
    async start() { return {}; }
    async request(method, params) {
      calls.push({ client: this, method, params });
      const overridden = custom?.(method, params, this);
      if (overridden !== undefined) return overridden;
      if (method === 'model/list') return { data: [], nextCursor: null };
      if (method === 'account/read') return { account: null };
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/list') return { data: [...archive].map(key => threads.get(key)), nextCursor: null };
      if (method === 'thread/read' || method === 'thread/resume') return { thread: threads.get(params.threadId) };
      if (method === 'thread/items/list') return { data: [{ turnId: 'paged-turn', item: { id: 'paged-item', type: 'agentMessage', text: 'Page' } }], nextCursor: params.cursor ? null : 'next' };
      if (method === 'thread/name/set') { threads.get(params.threadId).name = params.name; return {}; }
      if (method === 'thread/archive') { archive.add(params.threadId); this.emit('notification', { method: 'thread/archived', params: { threadId: params.threadId } }); return {}; }
      if (method === 'thread/delete') { threads.delete(params.threadId); archive.delete(params.threadId); this.emit('notification', { method: 'thread/deleted', params: { threadId: params.threadId } }); return {}; }
      if (method === 'thread/unarchive') { archive.delete(params.threadId); return { thread: threads.get(params.threadId) }; }
      if (method === 'thread/compact/start') return {};
      if (method === 'turn/start') return {};
      throw new Error(`Unexpected method ${method}`);
    }
    stop() { this.emit('status', { state: 'stopped' }); }
  }
  const createSession = settings => new WindowSession({ settings, threadActions: coordinator,
    resolveDirectory: async value => value, resolveExecutable: async value => value,
    createClient: () => new Client(), persistSettings: async patch => saved.push(patch) });
  const manager = new ThreadManagement({ coordinator, getSessions: () => sessions,
    getSettings: async () => ({ cwd: 'missing-saved-folder', executable: 'configured-codex', model: 'configured-model' }),
    resolveDirectory: async value => { if (value === 'missing-saved-folder') throw new Error('Missing'); return value; },
    fallbackCwd: cwd, createSession: settings => {
      const session = createSession(settings);
      session.persistSettings = async () => {};
      return session;
    }, onRestore: async folder => restored.push(folder) });
  const addSession = async (threadId = id) => {
    const session = createSession({ cwd, executable: 'configured-codex' });
    sessions.push(session); await session.start(); await session.request('thread/resume', { threadId }); return session;
  };
  return { manager, coordinator, calls, threads, archive, saved, restored, addSession, setResponse: fn => { custom = fn; } };
}

test('archive list is global, paginated and independent from tabs/configuration', async () => {
  const f = fixture();
  const page = await f.manager.listArchivedThreads('page-2');
  assert.equal(page.data[0].id, id);
  assert.deepEqual(f.calls.at(-1).params, { archived: true, limit: 100, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], modelProviders: [], cursor: 'page-2' });
  assert.equal(f.manager.session.currentCwd, cwd);
  assert.equal(f.manager.session.settings.executable, 'configured-codex');
  assert.deepEqual(f.saved, []);
  assert.throws(() => f.manager.listArchivedThreads({}), /страница/);
  f.manager.dispose();
  assert.throws(() => f.manager.listArchivedThreads(), /закрыто/);
});

test('dialog search uses native title filter across folders and providers without resuming history', async () => {
  const f = fixture();
  const results = [{ id: otherId, cwd: path.resolve('different-project'), name: 'Unicode поиск' }];
  f.setResponse((method, params) => method === 'thread/list' ? { data: results, nextCursor: params.cursor ? null : 'next-search' } : undefined);
  const first = await f.manager.searchThreads({ query: '  поиск  ', archived: false });
  assert.deepEqual(first, { data: results, nextCursor: 'next-search' });
  assert.deepEqual(f.calls.at(-1).params, { searchTerm: 'поиск', archived: false, limit: 100, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], modelProviders: [] });
  const second = await f.manager.searchThreads({ query: 'поиск', archived: true, cursor: 'next-search' });
  assert.deepEqual(second, { data: results, nextCursor: null });
  assert.deepEqual(f.calls.at(-1).params, { searchTerm: 'поиск', archived: true, limit: 100, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], modelProviders: [], cursor: 'next-search' });
  assert.equal(f.coordinator.threads.get(otherId), results[0]);
  assert.deepEqual(f.saved, []);
  assert.equal(f.calls.some(call => /^(thread\/(read|resume|start|items\/list)|turn\/start)$/.test(call.method)), false);
  assert.equal(f.manager.archived.size, 0, 'search must not replace the full archive membership cache');
  f.manager.dispose();
  assert.throws(() => f.manager.searchThreads({ query: 'after dispose', archived: false }), /закрыто/);
});

test('dialog search rejects invalid text, scope and cursor before opening a connection', () => {
  const f = fixture();
  for (const query of [undefined, null, 1, {}, '', '   ', 'a'.repeat(501), 'one\ntwo', 'nul\0']) assert.throws(() => f.manager.searchThreads({ query, archived: false }), /поиска/);
  for (const archived of [undefined, null, 'true', 1]) assert.throws(() => f.manager.searchThreads({ query: 'valid', archived }), /область/);
  for (const cursor of [null, 123, '', 'a'.repeat(16385)]) assert.throws(() => f.manager.searchThreads({ query: 'valid', archived: false, cursor }), /страница/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.session, null);
});

test('dialog search failure is recoverable without local history fallback', async () => {
  const f = fixture();
  f.setResponse(method => { if (method === 'thread/list') throw new Error('Search is unavailable'); });
  await assert.rejects(f.manager.searchThreads({ query: 'missing', archived: false }), /Search is unavailable/);
  assert.equal(f.calls.some(call => call.method === 'thread/read'), false);
  f.setResponse(undefined);
  assert.equal((await f.manager.searchThreads({ query: 'retry', archived: true })).data[0].id, id);
});

test('archived legacy reads flatten completed items without resume, and recheck membership', async () => {
  const f = fixture();
  const result = await f.manager.readArchivedThread({ threadId: id });
  assert.deepEqual(result.items, [{ id: 'item', type: 'agentMessage', text: 'Hello', turnId: 'turn', complete: true }]);
  assert.equal(result.nextCursor, null);
  assert.equal(f.calls.some(call => call.method === 'thread/resume' || call.method === 'turn/start'), false);
  f.archive.delete(id);
  await assert.rejects(f.manager.readArchivedThread({ threadId: id }), /не находится в архиве/);
});

test('paginated archived reads use read metadata and item pages only', async () => {
  const f = fixture(); f.threads.get(id).historyMode = 'paginated';
  const result = await f.manager.readArchivedThread({ threadId: id, cursor: 'next' });
  assert.equal(result.items[0].turnId, 'paged-turn');
  assert.equal(result.nextCursor, null);
  assert.deepEqual(f.calls.at(-1).params, { threadId: id, limit: 100, sortDirection: 'desc', cursor: 'next' });
  assert.equal(f.calls.some(call => call.method === 'thread/read' && call.params.includeTurns), false);
});

test('management validates target/cwd/name and only invokes exact documented RPC', async () => {
  const f = fixture();
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: '../history', cwd }), /идентификатор/);
  assert.throws(() => f.manager.manageThread({ action: 'rename', threadId: id, cwd, name: '  ' }), /Название/);
  await assert.rejects(f.manager.manageThread({ action: 'delete', threadId: id, cwd: path.dirname(cwd) }), /другой рабочей/);
  const renamed = await f.manager.manageThread({ action: 'rename', threadId: id, cwd, name: '  New title  ' });
  assert.equal(renamed.thread.name, 'New title');
  assert.deepEqual(f.calls.at(-1).params, { threadId: id, name: 'New title' });
  const restored = await f.manager.manageThread({ action: 'restore', threadId: id, cwd });
  assert.equal(restored.thread.id, id);
  assert.deepEqual(f.restored, [cwd]);
  assert.deepEqual(f.calls.at(-1).params, { threadId: id });
  await f.manager.manageThread({ action: 'archive', threadId: id, cwd });
  assert.deepEqual(f.calls.findLast(call => call.method === 'thread/archive').params, { threadId: id });
  await f.manager.manageThread({ action: 'delete', threadId: id, cwd });
  assert.deepEqual(f.calls.findLast(call => call.method === 'thread/delete').params, { threadId: id });
});

test('busy, terminal, approval and compact ACK gaps all reject archive', async () => {
  const f = fixture(), session = await f.addSession();
  for (const setup of [
    () => { session.activeThreadTurns.set(id, 'busy'); return () => session.activeThreadTurns.clear(); },
    () => { session.terminal = { threadId: id }; return () => { session.terminal = null; }; },
    () => { session.requests.set(1, {}); return () => session.requests.clear(); },
  ]) {
    const clear = setup();
    assert.throws(() => f.manager.manageThread({ action: 'archive', threadId: id, cwd }), /Дождитесь/);
    clear();
  }
  await session.request('thread/compact/start', { threadId: id });
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /Дождитесь/);
  session.client.emit('notification', { method: 'turn/completed', params: { threadId: id, turn: { id: 'old', status: 'completed' } } });
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /Дождитесь/);
  session.client.emit('notification', { method: 'thread/compacted', params: { threadId: id } });
  await f.manager.manageThread({ action: 'archive', threadId: id, cwd });
});

test('compaction item completion keeps parent protected until its matching turn completes', async () => {
  const f = fixture(), session = await f.addSession();
  await session.request('thread/compact/start', { threadId: id });
  session.client.emit('notification', { method: 'turn/started', params: { threadId: id, turn: { id: 'compact-turn' } } });
  session.client.emit('notification', { method: 'item/completed', params: { threadId: id, turnId: 'compact-turn', item: { type: 'contextCompaction' } } });
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /Дождитесь/);
  session.client.emit('notification', { method: 'turn/completed', params: { threadId: id, turn: { id: 'compact-turn', status: 'completed' } } });
  await f.manager.manageThread({ action: 'archive', threadId: id, cwd });
});

test('reservation blocks RPC/terminal races and stays blocked after archive until restore', async () => {
  const f = fixture(), session = await f.addSession(), gate = deferred(), reached = deferred();
  f.setResponse((method, params) => { if (method === 'thread/read') { reached.resolve(); return gate.promise.then(() => ({ thread: f.threads.get(params.threadId) })); } });
  const archiving = f.manager.manageThread({ action: 'archive', threadId: id, cwd });
  await reached.promise;
  await assert.rejects(session.request('turn/start', { threadId: id }), /операции с диалогом/);
  await assert.rejects(session.request('thread/resume', { threadId: id }), /операции с диалогом/);
  await assert.rejects(session.openTerminal({ threadId: id }), /операции с диалогом/);
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /уже выполняется/);
  gate.resolve(); await archiving;
  await assert.rejects(session.request('turn/start', { threadId: id }), /в архиве/);
  f.setResponse(undefined);
  await f.manager.manageThread({ action: 'restore', threadId: id, cwd });
  await session.request('turn/start', { threadId: id });
});

test('descendant events are returned and block stale writers, unrelated busy sessions remain usable', async () => {
  const f = fixture();
  f.threads.set(otherId, { id: otherId, cwd, status: { type: 'idle' } });
  const unrelated = await f.addSession(otherId);
  unrelated.activeThreadTurns.set(otherId, 'working');
  f.setResponse((method, _params, client) => {
    if (method !== 'thread/delete') return;
    for (const threadId of [id, childId]) client.emit('notification', { method: 'thread/deleted', params: { threadId } });
    return {};
  });
  const result = await f.manager.manageThread({ action: 'delete', threadId: id, cwd });
  assert.deepEqual(result.affectedThreadIds, [id, childId]);
  assert.throws(() => f.coordinator.assertAllowed(childId), /удалён/);
  await unrelated.request('turn/start', { threadId: otherId });
});

test('busy spawned descendants block destructive parent mutation across sessions', async () => {
  const f = fixture();
  f.threads.set(childId, { id: childId, parentThreadId: id, cwd, status: { type: 'idle' } });
  const child = await f.addSession(childId);
  child.activeThreadTurns.set(childId, 'working');
  assert.throws(() => f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /Дождитесь/);
});

test('late archive events after ACK are observed through the read barrier', async () => {
  const f = fixture();
  let archived = false;
  f.setResponse((method, _params, client) => {
    if (method === 'thread/archive') { archived = true; return {}; }
    if (method === 'thread/list' && archived) return new Promise(resolve => setImmediate(() => {
      client.emit('notification', { method: 'thread/archived', params: { threadId: childId } });
      resolve({ data: [], nextCursor: null });
    }));
  });
  const result = await f.manager.manageThread({ action: 'archive', threadId: id, cwd });
  assert.deepEqual(result.affectedThreadIds, [id, childId]);
  assert.throws(() => f.coordinator.assertAllowed(childId), /в архиве/);
});

test('archive reconciles only descendants actually archived and delete covers all known descendants', async () => {
  const f = fixture();
  f.threads.set(childId, { id: childId, parentThreadId: id, cwd, status: { type: 'idle' } });
  await f.addSession(childId);
  const archived = await f.manager.manageThread({ action: 'archive', threadId: id, cwd });
  assert.deepEqual(archived.affectedThreadIds, [id]);
  assert.doesNotThrow(() => f.coordinator.assertAllowed(childId));
  const deleted = await f.manager.manageThread({ action: 'delete', threadId: id, cwd });
  assert.deepEqual(deleted.affectedThreadIds, [id, childId]);
});

test('unsupported delete fails without local history fallback and releases reservation', async () => {
  const f = fixture();
  f.setResponse(method => { if (method === 'thread/delete') throw new Error('Unknown method thread/delete'); });
  await assert.rejects(f.manager.manageThread({ action: 'delete', threadId: id, cwd }), /Unknown method/);
  assert.equal(f.coordinator.locks.size, 0);
  assert.equal(f.coordinator.blocked.size, 0);
  assert.equal(f.threads.has(id), true);
  await f.manager.manageThread({ action: 'rename', threadId: id, cwd, name: 'Still here' });
});

test('dispose while server reads aborts before mutation and releases reservation', async () => {
  const f = fixture(), gate = deferred(), reached = deferred();
  f.setResponse((method, params) => { if (method === 'thread/read') { reached.resolve(); return gate.promise.then(() => ({ thread: f.threads.get(params.threadId) })); } });
  const action = f.manager.manageThread({ action: 'delete', threadId: id, cwd });
  await reached.promise; f.manager.dispose(); gate.resolve();
  await assert.rejects(action, /закрыто/);
  assert.equal(f.calls.some(call => call.method === 'thread/delete'), false);
  assert.equal(f.coordinator.locks.size, 0);
});
