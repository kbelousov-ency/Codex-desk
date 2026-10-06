import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { buildClaudeConnectionProfile, claudeConnectionProfile, createClaudeSettingsFile } from '../electron/connection-source.mjs';

const secret = 'fixture-router-credential-only';
const inherited = Object.freeze({ PATH: 'system-bin', CLAUDE_CONFIG_DIR: 'existing-history', TOOL_SETTING: 'keep', ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_API_KEY: 'other-api-key', ANTHROPIC_AUTH_TOKEN: 'other-token', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: other', anthropic_auth_token: 'other-cased-token' });

test('inherited source preserves existing environment and the application OAuth token without settings overrides', () => {
  const profile = buildClaudeConnectionProfile({ processEnv: inherited, accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'app-token' } });
  assert.deepEqual(profile, { env: { ...inherited, CLAUDE_CODE_OAUTH_TOKEN: 'app-token' }, inheritEnv: false });
  assert.equal(inherited.CLAUDE_CODE_OAUTH_TOKEN, 'old-oauth');
  assert.deepEqual(claudeConnectionProfile({ TOKEN: 'old-callback' }), { env: { TOKEN: 'old-callback' } });
});

test('router profile isolates credentials from inherited and settings auth without changing native history or tools', () => {
  for (const authScheme of ['bearer', 'api-key']) {
    const profile = buildClaudeConnectionProfile({ source: 'router', processEnv: inherited, router: { baseUrl: 'https://router.example/anthropic/', apiKey: secret, authScheme } });
    assert.equal(profile.inheritEnv, false);
    assert.equal(profile.env.CLAUDE_CONFIG_DIR, 'existing-history');
    assert.equal(profile.env.TOOL_SETTING, 'keep');
    assert.equal(profile.env.PATH, 'system-bin');
    assert.equal(profile.env.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.equal(profile.env.CLAUDE_CODE_USE_BEDROCK, '0');
    assert.equal(profile.env.ANTHROPIC_CUSTOM_HEADERS, '');
    assert.equal(profile.env.anthropic_auth_token, undefined);
    assert.equal(profile.env.ANTHROPIC_BASE_URL, 'https://router.example/anthropic');
    assert.equal(profile.env.ANTHROPIC_AUTH_TOKEN, authScheme === 'bearer' ? secret : '');
    assert.equal(profile.env.ANTHROPIC_API_KEY, authScheme === 'api-key' ? secret : '');
    assert.equal(profile.settingsOverrides.apiKeyHelper, '');
    for (const [key, value] of Object.entries(profile.settingsOverrides.env)) assert.equal(profile.env[key], value);
    assert.deepEqual(claudeConnectionProfile(profile), profile);
  }
  assert.equal(inherited.ANTHROPIC_AUTH_TOKEN, 'other-token');
});

test('account profile removes router authentication while preserving the account token and common config directory', () => {
  const profile = buildClaudeConnectionProfile({ source: 'account', processEnv: { ...inherited, ANTHROPIC_MODEL: 'cc/routed', ANTHROPIC_DEFAULT_FABLE_MODEL: 'cc/fable', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Routed Fable' }, accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'app-token' } });
  assert.equal(profile.env.CLAUDE_CODE_OAUTH_TOKEN, 'app-token');
  assert.equal(profile.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(profile.env.ANTHROPIC_API_KEY, '');
  assert.equal(profile.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(profile.env.CLAUDE_CONFIG_DIR, 'existing-history');
  assert.equal(profile.env.ANTHROPIC_MODEL, '');
  assert.equal(profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL, '');
  assert.equal(profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, '');
  assert.deepEqual(Object.keys(profile.settingsOverrides).sort(), ['apiKeyHelper', 'env']);
});

test('router maps the verified model families without inheriting personal defaults or selecting another model', () => {
  const profile = buildClaudeConnectionProfile({ source: 'router', processEnv: { ANTHROPIC_MODEL: 'personal-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-alias' }, router: {
    apiKey: secret, baseUrl: 'https://router.example', authScheme: 'bearer', model: 'router-default',
    modelAliases: { opus: 'cc/claude-opus-5-5[1m]', fable: 'cc/claude-fable-5-1[1m]', sonnet: 'cc/claude-sonnet-5-5', haiku: 'cc/claude-haiku-4-5' },
    modelNames: { fable: 'Claude Fable 5.1' },
  } });
  assert.equal(profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'cc/claude-fable-5-1[1m]');
  assert.equal(profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, 'Claude Fable 5.1');
  assert.equal(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'cc/claude-sonnet-5-5');
  assert.equal(profile.env.ANTHROPIC_MODEL, '', 'model is selected explicitly by the tab');
  assert.equal(profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, '');
  assert.throws(() => buildClaudeConnectionProfile({ source: 'router', router: { apiKey: secret, baseUrl: 'https://router.example', authScheme: 'bearer', modelAliases: { unknown: 'arbitrary' } } }), /каталог/);
});

test('missing or unsafe router configuration fails before launching without including secrets', () => {
  for (const router of [undefined, {}, { apiKey: secret, baseUrl: 'http://insecure.example', authScheme: 'bearer' }, { apiKey: secret, baseUrl: 'https://user:pass@router.example', authScheme: 'bearer' }, { apiKey: secret, baseUrl: 'https://router.example?key=x', authScheme: 'bearer' }, { apiKey: secret, baseUrl: 'https://router.example', authScheme: 'unknown' }]) {
    assert.throws(() => buildClaudeConnectionProfile({ source: 'router', router }), error => !error.message.includes(secret));
  }
  assert.throws(() => buildClaudeConnectionProfile({ source: 'invalid' }), /источник/);
  assert.throws(() => claudeConnectionProfile({ inheritEnv: false }), /окружение/);
});

test('private process settings hold auth overrides outside command arguments and cleanup removes the exact file', async () => {
  const overrides = { env: { ANTHROPIC_AUTH_TOKEN: secret }, apiKeyHelper: '' };
  const file = await createClaudeSettingsFile(overrides);
  try {
    assert.ok(!file.path.includes(secret));
    assert.deepEqual(JSON.parse(await readFile(file.path, 'utf8')), overrides);
    if (process.platform !== 'win32') assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  } finally { await file.cleanup(); }
  await assert.rejects(readFile(file.path), { code: 'ENOENT' });
  await file.cleanup();
});
