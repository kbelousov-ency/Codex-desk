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
const original = '# Native MCP import fixture: this comment must survive.\r\nmodel = "gpt-5.4"\r\nmodel_reasoning_effort = "high"\r\n\r\n[mcp_servers.existing]\r\nurl = "http://127.0.0.1:1/mcp"\r\nenabled = false\r\n[mcp_servers.existing.http_headers]\r\nAuthorization = "Bearer native-fixture-only-old"\r\n';
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
  assert.deepEqual(list.servers.map(server => server.name), ['existing']);
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
  assert.ok(!methods.includes('turn/start'));
  console.log(JSON.stringify({ result: 'PASS: native MCP config list/import/replace/backup/stale checks in isolated CODEX_HOME; no model turns or enabled MCP servers', fixture, nativeWrites: callsBefore }, null, 2));
} finally {
  manager.dispose();
  client.stop();
}
