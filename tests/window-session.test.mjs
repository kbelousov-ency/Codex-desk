import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, SettingsStore, WorkspaceStore, WindowSession, sessionForEvent, windowForEvent } from '../electron/window-session.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class FakeClient extends EventEmitter {
  constructor(options, startup) {
    super();
    this.options = options;
    this.startup = startup;
    this.calls = [];
    this.replies = [];
    this.stops = 0;
    this.turn = deferred();
  }
  async start() {
    await this.startup;
    this.emit('status', { state: 'ready' });
    return { serverInfo: { name: 'fake' } };
  }
  request(method, params) {
    this.calls.push({ method, params });
    if (method === 'model/list') return Promise.resolve({ data: [{ model: 'configured-model' }], nextCursor: null });
    if (method === 'account/read') return Promise.resolve({ account: null, requiresOpenaiAuth: false });
    if (method === 'config/read') return Promise.resolve({ config: { model: 'configured-model', model_reasoning_effort: 'high', ...(this.options.modelProvider ? { model_provider: this.options.modelProvider } : {}), secret: 'hidden' }, layers: ['private'], origins: { secret: true } });
    if (method === 'turn/start') return this.turn.promise;
    if (method === 'turn/interrupt') this.turn.resolve({ interrupted: true });
    return Promise.resolve({ method, cwd: this.options.cwd });
  }
  async respond(id, result) { this.replies.push({ id, result }); }
  stop() { this.stops += 1; this.emit('status', { state: 'stopped' }); }
}

function fixture(settings = {}, overrides = {}) {
  const clients = [];
  const events = [];
  const persisted = [];
  const session = new WindowSession({
    settings: { cwd: 'project-a', executable: 'codex-a', model: 'model-a', effort: 'high', access: 'auto', ...settings },
    resolveDirectory: async value => value,
    resolveExecutable: async value => value,
    send: (type, data) => events.push({ type, data }),
    persistSettings: async patch => { persisted.push(patch); },
    createClient: options => { const client = new FakeClient(options); clients.push(client); return client; },
    ...overrides,
  });
  return { session, clients, events, persisted };
}

function sourceFixture({ provider = 'claude', resolveProfile, stopWait } = {}) {
  const clients = [], resolved = [], persisted = [], events = [];
  const resolver = async settings => {
    resolved.push({ ...settings });
    if (resolveProfile) return resolveProfile(settings);
    return { env: { SELECTED: settings.connectionSource || 'inherited', SECRET: 'host-secret' }, inheritEnv: false,
      ...(provider === 'claude' ? { settingsOverrides: { env: { SOURCE: settings.connectionSource || 'inherited' } } } : { configOverrides: ['model_provider="codex_desk_router"'], modelProvider: settings.connectionSource === 'account' ? 'openai' : 'codex_desk_router' }) };
  };
  const create = options => {
    const client = new FakeClient(options);
    const request = client.request.bind(client);
    client.request = (method, params) => {
      if (['thread/resume', 'thread/start'].includes(method)) { client.calls.push({ method, params }); return Promise.resolve({ thread: { id: params.threadId || `${provider === 'claude' ? 'claude:' : ''}${terminalThreadId}`, status: { type: 'idle' }, turns: [] } }); }
      return request(method, params);
    };
    client.stopAndWait = async () => { client.stop(); if (stopWait) await stopWait(); };
    clients.push(client); return client;
  };
  const session = new WindowSession({ settings: { provider, cwd: 'project-a', executable: 'agent-cli', model: 'keep-model', effort: 'high', connectionSource: 'account' },
    resolveDirectory: async value => value, resolveExecutable: async value => value, resolveClaudeExecutable: async value => value,
    claudeEnvironment: resolver, codexEnvironment: resolver, createClaudeClient: create, createClient: create, persistSettings: async patch => persisted.push(patch), send: (type, data) => events.push({ type, data }) });
  return { session, clients, resolved, persisted, events };
}

test('source setting persists only the source enum and complete profiles stay inside the host', async () => {
  assert.deepEqual(cleanSettings({ connectionSource: 'router', apiKey: 'secret', env: { TOKEN: 'secret' } }), { connectionSource: 'router' });
  assert.deepEqual(cleanSettings({ connectionSource: 'other' }), {});
  const f = sourceFixture();
  const boot = await f.session.start();
  assert.equal(f.clients[0].options.inheritEnv, false);
  assert.equal(f.clients[0].options.env.SECRET, 'host-secret');
  assert.ok(!JSON.stringify(boot).includes('host-secret'));
  assert.equal(f.resolved[0].connectionSource, 'account');
  assert.throws(() => f.session.setSettings({ connectionSource: 'other' }), /источник/);
});

test('switching source reserves the session, waits for process exit and resumes the same Claude UUID without a model turn', async () => {
  const exiting = deferred();
  const f = sourceFixture({ stopWait: () => exiting.promise });
  await f.session.start();
  const id = `claude:${terminalThreadId}`;
  await f.session.request('thread/resume', { threadId: id });
  const switched = f.session.setSettings({ connectionSource: 'router' });
  assert.throws(() => f.session.start(), /переключения/);
  assert.throws(() => f.session.setSettings({ model: 'racing-model' }), /переключения/);
  await assert.rejects(f.session.request('turn/start', { threadId: id }), /переключения/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.clients.length, 1);
  assert.equal(f.session.settings.connectionSource, 'account');
  exiting.resolve();
  await switched;
  assert.equal(f.session.currentThreadId, id);
  assert.equal(f.session.settings.model, 'keep-model');
  assert.equal(f.session.bootstrap, null);
  await assert.rejects(f.session.request('turn/start', { threadId: id }), /Нет подключения/);
  await f.session.start();
  await f.session.request('thread/resume', { threadId: id });
  assert.equal(f.clients[1].options.env.SELECTED, 'router');
  assert.equal(f.clients[1].calls.at(-1).params.threadId, id);
  assert.deepEqual(f.resolved.map(settings => settings.connectionSource), ['account', 'router'], 'validated profile reused for reconnect');
  assert.equal(f.clients.flatMap(client => client.calls).some(call => call.method === 'turn/start'), false);
});

test('missing source credentials preserve the previous live client and source', async () => {
  const f = sourceFixture({ resolveProfile: settings => { if (settings.connectionSource === 'router') throw new Error('Подключите роутер'); return {}; } });
  await f.session.start();
  const previous = f.session.client;
  await assert.rejects(f.session.setSettings({ connectionSource: 'router' }), /Подключите роутер/);
  assert.strictEqual(f.session.client, previous);
  assert.equal(previous.stops, 0);
  assert.equal(f.session.settings.connectionSource, 'account');
  assert.equal(f.session.switchingSource, false);
  assert.equal(f.events.some(event => event.type === 'status' && event.data.state === 'error'), false, 'preflight failure leaves a genuinely ready connection');
});

test('source changes cannot interrupt native work, approvals, boots, compaction or a terminal', async () => {
  for (const block of ['pendingBoots', 'pendingMutations', 'requests', 'activeThreadTurns', 'compactingThreads', 'terminal']) {
    const f = sourceFixture();
    await f.session.start();
    if (block === 'requests' || block === 'activeThreadTurns') f.session[block].set('busy', 'request');
    else if (block === 'compactingThreads') f.session[block].add('busy');
    else f.session[block] = block === 'terminal' ? {} : 1;
    assert.throws(() => f.session.setSettings({ connectionSource: 'router' }), /Дождитесь|терминале/);
    assert.equal(f.clients[0].stops, 0);
    assert.equal(f.session.settings.connectionSource, 'account');
  }
});

test('source process stop timeout remains owned and a reconnect waits before creating another client', async () => {
  let exited = false;
  const f = sourceFixture({ stopWait: async () => { if (!exited) throw new Error('still stopping'); } });
  await f.session.start();
  await assert.rejects(f.session.setSettings({ connectionSource: 'router' }), /still stopping/);
  assert.equal(f.events.at(-1).type, 'status');
  assert.equal(f.events.at(-1).data.state, 'error');
  assert.match(f.events.at(-1).data.message, /Переподключите/);
  assert.strictEqual(f.session.sourceStoppingClient, f.clients[0]);
  await assert.rejects(f.session.start(), /still stopping/);
  assert.equal(f.clients.length, 1);
  exited = true;
  await f.session.start();
  assert.equal(f.clients.length, 2);
  assert.equal(f.session.sourceStoppingClient, null);
  assert.equal(f.session.settings.connectionSource, 'account');
});

test('failed source persistence reports disconnected state and reconnects with the previous committed source', async () => {
  const f = sourceFixture();
  await f.session.start();
  const threadId = `claude:${terminalThreadId}`;
  await f.session.request('thread/resume', { threadId });
  const persist = f.session.persistSettings;
  f.session.persistSettings = async () => { throw new Error('fixture save failed'); };
  await assert.rejects(f.session.setSettings({ connectionSource: 'router' }), /fixture save failed/);
  assert.equal(f.events.at(-1).type, 'status');
  assert.equal(f.events.at(-1).data.state, 'error');
  assert.equal(f.session.client, null);
  assert.equal(f.session.bootstrap, null);
  assert.equal(f.session.sourceStoppingClient, null);
  assert.equal(f.session.settings.connectionSource, 'account');
  assert.equal(f.session.currentThreadId, threadId);
  f.session.persistSettings = persist;
  await f.session.start();
  await f.session.request('thread/resume', { threadId });
  assert.equal(f.clients[1].options.env.SELECTED, 'account');
  assert.equal(f.clients[1].calls.at(-1).params.threadId, threadId);
});

test('Codex source profiles override a resumed thread provider without putting credentials in RPCs', async () => {
  const f = sourceFixture({ provider: 'codex' });
  await f.session.start();
  await f.session.request('thread/resume', { threadId: terminalThreadId, modelProvider: 'from-old-thread' });
  assert.equal(f.clients[0].calls.at(-1).params.modelProvider, 'openai');
  await f.session.setSettings({ connectionSource: 'router' });
  await f.session.start();
  await f.session.request('thread/resume', { threadId: terminalThreadId, modelProvider: 'from-old-thread' });
  assert.equal(f.clients[1].calls.at(-1).params.modelProvider, 'codex_desk_router');
  assert.deepEqual(f.clients[1].options.configOverrides, ['model_provider="codex_desk_router"']);
  assert.ok(!JSON.stringify(f.clients.flatMap(client => client.calls)).includes('host-secret'));
});

test('explicit Codex validates configuration before catalog/account reads and reuses that response', async () => {
  const f = sourceFixture({ provider: 'codex' });
  await f.session.start();
  assert.deepEqual(f.clients[0].calls.map(call => call.method), ['config/read', 'model/list', 'account/read']);
  const inherited = fixture();
  await inherited.session.start();
  assert.deepEqual(inherited.clients[0].calls.map(call => call.method), ['model/list', 'account/read', 'config/read']);
});

test('a conflicting explicit Codex config never reaches model catalog or account lookup', async () => {
  const f = sourceFixture({ provider: 'codex', resolveProfile: () => ({ env: {}, modelProvider: 'openai', expectedConnection: { source: 'account' }, configOverrides: ['model_provider="openai"'] }) });
  await assert.rejects(f.session.start(), /переопределяют/);
  assert.deepEqual(f.clients[0].calls.map(call => call.method), ['config/read']);
  assert.equal(f.clients[0].stops, 1);
  assert.equal(f.session.bootstrap, null);
  assert.equal(f.events.at(-1).data.state, 'error');
});

test('two sessions run concurrent turns with isolated events, cwd, approvals and interruption', async () => {
  const a = fixture();
  const b = fixture({ cwd: 'project-b', executable: 'codex-b' });
  await Promise.all([a.session.start(), b.session.start()]);
  const aTurn = a.session.request('turn/start', { cwd: 'project-b', input: ['develop'] });
  const bTurn = b.session.request('turn/start', { cwd: 'project-a', input: ['fix'] });
  assert.equal(a.clients[0].calls.at(-1).params.cwd, 'project-a');
  assert.equal(b.clients[0].calls.at(-1).params.cwd, 'project-b');

  a.clients[0].emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'A only' } });
  b.clients[0].emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'B only' } });
  a.clients[0].emit('serverRequest', { id: 1, method: 'approval', params: { command: 'A' } });
  b.clients[0].emit('serverRequest', { id: 1, method: 'approval', params: { command: 'B' } });
  a.clients[0].emit('serverRequest', { id: '1', method: 'approval', params: { command: 'string-id' } });
  b.clients[0].emit('serverRequest', { id: 2, method: 'approval' });
  assert.equal(a.events.some(event => event.data?.params?.delta === 'B only'), false);
  assert.equal(b.events.some(event => event.data?.params?.delta === 'A only'), false);
  await assert.rejects(a.session.respond(2, { decision: 'accept' }), /уже завершён/);
  await a.session.respond(1, { decision: 'accept' });
  await assert.rejects(a.session.respond(1, { decision: 'accept' }), /уже завершён/);
  assert.equal(a.session.requests.has('1'), true);
  assert.equal(b.session.requests.has(1), true);
  assert.deepEqual(b.clients[0].replies, []);
  a.clients[0].emit('notification', { method: 'serverRequest/resolved', params: { requestId: '1' } });
  assert.equal(a.session.requests.size, 0);
  assert.equal(b.session.requests.size, 2);

  await a.session.request('turn/interrupt', { threadId: 'thread-a', turnId: 'turn-a' });
  assert.deepEqual(await aTurn, { interrupted: true });
  assert.equal(b.clients[0].calls.some(call => call.method === 'turn/interrupt'), false);
  b.clients[0].turn.resolve({ completed: true });
  assert.deepEqual(await bTurn, { completed: true });
});

test('explicit model refresh replaces a cached bootstrap without changing the project', async () => {
  const a = fixture();
  const first = await a.session.start();
  assert.strictEqual(await a.session.start(), first);
  const refreshed = await a.session.start({ refreshModels: true });
  assert.notStrictEqual(refreshed, first);
  assert.equal(a.clients.length, 2);
  assert.equal(a.clients[0].stops, 1);
  assert.equal(a.clients[1].options.cwd, 'project-a');
});

test('router bootstrap exposes the verified Sol 6.1 model before native model/list catches up', async () => {
  const router = fixture({ connectionSource: 'router' });
  const boot = await router.session.start();
  const model = boot.models.find(value => value.model === 'gpt-6.1-sol');
  assert.equal(model?.displayName, 'GPT-6.1-Sol');
  assert.equal(model?.defaultReasoningEffort, 'medium');
  assert.deepEqual(model?.supportedReasoningEfforts.map(value => value.reasoningEffort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

  const inherited = fixture({ connectionSource: 'inherited' }, { codexEnvironment: async () => ({ modelProvider: 'router' }) });
  const inheritedBoot = await inherited.session.start();
  assert.equal(inheritedBoot.models.some(value => value.model === 'gpt-6.1-sol'), true);

  const local = fixture({ connectionSource: 'inherited' });
  const localBoot = await local.session.start();
  assert.equal(localBoot.models.some(value => value.model === 'gpt-6.1-sol'), false);
});

test('changing a project or executable and closing a window leaves the other transport running', async () => {
  const a = fixture();
  const b = fixture({ cwd: 'project-b' });
  await Promise.all([a.session.start(), b.session.start()]);
  await a.session.start({ cwd: 'project-c' });
  assert.equal(a.clients[0].stops, 1);
  assert.equal(a.clients[1].options.cwd, 'project-c');
  assert.equal(b.clients[0].stops, 0);
  const eventCount = a.events.length;
  a.clients[0].emit('serverRequest', { id: 50, method: 'stale' });
  assert.equal(a.events.length, eventCount);
  assert.equal(a.session.requests.has(50), false);
  await a.session.setSettings({ executable: 'codex-new', model: 'model-new' });
  await a.session.start();
  assert.equal(a.clients[1].stops, 1);
  assert.equal(a.clients[2].options.executable, 'codex-new');
  assert.equal(b.session.getSettings().executable, 'codex-a');
  a.session.dispose();
  assert.equal(a.clients[2].stops, 1);
  assert.equal(b.clients[0].stops, 0);
  assert.equal((await b.session.request('thread/start')).cwd, 'project-b');
});

test('a slow window does not hold up another window, while each boot queue reuses its connection', async () => {
  const slow = deferred();
  const aClients = [];
  const a = fixture({}, { createClient: options => { const client = new FakeClient(options, slow.promise); aClients.push(client); return client; } });
  const b = fixture({ cwd: 'project-b' });
  const first = a.session.start();
  const repeated = a.session.start();
  await b.session.start();
  assert.equal(b.session.bootstrap.cwd, 'project-b');
  assert.equal(a.session.bootstrap, null);
  slow.resolve();
  assert.strictEqual(await first, await repeated);
  assert.equal(aClients.length, 1);
});

test('close during directory resolution cancels both active and queued boots without spawning', async () => {
  const lookup = deferred();
  const started = deferred();
  const a = fixture({}, { resolveDirectory: async () => { started.resolve(); return lookup.promise; } });
  const first = a.session.start();
  const queued = a.session.start({ cwd: 'queued-project' });
  const failures = Promise.all([assert.rejects(first, /Сеанс окна завершён/), assert.rejects(queued, /Сеанс окна завершён/)]);
  await started.promise;
  a.session.dispose();
  lookup.resolve('project-a');
  await failures;
  assert.equal(a.clients.length, 0);
  assert.equal(a.session.bootstrap, null);
  assert.throws(() => a.session.start(), /Сеанс окна завершён/);
});

test('renderer crash invalidates a pending startup and allows only a fresh connection to publish', async () => {
  const firstStart = deferred();
  const started = deferred();
  const clients = [];
  const a = fixture({}, { createClient: options => {
    const client = new FakeClient(options, clients.length === 0 ? firstStart.promise : undefined);
    clients.push(client);
    started.resolve();
    return client;
  } });
  const previousBoot = a.session.start();
  const failure = assert.rejects(previousBoot, /Сеанс окна завершён/);
  await started.promise;
  a.session.stop();
  const newBootstrap = await a.session.start({ cwd: 'recovered-project' });
  const eventCount = a.events.length;
  firstStart.resolve();
  await failure;
  assert.strictEqual(a.session.bootstrap, newBootstrap);
  assert.equal(newBootstrap.cwd, 'recovered-project');
  assert.equal(a.events.length, eventCount);
  assert.equal(clients[1].stops, 0);
});

test('terminal status during a pending settings save cannot restore a dead bootstrap', async () => {
  const saving = deferred();
  const saved = deferred();
  const a = fixture({}, { persistSettings: () => { saving.resolve(); return saved.promise; } });
  const boot = a.session.start();
  const failure = assert.rejects(boot, /Подключение Codex изменилось/);
  await saving.promise;
  a.clients[0].emit('status', { state: 'stopped' });
  saved.resolve();
  await failure;
  assert.equal(a.session.bootstrap, null);
  await assert.rejects(a.session.request('thread/start'), /Нет подключения/);
});

test('window snapshots survive other settings writes and reconnects; shared defaults keep every patch', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'settings.json');
  await writeFile(filename, JSON.stringify({ cwd: 'saved-project', model: 'saved-model', effort: 'ultra', access: 'auto', executable: 'saved-codex', futureSetting: 42 }));
  const store = new SettingsStore(filename);
  const defaults = await store.snapshot();
  const a = fixture(defaults, { persistSettings: patch => store.update(patch) });
  const b = fixture({ ...a.session.getSettings(), cwd: 'selected-project' }, { persistSettings: patch => store.update(patch) });
  await Promise.all([a.session.start(), b.session.start()]);
  await Promise.all([
    a.session.setSettings({ model: 'changed-model', effort: 'low', access: 'read-only', executable: 'changed-codex' }),
    b.session.setSettings({ cwd: 'selected-project' }),
  ]);
  const returned = b.session.getSettings();
  returned.model = 'mutated-copy';
  b.session.stop();
  const bootstrap = await b.session.start();
  assert.equal(bootstrap.cwd, 'selected-project');
  assert.equal(bootstrap.executable, 'saved-codex');
  assert.deepEqual(b.session.getSettings(), { cwd: 'selected-project', model: 'saved-model', effort: 'ultra', access: 'auto', executable: 'saved-codex' });
  const updates = [store.update({ model: 'last-model' }), store.snapshot(), store.update({ access: 'auto' }), store.snapshot()];
  const results = await Promise.all(updates);
  assert.equal(results[1].model, 'last-model');
  assert.equal(results[3].access, 'auto');
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { cwd: 'selected-project', model: 'last-model', effort: 'low', access: 'auto', executable: 'changed-codex', futureSetting: 42 });
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('shutdown flush waits for settings queued during an earlier write and leaves a complete settings file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'settings.json');
  const store = new SettingsStore(filename);
  const first = store.update({ cwd: 'project-a' });
  void first.then(() => store.update({ model: 'model-after-first-write' }));
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { cwd: 'project-a', model: 'model-after-first-write' });
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('trusted IPC resolves only owned tabs and rejects foreign, spoofed, child and disposed senders', () => {
  const makeRecord = id => ({ window: { isDestroyed: () => false, webContents: { id, mainFrame: {} } }, sessions: new Map([[`session-${id}`, fixture().session]]), defaultSessionId: `session-${id}` });
  const a = makeRecord(1);
  const b = makeRecord(2);
  const records = new Map([[1, a], [2, b]]);
  const event = { sender: b.window.webContents, senderFrame: b.window.webContents.mainFrame };
  const secondTab = fixture({ cwd: 'another-project' }).session;
  b.sessions.set('second-tab', secondTab);
  assert.strictEqual(sessionForEvent(records, event).session, b.sessions.get('session-2'));
  assert.strictEqual(sessionForEvent(records, event, 'second-tab').session, secondTab);
  assert.throws(() => sessionForEvent(records, event, 'session-1'), /Недопустимая/);
  assert.throws(() => sessionForEvent(records, event, ''), /Недопустимая/);
  assert.throws(() => sessionForEvent(records, event, null), /Недопустимая/);
  assert.throws(() => sessionForEvent(records, { ...event, senderFrame: {} }), /Недопустимый/);
  assert.throws(() => sessionForEvent(records, { ...event, sender: { id: 1 } }), /Недопустимый/);
  assert.throws(() => sessionForEvent(records, { ...event, sender: { id: 404 } }), /Недопустимый/);
  b.sessions.get('session-2').dispose();
  assert.throws(() => sessionForEvent(records, event), /Недопустимая/);
  assert.strictEqual(sessionForEvent(records, event, 'second-tab').session, secondTab);
  b.defaultSessionId = 'second-tab';
  assert.strictEqual(sessionForEvent(records, event).session, secondTab);
  b.sessions.clear();
  b.defaultSessionId = null;
  assert.strictEqual(windowForEvent(records, event), b);
  assert.throws(() => sessionForEvent(records, event), /Недопустимая/);
});

test('workspace stores additive folder order separately from settings and deduplicates concurrent additions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workspace.json');
  const settingsFilename = path.join(dir, 'settings.json');
  const originalSettings = JSON.stringify({ cwd: 'original-project', model: 'configured-model', futureSetting: 42 });
  await writeFile(settingsFilename, originalSettings);
  const workspace = new WorkspaceStore(filename);
  assert.deepEqual(await workspace.snapshot(), { projects: [] });
  await Promise.all([workspace.addProject('project-a'), workspace.addProject('project-b'), workspace.addProject('project-a')]);
  await workspace.flush();
  assert.deepEqual(await new WorkspaceStore(filename).snapshot(), { projects: ['project-a', 'project-b'] });
  const returned = await workspace.snapshot();
  returned.projects.push('mutated-copy');
  assert.deepEqual(await workspace.snapshot(), { projects: ['project-a', 'project-b'] });
  assert.equal(await readFile(settingsFilename, 'utf8'), originalSettings);
  assert.deepEqual((await readdir(dir)).sort(), ['settings.json', 'workspace.json']);
});

test('closing projects persists their removal, preserves files and history, and allows adding them again', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-close-project-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workspace.json');
  const workspace = new WorkspaceStore(filename);
  const first = path.join(dir, 'first-project');
  const second = path.join(dir, 'second-project');
  const projectFile = path.join(dir, 'project-content.txt');
  const historyFile = path.join(dir, 'history.jsonl');
  await writeFile(projectFile, 'user files stay untouched');
  await writeFile(historyFile, 'history owned by Codex');
  await writeFile(filename, JSON.stringify({ projects: [first, second], futureProperty: 42 }));
  await workspace.removeProject(`${first}${path.sep}`);
  assert.deepEqual(await new WorkspaceStore(filename).snapshot(), { projects: [second] });
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).futureProperty, 42);
  assert.equal(await readFile(projectFile, 'utf8'), 'user files stay untouched');
  assert.equal(await readFile(historyFile, 'utf8'), 'history owned by Codex');
  await workspace.addProject(first);
  assert.deepEqual(await workspace.snapshot(), { projects: [second, first] });
  await Promise.all([workspace.removeProject(first), workspace.addProject('third-project'), workspace.removeProject(second)]);
  assert.deepEqual(await workspace.snapshot(), { projects: ['third-project'] });
  if (process.platform === 'win32') {
    await workspace.removeProject('THIRD-PROJECT');
    assert.deepEqual(await workspace.snapshot(), { projects: [] });
  }
  assert.throws(() => workspace.removeProject(null), /Некорректная/);
});

test('workspace migrates legacy defaults only once and never revives a closed project during boot', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-workspace-boot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workspace.json');
  const workspace = new WorkspaceStore(filename);
  await workspace.initializeProjects('legacy-project');
  assert.deepEqual(await workspace.snapshot(), { projects: ['legacy-project'] });
  await workspace.addProject('another-project');
  await workspace.removeProject('legacy-project');
  await new WorkspaceStore(filename).initializeProjects('legacy-project');
  assert.deepEqual(await workspace.snapshot(), { projects: ['another-project'] });
  await workspace.removeProject('another-project');
  await new WorkspaceStore(filename).initializeProjects('legacy-project');
  assert.deepEqual(await workspace.snapshot(), { projects: [] });
  await workspace.addProject('legacy-project');
  assert.deepEqual(await workspace.snapshot(), { projects: ['legacy-project'] });
});

test('config responses remain filtered and methods outside the bridge remain rejected', async () => {
  const a = fixture();
  const boot = await a.session.start();
  assert.deepEqual(boot.config, { model: 'configured-model', model_reasoning_effort: 'high' });
  const result = await a.session.request('config/read', { cwd: 'different-project' });
  assert.deepEqual(result, { config: boot.config, layers: null, origins: {} });
  assert.equal(a.clients[0].calls.at(-1).params.cwd, 'project-a');
  await a.session.request('thread/list', { cwd: 'different-project', limit: 30 });
  assert.deepEqual(a.clients[0].calls.at(-1).params, { cwd: 'project-a', limit: 30 });
  await assert.rejects(a.session.request('config/value/write'), /метод недоступен/);
});

test('manual compaction reaches only the owning transport with its exact thread parameters', async () => {
  const a = fixture();
  const b = fixture({ cwd: 'project-b' });
  await Promise.all([a.session.start(), b.session.start()]);
  await a.session.request('thread/compact/start', { threadId: 'thread-a' });
  assert.deepEqual(a.clients[0].calls.at(-1), { method: 'thread/compact/start', params: { threadId: 'thread-a' } });
  assert.equal(b.clients[0].calls.some(call => call.method === 'thread/compact/start'), false);
  assert.equal(a.clients[0].calls.some(call => call.method === 'turn/start'), false);
  await assert.rejects(a.session.request('thread/compact/other'), /метод недоступен/);
});

const terminalThreadId = '11111111-2222-3333-4444-555555555555';

async function terminalFixture() {
  const launches = [];
  const child = new EventEmitter();
  child.unrefs = 0;
  child.unref = () => { child.unrefs++; };
  child.kill = () => { throw new Error('An external console must not be killed.'); };
  const a = fixture({}, { launchTerminal: options => { launches.push(options); return child; } });
  await a.session.start();
  const original = a.clients[0].request.bind(a.clients[0]);
  a.clients[0].request = (method, params) => method === 'thread/read'
    ? Promise.resolve({ thread: { id: terminalThreadId, cwd: 'project-a', status: { type: 'idle' }, turns: [] } })
    : original(method, params);
  return { ...a, child, launches };
}

test('terminal handoff stops only the idle owning transport, preserves settings and returns on spawn', async () => {
  const a = await terminalFixture();
  const b = fixture({ cwd: 'project-b' });
  await b.session.start();
  const eventCount = a.events.length;
  const opened = a.session.openTerminal({ threadId: terminalThreadId, model: 'selected-model', effort: 'ultra', access: 'read-only', cwd: 'spoofed-project', executable: 'spoofed-code' });
  await Promise.resolve();
  assert.deepEqual(a.launches, [{ executable: 'codex-a', cwd: 'project-a', threadId: terminalThreadId, model: 'selected-model', effort: 'ultra', access: 'read-only' }]);
  assert.equal(a.clients[0].stops, 1);
  assert.equal(b.clients[0].stops, 0);
  assert.equal(a.events.length, eventCount);
  assert.throws(() => a.session.start(), /открыт в терминале/);
  assert.throws(() => a.session.setSettings({ cwd: 'other-project' }), /открыт в терминале/);
  await assert.rejects(a.session.request('turn/start', { input: ['cannot-send'] }), /открыт в терминале/);
  await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /открыт в терминале/);
  a.child.emit('spawn');
  assert.deepEqual(await opened, { threadId: terminalThreadId });
  assert.equal(a.child.unrefs, 1);
  assert.deepEqual(a.events.at(-1), { type: 'terminal', data: { state: 'opened', threadId: terminalThreadId } });
  assert.equal(a.session.settings.model, 'model-a');
  a.child.emit('close', 0, null);
  assert.deepEqual(a.events.at(-1), { type: 'terminal', data: { state: 'closed', threadId: terminalThreadId } });
  assert.equal(a.session.terminal, null);
  await a.session.start();
  assert.equal(a.clients.length, 2);
  assert.equal(b.clients[0].stops, 0);
});

test('terminal reservation blocks concurrent mutations and boots while validating idle history', async () => {
  const a = await terminalFixture();
  const reading = deferred();
  a.clients[0].request = () => reading.promise;
  const opened = a.session.openTerminal({ threadId: terminalThreadId });
  await assert.rejects(a.session.request('thread/compact/start', { threadId: terminalThreadId }), /открыт в терминале/);
  assert.throws(() => a.session.start({ cwd: 'different' }), /открыт в терминале/);
  assert.throws(() => a.session.setSettings({ executable: 'different' }), /открыт в терминале/);
  await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /открыт в терминале/);
  reading.resolve({ thread: { id: terminalThreadId, turns: [], status: { type: 'idle' } } });
  await Promise.resolve();
  a.child.emit('spawn');
  await opened;
  a.child.emit('close', 0, null);
});

test('terminal validates history ownership, active turns and approvals before stopping Codex', async () => {
  const invalid = [
    { id: 'another-thread', turns: [] },
    { id: terminalThreadId, cwd: 'another-project', turns: [] },
    { id: terminalThreadId, status: { type: 'active' }, turns: [] },
    { id: terminalThreadId, turns: [{ id: 'busy-turn', status: 'inProgress' }] },
  ];
  for (const thread of invalid) {
    const a = await terminalFixture();
    a.clients[0].request = async () => ({ thread });
    await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /другой|Дождитесь/);
    assert.equal(a.launches.length, 0);
    assert.equal(a.clients[0].stops, 0);
    assert.equal(a.session.terminal, null);
    assert.equal(a.events.some(event => event.type === 'terminal'), false);
  }
  const a = await terminalFixture();
  await assert.rejects(a.session.openTerminal({ threadId: 'invalid-id' }), /идентификатор/);
  a.clients[0].emit('serverRequest', { id: 1, method: 'approval' });
  await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /подтверждений/);
  assert.equal(a.clients[0].stops, 0);
});

test('approval, active turn or generation changes during terminal validation prevent launch', async () => {
  for (const operation of ['approval', 'turn-started', 'stop', 'dispose']) {
    const a = await terminalFixture();
    const reading = deferred();
    a.clients[0].request = () => reading.promise;
    const opened = a.session.openTerminal({ threadId: terminalThreadId });
    const rejection = assert.rejects(opened, /подтверждений|Сеанс окна/);
    if (operation === 'approval') a.clients[0].emit('serverRequest', { id: 1, method: 'approval' });
    else if (operation === 'turn-started') a.clients[0].emit('notification', { method: 'turn/started', params: { threadId: terminalThreadId, turn: { id: 'new-turn', status: 'inProgress' } } });
    else a.session[operation]();
    reading.resolve({ thread: { id: terminalThreadId, turns: [] } });
    await rejection;
    assert.equal(a.launches.length, 0);
    assert.equal(a.session.terminal, null);
  }
});

test('in-flight turn RPC and queued boots cannot race terminal launch', async () => {
  const a = await terminalFixture();
  const pending = a.session.request('turn/start', { threadId: terminalThreadId, input: [] });
  await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /подтверждений/);
  a.clients[0].turn.resolve({ turn: { id: 'turn-a' } });
  await pending;
  const lookup = deferred();
  a.session.resolveDirectory = () => lookup.promise;
  const reconnect = a.session.start();
  await assert.rejects(a.session.openTerminal({ threadId: terminalThreadId }), /подтверждений/);
  lookup.resolve('project-a');
  await reconnect;
  assert.equal(a.launches.length, 0);
});

test('disposal before spawn leaves helper ownership intact and suppresses terminal events', async () => {
  const a = await terminalFixture();
  const opened = a.session.openTerminal({ threadId: terminalThreadId });
  const rejection = assert.rejects(opened, /Сеанс окна завершён/);
  await Promise.resolve();
  a.session.dispose();
  a.child.emit('spawn');
  await rejection;
  a.child.emit('close', 0, null);
  assert.equal(a.events.some(event => event.type === 'terminal'), false);
  assert.equal(a.session.terminal, null);
});

test('terminal spawn failures recover the paused connection and duplicate close is ignored', async () => {
  for (const synchronous of [true, false]) {
    const a = await terminalFixture();
    if (synchronous) a.session.launchTerminal = () => { throw new Error('spawn failed'); };
    const opened = a.session.openTerminal({ threadId: terminalThreadId });
    const rejection = assert.rejects(opened, /spawn failed/);
    await Promise.resolve();
    if (!synchronous) a.child.emit('error', new Error('spawn failed'));
    await rejection;
    assert.equal(a.session.terminal, null);
    assert.deepEqual(a.events.at(-1), { type: 'terminal', data: { state: 'closed', threadId: terminalThreadId, error: 'spawn failed' } });
    const eventCount = a.events.length;
    a.child.emit('close', -1, null);
    assert.equal(a.events.length, eventCount);
    await a.session.start();
    assert.equal(a.clients.length, 2);
  }
});

test('closing the app leaves an external console alive and suppresses callbacks into disposed session', async () => {
  const a = await terminalFixture();
  const opened = a.session.openTerminal({ threadId: terminalThreadId });
  await Promise.resolve();
  a.child.emit('spawn');
  await opened;
  const eventCount = a.events.length;
  a.session.dispose();
  a.child.emit('close', 0, null);
  assert.equal(a.events.length, eventCount);
  assert.equal(a.session.terminal, null);
});


test('message status checks exact identifiers, trusts late receipts, and never treats matching text as delivery', async t => {
  const { session, clients } = fixture(); t.after(() => session.dispose()); await session.start();
  const clientUserMessageId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const client = clients[0], original = client.request.bind(client);
  client.request = (method, params) => method === 'thread/read' ? Promise.resolve({ thread: { id: params.threadId, turns: [{ id: 'turn-a', status: 'completed', items: [{ id: 'other-id', type: 'userMessage', content: [{ type: 'text', text: 'same text' }] }] }] } }) : original(method, params);
  assert.deepEqual(await session.request('message/status', { threadId: 'thread-a', clientUserMessageId }), { accepted: false, rejected: false });
  client.emit('notification', { method: 'message/receipt', params: { threadId: 'thread-a', clientUserMessageId, accepted: true, rejected: false, turnId: 'turn-a' } });
  assert.equal((await session.request('message/status', { threadId: 'thread-a', clientUserMessageId })).accepted, true);
  assert.equal((await session.request('message/status', { threadId: 'thread-b', clientUserMessageId })).accepted, false);
  await assert.rejects(session.request('message/status', { threadId: 'thread-a', clientUserMessageId: '' }), /идентификатор/);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('history receipts work after host restart using clientId and native Claude UUID', async t => {
  const { session, clients } = fixture(); t.after(() => session.dispose()); await session.start();
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const client = clients[0];
  for (const item of [{ id: 'provider-id', clientId: id }, { id }]) {
    client.request = async () => ({ thread: { id: 'thread-a', turns: [{ id: 'turn-a', status: 'completed', items: [{ ...item, type: 'userMessage', content: [] }] }] } });
    session.messageReceipts.clear();
    const receipt = await session.request('message/status', { threadId: 'thread-a', clientUserMessageId: id });
    assert.equal(receipt.accepted, true); assert.equal(receipt.turnId, 'turn-a'); assert.equal(receipt.status, 'completed');
  }
});
