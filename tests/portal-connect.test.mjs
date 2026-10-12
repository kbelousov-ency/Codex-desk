import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortalConnectService } from '../electron/portal-connect.mjs';
import { RouterPortalClient } from '../electron/router-portal.mjs';

const key = 'router-secret-fixture';
const claudeKey = 'claude-secret-fixture';
const provider = { name: 'Router', base_url: 'https://router.example.com/v1', wire_api: 'responses', requires_openai_auth: false };
const defaults = { model: 'gpt-test', model_provider: 'router', model_context_window: 1000000,
  model_auto_compact_token_limit: 900000, model_reasoning_summary: 'detailed', hide_agent_reasoning: false };
const portalEnv = { ANTHROPIC_BASE_URL: 'https://router.example.com', ANTHROPIC_AUTH_TOKEN: claudeKey,
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/sonnet', ENABLE_TOOL_SEARCH: 'true' };
const payload = { settings: { env: portalEnv, model: 'opus', effortLevel: 'medium', autoUpdatesChannel: 'latest' }, path: 'ignored-path' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function safe(status) {
  assert.doesNotMatch(JSON.stringify(status), /router-secret-fixture|claude-secret-fixture|api_key|cookie-secret/);
  assert.equal(typeof status.running, 'boolean');
  for (const result of Object.values(status.products)) {
    assert.ok(['idle', 'working', 'done', 'error', 'skipped'].includes(result.state));
    assert.ok(Object.keys(result).every(name => ['state', 'message', 'configPath', 'backupPath'].includes(name)));
  }
  return status;
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desk-portal-connect-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'claude');
  const filename = path.join(configDir, 'settings.json');
  const calls = [];
  const operations = [];
  const connections = [];
  const state = { state: 'signed-in', keyState: 'approved', products: { codex: true, claude: true }, ...options.state };
  const env = { USERPROFILE: root, CLAUDE_CONFIG_DIR: configDir };
  const service = new PortalConnectService({
    env,
    portalSession: { status: async () => state, routerKey: async () => options.nullKey ? null : key },
    session: { fetch: async (url, request) => {
      calls.push({ url, ...request });
      assert.equal(url, 'https://coder-portal.encycam.com/api/config/claude?scope=global');
      assert.equal(request.credentials, 'include');
      assert.equal(request.redirect, 'error');
      assert.equal(request.cache, 'no-store');
      assert.equal(request.headers.Authorization, undefined);
      return options.cookieFetch ? options.cookieFetch(url, request) : reply(options.payload || payload);
    } },
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      if (request.headers.Authorization === 'Bearer ' + claudeKey) {
        assert.equal(url, 'https://router.example.com/v1/models', 'Claude catalog uses /v1 and the Claude token');
        assert.equal(request.headers.Authorization, 'Bearer ' + claudeKey);
      } else {
        assert.equal(url, 'https://router.example.com/v1/models', 'Codex catalog uses provider.base_url');
        assert.equal(request.headers.Authorization, 'Bearer ' + key, 'Codex uses the router token');
      }
      assert.equal(request.credentials, 'omit');
      assert.equal(request.redirect, 'error');
      return options.verifyFetch ? options.verifyFetch(url, request) : reply({ data: [] });
    },
    scan: options.scan || (async () => ({ components: [
      { id: 'codex', status: options.missing === 'codex' ? 'missing' : 'installed' },
      { id: 'claude', status: options.missing === 'claude' ? 'missing' : 'installed' },
    ] })),
    getSettings: async () => ({ executable: 'preferred-codex.exe' }),
    resolveExecutable: async preferred => { assert.equal(preferred, 'preferred-codex.exe'); return 'resolved-codex.exe'; },
    routerPortal: { config: async received => { assert.equal(received, key); operations.push('config'); return { apiKey: key, provider, defaults }; }, cancel() {} },
    createClient: config => {
      assert.equal(config.executable, 'resolved-codex.exe');
      return { start: async () => { operations.push('start'); }, request: async method => { operations.push(method); return {}; }, stop: () => { operations.push('stop'); } };
    },
    createManager: wiring => ({
      preview: async received => { assert.deepEqual(received, { apiKey: key, provider, defaults }); operations.push('preview'); await wiring.request('config/read', {}); return { previewId: 'preview-id' }; },
      save: async received => { assert.deepEqual(received, { previewId: 'preview-id' }); operations.push('save'); await wiring.request('config/batchWrite', {}); return { configPath: path.join(root, 'config.toml'), backupPath: path.join(root, 'config.toml.backup'), api_key: key }; },
      dispose: () => { operations.push('dispose'); },
    }),
    runMutation: options.runMutation || (async (product, task) => { operations.push('guard:' + product); return task(); }),
    routerConnections: { set: async (product, connection) => { assert.equal(product, 'claude'); assert.equal(connection.apiKey, claudeKey); connections.push(connection); } },
    boatswainSetup: { readClaudeConnection: async () => {
      const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
      return { baseUrl: saved.env.ANTHROPIC_BASE_URL, apiKey: saved.env.ANTHROPIC_AUTH_TOKEN };
    } },
    reconnectAfterSetup: product => { operations.push('reconnect:' + product); },
    ...(options.files ? { files: options.files } : {}),
  });
  return { service, root, configDir, filename, calls, operations, connections, state, async existing(value, bom = false) {
    await fs.mkdir(configDir, { recursive: true });
    const bytes = (bom ? '\uFEFF' : '') + (typeof value === 'string' ? value : JSON.stringify(value));
    await fs.writeFile(filename, bytes);
    return Buffer.from(bytes);
  } };
}

test('Claude merges env only, drops exactly six names and preserves all foreign settings', async context => {
  const f = await fixture(context);
  const old = { permissions: { allow: ['Read'] }, hooks: { stop: ['notify'] }, mcp: { custom: {} }, model: 'user-model', effortLevel: 'high', autoUpdatesChannel: 'stable', env: {
    CUSTOM_FLAG: 'keep', ANTHROPIC_API_KEY: 'foreign-key', ANTHROPIC_MODEL: 'old',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Old Opus',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-fable', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Old Fable',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'keep-haiku', ANTHROPIC_SMALL_FAST_MODEL: 'keep-small',
  } };
  const original = await f.existing(old, true);
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'done');
  assert.equal(result.configPath, f.filename);
  assert.deepEqual(await fs.readFile(result.backupPath), original);
  const output = await fs.readFile(f.filename);
  assert.notDeepEqual([...output.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const saved = JSON.parse(output);
  for (const name of ['permissions', 'hooks', 'mcp', 'model', 'effortLevel', 'autoUpdatesChannel']) assert.deepEqual(saved[name], old[name]);
  assert.deepEqual(saved.env, { CUSTOM_FLAG: 'keep', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'keep-haiku', ANTHROPIC_SMALL_FAST_MODEL: 'keep-small', ...portalEnv });
  const names = await fs.readdir(f.configDir);
  assert.equal(names.filter(name => name.startsWith('settings.json.backup-')).length, 1);
  assert.equal(names.some(name => name.includes('.tmp-')), false);
  assert.equal(f.connections.length, 1);
  assert.ok(f.operations.includes('reconnect:claude'));
});

test('drop runs before overlay, so portal-provided Opus/Fable return', async context => {
  const env = { ...portalEnv, ANTHROPIC_DEFAULT_OPUS_MODEL: 'new-opus', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'New Fable' };
  const f = await fixture(context, { payload: { settings: { env } } });
  assert.equal(safe(await f.service.connect({ products: ['claude'] })).products.claude.state, 'done');
  assert.deepEqual(JSON.parse(await fs.readFile(f.filename, 'utf8')).env, env);
});

for (const baseUrl of ['https://router.example.com/', 'https://router.example.com/v1', 'https://router.example.com/v1/']) {
  test('Claude catalog normalizes trailing slashes and an existing /v1: ' + baseUrl, async context => {
    const f = await fixture(context, { payload: { settings: { env: { ...portalEnv, ANTHROPIC_BASE_URL: baseUrl } } } });
    const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
    assert.equal(result.state, 'done');
    const verification = f.calls.filter(call => call.headers.Authorization);
    assert.equal(verification.length, 1);
    assert.equal(verification[0].url, 'https://router.example.com/v1/models');
    assert.equal(verification[0].headers.Authorization, 'Bearer ' + claudeKey);
    assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).env.ANTHROPIC_BASE_URL, baseUrl);
  });
}

test('Claude writes a wx/0600 temporary file then atomically renames it', async context => {
  const events = [];
  let f;
  const files = { ...fs, writeFile: async (filename, bytes, options) => {
    assert.equal(options.flag, 'wx');
    assert.equal(options.mode, 0o600);
    events.push(filename.includes('.backup-') ? 'backup' : 'temp');
    return fs.writeFile(filename, bytes, options);
  }, rename: async (temporary, filename) => {
    assert.ok(temporary.startsWith(filename + '.tmp-'));
    assert.equal(await fs.readFile(filename, 'utf8'), '{"model":"keep"}');
    events.push('rename');
    return fs.rename(temporary, filename);
  } };
  f = await fixture(context, { files });
  await f.existing({ model: 'keep' });
  assert.equal(safe(await f.service.connect({ products: ['claude'] })).products.claude.state, 'done');
  assert.deepEqual(events, ['backup', 'temp', 'rename']);
});

for (const existing of ['not-json', 'null', '[]', '{"env":[]}']) {
  test('invalid existing Claude settings are untouched: ' + existing, async context => {
    const f = await fixture(context);
    const bytes = await f.existing(existing);
    const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
    assert.equal(result.state, 'error');
    assert.ok(result.message.includes(f.filename));
    assert.deepEqual(await fs.readFile(f.filename), bytes);
    assert.deepEqual(await fs.readFile(result.backupPath), bytes);
    assert.equal(f.calls.length, 1);
  });
}

test('Claude CAS refuses an external edit and cleans its temporary file', async context => {
  let filename;
  const external = '{"model":"external"}';
  const files = { ...fs, writeFile: async (target, bytes, options) => {
    await fs.writeFile(target, bytes, options);
    if (target.includes('.tmp-')) await fs.writeFile(filename, external);
  } };
  const f = await fixture(context, { files });
  filename = f.filename;
  await f.existing({ model: 'original' });
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'error');
  assert.match(result.message, /изменились/);
  assert.equal(await fs.readFile(filename, 'utf8'), external);
  assert.equal((await fs.readdir(f.configDir)).some(name => name.includes('.tmp-')), false);
});

test('Codex uses validated payload, preview/save, native request wiring and reconnect', async context => {
  const f = await fixture(context);
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'done');
  assert.deepEqual(f.operations, ['config', 'preview', 'start', 'config/read', 'guard:codex', 'save', 'config/batchWrite', 'reconnect:codex', 'dispose', 'stop']);
  assert.equal(f.calls[0].url, provider.base_url + '/models');
});

test('busy guard blocked result becomes an error without save or reconnect', async context => {
  const f = await fixture(context, { runMutation: async () => ({ blocked: true, message: 'Busy tab blocks this write. ' + key }) });
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'error');
  assert.match(result.message, /Busy tab/);
  assert.equal(f.operations.includes('save'), false);
  assert.equal(f.operations.includes('reconnect:codex'), false);
});

test('throwing guard blocks write as in PortalSetupService', async context => {
  const f = await fixture(context, { runMutation: async () => { throw new Error(key); } });
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'error');
  assert.match(result.message, /Завершите текущие задачи/);
  assert.equal(f.operations.includes('save'), false);
});

test('Codex executable disappearing after scan is skipped without native writes', async context => {
  const f = await fixture(context);
  f.service.resolveExecutable = async () => { throw new Error(key); };
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'skipped');
  assert.match(result.message, /не установлен/);
  assert.equal(f.operations.includes('preview'), false);
  assert.equal(f.operations.includes('save'), false);
});

test('Codex verification failure names the manager backup and does not reconnect', async context => {
  const f = await fixture(context, { verifyFetch: () => reply({ error: key }, 401) });
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'error');
  assert.ok(result.message.includes(result.backupPath));
  assert.match(result.message, /Проверка подключения/);
  assert.match(result.message, /HTTP 401/);
  assert.doesNotMatch(result.message, /Portal отклонил/);
  assert.match(result.message, /Войдите в Portal снова/);
  assert.ok(f.operations.includes('save'));
  assert.equal(f.operations.includes('reconnect:codex'), false);
});

test('blocked result from manager save is preserved as an error', async context => {
  const f = await fixture(context);
  f.service.createManager = () => ({ preview: async () => ({ previewId: 'id' }), save: async () => ({ blocked: true, message: 'Занят текущий диалог.' }), dispose() {} });
  const result = safe(await f.service.connect({ products: ['codex'] })).products.codex;
  assert.equal(result.state, 'error');
  assert.equal(result.message, 'Занят текущий диалог.');
  assert.equal(f.calls.length, 0);
});

test('cookie fetch timeout resolves safely even when fake fetch ignores abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const pending = deferred();
  const f = await fixture(context, { cookieFetch: () => { started.resolve(); return pending.promise; } });
  const run = f.service.connect({ products: ['claude'] });
  await started.promise;
  context.mock.timers.tick(15_001);
  const result = safe(await run).products.claude;
  assert.equal(result.state, 'error');
  assert.match(result.message, /не ответил вовремя/);
  assert.equal(f.service.controllers.size, 0);
  pending.resolve(reply(payload));
});

for (const [options, state, message] of [
  [{ state: { state: 'signed-out' } }, 'error', /Войдите в Portal/],
  [{ state: { keyState: 'pending' } }, 'error', /паузе/],
  [{ nullKey: true }, 'error', /паузе/],
  [{ missing: 'claude' }, 'skipped', /не установлен/],
  [{ state: { products: { codex: true, claude: false } } }, 'skipped', /Portal не даёт доступ/],
]) {
  test('precondition matrix: ' + JSON.stringify(options), async context => {
    const f = await fixture(context, options);
    const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
    assert.equal(result.state, state);
    assert.match(result.message, message);
    assert.equal(f.calls.length, 0);
  });
}

test('401 mid-connect suggests signing in again without writing Claude settings', async context => {
  const f = await fixture(context, { cookieFetch: () => reply({ detail: { error: { type: 'not_authenticated', message: key } } }, 401) });
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'error');
  assert.match(result.message, /Войдите в Portal снова/);
  await assert.rejects(fs.readFile(f.filename), { code: 'ENOENT' });
});

test('verification failure keeps written settings and names the backup', async context => {
  const f = await fixture(context, { verifyFetch: () => reply({ message: key }, 401) });
  const original = await f.existing({ model: 'keep' });
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'error');
  assert.ok(result.message.includes(result.backupPath));
  assert.match(result.message, /Проверка подключения/);
  assert.match(result.message, /HTTP 401/);
  assert.match(result.message, /Войдите в Portal снова/);
  assert.doesNotMatch(result.message, /Portal отклонил/);
  assert.match(result.message, /не откатывались/);
  assert.deepEqual(await fs.readFile(result.backupPath), original);
  assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, claudeKey);
  assert.equal(f.connections.length, 0);
});

for (const product of ['codex', 'claude']) {
  test('non-OK router verification has its own message: ' + product, async context => {
    const f = await fixture(context, { verifyFetch: () => reply({ error: key }, 503) });
    const result = safe(await f.service.connect({ products: [product] })).products[product];
    assert.equal(result.state, 'error');
    assert.match(result.message, /Проверка подключения.*HTTP 503/);
    assert.doesNotMatch(result.message, /Portal отклонил/);
    assert.match(result.message, /Резервная копия:/);
    assert.match(result.message, /не откатывались/);
  });
}

test('config-fetch failure retains the Portal rejection message', async context => {
  const f = await fixture(context, { cookieFetch: () => reply({}, 403) });
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'error');
  assert.match(result.message, /Portal отклонил запрос подключения/);
  assert.doesNotMatch(result.message, /Проверка подключения/);
  await assert.rejects(fs.readFile(f.filename), { code: 'ENOENT' });
});

test('verification failure without an old file reports no backup honestly', async context => {
  const f = await fixture(context, { verifyFetch: () => { throw new Error(claudeKey); } });
  const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
  assert.equal(result.state, 'error');
  assert.equal(result.backupPath, null);
  assert.match(result.message, /файла раньше не было/);
  assert.ok(await fs.readFile(f.filename));
});

test('single-flight returns current status without starting a second run', async context => {
  const started = deferred();
  const pending = deferred();
  const f = await fixture(context, { cookieFetch: () => { started.resolve(); return pending.promise; } });
  const first = f.service.connect({ products: ['claude'] });
  await started.promise;
  const second = safe(await f.service.connect({ products: ['codex'] }));
  assert.equal(second.running, true);
  assert.equal(second.products.claude.state, 'working');
  assert.equal(second.products.codex, undefined);
  assert.equal(f.calls.length, 1);
  pending.resolve(reply(payload));
  assert.equal(safe(await first).products.claude.state, 'done');
});

test('stale generation cannot overwrite a newer running task or write its config', async context => {
  const oldScan = deferred();
  const newFetch = deferred();
  const newStarted = deferred();
  let scans = 0;
  const f = await fixture(context, { scan: () => ++scans === 1 ? oldScan.promise : { components: [{ id: 'claude', status: 'installed' }] },
    cookieFetch: () => { newStarted.resolve(); return newFetch.promise; } });
  const oldRun = f.service.connect({ products: ['codex'] });
  while (!scans) await new Promise(resolve => setImmediate(resolve));
  f.service.cancel();
  const newRun = f.service.connect({ products: ['claude'] });
  await newStarted.promise;
  oldScan.resolve({ components: [{ id: 'codex', status: 'installed' }] });
  safe(await oldRun);
  assert.equal(f.service.status().running, true);
  assert.equal(f.service.status().products.claude.state, 'working');
  assert.equal(f.operations.includes('save'), false);
  newFetch.resolve(reply(payload));
  assert.equal(safe(await newRun).products.claude.state, 'done');
});

test('both products run sequentially and status snapshots are detached', async context => {
  const f = await fixture(context);
  const status = safe(await f.service.connect({ products: ['codex', 'claude'] }));
  assert.equal(status.products.codex.state, 'done');
  assert.equal(status.products.claude.state, 'done');
  assert.deepEqual(f.calls.filter(call => call.headers.Authorization).map(call => [call.url, call.headers.Authorization]), [
    ['https://router.example.com/v1/models', 'Bearer ' + key],
    ['https://router.example.com/v1/models', 'Bearer ' + claudeKey],
  ]);
  assert.ok(f.operations.indexOf('reconnect:codex') < f.operations.indexOf('guard:claude'));
  status.products.codex.state = 'error';
  assert.equal(f.service.status().products.codex.state, 'done');
});

for (const env of [
  { ...portalEnv, ENABLE_TOOL_SEARCH: true },
  { ...portalEnv, ANTHROPIC_BASE_URL: 'http://router.example.com' },
  { ...portalEnv, ANTHROPIC_BASE_URL: 'https://user:password@router.example.com' },
  { ...portalEnv, ANTHROPIC_BASE_URL: 'https://router.example.com?key=value' },
  { ...portalEnv, ANTHROPIC_AUTH_TOKEN: 'bad\nvalue' },
  { ...portalEnv, ANTHROPIC_DEFAULT_UNKNOWN_MODEL: 'invalid' },
]) {
  test('invalid portal Claude env is rejected before any write: ' + Object.keys(env).at(-1), async context => {
    const f = await fixture(context, { payload: { settings: { env } } });
    const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
    assert.equal(result.state, 'error');
    await assert.rejects(fs.readFile(f.filename), { code: 'ENOENT' });
  });
}

test('bounded config and models responses fail without leaking response content', async context => {
  for (const target of ['config', 'models']) await context.test(target, async subcontext => {
    const huge = () => reply({ padding: key + 'x'.repeat(65 * 1024) });
    const f = await fixture(subcontext, target === 'config' ? { cookieFetch: huge } : { verifyFetch: huge });
    const result = safe(await f.service.connect({ products: ['claude'] })).products.claude;
    assert.equal(result.state, 'error');
    assert.match(result.message, /64 КиБ/);
  });
});

test('direct Codex provider fetch reuses validation and never calls device flow', async () => {
  const calls = [];
  const client = new RouterPortalClient({ fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    assert.equal(options.credentials, 'omit');
    return reply(url.endsWith('/provider') ? provider : defaults);
  } });
  assert.deepEqual(await client.config(key), { apiKey: key, provider, defaults });
  assert.deepEqual(calls.map(url => new URL(url).pathname), ['/api/codex/provider', '/api/codex/defaults']);
  const invalid = new RouterPortalClient({ fetchImpl: async url => reply(url.endsWith('/provider') ? { ...provider, base_url: 'http://unsafe' } : defaults) });
  await assert.rejects(invalid.config(key), { code: 'invalid_response' });
  client.dispose(); invalid.dispose();
});
