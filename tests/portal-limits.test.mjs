import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalLimitsClient, productLimits } from '../electron/portal-limits.mjs';

test('Portal limits normalize quotas without exposing the key', async () => {
  let request;
  const client = new PortalLimitsClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    const payload = { limits: [{ name: 'Codex', left: 75, resetAt: '2026-10-09T00:00:00Z', blocked: false, bands: [{ name: 'window', left: 60, resetAt: '2026-10-08T20:00:00Z', blocked: false }] }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  } });
  const result = await client.read('router-secret');
  assert.equal(result.available, true);
  assert.equal(result.limits[0].left, 75);
  assert.equal(result.limits[0].bands[0].left, 60);
  assert.equal(request.options.headers.Authorization, 'Bearer router-secret');
  assert.equal(request.options.credentials, 'omit');
  assert.doesNotMatch(JSON.stringify(result), /router-secret/);
});

test('Portal limits fail closed for invalid key, HTTP errors and malformed data', async () => {
  const invalid = new PortalLimitsClient({ fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal((await invalid.read('')).available, false);
  const failed = new PortalLimitsClient({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{}' }) });
  assert.match((await failed.read('key')).reason, /отклонён/);
  const malformed = new PortalLimitsClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{limits:{}}' }) });
  assert.equal((await malformed.read('key')).available, false);
});

test('Portal limits normalize numeric fields and preserve nulls', async () => {
  const client = new PortalLimitsClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ limits: [{ name: 'Codex', left: 75, usedPercent: 25.25, limitCredits: 120, usedCredits: 30, remainingCredits: 90, bands: [{ name: 'неделя', left: 50, sharePercent: 40, limitCredits: 100, usedCredits: 50, remainingCredits: 50 }] }, { name: 'Partial', left: 80, usedPercent: -1, limitCredits: 'bad', usedCredits: -2, remainingCredits: null, bonusCredits: -3 }] }) }) });
  const result = await client.read('router-secret');
  assert.equal(result.limits[0].usedPercent, 25.25);
  assert.equal(result.limits[0].limitCredits, 120);
  assert.equal(result.limits[0].bands[0].sharePercent, 40);
  assert.equal(result.limits[1].usedPercent, null);
  assert.equal(result.limits[1].limitCredits, null);
  assert.equal(result.limits[1].usedCredits, null);
});

test('Portal limits keep the legacy shape valid', async () => {
  const client = new PortalLimitsClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ limits: [{ name: 'Claude', left: 80, resetAt: null, blocked: false, bands: [] }] }) }) });
  const result = await client.read('router-secret');
  assert.equal(result.available, true);
  assert.equal(result.limits[0].left, 80);
  assert.equal(result.limits[0].usedPercent, null);
});

test('Product filter keeps only the requested product and fails closed when it is missing', () => {
  const snapshot = { available: true, fetchedAt: '2026-10-10T09:00:00.000Z', limits: [{ name: 'Codex', left: 63 }, { name: 'Claude', left: 30 }, { name: ' claude ', left: 29 }] };
  const claude = productLimits(snapshot, 'Claude');
  assert.equal(claude.available, true);
  assert.deepEqual(claude.limits.map(limit => limit.left), [30, 29]);
  // The Codex quota must never be presented as the Claude limit.
  assert.ok(claude.limits.every(limit => limit.left !== 63));
  const missing = productLimits({ available: true, fetchedAt: '2026-10-10T09:00:00.000Z', limits: [{ name: 'Codex', left: 63 }] }, 'Claude');
  assert.equal(missing.available, false);
  assert.match(missing.reason, /Claude/);
  assert.equal(missing.limits, undefined);
});

test('Product filter passes failures through unchanged', () => {
  const failed = { available: false, reason: 'Ключ роутера отклонён.' };
  assert.equal(productLimits(failed, 'Claude'), failed);
  const empty = { available: true, fetchedAt: '2026-10-10T09:00:00.000Z', limits: [] };
  assert.equal(productLimits(empty, 'Claude').available, false);
});
