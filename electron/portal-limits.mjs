import { randomUUID } from 'node:crypto';

export const PORTAL_LIMITS_ORIGIN = 'https://coder-portal.encycam.com';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LIMITS = 32;

function safeOrigin(value) {
  const url = new URL(value || PORTAL_LIMITS_ORIGIN);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Некорректный адрес портала.');
  return url.origin;
}

function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonNegative(value) { const parsed = number(value); return parsed !== null && parsed >= 0 ? parsed : null; }
function date(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function boundedPercent(value) { const parsed = number(value); return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : null; }

function normalizeBand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = typeof value.name === 'string' && value.name.length <= 128 ? value.name : null;
  return { name, left: boundedPercent(value.left), resetAt: date(value.resetAt), blocked: typeof value.blocked === 'boolean' ? value.blocked : null, band: typeof value.band === 'string' ? value.band : null, hours: nonNegative(value.hours), sharePercent: boundedPercent(value.sharePercent), usedPercent: nonNegative(value.usedPercent), limitCredits: nonNegative(value.limitCredits), usedCredits: nonNegative(value.usedCredits), remainingCredits: nonNegative(value.remainingCredits) };
}

function normalizeLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bands = Array.isArray(value.bands) ? value.bands.slice(0, 16).map(normalizeBand).filter(Boolean) : [];
  return { key: null, name: typeof value.name === 'string' && value.name.length <= 128 ? value.name : null, left: boundedPercent(value.left), resetAt: date(value.resetAt), blocked: typeof value.blocked === 'boolean' ? value.blocked : null, available: typeof value.available === 'boolean' ? value.available : null, tier: typeof value.tier === 'string' ? value.tier : null, state: typeof value.state === 'string' ? value.state : null, blockedReason: typeof value.blockedReason === 'string' ? value.blockedReason : null, usedPercent: nonNegative(value.usedPercent), limitCredits: nonNegative(value.limitCredits), usedCredits: nonNegative(value.usedCredits), remainingCredits: nonNegative(value.remainingCredits), ledgerUsedCredits: nonNegative(value.ledgerUsedCredits), bonusCredits: nonNegative(value.bonusCredits), bands }; 
}

export class PortalLimitsClient {
  constructor({ origin = PORTAL_LIMITS_ORIGIN, fetchImpl = globalThis.fetch, timeoutMs = 8_000, now = () => new Date().toISOString() } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('В этой среде недоступен HTTP-клиент.');
    this.origin = safeOrigin(origin); this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.now = now;
  }

  async read(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\0]/.test(apiKey)) return { available: false, fetchedAt: this.now(), reason: 'Ключ роутера недоступен.' };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); const requestId = randomUUID();
    try {
      const response = await this.fetch(`${this.origin}/api/relay/limits`, { method: 'GET', credentials: 'omit', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Cache-Control': 'no-store', 'X-Request-ID': requestId }, redirect: 'error', signal: controller.signal });
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { available: false, fetchedAt: this.now(), reason: 'Ответ портала слишком большой.' };
      if (!response.ok) return { available: false, fetchedAt: this.now(), status: response.status, reason: response.status === 401 || response.status === 403 ? 'Ключ роутера отклонён.' : 'Портал лимитов недоступен.' };
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.limits)) return { available: false, fetchedAt: this.now(), reason: 'Портал вернул некорректные лимиты.' };
      return { available: true, fetchedAt: this.now(), limits: parsed.limits.slice(0, MAX_LIMITS).map(normalizeLimit).filter(Boolean) };
    } catch (error) { return { available: false, fetchedAt: this.now(), reason: error?.name === 'AbortError' ? 'Портал не ответил вовремя.' : 'Не удалось получить лимиты портала.' }; }
    finally { clearTimeout(timer); }
  }
}

/** One product's rows from a relay snapshot: a Claude tab must not show the Codex quota. */
export function productLimits(snapshot, product) {
  if (!snapshot?.available || !Array.isArray(snapshot.limits)) return snapshot;
  const limits = snapshot.limits.filter(limit => typeof limit?.name === 'string' && limit.name.trim().toLowerCase() === product.toLowerCase());
  if (!limits.length) return { available: false, ...(snapshot.fetchedAt ? { fetchedAt: snapshot.fetchedAt } : {}), reason: `Портал не передал лимит ${product}.` };
  return { ...snapshot, limits };
}
