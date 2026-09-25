import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';

const DEFAULT_BASE_URL = 'https://router.encycam.com';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONFIG_BYTES = 512 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const publicText = (value, token) => typeof value === 'string' && value !== token && !(token && value.includes(token)) ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : null;

function publicLimits(value, token) {
  if (!Array.isArray(value.limits) || value.limits.length > 100 || value.limits.some(item => !record(item))) return null;
  return value.limits.map(item => ({
    key: publicText(item.key, token),
    available: typeof item.available === 'boolean' ? item.available : null,
    tier: publicText(item.tier, token), state: publicText(item.state, token),
    reset_at: typeof item.reset_at === 'string' && Number.isFinite(Date.parse(item.reset_at)) ? new Date(item.reset_at).toISOString() : null,
    limit_credits: numeric(item.limit_credits), used_credits: numeric(item.used_credits), remaining_credits: numeric(item.remaining_credits),
    ledger_used_credits: numeric(item.ledger_used_credits),
    used_percent: numeric(item.used_percent),
  }));
}

function messageForStatus(status) {
  if (status === 401 || status === 403) return 'Ключ роутера отклонён.';
  if (status === 404) return 'Endpoint статистики роутера не найден.';
  if (status >= 500) return 'Роутер временно недоступен.';
  return `Роутер вернул HTTP ${status}.`;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value || DEFAULT_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new Error('Некорректный адрес роутера.');
  }
}

/** Read-only client for the personal router usage endpoint. The token never leaves this process. */
export class RouterUsageClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date().toISOString(), configPath, readFileImpl = readFile } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('В этой среде недоступен HTTP-клиент.');
    this.baseUrl = safeBaseUrl(baseUrl);
    this.env = env;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.configPath = configPath || path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(env.USERPROFILE || os.homedir(), '.codex'), 'config.toml');
    this.readFile = readFileImpl;
  }

  async token() {
    const environmentToken = typeof this.env?.ANTHROPIC_AUTH_TOKEN === 'string' ? this.env.ANTHROPIC_AUTH_TOKEN.trim() : '';
    if (environmentToken) return environmentToken;
    try {
      const bytes = await this.readFile(this.configPath);
      if (Buffer.byteLength(bytes) > MAX_CONFIG_BYTES) return '';
      const config = TOML.parse(bytes.toString('utf8'));
      const provider = typeof config.model_provider === 'string' ? config.model_provider : 'router';
      const providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {};
      const providerConfig = providers[provider] && typeof providers[provider] === 'object' ? providers[provider] : {};
      // A different provider's credential must never be sent to the router statistics host.
      if (typeof providerConfig.base_url === 'string' && new URL(providerConfig.base_url).origin !== new URL(this.baseUrl).origin) return '';
      return typeof providerConfig.experimental_bearer_token === 'string' ? providerConfig.experimental_bearer_token.trim() : '';
    } catch {
      return '';
    }
  }

  async requestJson(pathname, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-store' },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit', cache: 'no-store',
      });
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) return { ok: false, reason: 'Ответ роутера слишком велик.' };
      if (!response.ok) return { ok: false, status: response.status, reason: messageForStatus(response.status) };
      let value;
      try { value = JSON.parse(body); } catch { return { ok: false, reason: 'Роутер вернул некорректный JSON.' }; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'Роутер вернул неожиданный формат.' };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error?.name === 'AbortError' ? 'Роутер не ответил вовремя.' : 'Не удалось получить статистику роутера.' };
    } finally {
      clearTimeout(timer);
    }
  }

  async overview() {
    const token = await this.token();
    if (!token) return { available: false, reason: 'Не найден ключ router: задайте ANTHROPIC_AUTH_TOKEN или bearer-токен провайдера Codex.' };
    const [overview, limit] = await Promise.all([this.requestJson('/v1/me/overview', token), this.requestJson('/v1/me/limit', token)]);
    const limits = limit.ok ? publicLimits(limit.value, token) : null;
    const limitReason = limits === null ? limit.reason || 'Роутер вернул неожиданный формат лимитов.' : undefined;
    if (!overview.ok && limits === null) return { available: false, ...(overview.status ? { status: overview.status } : {}), reason: overview.reason };
    return { available: true, fetchedAt: this.now(),
      ...(overview.ok ? { overview: overview.value } : { overviewReason: overview.reason }),
      ...(limits !== null ? { limits } : { limitReason }),
    };
  }
}

export { DEFAULT_BASE_URL };
