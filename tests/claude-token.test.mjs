import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeLaunchGate, ClaudeTokenStore, validateClaudeToken } from '../electron/claude-token.mjs';
import { ClaudeAuthService } from '../electron/claude-auth.mjs';
import { ClaudeClient } from '../electron/claude-client.mjs';
import { WindowSession } from '../electron/window-session.mjs';
import { buildClaudeSetupTokenLaunch, buildTerminalLaunch } from '../electron/terminal-launcher.mjs';

const sample = `sk-ant-oat01-${'a1B2c3D4'.repeat(12)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function store(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-claude-token-'));
  const changes = [];
  const created = new ClaudeTokenStore({
    filename: path.join(directory, 'nested', 'claude-token.json'),
    encrypt: value => Buffer.from(`enc:${value}`, 'utf8'), decrypt: bytes => { const text = bytes.toString('utf8'); if (!text.startsWith('enc:')) throw new Error('bad'); return text.slice(4); },
    onChange: kind => changes.push(kind), ...overrides,
  });
  return { store: created, directory, changes, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('token validation accepts only setup-token shaped strings', () => {
  assert.equal(validateClaudeToken(`  ${sample}\n`), sample);
  for (const bad of [undefined, 42, '', 'sk-ant-api03-' + 'x'.repeat(60), 'sk-ant-oat01-short', `${sample} extra`, sample.replace('oat01', 'oat0')]) {
    assert.throws(() => validateClaudeToken(bad), /setup-token/);
  }
});

test('token store encrypts at rest, exposes no secret to info and feeds only the CLI environment', async () => {
  const f = await store();
  try {
    assert.deepEqual(await f.store.info(), { configured: false, encryptionAvailable: true });
    assert.deepEqual(await f.store.environment(), {});
    const saved = await f.store.set(`${sample}\n`);
    assert.equal(saved.configured, true); assert.ok(saved.savedAt);
    const raw = JSON.parse(await readFile(f.store.filename, 'utf8'));
    assert.equal(raw.version, 1); assert.doesNotMatch(JSON.stringify(raw), /sk-ant-oat/);
    assert.equal(Buffer.from(raw.token, 'base64').toString('utf8'), `enc:${sample}`);
    assert.deepEqual(await f.store.info(), { configured: true, savedAt: saved.savedAt, encryptionAvailable: true });
    assert.deepEqual(await f.store.environment(), { CLAUDE_CODE_OAUTH_TOKEN: sample });
    // A fresh store instance reads the same file back.
    const again = new ClaudeTokenStore({ filename: f.store.filename, encrypt: f.store.encrypt, decrypt: f.store.decrypt });
    assert.deepEqual(await again.environment(), { CLAUDE_CODE_OAUTH_TOKEN: sample });
    assert.deepEqual(await f.store.clear(), { configured: false, encryptionAvailable: true });
    assert.deepEqual(await f.store.environment(), {});
    await assert.rejects(readFile(f.store.filename), { code: 'ENOENT' });
    assert.deepEqual(f.changes, ['saved', 'cleared']);
    await f.store.clear();
    await assert.rejects(f.store.set('nope'), /setup-token/);
  } finally { await f.cleanup(); }
});

test('unreadable or undecryptable token storage reports an error and yields no environment', async () => {
  const f = await store();
  try {
    await f.store.set(sample);
    await writeFile(f.store.filename, 'not json');
    const fresh = () => new ClaudeTokenStore({ filename: f.store.filename, encrypt: f.store.encrypt, decrypt: f.store.decrypt });
    const info = await fresh().info();
    assert.equal(info.configured, false); assert.match(info.error, /не читается/);
    assert.deepEqual(await fresh().environment(), {});
    await writeFile(f.store.filename, JSON.stringify({ version: 1, token: Buffer.from('other:x').toString('base64'), savedAt: 'now' }));
    const reread = fresh();
    assert.match((await reread.info()).error, /не читается/);
    assert.deepEqual(await reread.environment(), {});
    // Clearing recovers.
    await reread.clear();
    assert.deepEqual(await reread.info(), { configured: false, encryptionAvailable: true });
  } finally { await f.cleanup(); }
});

test('token store refuses to save when OS encryption is unavailable', async () => {
  const f = await store({ available: () => false });
  try {
    await assert.rejects(f.store.set(sample), /Шифрование/);
    assert.deepEqual(await f.store.info(), { configured: false, encryptionAvailable: false });
    assert.deepEqual(f.changes, []);
  } finally { await f.cleanup(); }
});

test('launch gate runs jobs one at a time, survives failures and stops waiting for a stalled predecessor', async () => {
  const gate = new ClaudeLaunchGate({ maxWaitMs: 50 });
  const order = [];
  const first = deferred();
  const a = gate.run(async () => { order.push('a:start'); await first.promise; order.push('a:end'); return 'a'; });
  const b = gate.run(async () => { order.push('b:start'); throw new Error('boom'); });
  const c = gate.run(async () => { order.push('c:start'); return 'c'; });
  await tick();
  assert.deepEqual(order, ['a:start']);
  assert.equal(gate.pending, 3);
  first.resolve();
  assert.equal(await a, 'a');
  await assert.rejects(b, /boom/);
  assert.equal(await c, 'c');
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'c:start']);
  assert.equal(gate.pending, 0);
  const stalled = gate.run(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await gate.run(async () => 'after'), 'after');
  assert.ok(Date.now() - started >= 40, 'waited for the stall limit');
  void stalled;
  assert.throws(() => new ClaudeLaunchGate({ maxWaitMs: 0 }), TypeError);
});

test('Claude client merges host variables over the inherited environment only when given', () => {
  const seen = [];
  const spawnImpl = (_exe, _args, options) => { seen.push(options.env); const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; };
  new ClaudeClient({ executable: 'claude.exe', cwd: 'E:\\p', spawnImpl, requestTimeoutMs: 10 })._launch({ id: '11111111-1111-4111-8111-111111111111' }).catch(() => {});
  new ClaudeClient({ executable: 'claude.exe', cwd: 'E:\\p', spawnImpl, requestTimeoutMs: 10, env: { CLAUDE_CODE_OAUTH_TOKEN: sample } })._launch({ id: '11111111-1111-4111-8111-111111111112' }).catch(() => {});
  assert.equal(seen[0], undefined);
  assert.equal(seen[1].CLAUDE_CODE_OAUTH_TOKEN, sample);
  assert.equal(seen[1].PATH ?? seen[1].Path, process.env.PATH ?? process.env.Path);
  assert.throws(() => new ClaudeClient({ env: 'token' }), TypeError);
});

function fakeClaudeClient(log, name, start = async () => ({ version: '2.1.278' })) {
  const client = new EventEmitter();
  client.start = async () => { log.push(`${name}:start`); const result = await start(); log.push(`${name}:started`); return result; };
  client.request = async method => {
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'usage/read') { log.push(`${name}:usage`); await tick(); log.push(`${name}:usage-done`); return { available: false, windows: [] }; }
    return method === 'config/read' ? { config: {} } : { account: null };
  };
  client.stop = () => {};
  return client;
}

test('window sessions start Claude processes with the host token one at a time and serialize usage reads', async () => {
  const log = [], gate = new ClaudeLaunchGate(), envs = [];
  const starts = [deferred(), deferred()];
  const make = index => new WindowSession({
    settings: { provider: 'claude', cwd: 'E:\\p', executable: 'C:\\claude.exe' },
    resolveDirectory: async value => value, resolveClaudeExecutable: async value => value,
    claudeEnvironment: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: sample }), claudeGate: gate,
    createClaudeClient: options => { envs.push(options.env); return fakeClaudeClient(log, `s${index}`, () => starts[index].promise); },
  });
  const first = make(0), second = make(1);
  const boots = [first.start(), second.start()];
  await tick();
  assert.deepEqual(log, ['s0:start'], 'second start waits for the first process to finish booting');
  starts[0].resolve({ version: '2.1.278' });
  await tick(); await tick();
  assert.deepEqual(log.slice(0, 3), ['s0:start', 's0:started', 's1:start']);
  starts[1].resolve({ version: '2.1.278' });
  await Promise.all(boots);
  assert.deepEqual(envs, [{ CLAUDE_CODE_OAUTH_TOKEN: sample }, { CLAUDE_CODE_OAUTH_TOKEN: sample }]);
  log.length = 0;
  await Promise.all([first.request('usage/read', {}), second.request('usage/read', {})]);
  assert.deepEqual(log, ['s0:usage', 's0:usage-done', 's1:usage', 's1:usage-done']);
  // Without a token the client receives no env option at all, and Codex sessions never consult the gate.
  const plain = new WindowSession({ settings: { provider: 'claude', cwd: 'E:\\p', executable: 'C:\\claude.exe' }, resolveDirectory: async v => v, resolveClaudeExecutable: async v => v,
    createClaudeClient: options => { envs.push(options.env); return fakeClaudeClient(log, 'plain'); } });
  await plain.start();
  assert.equal(envs.at(-1), undefined);
});

test('auth status sees the token environment while browser login and setup-token consoles do not', async () => {
  const contexts = [];
  const spawnChild = () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  const service = new ClaudeAuthService({
    getEnvironment: async () => ({ BASE: '1', CLAUDE_CODE_OAUTH_TOKEN: sample }), getLoginEnvironment: () => ({ BASE: '1' }),
    readStatus: async options => { contexts.push(['status', options.env]); return { loggedIn: true, authMethod: 'oauth_token' }; },
    launchTerminal: options => { contexts.push(['login', options.env]); return spawnChild(); },
    launchSetupToken: options => { contexts.push(['setup', options.env]); return spawnChild(); },
  });
  const session = new WindowSession({ settings: { provider: 'claude', cwd: 'E:\\p', executable: 'C:\\claude.exe' }, claudeAuth: service, resolveDirectory: async v => v, resolveClaudeExecutable: async v => v });
  assert.equal((await service.status(session)).loggedIn, true);
  assert.deepEqual(await service.setupToken(session), { started: true });
  assert.deepEqual(await service.login(session), { started: true });
  assert.deepEqual(contexts.map(([kind, env]) => [kind, env.CLAUDE_CODE_OAUTH_TOKEN === sample]), [['status', true], ['setup', false], ['login', false]]);
  const codex = new WindowSession({ settings: { provider: 'codex', cwd: 'E:\\p' }, claudeAuth: service });
  await assert.rejects(service.setupToken(codex), /настройках Claude/);
});

test('terminal launches forward a caller environment and setup-token uses the fixed CLI command', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: sample };
  const resume = buildTerminalLaunch({ executable: 'C:\\claude.exe', cwd: 'E:\\p', threadId: 'claude:11111111-1111-4111-8111-111111111111', provider: 'claude', env });
  assert.equal(resume.options.env, env);
  assert.equal(buildTerminalLaunch({ executable: 'C:\\codex.exe', cwd: 'E:\\p', threadId: '11111111-1111-4111-8111-111111111111' }).options.env, undefined);
  assert.throws(() => buildTerminalLaunch({ executable: 'C:\\claude.exe', cwd: 'E:\\p', threadId: 'claude:11111111-1111-4111-8111-111111111111', provider: 'claude', env: 'x' }), /окружение/);
  const setup = buildClaudeSetupTokenLaunch({ executable: 'C:\\claude.exe', cwd: 'E:\\p', env: { BASE: '1' } });
  assert.deepEqual(setup.codexArgs, ['setup-token']);
  assert.deepEqual(setup.options.env, { BASE: '1' });
  assert.doesNotMatch(setup.script, /login|--resume/);
  assert.throws(() => buildClaudeSetupTokenLaunch({ executable: 'claude', cwd: 'E:\\p' }));
});
