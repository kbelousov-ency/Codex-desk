import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WindowSession } from '../electron/window-session.mjs';

function fixture(request) {
  const calls = [], events = [];
  const session = new WindowSession({ settings: { cwd: 'project' }, send: (type, data) => events.push({ type, data }) });
  const client = new EventEmitter();
  client.request = async (method, params) => { calls.push({ method, params }); return request(method, params); };
  client.stop = () => {};
  session.client = client; session.bootstrap = {}; session.currentThreadId = 'thread-a';
  return { session, calls, events };
}
test('MCP refresh preserves thread and filters tools/status responses without exposing credentials', async () => {
  const f = fixture((method, params) => method === 'config/mcpServer/reload' ? {} : {
    data: [{ name: 'company', authStatus: 'bearerToken', runtimeStatus: 'connected', tools: { search: { secret: 'never-return' } }, toolsError: 'never-return', resources: ['never-return'] }], nextCursor: params.cursor ? null : 'page2',
  });
  const report = await f.session.mcpRuntime(true);
  assert.equal(report.servers.length, 2);
  assert.deepEqual(report.servers[0], { name: 'company', authStatus: 'bearerToken', status: 'connected', toolCount: 1 });
  assert.equal(JSON.stringify(report).includes('never-return'), false);
  assert.equal(f.session.currentThreadId, 'thread-a');
  assert.deepEqual(f.calls.map(call => call.method), ['config/mcpServer/reload', 'mcpServerStatus/list', 'mcpServerStatus/list']);
  assert.equal(f.calls[1].params.threadId, 'thread-a');
  assert.deepEqual(f.events, [{ type: 'mcp', data: { state: 'refreshing' } }, { type: 'mcp', data: { state: 'ready' } }]);
});
test('busy, approval, terminal and compact prohibit MCP refresh without queueing surprises', async () => {
  for (const busy of ['turn', 'approval', 'terminal', 'compact', 'request', 'boot']) {
    const f = fixture(() => assert.fail('busy MCP must not call server'));
    if (busy === 'turn') f.session.activeThreadTurns.set('thread-a', 'turn-a');
    if (busy === 'approval') f.session.requests.set(1, {});
    if (busy === 'terminal') f.session.terminal = {};
    if (busy === 'compact') f.session.compactingThreads.add('thread-a');
    if (busy === 'request') f.session.pendingMutations++;
    if (busy === 'boot') f.session.pendingBoots++;
    assert.equal((await f.session.mcpRuntime()).status, 'deferred');
    assert.deepEqual((await f.session.mcpRuntime(true)).servers, []);
    assert.equal(f.calls.length, 0);
  }
});
test('MCP refresh reserves before await and sanitizes failed requests then unlocks', async () => {
  let reject;
  const f = fixture(() => new Promise((_, fail) => { reject = fail; }));
  const checking = f.session.mcpRuntime();
  assert.equal((await f.session.mcpRuntime()).status, 'deferred');
  await assert.rejects(f.session.request('turn/start', { threadId: 'thread-a' }), /MCP/);
  reject(new Error('Authorization secret-test-bearer'));
  await assert.rejects(checking, error => /MCP/.test(error.message) && !error.message.includes('secret-test'));
  assert.equal(f.session.mcpRefreshing, false);
});
