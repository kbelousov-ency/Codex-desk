import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { ApiError, RateLimiter, validateInitData } from '../src/security.ts';

const TOKEN = '100000:LOCAL_ONLY_NOT_A_TELEGRAM_BOT_TOKEN';
const NOW = 1_700_000_000_000;
const USER = { id: 10001, first_name: 'Alice', username: 'alice_fixture' };
const VECTOR_HASH = 'd2edae3f79ed465d53fb86c09689ea9c2ae77b17011f9f2caf46d962936ddd53';
const vector = () => new URLSearchParams({ auth_date: '1700000000', query_id: 'AAE_FIXTURE',
  signature: 'fixture_signature', user: JSON.stringify(USER), hash: VECTOR_HASH }).toString();
const errorCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function signed(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const canonical = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(canonical).digest('hex'));
  return params.toString();
}

test('Telegram HMAC accepts an independently calculated fixed vector including signature', () => {
  assert.deepEqual(validateInitData(vector(), TOKEN, NOW), { telegram_id: '10001', display_name: 'Alice', username: 'alice_fixture' });
  const reordered = new URLSearchParams(vector());
  assert.deepEqual(validateInitData([...reordered].reverse().map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&'), TOKEN, NOW),
    { telegram_id: '10001', display_name: 'Alice', username: 'alice_fixture' });
});

test('Telegram initData rejects tampering, wrong token, unsigned unsafe identity and malformed fields', () => {
  const changed = new URLSearchParams(vector()); changed.set('user', JSON.stringify({ ...USER, id: 99999 }));
  for (const candidate of [changed.toString(), '', JSON.stringify({ initDataUnsafe: { user: USER } }),
    vector() + '&user=' + encodeURIComponent(JSON.stringify(USER)), vector() + '&hash=' + VECTOR_HASH,
    vector().replace('AAE_FIXTURE', '%ZZ'), vector().replace(VECTOR_HASH, 'x'.repeat(64))]) {
    assert.throws(() => validateInitData(candidate, TOKEN, NOW), errorCode('invalid_init_data'));
  }
  assert.throws(() => validateInitData(vector(), 'different-synthetic-token', NOW), errorCode('invalid_init_data'));
  assert.throws(() => validateInitData(vector(), '', NOW), errorCode('invalid_init_data'));
});

test('Telegram auth_date expires at the configured boundary and rejects future replay', () => {
  assert.equal(validateInitData(vector(), TOKEN, NOW + 300_000).telegram_id, '10001');
  assert.throws(() => validateInitData(vector(), TOKEN, NOW + 301_000), errorCode('expired_init_data'));
  assert.equal(validateInitData(vector(), TOKEN, NOW - 30_000).telegram_id, '10001');
  assert.throws(() => validateInitData(vector(), TOKEN, NOW - 31_000), errorCode('expired_init_data'));
  for (const value of ['-1', 'NaN', '9007199254740992']) {
    assert.throws(() => validateInitData(signed({ auth_date: value, user: JSON.stringify(USER) }), TOKEN, NOW), ApiError);
  }
});

test('signed malformed Telegram identities do not become server users', () => {
  for (const user of [{ ...USER, id: 0 }, { ...USER, id: -1 }, { ...USER, id: '10001' },
    { ...USER, id: Number.MAX_SAFE_INTEGER + 1 }, { ...USER, first_name: null }, null, []]) {
    assert.throws(() => validateInitData(signed({ auth_date: '1700000000', user: JSON.stringify(user) }), TOKEN, NOW), errorCode('invalid_init_data'));
  }
});

test('rate limits bound attempts per identity without affecting another identity or a new window', () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 5; i++) limiter.consume('claim:user-a', 5, 600_000, NOW);
  assert.throws(() => limiter.consume('claim:user-a', 5, 600_000, NOW), errorCode('rate_limited'));
  limiter.consume('claim:user-b', 5, 600_000, NOW);
  limiter.consume('claim:user-a', 5, 600_000, NOW + 600_000);
});
