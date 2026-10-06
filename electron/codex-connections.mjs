import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';

const conflict = 'Настройки Codex переопределяют выбранный источник подключения. Проверьте провайдер в настройках CLI.';
const authHeaders = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie']);
const firstPartyBases = new Set(['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const envValue = (env, key) => Object.entries(env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1];
const hasHeaderAuth = provider => ['http_headers', 'env_http_headers'].some(field =>
  record(provider[field]) && Object.keys(provider[field]).some(key => authHeaders.has(key.toLowerCase())));

function routerConnection(value) {
  if (!value || typeof value.apiKey !== 'string' || !value.apiKey || value.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(value.apiKey)) throw new Error('Ключ роутера Codex не найден. Подключите роутер через портал.');
  if (value.authScheme !== undefined && value.authScheme !== 'bearer') throw new Error('Неизвестный способ авторизации роутера Codex.');
  let url;
  try {
    if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048 || /[\x00-\x20\x7f]/.test(value.baseUrl)) throw new Error();
    url = new URL(value.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.baseUrl.includes(value.apiKey)) throw new Error();
  } catch { throw new Error('Некорректный адрес роутера Codex.'); }
  if (value.envKey !== undefined && (typeof value.envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.envKey))) throw new Error('Некорректный источник ключа роутера Codex.');
  return { apiKey: value.apiKey, baseUrl: url.href.replace(/\/$/, ''), authScheme: 'bearer', ...(value.envKey ? { envKey: value.envKey } : {}) };
}

/** Only the existing, explicitly named router provider is eligible for reuse. */
export async function readCodexRouterConnection({ env = process.env, read = readFile } = {}) {
  const filename = path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(env.USERPROFILE || os.homedir(), '.codex'), 'config.toml');
  let config;
  try {
    const bytes = await read(filename);
    if (Buffer.byteLength(bytes) > 512 * 1024) throw new Error();
    config = TOML.parse(bytes.toString('utf8'));
  } catch { throw new Error('Не удалось прочитать подключение роутера Codex. Подключите его через портал в мастере настройки.'); }
  const provider = config.model_providers?.router;
  if (!provider || provider.wire_api !== 'responses' || provider.requires_openai_auth === true || hasHeaderAuth(provider)) throw new Error('Роутер Codex не настроен. Подключите его через портал в мастере настройки.');
  const token = provider.experimental_bearer_token || (typeof provider.env_key === 'string' ? envValue(env, provider.env_key) : '');
  return routerConnection({ apiKey: token, baseUrl: provider.base_url, authScheme: 'bearer',
    ...(!provider.experimental_bearer_token && provider.env_key ? { envKey: provider.env_key } : {}) });
}

/** Process-local configuration: credentials never appear in argv or global config. */
export function buildCodexConnectionProfile({ source = 'inherited', processEnv = process.env, router } = {}) {
  if (source === 'inherited') return {};
  if (!['account', 'router'].includes(source)) throw new Error('Неизвестный источник подключения.');
  const env = { ...processEnv };
  for (const key of Object.keys(env)) if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_DESK_ROUTER_TOKEN'].includes(key.toUpperCase())) delete env[key];
  // These native names remain resolvable by a normal `codex resume` outside Desk.
  // Never inject a new provider table: Codex persists its name in the transcript.
  const modelProvider = source === 'router' ? 'router' : 'openai';
  let expectedConnection = { source: 'account' };
  if (source === 'router') {
    if (!router?.apiKey || !router.baseUrl) throw new Error('Сначала подключите роутер Codex.');
    const connection = routerConnection(router);
    if (connection.envKey) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === connection.envKey.toUpperCase()) delete env[key];
      env[connection.envKey] = connection.apiKey;
    }
    expectedConnection = { source: 'router', ...connection };
  }
  return { env, modelProvider, expectedConnection, configOverrides: [`model_provider=${JSON.stringify(modelProvider)}`] };
}

/** Validate raw effective CLI config before exposing bootstrap; values and credentials stay in the host. */
export function validateCodexConnectionConfig(config, profile) {
  const expected = profile?.expectedConnection;
  if (!expected) return;
  if (!record(config) || config.model_provider !== profile.modelProvider) throw new Error(conflict);
  const provider = config.model_providers?.[profile.modelProvider];
  if (expected.source === 'account') {
    if (provider === undefined) return; // Native built-in OpenAI provider.
    if (!record(provider) || (provider.wire_api !== undefined && provider.wire_api !== 'responses')
      || provider.requires_openai_auth !== true || provider.env_key || provider.experimental_bearer_token || hasHeaderAuth(provider)) throw new Error(conflict);
    if (provider.base_url !== undefined && provider.base_url !== null) {
      if (typeof provider.base_url !== 'string' || !firstPartyBases.has(provider.base_url.replace(/\/$/, ''))) throw new Error(conflict);
    }
    return;
  }
  if (!record(provider) || provider.wire_api !== 'responses' || provider.requires_openai_auth === true || hasHeaderAuth(provider)) throw new Error(conflict);
  let effective;
  try {
    const token = provider.experimental_bearer_token || (typeof provider.env_key === 'string' ? envValue(profile.env, provider.env_key) : '');
    effective = routerConnection({ apiKey: token, baseUrl: provider.base_url, authScheme: 'bearer',
      ...(!provider.experimental_bearer_token && provider.env_key ? { envKey: provider.env_key } : {}) });
  } catch { throw new Error(conflict); }
  if (effective.apiKey !== expected.apiKey || effective.baseUrl !== expected.baseUrl || effective.envKey !== expected.envKey) throw new Error(conflict);
}

export function assertCodexConnectionProfile(profile, config) { return validateCodexConnectionConfig(config, profile); }
