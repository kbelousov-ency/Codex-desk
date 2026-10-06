/**
 * The wiring between the App Server's approval requests and the rule engine: a request answered from rules
 * must be answered on the transport, never recorded as pending, and never reach the window — while every
 * other access mode, every other agent and every undecidable request must still raise the ordinary card.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WindowSession } from '../electron/window-session.mjs';
import { ApprovalCatalog } from '../electron/approval-catalog.mjs';

class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.replies = [];
    this.respondError = null;
  }
  async start() { this.emit('status', { state: 'ready' }); return { serverInfo: { name: 'fake' } }; }
  request(method) {
    if (method === 'model/list') return Promise.resolve({ data: [{ model: 'm' }], nextCursor: null });
    if (method === 'account/read') return Promise.resolve({ account: null, requiresOpenaiAuth: false });
    if (method === 'config/read') return Promise.resolve({ config: {}, layers: [], origins: {} });
    return Promise.resolve({});
  }
  respond(id, result) {
    if (this.respondError) return Promise.reject(this.respondError);
    this.replies.push({ id, result });
    return Promise.resolve();
  }
  stop() { this.emit('status', { state: 'stopped' }); }
}

async function fixture({ access = 'rules', provider = 'codex', cwd, catalog = null } = {}) {
  const clients = [];
  const events = [];
  const session = new WindowSession({
    settings: { cwd, provider, executable: 'codex', model: 'm', effort: 'high', access },
    resolveDirectory: async value => value,
    resolveExecutable: async value => value,
    resolveClaudeExecutable: async value => value,
    send: (type, data) => events.push({ type, data }),
    persistSettings: async () => {},
    createClient: options => { const client = new FakeClient(options); clients.push(client); return client; },
    createClaudeClient: options => { const client = new FakeClient(options); clients.push(client); return client; },
    approvalCatalog: catalog,
  });
  await session.start();
  return { session, client: clients[0], events };
}

const execRequest = (command, extra = {}) => ({
  id: 7,
  method: 'item/commandExecution/requestApproval',
  params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command, ...extra },
});

async function project() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'session-rules-'));
  return { cwd: base, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('a read-only command is answered on the transport and never shown', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    f.client.emit('serverRequest', execRequest('git status --short'));
    assert.deepEqual(f.client.replies, [{ id: 7, result: { decision: 'accept' } }]);
    assert.equal(f.session.requests.size, 0, 'nothing is left pending');
    assert.ok(!f.events.some(event => event.type === 'serverRequest'), 'the window never sees it');
    const notice = f.events.find(event => event.data?.method === 'approval/autoDecided');
    assert.equal(notice.data.params.itemId, 'item-1');
    assert.match(notice.data.params.reason, /только на чтение/);
  } finally { await cleanup(); }
});

test('an undecidable command still raises the ordinary card', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    f.client.emit('serverRequest', execRequest('rm -rf build'));
    assert.deepEqual(f.client.replies, []);
    assert.equal(f.session.requests.size, 1);
    assert.ok(f.events.some(event => event.type === 'serverRequest'));
  } finally { await cleanup(); }
});

test('only the rules mode consults rules; the other modes mean what their labels say', async () => {
  const { cwd, cleanup } = await project();
  try {
    for (const access of ['workspace-write', 'auto', 'danger-full-access', 'inherited']) {
      const f = await fixture({ cwd, access });
      f.client.emit('serverRequest', execRequest('git status'));
      assert.deepEqual(f.client.replies, [], access);
      assert.equal(f.session.requests.size, 1, access);
    }
  } finally { await cleanup(); }
});

test('a Claude tab is never answered from Codex rules, even when it carries the mode', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd, provider: 'claude' });
    f.client.emit('serverRequest', execRequest('git status'));
    assert.deepEqual(f.client.replies, []);
    assert.equal(f.session.requests.size, 1);
  } finally { await cleanup(); }
});

test('a question is never auto-answered, whatever the mode', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    f.client.emit('serverRequest', {
      id: 8, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-1', questions: [{ id: 'q', question: 'Which?' }] },
    });
    assert.deepEqual(f.client.replies, []);
    assert.equal(f.session.requests.size, 1);
  } finally { await cleanup(); }
});

test('a file change is judged on the paths of the item the host recorded', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    const item = { id: 'item-2', type: 'fileChange', changes: [{ path: path.join(cwd, 'src/App.tsx'), kind: 'update', diff: '' }] };
    f.client.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item } });
    f.client.emit('serverRequest', {
      id: 9, method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-2' },
    });
    assert.deepEqual(f.client.replies, [{ id: 9, result: { decision: 'accept' } }]);

    // the same approval without a recorded item has nothing to judge, so it asks
    const g = await fixture({ cwd });
    g.client.emit('serverRequest', {
      id: 10, method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-2' },
    });
    assert.deepEqual(g.client.replies, []);
    assert.equal(g.session.requests.size, 1);
  } finally { await cleanup(); }
});

test('a saved rule of this project answers a call the whitelist refuses', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    await store.add(cwd, [['commands', 'node scripts/check.mjs']]);
    const f = await fixture({ cwd, catalog: store });
    f.client.emit('serverRequest', execRequest('node scripts/check.mjs --fast'));
    assert.deepEqual(f.client.replies, [{ id: 7, result: { decision: 'accept' } }]);
  } finally { await cleanup(); }
});

test('a request about another thread is left alone', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    f.session.currentThreadId = 'thread-other';
    f.client.emit('serverRequest', execRequest('git status'));
    assert.deepEqual(f.client.replies, []);
    assert.equal(f.session.requests.size, 1);
  } finally { await cleanup(); }
});

test('a failed write hands the request to the window instead of leaving the turn waiting', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    f.client.respondError = new Error('transport closed');
    f.client.emit('serverRequest', execRequest('git status'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.session.requests.size, 1, 'the user gets the card after all');
    assert.ok(f.events.some(event => event.type === 'serverRequest'));
  } finally { await cleanup(); }
});

test('tracked items do not grow without bound', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    for (let index = 0; index < 400; index += 1) {
      f.client.emit('notification', {
        method: 'item/started',
        params: { threadId: 'thread-1', item: { id: `item-${index}`, type: 'fileChange', changes: [] } },
      });
    }
    assert.ok(f.session.trackedItems.size <= 256);
  } finally { await cleanup(); }
});

test('a card is told the rule it would save, and saves exactly that rule on agreement', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    const f = await fixture({ cwd, catalog: store });
    f.client.emit('serverRequest', execRequest('node scripts/check.mjs --fast'));
    const shown = f.events.find(event => event.type === 'serverRequest').data;
    assert.deepEqual(shown.rules, [['commands', 'node scripts/check.mjs']]);

    await f.session.respond(7, { decision: 'accept' }, { remember: true });
    assert.deepEqual(store.listing(cwd), [['commands', 'node scripts/check.mjs']]);
    assert.ok(store.allows(cwd, 'command', { command: 'node scripts/check.mjs --quiet' }));
  } finally { await cleanup(); }
});

test('allowing once saves nothing, and a card with no derivable rule offers none', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    const f = await fixture({ cwd, catalog: store });
    f.client.emit('serverRequest', execRequest('node scripts/check.mjs'));
    await f.session.respond(7, { decision: 'accept' });
    assert.deepEqual(store.listing(cwd), []);

    // an absolute-path argument describes one call only, so no rule is offered at all
    f.client.emit('serverRequest', { ...execRequest(`node ${path.join(cwd, 'once.mjs')}`), id: 11 });
    const shown = f.events.filter(event => event.type === 'serverRequest').at(-1).data;
    assert.equal(shown.rules, undefined);
  } finally { await cleanup(); }
});

test('a network card offers both halves or nothing, so one of them is never saved alone', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    const f = await fixture({ cwd, catalog: store });
    f.client.emit('serverRequest', execRequest('npm install',
      { networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' } }));
    const shown = f.events.find(event => event.type === 'serverRequest').data;
    assert.deepEqual(shown.rules, [['commands', 'npm install'], ['hosts', 'registry.npmjs.org']]);

    await f.session.respond(7, { decision: 'accept' }, { remember: true });
    assert.deepEqual(store.listing(cwd), [['commands', 'npm install'], ['hosts', 'registry.npmjs.org']]);

    // a host Codex cannot name yields no rule at all rather than a lone command rule
    f.client.emit('serverRequest', { ...execRequest('npm install', { networkApprovalContext: { host: 'localhost' } }), id: 12 });
    assert.equal(f.events.filter(event => event.type === 'serverRequest').at(-1).data.rules, undefined);
  } finally { await cleanup(); }
});

test('the other access modes never offer a rule, because they never consult one', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    const f = await fixture({ cwd, access: 'workspace-write', catalog: store });
    f.client.emit('serverRequest', execRequest('node scripts/check.mjs'));
    assert.equal(f.events.find(event => event.type === 'serverRequest').data.rules, undefined);
    await f.session.respond(7, { decision: 'accept' }, { remember: true });
    assert.deepEqual(store.listing(cwd), []);
  } finally { await cleanup(); }
});

test('rules are listed for the project and can always be taken back', async () => {
  const { cwd, cleanup } = await project();
  const store = new ApprovalCatalog(path.join(cwd, 'approvals.json'));
  try {
    await store.add(cwd, [['commands', 'git status'], ['hosts', 'registry.npmjs.org']]);
    const f = await fixture({ cwd, catalog: store });
    assert.deepEqual(f.session.listApprovalRules(), {
      cwd,
      rules: [{ kind: 'commands', value: 'git status' }, { kind: 'hosts', value: 'registry.npmjs.org' }],
    });
    const after = await f.session.dropApprovalRule(1);
    assert.deepEqual(after.rules, [{ kind: 'hosts', value: 'registry.npmjs.org' }]);
    await assert.rejects(() => f.session.dropApprovalRule(9), /уже удалено/);
  } finally { await cleanup(); }
});

test('a session without a catalog lists nothing instead of failing', async () => {
  const { cwd, cleanup } = await project();
  try {
    const f = await fixture({ cwd });
    assert.deepEqual(f.session.listApprovalRules(), { cwd, rules: [] });
    await assert.rejects(() => f.session.dropApprovalRule(1), /недоступны/);
  } finally { await cleanup(); }
});
