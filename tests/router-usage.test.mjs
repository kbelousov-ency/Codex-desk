import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouterUsageClient } from '../electron/router-usage.mjs';

test('router overview uses a bearer header and never puts the key in the URL', async () => {
  const calls = [];
  const client = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret-token' }, now: () => '2026-09-22T12:00:00.000Z', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const value = url.endsWith('/limit') ? { limits: [{ key: 'fixture-key', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-09-28T03:00:00+00:00', limit_credits: 100, used_credits: 20, remaining_credits: 80, used_percent: 20, ledger_used_credits: 999 }] } : { limit: { remaining: 42 }, coverage: 'full', sources: ['omniroute'] };
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await client.overview(), { available: true, fetchedAt: '2026-09-22T12:00:00.000Z', overview: { limit: { remaining: 42 }, coverage: 'full', sources: ['omniroute'] }, limits: [{ key: 'fixture-key', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-09-28T03:00:00.000Z', limit_credits: 100, used_credits: 20, remaining_credits: 80, used_percent: 20, ledger_used_credits: 999 }] });
  assert.equal(calls[0].url, 'https://router.encycam.com/v1/me/overview');
  assert.equal(calls[1].url, 'https://router.encycam.com/v1/me/limit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].url.includes('secret-token'), false);
});

test('router overview remains unavailable without a token and does not call the network', async () => {
  let called = false;
  const client = new RouterUsageClient({ env: {}, readFileImpl: async () => { throw new Error('missing config'); }, fetchImpl: async () => { called = true; throw new Error('must not call'); } });
  assert.deepEqual(await client.overview(), { available: false, reason: 'Не найден ключ router: задайте ANTHROPIC_AUTH_TOKEN или bearer-токен провайдера Codex.' });
  assert.equal(called, false);
});

test('router overview can use the bearer token already stored in the Codex provider config', async () => {
  let authorization = '';
  const client = new RouterUsageClient({ env: {}, readFileImpl: async () => Buffer.from('model_provider = "router"\n[model_providers.router]\nbase_url = "https://router.encycam.com/v1"\nexperimental_bearer_token = "config-secret"\n'), fetchImpl: async (_url, options) => { authorization = options.headers.Authorization; return new Response('{}', { status: 200 }); } });
  assert.equal((await client.overview()).available, true);
  assert.equal(authorization, 'Bearer config-secret');
});

test('router preserves raw quota fields separately from ledger and daily credits', async () => {
  const calls = [];
  const client = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, fetchImpl: async url => {
    calls.push(url);
    return new Response(JSON.stringify(url.endsWith('/limit') ? { limits: [{ key: 'fixture', available: true, state: 'ACTIVE', reset_at: '2026-09-28T03:00:00+00:00', limit_credits: null, used_credits: null, remaining_credits: null, ledger_used_credits: 99, bonus_credits: 5 }] } : { last_24h: { credits: 9999 } }), { status: 200 });
  } });
  const result = await client.overview();
  assert.deepEqual(result.limits[0], { key: 'fixture', available: true, tier: null, state: 'ACTIVE', reset_at: '2026-09-28T03:00:00.000Z', limit_credits: null, used_credits: null, remaining_credits: null, used_percent: null, ledger_used_credits: 99 });
  assert.deepEqual(calls, ['https://router.encycam.com/v1/me/overview', 'https://router.encycam.com/v1/me/limit']);
});

test('router normalizes ledger credits while preserving zero and unknown values', async () => {
  const fixtures = [
    { input: 18658.25, expected: 18658.25 },
    { input: ' 18658.25 ', expected: 18658.25 },
    { input: 0, expected: 0 },
    { input: '0', expected: 0 },
    { input: null, expected: null },
    { input: 'invalid', expected: null },
    { input: '', expected: null },
    { input: false, expected: null },
    { input: {}, expected: null },
    { expected: null },
  ];
  const client = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, fetchImpl: async url => {
    const value = url.endsWith('/limit') ? { limits: fixtures.map(fixture => ({ ledger_used_credits: fixture.input })) } : {};
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  const result = await client.overview();
  assert.deepEqual(result.limits.map(limit => limit.ledger_used_credits), fixtures.map(fixture => fixture.expected));
  assert.ok(result.limits.every(limit => limit.used_credits === null && limit.remaining_credits === null && limit.used_percent === null));
});

test('router keeps overview when limit endpoint is unavailable and never exposes its body', async () => {
  const client = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, fetchImpl: async url => url.endsWith('/limit') ? new Response('private-secret-body', { status: 503 }) : new Response(JSON.stringify({ last_24h: { credits: 10 } }), { status: 200 }) });
  const result = await client.overview();
  assert.equal(result.available, true);
  assert.deepEqual(result.overview, { last_24h: { credits: 10 } });
  assert.equal(result.limits, undefined);
  assert.match(result.limitReason, /Роутер временно недоступен/);
  assert.equal(JSON.stringify(result).includes('private-secret-body'), false);
});

test('router errors are safe and timeout is converted to a local status', async () => {
  const unauthorized = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, fetchImpl: async () => new Response('private body', { status: 401 }) });
  assert.deepEqual(await unauthorized.overview(), { available: false, status: 401, reason: 'Ключ роутера отклонён.' });
  const timeout = new RouterUsageClient({ env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); })) });
  assert.deepEqual(await timeout.overview(), { available: false, reason: 'Роутер не ответил вовремя.' });
});

test('router base URL must be HTTPS and cannot carry credentials or query data', () => {
  assert.throws(() => new RouterUsageClient({ baseUrl: 'http://router.example.test' }), /Некорректный адрес/);
  assert.throws(() => new RouterUsageClient({ baseUrl: 'https://user:pass@router.example.test' }), /Некорректный адрес/);
  assert.throws(() => new RouterUsageClient({ baseUrl: 'https://router.example.test/?token=secret' }), /Некорректный адрес/);
});
