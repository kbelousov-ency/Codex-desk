import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listProjectThreads } from '../electron/project-history.mjs';
import { WindowSession } from '../electron/window-session.mjs';

const a = path.resolve('history-project-a');
const b = path.resolve('history-project-b');
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function fixture() {
  const calls = [], saves = [];
  let active = true;
  const record = { sessions: new Map(), defaultSessionId: null, historySession: null };
  let listResponse = async params => ({ data: [{ id: 'history', cwd: params.cwd }], nextCursor: 'page-2' });
  class Client extends EventEmitter {
    async start() { return {}; }
    async request(method, params) {
      calls.push({ client: this, method, params });
      if (method === 'model/list') return { data: [], nextCursor: null };
      if (method === 'config/read') return { config: {} };
      if (method === 'account/read') return { account: null };
      if (method === 'thread/list') return listResponse(params);
      throw new Error(`Unexpected method ${method}`);
    }
    stop() { this.emit('status', { state: 'stopped' }); }
  }
  const create = (cwd, persist = true) => new WindowSession({
    settings: { cwd, executable: 'configured-codex', model: 'configured-model' },
    resolveDirectory: async value => value, resolveExecutable: async value => value,
    createClient: () => new Client(), persistSettings: persist ? async patch => { saves.push(patch); } : undefined,
  });
  const add = async (id, cwd, start = true) => {
    const session = create(cwd);
    record.sessions.set(id, session);
    record.defaultSessionId ??= id;
    if (start) await session.start();
    return session;
  };
  const options = {
    record, workspaceStore: { snapshot: async () => ({ projects: [a, b, 'missing'] }) },
    assertWindow: () => { if (!active) throw new Error('Окно уже закрыто.'); },
    resolveDirectory: async value => {
      if (value === 'missing') throw new Error('Missing folder');
      return value === 'alias-b' ? b : path.resolve(value);
    },
    createHistorySession: async cwd => record.historySession ??= create(cwd, false),
  };
  const list = (cwd, cursor) => listProjectThreads({ ...options, cwd, cursor });
  return { record, add, list, calls, saves, options, setResponse: response => { listResponse = response; }, close: () => { active = false; } };
}

test('folder history prefers the matching ready tab and keeps the ordinary RPC cwd boundary', async () => {
  const f = fixture();
  const first = await f.add('a', a);
  const second = await f.add('b', b);
  const settings = second.getSettings();
  const saveCount = f.saves.length;
  const result = await f.list('alias-b', 'next-page');
  assert.deepEqual(result, { data: [{ id: 'history', cwd: b }], nextCursor: 'page-2' });
  assert.deepEqual(f.calls.at(-1), { client: second.client, method: 'thread/list', params: {
    cwd: b, limit: 40, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], cursor: 'next-page',
  } });
  assert.equal(f.saves.length, saveCount);
  assert.deepEqual(second.getSettings(), settings);
  assert.equal(first.currentCwd, a);
  await first.request('thread/list', { cwd: b });
  assert.deepEqual(f.calls.at(-1).params, { cwd: a });
});

test('only registered exact canonical folders and valid cursors may reach the transport', async () => {
  const f = fixture();
  await f.add('a', a);
  const count = f.calls.length;
  await assert.rejects(f.list(path.dirname(a)), /не добавлена/);
  await assert.rejects(f.list(path.join(a, 'child')), /не добавлена/);
  await assert.rejects(f.list(b, { method: 'turn/start' }), /страница истории/);
  await assert.rejects(f.list(b, ''), /страница истории/);
  await assert.rejects(f.list(b, 'x'.repeat(16385)), /страница истории/);
  await assert.rejects(f.list(null), /папка проекта/);
  assert.equal(f.calls.length, count);
  if (process.platform === 'win32') {
    await f.list(b.toUpperCase());
    assert.equal(f.calls.at(-1).params.cwd, b);
  }
});

test('an already ready tab serves other folder history without starting or reconfiguring any tab', async () => {
  const f = fixture();
  const first = await f.add('a', a);
  const second = await f.add('b', b, false);
  const saveCount = f.saves.length;
  await f.list(b);
  assert.equal(f.calls.at(-1).client, first.client);
  assert.equal(f.calls.at(-1).params.cwd, b);
  assert.equal(second.client, null);
  assert.equal(f.saves.length, saveCount);
  assert.equal(first.currentCwd, a);
  assert.equal(f.record.historySession, null);
});

test('no ready tabs boot the existing default at its own cwd; no tabs use one private history connection', async () => {
  const f = fixture();
  const first = await f.add('a', a, false);
  await f.list(b);
  assert.equal(first.currentCwd, a);
  assert.equal(f.calls.find(call => call.method === 'config/read').params.cwd, a);
  assert.equal(f.calls.at(-1).params.cwd, b);
  first.dispose();
  f.record.sessions.clear();
  f.record.defaultSessionId = null;
  const saves = f.saves.length;
  await Promise.all([f.list(a), f.list(b)]);
  const history = f.record.historySession;
  assert.ok(history.client);
  assert.equal(f.record.sessions.size, 0);
  assert.equal(f.saves.length, saves);
  assert.equal(f.calls.filter(call => call.client === history.client && call.method === 'model/list').length, 1);
  assert.deepEqual(f.calls.filter(call => call.client === history.client && call.method === 'thread/list').map(call => call.params.cwd), [a, b]);
});

test('closed windows and sessions cannot publish pending history', async () => {
  for (const kind of ['window', 'session', 'transport']) {
    const f = fixture();
    const session = await f.add('a', a);
    const pending = deferred(), started = deferred();
    f.setResponse(() => { started.resolve(); return pending.promise; });
    const listing = f.list(b);
    const failure = assert.rejects(listing, /закрыто|завершён|изменилось/);
    await started.promise;
    if (kind === 'window') f.close();
    if (kind === 'session') session.dispose();
    if (kind === 'transport') session.client = {};
    pending.resolve({ data: [], nextCursor: null });
    await failure;
  }
});

test('terminal-owned default uses private read-only history without restarting or changing its session', async () => {
  for (const hasTransport of [true, false]) {
    const f = fixture();
    const terminalSession = await f.add('a', a, hasTransport);
    const originalClient = terminalSession.client;
    terminalSession.terminal = { threadId: 'externally-owned' };
    terminalSession.start = () => { throw new Error('Must never start a terminal-owned session.'); };
    const saveCount = f.saves.length;
    const callCount = f.calls.length;
    const result = await f.list(b);
    const history = f.record.historySession;
    assert.deepEqual(result.data, [{ id: 'history', cwd: b }]);
    assert.ok(history.client);
    assert.equal(terminalSession.client, originalClient);
    assert.equal(terminalSession.currentCwd, a);
    assert.equal(terminalSession.terminal.threadId, 'externally-owned');
    assert.equal(f.saves.length, saveCount);
    assert.ok(f.calls.slice(callCount).every(call => call.client === history.client));
    assert.ok(f.calls.slice(callCount).every(call => ['model/list', 'account/read', 'config/read', 'thread/list'].includes(call.method)));
    await f.list(a);
    assert.equal(f.calls.at(-1).client, history.client);
    assert.equal(f.calls.at(-1).params.cwd, a);
  }
});

test('closing during folder resolution prevents booting a history connection', async () => {
  const f = fixture();
  const pending = deferred();
  const listing = listProjectThreads({ ...f.options, cwd: a, resolveDirectory: () => pending.promise });
  const failure = assert.rejects(listing, /закрыто/);
  f.close();
  pending.resolve(a);
  await failure;
  assert.equal(f.record.historySession, null);
  assert.deepEqual(f.calls, []);
});
