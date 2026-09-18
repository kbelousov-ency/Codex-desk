import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';
import { McpConfigManager } from '../electron/mcp-config.mjs';

const secret = 'unit-test-private-token-42';
const httpImport = `[mcp_servers.team]\nurl = "https://user:password@mcp.example.test/service?key=${secret}#private"\n[mcp_servers.team.http_headers]\nAuthorization = "Bearer ${secret}"\n`;
const original = '# Preserve this comment and formatting.\r\nmodel = "existing-model"\r\nmodel_reasoning_effort = "high"\r\n\r\n[mcp_servers.old]\r\ncommand = "node"\r\nargs = ["old-server.mjs"]\r\n';

async function fixture(t, { contents = original, ...options } = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-mcp-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const configPath = path.join(folder, 'custom-user-config.toml');
  if (contents !== null) await writeFile(configPath, contents);
  const calls = [];
  const state = { unavailable: false, nativeError: false, disabled: false, writeStatus: 'ok' };
  async function bytes() {
    try { return await readFile(configPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const version = content => createHash('sha256').update(content ?? Buffer.alloc(0)).digest('hex');
  const request = async (method, params) => {
    calls.push({ method, params });
    if (state.unavailable) throw new Error(`unavailable ${secret}`);
    if (method === 'config/read') {
      const content = await bytes();
      const config = content ? TOML.parse(content.toString('utf8')) : {};
      return { config: { mcp_servers: { project: { command: 'project-secret-command' } } }, layers: [
        { name: { type: 'project', dotCodexFolder: folder }, config: { mcp_servers: { project: { command: 'project-secret-command' } } }, version: 'project' },
        { name: { type: 'user', file: path.join(folder, 'profiles', 'profile.toml'), profile: 'custom' }, config: { mcp_servers: { profile: { command: 'profile-secret-command' } } }, version: 'profile' },
        { name: { type: 'user', file: configPath, profile: null }, config, version: version(content), disabledReason: state.disabled ? 'disabled' : null },
      ] };
    }
    assert.equal(method, 'config/batchWrite');
    if (state.nativeError) throw new Error(`native rejected value ${secret}`);
    const content = await bytes();
    assert.equal(params.expectedVersion, version(content));
    assert.equal(params.filePath, configPath);
    const config = content ? TOML.parse(content.toString('utf8')) : {};
    config.mcp_servers ??= {};
    for (const edit of params.edits) {
      assert.equal(edit.mergeStrategy, 'replace');
      const [, name] = edit.keyPath.split('.');
      config.mcp_servers[name] = edit.value;
    }
    await writeFile(configPath, TOML.stringify(config));
    return { status: state.writeStatus, filePath: configPath, version: 'after', overriddenMetadata: null };
  };
  const manager = new McpConfigManager({ request, ...options });
  t.after(() => manager.dispose());
  return { manager, folder, configPath, calls, state, request };
}

test('MCP preview hides credentials and lists only the base user config', async t => {
  const { manager, configPath, calls } = await fixture(t);
  const list = await manager.list();
  assert.equal(list.configPath, configPath);
  assert.deepEqual(list.servers.map(server => server.name), ['old']);
  assert.equal(list.servers[0].address, 'node');
  const preview = await manager.preview(httpImport);
  assert.equal(preview.configPath, configPath);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.servers, [{ name: 'team', transport: 'http', address: 'https://mcp.example.test/service', enabled: true, headerNames: ['Authorization'], envNames: [], exists: false }]);
  assert.doesNotMatch(JSON.stringify({ list, preview }), new RegExp(`${secret}|password|Bearer|project-secret|profile-secret`));
  assert.ok(calls.every(call => call.method === 'config/read' && call.params.includeLayers === true));
});

test('MCP save uses native per-server replacement and an exact backup of the original bytes', async t => {
  const { manager, configPath, calls } = await fixture(t);
  const preview = await manager.preview(httpImport);
  const result = await manager.save({ previewId: preview.previewId });
  assert.equal(result.configPath, configPath);
  assert.equal(path.dirname(result.backupPath), path.dirname(configPath));
  assert.deepEqual(await readFile(result.backupPath), Buffer.from(original));
  assert.deepEqual(result.servers, ['team']);
  const saved = TOML.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.model, 'existing-model');
  assert.equal(saved.model_reasoning_effort, 'high');
  assert.equal(saved.mcp_servers.old.command, 'node');
  assert.equal(saved.mcp_servers.team.http_headers.Authorization, `Bearer ${secret}`);
  const write = calls.find(call => call.method === 'config/batchWrite');
  assert.deepEqual(write.params.edits.map(edit => ({ keyPath: edit.keyPath, mergeStrategy: edit.mergeStrategy })), [{ keyPath: 'mcp_servers.team', mergeStrategy: 'replace' }]);
  assert.equal(write.params.reloadUserConfig, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('MCP conflicts require an explicit true and replace all old server settings', async t => {
  const { manager, configPath, calls } = await fixture(t);
  const preview = await manager.preview('[mcp_servers.old]\nurl="https://mcp.example.test/mcp"');
  assert.deepEqual(preview.conflicts, ['old']);
  assert.equal(preview.servers[0].exists, true);
  for (const replaceExisting of [false, undefined, 'true']) {
    await assert.rejects(manager.save({ previewId: preview.previewId, replaceExisting }), /Подтвердите замену/);
  }
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
  await manager.save({ previewId: preview.previewId, replaceExisting: true });
  const saved = TOML.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.mcp_servers.old, { url: 'https://mcp.example.test/mcp' });
});

test('MCP rejects malformed, unrelated or unsupported config without leaking values or writing', async t => {
  const { manager, calls } = await fixture(t);
  const invalid = [
    `Authorization = "Bearer ${secret}`, // Parser error must not echo the source line.
    `model="${secret}"\n[mcp_servers.team]\nurl="https://mcp.example.test"`,
    '[mcp_servers]\n',
    '[mcp_servers.team]\nurl="file:///tmp/example"',
    '[mcp_servers.team]\nurl="https://mcp.example.test"\ncommand="node"',
    '[mcp_servers.team]\nurl="https://mcp.example.test"\nenabled="true"',
    '[mcp_servers.team]\ncommand="node"\nstartup_timeout_sec=-1',
    '[mcp_servers.team]\ncommand="node"\nargs=[1]',
    '[mcp_servers.team]\ncommand="node"\n[ mcp_servers.team.http_headers ]\nAuthorization="private"',
    `[mcp_servers.team]\nurl="https://mcp.example.test"\nunknown_field="${secret}"`,
    `[mcp_servers."bad.name"]\ncommand="node"`,
    '[mcp_servers.team]\ncommand="node"\n[mcp_servers.team.env]\nTOKEN=1',
    '[mcp_servers.team]\nurl="https://mcp.example.test"\nbearer_token_env_var="bad name"',
    '[mcp_servers.team]\nurl="https://mcp.example.test"\n[mcp_servers.team.http_headers]\nAuthorization="bad\\r\\nheader"',
    '[mcp_servers.team]\ncommand="node"\n[mcp_servers.team.tools.example]\napproval_mode="unknown"',
    '[mcp_servers.team]\ncommand="node"\n[mcp_servers.team.tools.example]\noutput_token_limit=0',
    'x'.repeat(256 * 1024 + 1),
  ];
  for (const text of invalid) {
    await assert.rejects(manager.preview(text), error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

test('MCP imports multiple servers, fenced TOML, env names and common tool policies', async t => {
  const { manager, configPath } = await fixture(t);
  const preview = await manager.preview('```toml\n[mcp_servers.local]\ncommand="node"\nargs=["server.js"]\nenv_vars=["HOST_ENV"]\nenabled=false\nrequired=true\nstartup_timeout_sec=5.5\ntool_timeout_sec=60\nenabled_tools=["read"]\ndisabled_tools=["write"]\ndefault_tools_approval_mode="prompt"\n[mcp_servers.local.env]\nTOKEN="private-env"\n[mcp_servers.local.tools.read]\napproval_mode="approve"\noutput_token_limit=1000\n[mcp_servers.remote]\nurl="https://mcp.example.test"\nbearer_token_env_var="BEARER_TOKEN"\n[mcp_servers.remote.env_http_headers]\nX-Auth="HEADER_ENV"\n```');
  assert.deepEqual(preview.servers[0].envNames, ['HOST_ENV', 'TOKEN']);
  assert.equal(preview.servers[0].enabled, false);
  assert.deepEqual(preview.servers[1].envNames, ['BEARER_TOKEN', 'HEADER_ENV']);
  assert.deepEqual(preview.servers[1].headerNames, ['Authorization', 'X-Auth']);
  assert.doesNotMatch(JSON.stringify(preview), /private-env|server.js/);
  await manager.save({ previewId: preview.previewId });
  const saved = TOML.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.mcp_servers.local.env.TOKEN, 'private-env');
  assert.equal(saved.mcp_servers.local.tools.read.output_token_limit, 1000);
  assert.equal(saved.mcp_servers.remote.bearer_token_env_var, 'BEARER_TOKEN');
});

test('MCP JSON HTTP transports normalize to exact native settings without exposing credentials', async t => {
  for (const transport of ['http', 'streamable-http', undefined]) {
    const { manager, configPath, calls } = await fixture(t);
    const url = `https://user:password@mcp.example.test/service?key=${secret}#private`;
    const headers = { Authorization: `Bearer ${secret}`, 'x-Mixed-Case': 'literal ${HEADER_TOKEN}' };
    const preview = await manager.preview(JSON.stringify({ mcpServers: { company: { ...(transport ? { type: transport } : {}), url, headers, enabled: false } } }));
    assert.deepEqual(preview.servers, [{ name: 'company', transport: 'http', address: 'https://mcp.example.test/service', enabled: false, headerNames: ['Authorization', 'x-Mixed-Case'], envNames: [], exists: false }]);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(`${secret}|password|Bearer|HEADER_TOKEN`));
    const result = await manager.save({ previewId: preview.previewId });
    assert.deepEqual(await readFile(result.backupPath), Buffer.from(original));
    const expected = { url, http_headers: headers, enabled: false };
    const write = calls.find(call => call.method === 'config/batchWrite');
    assert.equal(write.params.filePath, configPath);
    assert.equal(write.params.reloadUserConfig, false);
    assert.deepEqual(JSON.parse(JSON.stringify(write.params.edits)), [{ keyPath: 'mcp_servers.company', value: expected, mergeStrategy: 'replace' }]);
    const saved = TOML.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(saved.mcp_servers.company, expected);
    assert.deepEqual(saved.mcp_servers.old, { command: 'node', args: ['old-server.mjs'] });
    assert.equal(saved.model, 'existing-model');
    assert.equal(saved.model_reasoning_effort, 'high');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test('MCP JSON supports BOM and markdown fences with mixed transports and literal process values', async t => {
  for (const wrap of [text => `\uFEFF  ${text}`, text => `\uFEFF\`\`\`json\n${text}\n\`\`\``, text => `\`\`\`\n${text}\n\`\`\``]) {
    const { manager, configPath, calls } = await fixture(t);
    const servers = {
      remote: { url: 'https://mcp.example.test', http_headers: { 'X-Auth': secret }, bearer_token_env_var: 'TOKEN_ENV' },
      local: { type: 'stdio', command: 'node', args: ['server.js', '${PROJECT_ROOT}', '$env:MY_TOKEN', '--token=' + secret], env: { TOKEN: secret, LITERAL: '${UNCHANGED}' }, env_vars: ['HOST_ENV'], enabled: false },
      implicit: { command: 'fixture-tool', args: [] },
    };
    const preview = await manager.preview(wrap(JSON.stringify({ mcpServers: servers })));
    assert.deepEqual(preview.servers.map(server => [server.name, server.transport]), [['remote', 'http'], ['local', 'stdio'], ['implicit', 'stdio']]);
    assert.deepEqual(preview.servers[0].headerNames, ['Authorization', 'X-Auth']);
    assert.deepEqual(preview.servers[1].envNames, ['HOST_ENV', 'LITERAL', 'TOKEN']);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(`${secret}|PROJECT_ROOT|UNCHANGED`));
    await manager.save({ previewId: preview.previewId });
    const expected = { ...servers, local: { ...servers.local } };
    delete expected.local.type;
    const saved = TOML.parse(await readFile(configPath, 'utf8'));
    for (const [name, server] of Object.entries(expected)) assert.deepEqual(saved.mcp_servers[name], server);
    const edits = calls.find(call => call.method === 'config/batchWrite').params.edits;
    assert.deepEqual(JSON.parse(JSON.stringify(edits)), Object.entries(expected).map(([name, value]) => ({ keyPath: `mcp_servers.${name}`, value, mergeStrategy: 'replace' })));
  }
});

test('MCP JSON rejects malformed, ambiguous and unsupported input before config access without echoing source', async t => {
  const { manager, calls } = await fixture(t);
  const json = server => JSON.stringify({ mcpServers: { company: server } });
  const invalid = [
    `{"mcpServers":{"company":{"url":"https://mcp.example.test","headers":{"Authorization":"Bearer ${secret}"}}`,
    '{"mcpServers":',
    '[]', 'null', '{}',
    JSON.stringify({ other: secret }),
    JSON.stringify({ mcpServers: {}, model: secret }),
    JSON.stringify({ mcpServers: { company: { command: 'node' } }, mcp_servers: { remote: { url: 'https://mcp.example.test' } } }),
    JSON.stringify({ mcpServers: null }),
    JSON.stringify({ mcpServers: [] }),
    JSON.stringify({ mcpServers: {} }),
    json(null), json([]), json(secret),
    json({ type: 'http', command: 'node' }),
    json({ type: 'stdio', url: 'https://mcp.example.test' }),
    json({ type: 'sse', url: 'https://mcp.example.test' }),
    json({ type: secret, url: 'https://mcp.example.test' }),
    json({ type: null, url: 'https://mcp.example.test' }),
    json({ type: [], url: 'https://mcp.example.test' }),
    json({ url: 'https://mcp.example.test', command: 'node' }),
    json({ url: 'https://mcp.example.test', headers: { Authorization: secret }, http_headers: { Authorization: secret } }),
    json({ url: 'https://mcp.example.test', headers: null }),
    json({ url: 'https://mcp.example.test', headers: [] }),
    json({ url: 'https://mcp.example.test', headers: { Authorization: `Bearer ${secret}\r\nInjected: header` } }),
    json({ url: 'https://mcp.example.test', enabled: 'true' }),
    json({ url: 'https://mcp.example.test', unknown: secret }),
    json({ command: 'node', headers: { Authorization: secret } }),
    json({ command: 'node', args: [secret, 1] }),
    json({ command: 'node', env: { TOKEN: 42 } }),
    json({ url: 'file:///tmp/fixture' }),
    JSON.stringify({ mcpServers: { 'bad.name': { command: 'node' } } }),
    JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`s${index}`, { command: 'node' }])) }),
  ];
  for (const text of invalid) {
    await assert.rejects(manager.preview(text), error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /Injected:|Bearer/);
      return true;
    }, `Expected rejection: input ${invalid.indexOf(text)}`);
  }
  assert.equal(calls.length, 0, 'Invalid JSON is rejected before native reads/writes or backup');
});

test('MCP JSON nested special keys stay data without changing object prototypes', async t => {
  const { manager, calls } = await fixture(t);
  const source = '{"mcpServers":{"remote":{"url":"https://mcp.example.test","headers":{"__proto__":"literal-header","constructor":"literal-constructor"}},"local":{"command":"node","env":{"__proto__":"literal-env","constructor":"literal-constructor"}}}}';
  const preview = await manager.preview(source);
  await manager.save({ previewId: preview.previewId });
  const edits = calls.find(call => call.method === 'config/batchWrite').params.edits;
  const remote = edits.find(edit => edit.keyPath === 'mcp_servers.remote').value;
  const local = edits.find(edit => edit.keyPath === 'mcp_servers.local').value;
  assert.equal(Object.hasOwn(remote.http_headers, '__proto__'), true);
  assert.equal(remote.http_headers.__proto__, 'literal-header');
  assert.equal(remote.http_headers.constructor, 'literal-constructor');
  assert.equal(Object.hasOwn(local.env, '__proto__'), true);
  assert.equal(local.env.__proto__, 'literal-env');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('MCP save rejects external config edits before any backup or native write', async t => {
  const { manager, configPath, calls, folder } = await fixture(t);
  const preview = await manager.preview(httpImport);
  await writeFile(configPath, `${original}# Changed independently.\r\n`);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /изменилась после проверки/);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
  assert.deepEqual(await readdir(folder), ['custom-user-config.toml']);
});

test('MCP backup failures prevent config writes and raw filesystem errors do not escape', async t => {
  const { manager, configPath, calls } = await fixture(t, { writeFile: async () => { throw new Error(secret); } });
  const preview = await manager.preview(httpImport);
  await assert.rejects(manager.save({ previewId: preview.previewId }), error => {
    assert.match(error.message, /резервную копию/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
});

test('MCP native write failure preserves backup, hides errors and consumes preview', async t => {
  const { manager, configPath, state, folder } = await fixture(t);
  const preview = await manager.preview(httpImport);
  state.nativeError = true;
  await assert.rejects(manager.save({ previewId: preview.previewId }), error => {
    assert.match(error.message, /не подтвердил сохранение/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.equal((await readdir(folder)).filter(file => file.includes('.backup-')).length, 1);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('MCP works when base config file does not yet exist and creates no fictitious backup', async t => {
  const { manager, configPath } = await fixture(t, { contents: null });
  assert.deepEqual((await manager.list()).servers, []);
  const preview = await manager.preview(httpImport);
  const result = await manager.save({ previewId: preview.previewId });
  assert.equal(result.backupPath, null);
  assert.equal(TOML.parse(await readFile(configPath, 'utf8')).mcp_servers.team.http_headers.Authorization, `Bearer ${secret}`);
});

test('MCP previews expire, are replaced by any new preview, and invalidate on disconnect', async t => {
  let now = Date.now();
  const { manager } = await fixture(t, { now: () => now });
  const first = await manager.preview(httpImport);
  const second = await manager.preview(httpImport);
  await assert.rejects(manager.save({ previewId: first.previewId }), /истекла|отменена/);
  now += 10 * 60 * 1000;
  await assert.rejects(manager.save({ previewId: second.previewId }), /истекла|отменена/);
  const third = await manager.preview(httpImport);
  manager.invalidate();
  await assert.rejects(manager.save({ previewId: third.previewId }), /истекла|отменена/);
  const fourth = await manager.preview(httpImport);
  await assert.rejects(manager.preview('invalid'));
  await assert.rejects(manager.save({ previewId: fourth.previewId }), /истекла|отменена/);
});

test('MCP rejects unavailable, disabled and missing base user layers without exposing native errors', async t => {
  const { manager, state } = await fixture(t);
  state.unavailable = true;
  await assert.rejects(manager.list(), error => {
    assert.match(error.message, /прочитать конфигурацию/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  state.unavailable = false;
  state.disabled = true;
  await assert.rejects(manager.preview(httpImport), /не сообщил доступный/);
  const empty = new McpConfigManager({ request: async () => ({ layers: [], config: {} }) });
  t.after(() => empty.dispose());
  await assert.rejects(empty.list(), /не сообщил доступный/);
});

test('MCP concurrent saves are single-use and imports cannot replace a pending save', async t => {
  let release;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { manager, calls } = await fixture(t, { writeFile: async (...args) => { enter(); await gate; return writeFile(...args); } });
  const preview = await manager.preview(httpImport);
  const saving = manager.save({ previewId: preview.previewId });
  await entered;
  await assert.rejects(manager.save({ previewId: preview.previewId }), /Дождитесь сохранения/);
  await assert.rejects(manager.preview(httpImport), /Дождитесь сохранения/);
  release();
  await saving;
  assert.equal(calls.filter(call => call.method === 'config/batchWrite').length, 1);
});

test('MCP invalidation during backup prevents a stale native write', async t => {
  let manager;
  const fixtureResult = await fixture(t, { writeFile: async (...args) => { await writeFile(...args); manager.invalidate(); } });
  manager = fixtureResult.manager;
  const preview = await manager.preview(httpImport);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /больше не актуальна/);
  assert.ok(fixtureResult.calls.every(call => call.method !== 'config/batchWrite'));
});

test('MCP overridden response gives a generic notice without returning metadata', async t => {
  const { manager, state } = await fixture(t);
  state.writeStatus = 'okOverridden';
  const preview = await manager.preview(httpImport);
  const result = await manager.save({ previewId: preview.previewId });
  assert.match(result.message, /переопределена другим уровнем/);
});
