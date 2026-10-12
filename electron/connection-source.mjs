import { mkdtemp, writeFile, unlink, rmdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONNECTION_SOURCES = new Set(['inherited', 'account', 'router']);
const MAX_CLAUDE_SETTINGS_BYTES = 512 * 1024;

// Only connection credentials/routing are overridden. Instructions, tools, permissions,
// CLAUDE_CONFIG_DIR and the native transcript directory retain their normal scope.
const credentialKeys = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
];
const providerKeys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const modelFamilies = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const modelEnvironmentKeys = ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', ...[...modelFamilies].flatMap(family => [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`, `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL_NAME`])];

/** An inherited tab is routed by the CLI's own settings file, not by Кузьмич: the credentials live in
 * `env` there and never reach the launch environment. Read them read-only so usage can be reported
 * for that tab, the same way the Codex provider table is read. Returns null when the CLI is personal. */
export async function readInheritedClaudeRouter({ env = process.env, read = readFile } = {}) {
  try {
    const directory = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || os.homedir(), '.claude');
    const bytes = await read(path.join(directory, 'settings.json'));
    if (Buffer.byteLength(bytes) > MAX_CLAUDE_SETTINGS_BYTES) return null;
    const values = JSON.parse(bytes.toString('utf8'))?.env;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const apiKey = [values.ANTHROPIC_AUTH_TOKEN, values.ANTHROPIC_API_KEY]
      .find(value => typeof value === 'string' && value.trim() && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value));
    if (!apiKey || typeof values.ANTHROPIC_BASE_URL !== 'string' || values.ANTHROPIC_BASE_URL.length > 2048) return null;
    const url = new URL(values.ANTHROPIC_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: url.href.replace(/\/$/, ''), apiKey };
  } catch { return null; }
}

/** Resolve one process's source; never mutate process.env, CLI settings or credential files. */
export function buildClaudeConnectionProfile({ source = 'inherited', processEnv = process.env, accountEnv = {}, router, inheritedRouter } = {}) {
  if (!CONNECTION_SOURCES.has(source)) throw new Error('Неизвестный источник подключения.');
  // The marker only records that the inherited CLI is already routed; its environment stays untouched.
  if (source === 'inherited') return { env: { ...processEnv, ...accountEnv }, inheritEnv: false, ...(inheritedRouter ? { inheritedRouter } : {}) };
  const overrides = Object.fromEntries([...credentialKeys.map(key => [key, '']), ...modelEnvironmentKeys.map(key => [key, '']), ...providerKeys.map(key => [key, '0'])]);
  if (source === 'account') {
    overrides.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    // An explicitly saved application token takes priority; inherited OAuth remains usable.
    overrides.CLAUDE_CODE_OAUTH_TOKEN = accountEnv.CLAUDE_CODE_OAUTH_TOKEN || processEnv.CLAUDE_CODE_OAUTH_TOKEN || '';
  } else {
    if (!router || typeof router.apiKey !== 'string' || !router.apiKey.trim() || /[\r\n\0]/.test(router.apiKey)) throw new Error('Подключите Claude к роутеру в настройках.');
    let url;
    try { url = new URL(router.baseUrl); } catch { throw new Error('Некорректный адрес роутера Claude.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Некорректный адрес роутера Claude.');
    overrides.ANTHROPIC_BASE_URL = url.href.replace(/\/$/, '');
    if (!['bearer', 'api-key'].includes(router.authScheme)) throw new Error('Неизвестный способ авторизации роутера Claude.');
    overrides[router.authScheme === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = router.apiKey;
    for (const [field, suffix] of [['modelAliases', ''], ['modelNames', '_NAME']]) {
      if (router[field] === undefined) continue;
      if (!router[field] || typeof router[field] !== 'object' || Array.isArray(router[field])) throw new Error('Некорректный каталог моделей роутера Claude.');
      for (const [family, value] of Object.entries(router[field])) {
        if (!modelFamilies.has(family) || typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value) || (!suffix && !/^[A-Za-z0-9][A-Za-z0-9._/:+\[\]-]*$/.test(value))) throw new Error('Некорректный каталог моделей роутера Claude.');
        overrides[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL${suffix}`] = value;
      }
    }
  }
  const env = { ...processEnv };
  // Windows environment names are case-insensitive; remove differently cased inherited copies.
  const names = new Set(Object.keys(overrides));
  for (const key of Object.keys(env)) if (names.has(key.toUpperCase())) delete env[key];
  Object.assign(env, overrides);
  return { env, inheritEnv: false, settingsOverrides: { env: overrides, apiKeyHelper: '' } };
}

/** A legacy callback returns additions; new callbacks return the complete launch profile. */
export function claudeConnectionProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.inheritEnv === false) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) throw new Error('Некорректное окружение Claude.');
    return { env: { ...value.env }, inheritEnv: false, ...(value.settingsOverrides ? { settingsOverrides: value.settingsOverrides } : {}), ...(value.settingsFile ? { settingsFile: value.settingsFile } : {}), ...(value.inheritedRouter ? { inheritedRouter: value.inheritedRouter } : {}) };
  }
  return Object.keys(value).length ? { env: { ...value } } : {};
}

/** CLI --settings takes a filename, so secrets never appear in process command lines. */
export async function createClaudeSettingsFile(settingsOverrides) {
  if (!settingsOverrides || typeof settingsOverrides !== 'object' || Array.isArray(settingsOverrides)) throw new Error('Некорректные настройки подключения Claude.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-claude-source-'));
  const filename = path.join(directory, 'settings.json');
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  })();
  try { await writeFile(filename, JSON.stringify(settingsOverrides), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch { await cleanup().catch(() => {}); throw new Error('Не удалось подготовить настройки подключения Claude.'); }
  return { path: filename, cleanup };
}
