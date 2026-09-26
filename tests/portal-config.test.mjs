import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import TOML from '@iarna/toml';
import { PortalConfigManager } from '../electron/portal-config.mjs';

const secret = 'portal-config-fixture-private-key';
const oldSecret = 'old-config-private-key';
const input = () => ({ apiKey: secret,
  provider: { name: 'Fixture router', base_url: 'https://router.example.test/v1', wire_api: 'responses', requires_openai_auth: false },
  defaults: { model: 'gpt-5.6-terra', model_provider: 'router', model_context_window: 1000000,
    model_auto_compact_token_limit: 900000, model_reasoning_summary: 'detailed', hide_agent_reasoning: false },
});
const original = `# Keep all original backup bytes.\r\nmodel = "old-model"\r\nmodel_reasoning_effort = "high"\r\n\r\n[profiles.work]\r\nmodel = "profile-model"\r\n\r\n[projects.fixture]\r\ntrust_level = "trusted"\r\n\r\n[mcp_servers.old]\r\ncommand = "fixture-command"\r\n\r\n[model_providers.router]\r\nname = "Previous router"\r\nbase_url = "https://user:${oldSecret}@old.example.test/v1?key=${oldSecret}"\r\nwire_api = "responses"\r\nrequires_openai_auth = true\r\nenv_key = "OLD_API_KEY"\r\nenv_key_instructions = "${oldSecret}"\r\nexperimental_bearer_token = "${oldSecret}"\r\nstream_idle_timeout_ms = 12345\r\n[model_providers.router.http_headers]\r\naUtHoRiZaTiOn = "Bearer ${oldSecret}"\r\nX-Keep = "${oldSecret}"\r\n[model_providers.router.env_http_headers]\r\nAUTHORIZATION = "OLD_HEADER_KEY"\r\nX-Keep-Env = "KEEP_HEADER_KEY"\r\n\r\n[model_providers.other]\r\nname = "Other provider"\r\nbase_url = "https://other.example.test/v1"\r\nexperimental_bearer_token = "${oldSecret}"\r\n`;

async function fixture(t, { contents = original, managerOptions = {} } = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-portal-config-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const configPath = path.join(folder, 'config.toml');
  if (contents !== null) await writeFile(configPath, contents);
  const calls = [];
  const state = { status: 'ok', disabled: false, readError: false, nativeError: false, staticVersion: false, beforeWrite: null, afterRead: null, layerTransform: null };
  const bytes = async () => { try { return await readFile(configPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const version = content => state.staticVersion ? 'static-version' : createHash('sha256').update(content ?? Buffer.alloc(0)).digest('hex');
  const request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'config/read') {
      if (state.readError) throw new Error(`cannot read ${secret}`);
      const content = await bytes();
      const config = content === null ? {} : TOML.parse(content.toString('utf8'));
      let layers = [
        { name: { type: 'project', dotCodexFolder: folder }, config: { model: 'project-model' }, version: 'project-version' },
        { name: { type: 'user', file: path.join(folder, 'profile.toml'), profile: 'work' }, config: { model: 'profile-model' }, version: 'profile-version' },
        { name: { type: 'user', file: configPath, profile: null }, config, version: version(content), disabledReason: state.disabled ? secret : null },
      ];
      if (state.layerTransform) layers = state.layerTransform(layers);
      await state.afterRead?.();
      return { config: { model: 'merged-model' }, layers };
    }
    assert.equal(method, 'config/batchWrite');
    await state.beforeWrite?.();
    if (state.nativeError) throw new Error(`native rejected ${secret}`);
    const content = await bytes();
    if (version(content) !== params.expectedVersion) throw new Error(`CAS rejected ${secret}`);
    assert.equal(params.filePath, configPath);
    const config = content === null ? {} : TOML.parse(content.toString('utf8'));
    for (const edit of params.edits) {
      assert.equal(edit.mergeStrategy, 'replace');
      const keys = edit.keyPath.split('.');
      if (keys.length > 1) assert.equal(keys[0], 'model_providers');
      let target = config;
      for (const key of keys.slice(0, -1)) { target[key] ??= {}; target = target[key]; }
      if (edit.value === null) delete target[keys.at(-1)];
      else target[keys.at(-1)] = edit.value;
    }
    await writeFile(configPath, TOML.stringify(config));
    return { status: state.status, overriddenMetadata: { secret } };
  };
  const manager = new PortalConfigManager({ request, ...managerOptions });
  t.after(() => manager.dispose());
  return { folder, configPath, calls, state, request, manager };
}

test('portal config preview exposes only allowlisted metadata and hides credentials', async t => {
  const { manager, calls, configPath } = await fixture(t);
  const preview = await manager.preview(input());
  assert.equal(preview.configPath, configPath);
  assert.equal(preview.exists, true);
  assert.equal(preview.providerName, 'router');
  assert.equal(preview.providerLabel, 'Fixture router');
  assert.equal(preview.baseUrl, input().provider.base_url);
  assert.equal(preview.model, input().defaults.model);
  assert.equal(preview.changes.find(change => change.key === 'model').before, 'old-model');
  assert.equal(preview.changes.find(change => change.key.endsWith('.base_url')).before, 'Настроено');
  assert.ok(preview.changes.some(change => change.key.endsWith('.http_headers.Authorization')));
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(`${secret}|${oldSecret}|OLD_API_KEY|OLD_HEADER_KEY|KEEP_HEADER_KEY|X-Keep|project-model|profile-model|merged-model`));
  assert.ok(calls.every(call => call.method === 'config/read' && call.params.includeLayers === true));
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('portal config save uses native CAS, exact protected backup and preserves unrelated settings', async t => {
  const backupOptions = [];
  const { manager, calls, configPath } = await fixture(t, { managerOptions: { writeFile: async (...args) => { backupOptions.push(args[2]); return writeFile(...args); } } });
  const preview = await manager.preview(input());
  const result = await manager.save({ previewId: preview.previewId });
  assert.equal(result.configPath, configPath);
  assert.equal(path.dirname(result.backupPath), path.dirname(configPath));
  assert.deepEqual(await readFile(result.backupPath), Buffer.from(original));
  assert.deepEqual(backupOptions, [{ flag: 'wx', mode: 0o600 }]);
  const saved = TOML.parse(await readFile(configPath, 'utf8'));
  const before = TOML.parse(original);
  for (const key of ['model_reasoning_effort', 'profiles', 'projects', 'mcp_servers']) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual(saved.model_providers.other, before.model_providers.other);
  for (const [key, value] of Object.entries(input().defaults)) assert.equal(saved[key], value);
  const provider = saved.model_providers.router;
  assert.equal(provider.experimental_bearer_token, secret);
  assert.equal(provider.env_key, undefined);
  assert.equal(provider.env_key_instructions, undefined);
  assert.equal(provider.stream_idle_timeout_ms, 12345);
  assert.deepEqual(provider.http_headers, { 'X-Keep': oldSecret });
  assert.deepEqual(provider.env_http_headers, { 'X-Keep-Env': 'KEEP_HEADER_KEY' });
  const write = calls.find(call => call.method === 'config/batchWrite');
  assert.deepEqual(write.params.edits.slice(0, 6).map(edit => edit.keyPath), Object.keys(input().defaults));
  assert.ok(write.params.edits.slice(6).every(edit => edit.keyPath.startsWith('model_providers.router.')));
  assert.ok(write.params.edits.filter(edit => edit.value === null).every(edit => /env_key|Authorization/i.test(edit.keyPath)));
  assert.equal(write.params.reloadUserConfig, false);
  assert.equal(typeof write.params.expectedVersion, 'string');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|${oldSecret}`));
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('portal config may create a missing user config without a spurious backup', async t => {
  const { manager, folder, configPath } = await fixture(t, { contents: null });
  const preview = await manager.preview(input());
  assert.equal(preview.exists, false);
  const result = await manager.save({ previewId: preview.previewId });
  assert.equal(result.backupPath, null);
  assert.deepEqual(await readdir(folder), ['config.toml']);
  assert.equal(TOML.parse(await readFile(configPath, 'utf8')).model_providers.router.experimental_bearer_token, secret);
});

test('portal config rejects invalid API fields before any native request or write', async t => {
  const { manager, calls } = await fixture(t);
  const invalid = [undefined, null, {}, { ...input(), apiKey: '' }, { ...input(), apiKey: 'bad\nkey' }];
  for (const [field, value] of [['base_url', 'http://router.example.test'], ['base_url', `https://user:${secret}@router.example.test`], ['base_url', `https://router.example.test/?key=${secret}`], ['base_url', 'https://router.example.test/#fragment'], ['name', 'bad\nname'], ['wire_api', 'chat'], ['requires_openai_auth', true]]) {
    const valueInput = input(); valueInput.provider[field] = value; invalid.push(valueInput);
  }
  for (const [field, value] of [['model_provider', '__proto__'], ['model_provider', 'constructor'], ['model_provider', 'router.other'], ['model', 'bad\nmodel'], ['model_context_window', -1], ['model_auto_compact_token_limit', 1000001], ['model_reasoning_summary', 'unknown'], ['hide_agent_reasoning', 'true']]) {
    const valueInput = input(); valueInput.defaults[field] = value; invalid.push(valueInput);
  }
  for (const value of invalid) await assert.rejects(manager.preview(value), error => { assert.match(error.message, /неподдерживаемые настройки/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
  assert.deepEqual(calls, []);
});

test('portal config cannot inject arbitrary API or renderer settings', async t => {
  const { manager, calls } = await fixture(t);
  const payload = input();
  payload.defaults.model_reasoning_effort = 'low';
  payload.defaults.mcp_servers = { injected: { command: 'bad' } };
  payload.provider.env_key = 'INJECTED_KEY';
  payload.provider.http_headers = { Authorization: 'injected' };
  const preview = await manager.preview(payload);
  payload.defaults.model = 'changed-after-preview';
  payload.provider.base_url = 'https://changed.example.test';
  await manager.save({ previewId: preview.previewId, edits: [{ keyPath: 'model_reasoning_effort', value: 'low' }] });
  const edits = calls.find(call => call.method === 'config/batchWrite').params.edits;
  assert.ok(!edits.some(edit => ['model_reasoning_effort', 'mcp_servers'].includes(edit.keyPath)));
  assert.equal(edits[0].value, input().defaults.model);
  assert.equal(edits.find(edit => edit.keyPath.endsWith('.env_key')).value, null);
  assert.equal(edits.find(edit => edit.keyPath.endsWith('.base_url')).value, input().provider.base_url);
  assert.ok(edits.filter(edit => /authorization/i.test(edit.keyPath)).every(edit => edit.value === null));
});

test('portal metadata cannot echo current or saved credentials through otherwise public fields', async t => {
  const { manager } = await fixture(t, { contents: original.replace('Previous router', oldSecret).replace('old-model', oldSecret) });
  const preview = await manager.preview(input());
  assert.equal(preview.changes.find(change => change.key === 'model').before, 'Настроено');
  assert.equal(preview.changes.find(change => change.key.endsWith('.name')).before, 'Настроено');
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(`${secret}|${oldSecret}`));
  for (const value of [secret, oldSecret]) {
    for (const modify of [payload => { payload.provider.name = value; }, payload => { payload.provider.base_url = `https://router.example.test/${value}`; }, payload => { payload.defaults.model = value; }, payload => { payload.defaults.model_provider = value; }]) {
      const payload = input(); modify(payload);
      await assert.rejects(manager.preview(payload), error => { assert.match(error.message, /неподдерживаемые настройки/); assert.doesNotMatch(error.message, new RegExp(`${secret}|${oldSecret}`)); return true; });
    }
  }
});

test('portal config rejects a changed file even when native layer version has not changed', async t => {
  const { manager, state, configPath, calls, folder } = await fixture(t);
  state.staticVersion = true;
  const preview = await manager.preview(input());
  await writeFile(configPath, `${original}\n# external change\n`);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /изменилась после проверки/);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
  assert.deepEqual(await readdir(folder), ['config.toml']);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('portal native expectedVersion prevents changes racing after the host snapshot', async t => {
  const { manager, state, configPath } = await fixture(t);
  const preview = await manager.preview(input());
  state.beforeWrite = () => writeFile(configPath, `${original}\n# racing external edit\n`);
  await assert.rejects(manager.save({ previewId: preview.previewId }), error => { assert.match(error.message, /не подтвердил сохранение/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
  assert.equal(await readFile(configPath, 'utf8'), `${original}\n# racing external edit\n`);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('portal config refuses missing, ambiguous, disabled or nonabsolute native user layers', async t => {
  const { manager, state, calls } = await fixture(t);
  for (const transform of [layers => layers.slice(0, 2), layers => [...layers, layers[2]], layers => [Object.assign(layers[2], { disabledReason: secret })], layers => [{ ...layers[2], name: { type: 'user', file: 'relative.toml' } }], layers => [{ ...layers[2], version: '' }]]) {
    state.layerTransform = transform;
    await assert.rejects(manager.preview(input()), /не сообщил доступный/);
  }
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
});

test('portal preview lifecycle handles replacement, cancellation, TTL and permanent disposal', async t => {
  let time = 1;
  const { manager, calls } = await fixture(t, { managerOptions: { now: () => time } });
  const first = await manager.preview(input());
  const second = await manager.preview(input());
  await assert.rejects(manager.save({ previewId: first.previewId }), /истекла|отменена/);
  time += 10 * 60 * 1000;
  await assert.rejects(manager.save({ previewId: second.previewId }), /истекла|отменена/);
  const third = await manager.preview(input());
  manager.invalidate();
  await assert.rejects(manager.save({ previewId: third.previewId }), /истекла|отменена/);
  manager.dispose();
  await assert.rejects(manager.preview(input()), /истекла|отменена/);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
});

test('portal config protects against stale operations completing after cancellation', async t => {
  const { manager, state, calls } = await fixture(t);
  state.afterRead = () => manager.invalidate();
  await assert.rejects(manager.preview(input()), /истекла|отменена/);
  state.afterRead = null;
  const preview = await manager.preview(input());
  state.afterRead = () => manager.dispose();
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
});

test('portal config TTL is enforced again after preparing the backup', async t => {
  let time = 1;
  const { manager, calls } = await fixture(t, { managerOptions: { now: () => time, writeFile: async (...args) => { await writeFile(...args); time += 10 * 60 * 1000; } } });
  const preview = await manager.preview(input());
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
});

test('portal config backup failure prevents writes and redacts file-system errors', async t => {
  const { manager, calls, configPath } = await fixture(t, { managerOptions: { writeFile: async () => { throw new Error(`backup ${secret}`); } } });
  const preview = await manager.preview(input());
  await assert.rejects(manager.save({ previewId: preview.previewId }), error => { assert.match(error.message, /резервную копию/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
  assert.ok(calls.every(call => call.method !== 'config/batchWrite'));
  assert.equal(await readFile(configPath, 'utf8'), original);
  await assert.rejects(manager.save({ previewId: preview.previewId }), /истекла|отменена/);
});

test('portal config serializes writes and rejects simultaneous preview or replay', async t => {
  let release;
  const { manager, state, calls } = await fixture(t);
  const preview = await manager.preview(input());
  state.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const first = manager.save({ previewId: preview.previewId });
  await assert.rejects(manager.save({ previewId: preview.previewId }), /Дождитесь сохранения/);
  await assert.rejects(manager.preview(input()), /Дождитесь сохранения/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  assert.equal(calls.filter(call => call.method === 'config/batchWrite').length, 1);
});

test('portal config masks native and inactive-session errors', async t => {
  const { manager, state } = await fixture(t);
  state.readError = true;
  await assert.rejects(manager.preview(input()), error => { assert.match(error.message, /прочитать конфигурацию/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
  state.readError = false;
  const preview = await manager.preview(input());
  state.nativeError = true;
  await assert.rejects(manager.save({ previewId: preview.previewId }), error => { assert.match(error.message, /не подтвердил сохранение/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
  const inactive = await fixture(t, { managerOptions: { assertActive() { throw new Error(secret); } } });
  await assert.rejects(inactive.manager.preview(input()), error => { assert.match(error.message, /Подключение Codex изменилось/); assert.doesNotMatch(error.message, new RegExp(secret)); return true; });
});

test('portal config reports overridden writes without metadata and consumes unknown results', async t => {
  const { manager, state } = await fixture(t);
  state.status = 'okOverridden';
  const preview = await manager.preview(input());
  const result = await manager.save({ previewId: preview.previewId });
  assert.match(result.message, /переопределена другим уровнем/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  state.status = 'unexpected';
  const second = await manager.preview(input());
  await assert.rejects(manager.save({ previewId: second.previewId }), /не подтвердил результат записи/);
  await assert.rejects(manager.save({ previewId: second.previewId }), /истекла|отменена/);
});
