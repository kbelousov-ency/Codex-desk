import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import TOML from '@iarna/toml';
import { buildCodexConnectionProfile, readCodexRouterConnection, validateCodexConnectionConfig } from '../electron/codex-connections.mjs';

const token = 'fixture-router-token-only';
const config = provider => Buffer.from(TOML.stringify({ model_provider: 'other', model_providers: { router: { name: 'Router', wire_api: 'responses', requires_openai_auth: false, base_url: 'https://router.example/v1', ...provider }, other: { experimental_bearer_token: 'unrelated-key' } } }));
const parseProfile = profile => TOML.parse(profile.configOverrides.join('\n'));

test('existing router reader honors absolute CODEX_HOME and only the explicitly named router profile', async () => {
  const home = path.resolve('isolated-codex-home');
  const reads = [];
  const connection = await readCodexRouterConnection({ env: { CODEX_HOME: home }, read: async filename => { reads.push(filename); return config({ experimental_bearer_token: token }); } });
  assert.deepEqual(reads, [path.join(home, 'config.toml')]);
  assert.deepEqual(connection, { apiKey: token, baseUrl: 'https://router.example/v1', authScheme: 'bearer' });
});

test('router reader supports env_key and preserves intentional account/user directory scope', async () => {
  const user = path.resolve('isolated-user');
  let filename;
  const connection = await readCodexRouterConnection({ env: { CODEX_HOME: 'relative-invalid-home', USERPROFILE: user, ROUTER_SECRET: token }, read: async name => { filename = name; return config({ env_key: 'ROUTER_SECRET' }); } });
  assert.equal(filename, path.join(user, '.codex', 'config.toml'));
  assert.equal(connection.apiKey, token);
  assert.equal(connection.envKey, 'ROUTER_SECRET');
});

test('reader rejects malformed, oversized, unsafe or incompatible config without reproducing credentials', async () => {
  const invalid = [Buffer.from('invalid = \n' + token), Buffer.alloc(512 * 1024 + 1), Buffer.from('[model_providers.other]\nexperimental_bearer_token="' + token + '"'),
    config({ wire_api: 'chat', experimental_bearer_token: token }), config({ requires_openai_auth: true, experimental_bearer_token: token }),
    config({ base_url: 'http://router.example', experimental_bearer_token: token }), config({ base_url: 'https://user:pass@router.example', experimental_bearer_token: token }),
    config({ experimental_bearer_token: 'key with whitespace' }), config({ env_key: 'MISSING' })];
  for (const bytes of invalid) await assert.rejects(readCodexRouterConnection({ env: {}, read: async () => bytes }), error => !error.message.includes(token));
});

test('inherited source supplies no overrides and account uses the native provider without rewriting its table', () => {
  assert.deepEqual(buildCodexConnectionProfile(), {});
  const processEnv = Object.freeze({ PATH: 'keep', CODEX_HOME: 'existing-history', TOOL_ENV: 'keep', OPENAI_BASE_URL: 'https://old-router.example', OPENAI_API_KEY: 'old-key', CODEX_API_KEY: 'other-key', codex_desk_router_token: 'stale-token', openai_api_key: 'other-case' });
  const profile = buildCodexConnectionProfile({ source: 'account', processEnv });
  assert.deepEqual(profile.env, { PATH: 'keep', CODEX_HOME: 'existing-history', TOOL_ENV: 'keep' });
  assert.equal(profile.modelProvider, 'openai');
  const parsed = parseProfile(profile);
  assert.equal(parsed.model_provider, profile.modelProvider);
  assert.equal(parsed.model_providers, undefined);
  assert.deepEqual(profile.expectedConnection, { source: 'account' });
  assert.equal(processEnv.OPENAI_API_KEY, 'old-key');
  assert.equal(buildCodexConnectionProfile({ source: 'account' }).modelProvider, profile.modelProvider, 'ordinary CLI can resolve the persisted native provider');
});

test('router selects its existing native table and keeps credentials out of argv', () => {
  const profile = buildCodexConnectionProfile({ source: 'router', processEnv: { PATH: 'keep', CODEX_HOME: 'native-history', OPENAI_BASE_URL: 'https://old.example', OPENAI_API_KEY: 'old-key' }, router: { apiKey: token, baseUrl: 'https://router.example/v1/', authScheme: 'bearer' } });
  assert.equal(profile.env.CODEX_DESK_ROUTER_TOKEN, undefined);
  assert.equal(profile.env.OPENAI_API_KEY, undefined);
  assert.equal(profile.env.CODEX_HOME, 'native-history');
  assert.equal(profile.modelProvider, 'router');
  assert.ok(!profile.configOverrides.join(' ').includes(token));
  const parsed = parseProfile(profile);
  assert.equal(parsed.model_providers, undefined);
  assert.equal(profile.expectedConnection.apiKey, token);
  assert.equal(parsed.model_provider, profile.modelProvider);
});

test('an env_key router retains exactly its configured credential source after clearing unrelated API variables', () => {
  const profile = buildCodexConnectionProfile({ source: 'router', processEnv: { PATH: 'keep', openai_api_key: 'stale', CODEX_API_KEY: 'other' },
    router: { apiKey: token, baseUrl: 'https://router.example/v1', authScheme: 'bearer', envKey: 'OPENAI_API_KEY' } });
  assert.equal(profile.env.OPENAI_API_KEY, token);
  assert.equal(profile.env.openai_api_key, undefined);
  assert.equal(profile.env.CODEX_API_KEY, undefined);
  assert.doesNotThrow(() => validateCodexConnectionConfig({ model_provider: 'router', model_providers: { router: {
    wire_api: 'responses', base_url: 'https://router.example/v1', env_key: 'OPENAI_API_KEY',
  } } }, profile));
});

test('effective account config rejects provider table collisions while accepting an unmodified native route', () => {
  const profile = buildCodexConnectionProfile({ source: 'account', processEnv: {} });
  assert.doesNotThrow(() => validateCodexConnectionConfig({}, {}));
  assert.doesNotThrow(() => validateCodexConnectionConfig({ model_provider: 'openai' }, profile));
  for (const base_url of [undefined, 'https://api.openai.com/v1', 'https://api.openai.com/v1/', 'https://chatgpt.com/backend-api/codex']) {
    assert.doesNotThrow(() => validateCodexConnectionConfig({ model_provider: 'openai', model_providers: { openai: {
      name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, ...(base_url ? { base_url } : {}), stream_idle_timeout_ms: 600000,
    } } }, profile));
  }
  for (const patch of [
    { base_url: 'https://old-router.example/v1' }, { experimental_bearer_token: token }, { env_key: 'PRIVATE_KEY' },
    { requires_openai_auth: false }, { wire_api: 'chat' }, { http_headers: { aUtHoRiZaTiOn: token } },
    { env_http_headers: { 'X-API-Key': 'PRIVATE_KEY' } }, { base_url: `https://api.openai.com/v1?key=${token}` },
  ]) assert.throws(() => validateCodexConnectionConfig({ model_provider: 'openai', model_providers: { openai: {
    name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, ...patch,
  } } }, profile), error => /переопределяют/.test(error.message) && !error.message.includes(token));
  assert.throws(() => validateCodexConnectionConfig({ model_provider: 'different' }, profile), /переопределяют/);
});

test('effective router config preserves unrelated native knobs but rejects project auth and route overrides', () => {
  const profile = buildCodexConnectionProfile({ source: 'router', processEnv: {}, router: { apiKey: token, baseUrl: 'https://router.example/v1' } });
  const base = { wire_api: 'responses', base_url: 'https://router.example/v1', requires_openai_auth: false,
    experimental_bearer_token: token, stream_idle_timeout_ms: 900000, request_max_retries: 7, http_headers: { 'X-Company': 'team' } };
  const effective = provider => ({ model_provider: 'router', model_providers: { router: { ...base, ...provider } } });
  assert.doesNotThrow(() => validateCodexConnectionConfig(effective({}), profile));
  for (const patch of [
    { base_url: 'https://another-router.example/v1' }, { experimental_bearer_token: 'changed-key' },
    { requires_openai_auth: true }, { wire_api: 'chat' }, { http_headers: { Authorization: token } },
    { env_http_headers: { Cookie: 'PRIVATE_COOKIE' } }, { experimental_bearer_token: '', env_key: 'OTHER' },
  ]) assert.throws(() => validateCodexConnectionConfig(effective(patch), profile), error => /переопределяют/.test(error.message) && !error.message.includes(token));
});

test('profile builder fails closed for invalid endpoint/auth/token without echoing supplied secrets', () => {
  const invalid = [undefined, {}, { apiKey: token, baseUrl: 'not a URL' }, { apiKey: token, baseUrl: 'https://router.example', authScheme: 'api-key' },
    { apiKey: token, baseUrl: `https://router.example/${token}` }, { apiKey: token, baseUrl: 'https://router.example?token=hidden' },
    { apiKey: 'key with space', baseUrl: 'https://router.example' }, { apiKey: 123, baseUrl: 'https://router.example' }, { apiKey: token, baseUrl: [] }];
  for (const router of invalid) assert.throws(() => buildCodexConnectionProfile({ source: 'router', router }), error => !error.message.includes(token));
  assert.throws(() => buildCodexConnectionProfile({ source: 'unknown' }), /источник/);
});
