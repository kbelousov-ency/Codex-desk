import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childSourceKinds, listThreadChildren } from '../electron/thread-children.mjs';
import { WindowSession } from '../electron/window-session.mjs';

const a = path.resolve('children-project-a');
const b = path.resolve('children-project-b');

function fixture() {
  const calls = [], saves = [];
  let active = true;
  const record = { sessions: new Map(), defaultSessionId: null, historySession: null };
  let listResponse = async params => ({
    data: [{ id: 'child-1', cwd: params.cwd, parentThreadId: 'planner-1' }, null, { id: 'child-2', cwd: params.cwd, parentThreadId: 'planner-1' }],
    nextCursor: 'children-page-2',
  });
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
  const add = async (id, cwd) => {
    const session = create(cwd);
    record.sessions.set(id, session);
    record.defaultSessionId ??= id;
    await session.start();
    return session;
  };
  const options = {
    record, workspaceStore: { snapshot: async () => ({ projects: [a, b] }) },
    assertWindow: () => { if (!active) throw new Error('Окно уже закрыто.'); },
    resolveDirectory: async value => (value === 'alias-b' ? b : path.resolve(value)),
    createHistorySession: async cwd => record.historySession ??= create(cwd, false),
  };
  const list = (cwd, cursor, limit) => listThreadChildren({ ...options, cwd, cursor, ...(limit ? { limit } : {}) });
  return { record, add, list, calls, saves, setResponse: response => { listResponse = response; }, close: () => { active = false; } };
}

test('the three conditions that populate parentThreadId are all present in the request', async () => {
  const f = fixture();
  const session = await f.add('a', a);
  const settings = session.getSettings();
  const saveCount = f.saves.length;
  await f.list(a);
  const { params } = f.calls.at(-1);
  // Measured on Codex 0.156.1: without any one of these, parentThreadId comes back null.
  assert.equal(params.cwd, a, 'a cwd filter is required');
  assert.deepEqual(params.sourceKinds, childSourceKinds, 'subAgent source kinds are required');
  assert.equal('useStateDbOnly' in params, false, 'the JSONL scan must not be skipped');
  assert.equal(params.sortKey, 'updated_at');
  assert.equal(params.limit, 100);
  assert.equal('cursor' in params, false);
  // The read must not reconfigure the tab it borrowed.
  assert.equal(f.saves.length, saveCount);
  assert.deepEqual(session.getSettings(), settings);
  assert.equal(session.currentCwd, a);
});

test('archived is left unset so archived children cannot reappear through this path', async () => {
  const f = fixture();
  await f.add('a', a);
  await f.list(a);
  assert.equal('archived' in f.calls.at(-1).params, false);
});

test('only thread/list is ever sent: no mutation and no model turn', async () => {
  const f = fixture();
  await f.add('a', a);
  const before = f.calls.length;
  await f.list(a);
  const sent = f.calls.slice(before).map(call => call.method);
  assert.deepEqual(sent, ['thread/list']);
  assert.equal(f.calls.some(call => ['turn/start', 'thread/start', 'thread/fork', 'thread/archive', 'thread/delete', 'thread/name/set'].includes(call.method)), false);
});

test('malformed entries are dropped and the cursor is passed through', async () => {
  const f = fixture();
  await f.add('a', a);
  const page = await f.list(a);
  assert.deepEqual(page.data.map(thread => thread.id), ['child-1', 'child-2']);
  assert.equal(page.nextCursor, 'children-page-2');
  await f.list(a, 'children-page-2');
  assert.equal(f.calls.at(-1).params.cursor, 'children-page-2');
  f.setResponse(async () => ({ data: [{ id: 'child-3' }] }));
  assert.deepEqual(await f.list(a), { data: [{ id: 'child-3' }], nextCursor: null });
  f.setResponse(async () => ({}));
  assert.deepEqual(await f.list(a), { data: [], nextCursor: null });
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

test('an alias folder resolves to its canonical registered path', async () => {
  const f = fixture();
  await f.add('a', a);
  await f.list('alias-b');
  assert.equal(f.calls.at(-1).params.cwd, b);
});

test('a Claude tab never serves the relationship read', async () => {
  const f = fixture();
  const claude = new WindowSession({
    settings: { cwd: a, provider: 'claude', executable: 'claude' },
    resolveDirectory: async value => value, resolveExecutable: async value => value,
    createClient: () => { throw new Error('Claude must not be asked for Codex relationships.'); },
  });
  f.record.sessions.set('claude', claude);
  f.record.defaultSessionId = 'claude';
  await f.list(a);
  // A private read-only Codex connection was booted instead of borrowing the Claude tab.
  assert.ok(f.record.historySession);
  assert.notEqual(f.calls.at(-1).client, claude.client);
});

test('a closed window cannot publish a pending relationship page', async () => {
  const f = fixture();
  await f.add('a', a);
  let resolveList;
  const held = new Promise(resolve => { resolveList = resolve; });
  f.setResponse(() => held);
  const pending = f.list(a);
  const failure = assert.rejects(pending, /закрыто|завершён|изменилось|закрыта/);
  // Let the folder checks and the connection pick run before the window goes away.
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  f.close();
  resolveList({ data: [], nextCursor: null });
  await failure;
});
