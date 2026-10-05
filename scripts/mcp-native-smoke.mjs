import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import { CodexClient } from '../electron/codex-client.mjs';
import { findCodex } from '../electron/host-utils.mjs';
import { McpConfigManager } from '../electron/mcp-config.mjs';

// No user history/auth/config and no model turns: all MCP endpoints stay disabled.
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'mcp-native-'));
const isolatedHome = path.join(fixture, 'codex-home');
const cwd = path.join(fixture, 'project');
await mkdir(isolatedHome);
await mkdir(cwd);
const configPath = path.join(isolatedHome, 'config.toml');
const original = '# Native MCP import fixture: this comment must survive.\r\nmodel = "gpt-5.4"\r\nmodel_reasoning_effort = "high"\r\n\r\n[mcp_servers.existing]\r\nurl = "http://127.0.0.1:1/mcp"\r\nenabled = false\r\n[mcp_servers.existing.http_headers]\r\nAuthorization = "Bearer native-fixture-only-old"\r\n\r\n[mcp_servers."with.dot"]\r\ncommand = "node"\r\nenabled = false\r\n';
await writeFile(configPath, original);
const methods = [];
const client = new CodexClient({
  executable: await findCodex(),
  cwd,
  requestTimeoutMs: 30_000,
  spawnImpl: (executable, args, options) => spawn(executable, args, { ...options, env: { ...process.env, CODEX_HOME: isolatedHome } }),
});
const manager = new McpConfigManager({ request: (method, params) => { methods.push(method); return client.request(method, params); } });

try {
  await client.start();
  const list = await manager.list();
  assert.equal(path.normalize(list.configPath), path.normalize(configPath));
  assert.deepEqual(list.servers.map(server => server.name), ['existing', 'with.dot']);
  assert.doesNotMatch(JSON.stringify(list), /native-fixture-only-old/);

  const preview = await manager.preview(JSON.stringify({ mcpServers: {
    'new-server': { type: 'http', url: 'http://127.0.0.1:1/new?key=native-fixture-only-query', enabled: false, headers: { Authorization: 'Bearer native-fixture-only-new' } },
    'local-json': { type: 'stdio', command: 'node', args: ['fixture.js', '${LITERAL_ARG}'], env: { FIXTURE_ENV: '${LITERAL_VALUE}' }, enabled: false },
  } }));
  assert.equal(preview.servers[0].address, 'http://127.0.0.1:1/new');
  const result = await manager.save({ previewId: preview.previewId });
  assert.deepEqual(await readFile(result.backupPath), Buffer.from(original));
  const after = await readFile(configPath, 'utf8');
  assert.match(after, /# Native MCP import fixture: this comment must survive\./);
  const parsed = TOML.parse(after);
  assert.equal(parsed.model, 'gpt-5.4');
  assert.equal(parsed.model_reasoning_effort, 'high');
  assert.equal(parsed.mcp_servers.existing.http_headers.Authorization, 'Bearer native-fixture-only-old');
  assert.equal(parsed.mcp_servers['new-server'].http_headers.Authorization, 'Bearer native-fixture-only-new');
  assert.equal(parsed.mcp_servers['new-server'].enabled, false);
  assert.deepEqual(parsed.mcp_servers['new-server'], { url: 'http://127.0.0.1:1/new?key=native-fixture-only-query', enabled: false, http_headers: { Authorization: 'Bearer native-fixture-only-new' } });
  assert.deepEqual(parsed.mcp_servers['local-json'], { command: 'node', args: ['fixture.js', '${LITERAL_ARG}'], env: { FIXTURE_ENV: '${LITERAL_VALUE}' }, enabled: false });

  const replace = await manager.preview('[mcp_servers.existing]\ncommand="node"\nargs=["fixture.js"]\nenabled=false');
  assert.deepEqual(replace.conflicts, ['existing']);
  await assert.rejects(manager.save({ previewId: replace.previewId }), /Подтвердите замену/);
  await manager.save({ previewId: replace.previewId, replaceExisting: true });
  const replaced = TOML.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(replaced.mcp_servers.existing, { command: 'node', args: ['fixture.js'], enabled: false });
  assert.equal(replaced.mcp_servers['new-server'].enabled, false);

  const stale = await manager.preview('[mcp_servers.stale]\ncommand="node"\nenabled=false');
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n# Independent external edit.\n`);
  const callsBefore = methods.filter(method => method === 'config/batchWrite').length;
  await assert.rejects(manager.save({ previewId: stale.previewId }), /изменилась после проверки/);
  assert.equal(methods.filter(method => method === 'config/batchWrite').length, callsBefore);
  // Race after the host's snapshot: the native expectedVersion must still protect the file.
  const racingManager = new McpConfigManager({ request: async (method, params) => {
    if (method === 'config/batchWrite') {
      const current = await readFile(configPath, 'utf8');
      await writeFile(configPath, current.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
    }
    return client.request(method, params);
  } });
  try {
    const racing = await racingManager.preview('[mcp_servers.racing]\ncommand="node"\nenabled=false');
    await assert.rejects(racingManager.save({ previewId: racing.previewId }), /не подтвердил сохранение/);
    const unchanged = TOML.parse(await readFile(configPath, 'utf8'));
    assert.equal(unchanged.model_reasoning_effort, 'low');
    assert.equal(unchanged.mcp_servers.racing, undefined);
  } finally { racingManager.dispose(); }

  const beforeRemoval = await readFile(configPath);
  const removing = await manager.previewRemoval('new-server');
  assert.equal(removing.server.address, 'http://127.0.0.1:1/new');
  assert.doesNotMatch(JSON.stringify(removing), /native-fixture-only-new|native-fixture-only-query/);
  assert.deepEqual(await readFile(configPath), beforeRemoval, 'Opening confirmation never writes the configuration');
  const removed = await manager.remove({ previewId: removing.previewId });
  assert.deepEqual(await readFile(removed.backupPath), beforeRemoval);
  const removedText = await readFile(configPath, 'utf8');
  assert.match(removedText, /# Native MCP import fixture: this comment must survive\./);
  const afterRemoval = TOML.parse(removedText);
  assert.equal(afterRemoval.mcp_servers['new-server'], undefined);
  assert.deepEqual(afterRemoval.mcp_servers.existing, replaced.mcp_servers.existing);
  assert.deepEqual(afterRemoval.mcp_servers['local-json'], parsed.mcp_servers['local-json']);
  assert.equal(afterRemoval.model, 'gpt-5.4');
  assert.equal(afterRemoval.model_reasoning_effort, 'low');
  await assert.rejects(manager.remove({ previewId: removing.previewId }), /истекло|отменено/);

  const dottedRemoval = await manager.previewRemoval('with.dot');
  await manager.remove({ previewId: dottedRemoval.previewId });
  assert.equal(TOML.parse(await readFile(configPath, 'utf8')).mcp_servers['with.dot'], undefined);

  const staleRemoval = await manager.previewRemoval('existing');
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n# External edit before removal.\n`);
  const writesBeforeStaleRemoval = methods.filter(method => method === 'config/batchWrite').length;
  await assert.rejects(manager.remove({ previewId: staleRemoval.previewId }), /изменилась после проверки/);
  assert.equal(methods.filter(method => method === 'config/batchWrite').length, writesBeforeStaleRemoval);

  const racingRemovalManager = new McpConfigManager({ request: async (method, params) => {
    if (method === 'config/batchWrite') {
      const current = await readFile(configPath, 'utf8');
      await writeFile(configPath, current.replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"'));
    }
    return client.request(method, params);
  } });
  try {
    const racingRemoval = await racingRemovalManager.previewRemoval('existing');
    await assert.rejects(racingRemovalManager.remove({ previewId: racingRemoval.previewId }), /не подтвердил удаление/);
    const preserved = TOML.parse(await readFile(configPath, 'utf8'));
    assert.equal(preserved.model_reasoning_effort, 'high');
    assert.deepEqual(preserved.mcp_servers.existing, replaced.mcp_servers.existing);
  } finally { racingRemovalManager.dispose(); }

  for (const name of ['local-json', 'existing']) {
    const lastRemoval = await manager.previewRemoval(name);
    await manager.remove({ previewId: lastRemoval.previewId });
  }
  assert.deepEqual((await manager.list()).servers, []);

  // Existing configurations are not constrained by the importer's name regex.
  // The native parser must receive each quoted name as one literal key.
  const unusualNames = ['with space', 'quote"name', 'back\\slash', '__proto__', 'constructor', 'пример'];
  const unusualServers = Object.fromEntries(unusualNames.map(name => [name, { command: 'node', enabled: false }]));
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n${TOML.stringify({ mcp_servers: unusualServers })}`);
  let remainingNames = [...unusualNames];
  for (const name of unusualNames) {
    const literalRemoval = await manager.previewRemoval(name);
    await manager.remove({ previewId: literalRemoval.previewId });
    remainingNames = remainingNames.filter(item => item !== name);
    assert.deepEqual((await manager.list()).servers.map(server => server.name).sort(), [...remainingNames].sort());
  }
  assert.equal(TOML.parse(await readFile(configPath, 'utf8')).model, 'gpt-5.4');
  assert.ok(!methods.includes('turn/start'));
  console.log(JSON.stringify({ result: 'PASS: native MCP config list/import/replace/remove/backup/stale checks in isolated CODEX_HOME; no model turns or enabled MCP servers', fixture, nativeWrites: methods.filter(method => method === 'config/batchWrite').length }, null, 2));
} finally {
  manager.dispose();
  client.stop();
}
