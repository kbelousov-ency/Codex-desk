import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCreditThreadIds, readSessionRouterUsage } from '../electron/session-router-usage.mjs';
import { childSourceKinds } from '../electron/thread-children.mjs';

const root = '10000000-0000-0000-0000-000000000000';
const child = '20000000-0000-0000-0000-000000000000';
const grandchild = '30000000-0000-0000-0000-000000000000';
const unrelated = '40000000-0000-0000-0000-000000000000';

test('credit scope includes transitive and archived native children once, not unrelated conversations', async () => {
  const calls = [];
  const result = await collectCreditThreadIds({ provider: 'codex', threadId: root, cwd: 'project', request: async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/list');
    assert.equal(params.cwd, 'project');
    assert.deepEqual(params.sourceKinds, childSourceKinds);
    assert.equal('useStateDbOnly' in params, false);
    if (params.archived) return { data: [{ id: grandchild, parentThreadId: child }, { id: root, parentThreadId: grandchild }] };
    if (params.cursor) return { data: [{ id: child, parentThreadId: root }] };
    return { data: [{ id: unrelated, parentThreadId: unrelated }, { id: child, parentThreadId: root }], nextCursor: 'second' };
  } });
  assert.deepEqual(result, { threadIds: [root, child, grandchild], partial: false });
  assert.equal(calls.length, 3);
});

test('new conversations cost zero without reading history, Claude uses its native UUID', async () => {
  const request = () => { throw new Error('Must not read native children'); };
  assert.deepEqual(await collectCreditThreadIds({ provider: 'codex', threadId: null, request }), { threadIds: [], partial: false });
  assert.deepEqual(await collectCreditThreadIds({ provider: 'claude', threadId: `claude:${root}`, request }), { threadIds: [root], partial: false });
  await assert.rejects(collectCreditThreadIds({ provider: 'codex', threadId: `claude:${root}`, request }), /диалог/);
  await assert.rejects(collectCreditThreadIds({ provider: 'claude', threadId: root, request }), /диалог/);
  await assert.rejects(collectCreditThreadIds({ provider: 'codex', threadId: '../secret', request }), /диалог/);
});

test('native wire source is a parent fallback, a fork is never billed to its original thread', async () => {
  for (const source of [{ subAgent: { thread_spawn: { parent_thread_id: root } } }, { subagent: { threadSpawn: { parentThreadId: root } } }]) {
    const result = await collectCreditThreadIds({ provider: 'codex', threadId: root, cwd: 'project', request: async () => ({ data: [{ id: child, source }, { id: unrelated, forkedFromId: root }] }) });
    assert.deepEqual(result.threadIds, [root, child]);
    assert.equal(result.partial, false);
  }
});

test('missing history, repeated cursors, caps and timeout remain explicitly partial', async () => {
  const base = { provider: 'codex', threadId: root, cwd: 'project' };
  assert.equal((await collectCreditThreadIds({ ...base, request: async () => { throw new Error('offline'); } })).partial, true);
  assert.equal((await collectCreditThreadIds({ ...base, request: async () => ({ data: [], nextCursor: 'loop' }) })).partial, true);
  assert.equal((await collectCreditThreadIds({ ...base, maxThreads: 1, request: async () => ({ data: [{ id: child, parentThreadId: root }] }) })).partial, true);
  const timed = await collectCreditThreadIds({ ...base, timeoutMs: 5, request: () => new Promise(() => {}) });
  assert.deepEqual(timed, { threadIds: [root], partial: true });
});

function fixture(provider = 'codex', source = 'router') {
  const calls = [];
  const profile = provider === 'claude' ? { env: { ANTHROPIC_BASE_URL: 'https://router.encycam.com', ANTHROPIC_AUTH_TOKEN: 'running-token' } }
    : { expectedConnection: { baseUrl: 'https://router.encycam.com/v1', apiKey: 'running-token' } };
  const session = { settings: { provider, connectionSource: source }, connectionProfile: profile, generation: 1, currentThreadId: child, currentCwd: 'project', disposed: false };
  const options = { session, options: { threadId: provider === 'claude' ? `claude:${root}` : root }, routerClient: { token: async () => { calls.push('legacy'); return 'legacy-token'; } }, portalClient: {},
    collectThreads: async value => { calls.push({ collect: value }); return { threadIds: [root], partial: false }; },
    summary: async value => { calls.push({ summary: value }); return { available: true, spend: { session: { credits: 5 }, today: { credits: 6, since: 'today' } } }; },
  };
  return { calls, session, options };
}

test('credits use the running profile and displayed thread, not a child thread/started or newer saved credentials', async () => {
  for (const provider of ['codex', 'claude']) {
    const f = fixture(provider);
    const result = await readSessionRouterUsage(f.options);
    assert.equal(result.spend.session.credits, 5);
    assert.equal(f.calls[0].collect.threadId, provider === 'claude' ? `claude:${root}` : root);
    assert.equal(f.calls[1].summary.apiKey, 'running-token');
    assert.equal(f.calls[1].summary.provider, provider);
    assert.deepEqual(f.calls[1].summary.threadIds, [root]);
    assert.equal(JSON.stringify(result).includes('token'), false);
  }
});

test('personal connections and foreign origins never send a credential to router or portal', async () => {
  for (const provider of ['codex', 'claude']) {
    const f = fixture(provider, 'account');
    assert.equal((await readSessionRouterUsage(f.options)).available, false);
    assert.equal(f.calls.length, 0);
    f.session.settings.connectionSource = 'router';
    if (provider === 'claude') f.session.connectionProfile.env.ANTHROPIC_BASE_URL = 'https://other.example';
    else f.session.connectionProfile.expectedConnection.baseUrl = 'https://other.example';
    assert.equal((await readSessionRouterUsage(f.options)).available, false);
    assert.equal(f.calls.length, 0);
  }
});

test('inherited Claude uses captured CLI connection and inherited Codex retains legacy lookup', async () => {
  const c = fixture('claude', 'inherited');
  c.session.connectionProfile = { inheritedRouter: { baseUrl: 'https://router.encycam.com', apiKey: 'inherited-token' } };
  await readSessionRouterUsage(c.options);
  assert.equal(c.calls.at(-1).summary.apiKey, 'inherited-token');
  const x = fixture('codex', 'inherited');
  await readSessionRouterUsage(x.options);
  assert.equal(x.calls[0], 'legacy');
  assert.equal(x.calls.at(-1).summary.apiKey, 'legacy-token');
});

test('router-only uses its exact profile and a null displayed thread means a new conversation', async () => {
  const f = fixture();
  f.options.routerOnly = true;
  f.options.options.threadId = null;
  await readSessionRouterUsage(f.options);
  assert.equal(f.calls[0].collect.threadId, null);
  assert.equal(f.calls.at(-1).summary.apiKey, 'running-token');
});

test('connection changes discard both pending credentials and completed statistics', async () => {
  const f = fixture();
  f.options.summary = async () => { f.session.generation++; return { available: true, limits: [{ limitCredits: 999 }] }; };
  const result = await readSessionRouterUsage(f.options);
  assert.equal(result.available, false);
  assert.equal('limits' in result, false);
  const x = fixture('codex', 'inherited');
  x.options.routerClient.token = async () => { x.session.connectionProfile = {}; return 'new-token'; };
  assert.equal((await readSessionRouterUsage(x.options)).available, false);
  assert.equal(x.calls.length, 0);
  const switching = fixture('claude');
  switching.options.summary = async () => { switching.session.switchingSource = true; return { available: true }; };
  assert.equal((await readSessionRouterUsage(switching.options)).available, false);
  switching.calls.length = 0;
  assert.equal((await readSessionRouterUsage(switching.options)).available, false);
  assert.equal(switching.calls.length, 0);
});

test('incomplete descendant discovery marks session spend partial without inventing a zero', async () => {
  for (const credits of [0, 5]) {
    const f = fixture();
    f.options.collectThreads = async () => ({ threadIds: [root], partial: true });
    f.options.summary = async () => ({ available: true, spend: { session: { credits } } });
    const result = await readSessionRouterUsage(f.options);
    assert.equal(result.spend.session.partial, true);
    assert.equal(result.spend.session.credits, credits || null);
    assert.match(result.spend.session.reason, /подагентов/);
  }
});
