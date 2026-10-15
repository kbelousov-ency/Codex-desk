import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status: number, code: string, message = code): never {
  throw new ApiError(status, code, message);
}

export function opaqueToken(): string { return randomBytes(32).toString('base64url'); }
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function matchesHash(value: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
}

export interface TelegramIdentity { telegram_id: string; display_name: string; username?: string | null }

/** Telegram Bot API HMAC validation. No identity fields from initDataUnsafe are used. */
export function validateInitData(initData: string, botToken: string, now = Date.now(), maxAgeSeconds = 300): TelegramIdentity {
  if (!botToken || typeof initData !== 'string' || initData.length > 16384 || !initData.length) {
    fail(401, 'invalid_init_data');
  }
  // Reject duplicates and malformed percent encoding; URLSearchParams otherwise silently normalizes both.
  try { decodeURIComponent(initData.replace(/\+/g, ' ')); } catch { fail(401, 'invalid_init_data'); }
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) fail(401, 'invalid_init_data');
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) fail(401, 'invalid_init_data');
  const check = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) fail(401, 'invalid_init_data');
  const date = params.get('auth_date');
  if (!date || !/^\d+$/.test(date)) fail(401, 'invalid_init_data');
  const issued = Number(date);
  const age = Math.floor(now / 1000) - issued;
  if (!Number.isSafeInteger(issued) || age > maxAgeSeconds || age < -30) fail(401, 'expired_init_data');
  let user: unknown;
  try { user = JSON.parse(params.get('user') ?? ''); } catch { fail(401, 'invalid_init_data'); }
  if (!isRecord(user) || !Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.first_name !== 'string') {
    fail(401, 'invalid_init_data');
  }
  return { telegram_id: String(user.id), display_name: `${user.first_name}${typeof user.last_name === 'string' ? ' ' + user.last_name : ''}`.slice(0, 100),
    username: typeof user.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(user.username) ? user.username : null };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function bodyRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'invalid_fields');
  return value;
}
export function stringField(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail(400, 'invalid_fields');
  return value;
}

/** Fixed windows, bounded cardinality; callers never use secret material as a key. */
export class RateLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    for (const [storedKey, value] of this.entries) if (value.until <= now) this.entries.delete(storedKey);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 10000) fail(429, 'rate_limited');
      entry = { count: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    if (++entry.count > limit) fail(429, 'rate_limited');
  }
}
