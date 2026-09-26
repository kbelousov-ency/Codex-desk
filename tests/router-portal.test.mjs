import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouterPortalClient, PORTAL_ORIGIN } from '../electron/router-portal.mjs';

const device = { device_code: 'device-secret-fixture', user_code: 'BCDF-GHJK', verification_uri: `${PORTAL_ORIGIN}/device`, verification_uri_complete: `${PORTAL_ORIGIN}/device?code=BCDF-GHJK`, expires_in: 600, interval: 5 };
const provider = { name: 'ENCY OmniRoute', base_url: 'https://router.encycam.com/v1', wire_api: 'responses', requires_openai_auth: false };
const defaults = { model: 'gpt-5.6-terra', model_provider: 'router', model_context_window: 1000000, model_auto_compact_token_limit: 900000, model_reasoning_summary: 'detailed', hide_agent_reasoning: false };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(handler) {
  let now = Date.parse('2026-09-25T12:00:00.000Z');
  let nextId = 0;
  const timers = new Map();
  const calls = [];
  const client = new RouterPortalClient({ now: () => now, timers: {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (handler) { const result = await handler(url, options, calls); if (result !== undefined) return result; }
    if (url.endsWith('/api/device/codex')) return json(device);
    if (url.endsWith('/token')) return json({ api_key: 'router-secret-fixture', email: 'private@example.test' });
    if (url.endsWith('/provider')) return json(provider);
    if (url.endsWith('/defaults')) return json(defaults);
    throw new Error(`Unexpected request ${url}`);
  } });
  return { client, calls, timers, advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) { if (timer.at <= now && timers.delete(id)) timer.fn(); }
  } };
}

test('device flow waits for the interval and returns secrets only in host config', async () => {
  const f = fixture();
  const start = await f.client.start('WORKSTATION');
  assert.equal(start.userCode, device.user_code);
  assert.equal(start.verificationUri, device.verification_uri_complete);
  assert.equal(start.expiresAt, '2026-09-25T12:10:00.000Z');
  assert.equal(start.intervalMs, 5000);
  assert.equal(JSON.stringify(start).includes(device.device_code), false);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { client: 'Codex Desk', host: 'WORKSTATION' });
  assert.equal(f.client.verificationUri(start.flowId), device.verification_uri_complete);
  assert.deepEqual(await f.client.poll(start.flowId), { state: 'pending', intervalMs: 5000 });
  assert.equal(f.calls.length, 1);
  f.advance(5000);
  const result = await f.client.poll(start.flowId);
  assert.deepEqual(result, { state: 'ready', config: { apiKey: 'router-secret-fixture', provider, defaults } });
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ['/api/device/codex', '/api/device/codex/token', '/api/codex/provider', '/api/codex/defaults']);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, PORTAL_ORIGIN);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.url.includes('secret'), false);
  }
  assert.equal(f.calls[1].options.headers.Authorization, undefined);
  assert.equal(f.calls[2].options.headers.Authorization, 'Bearer router-secret-fixture');
  await assert.rejects(f.client.poll(start.flowId), { code: 'cancelled' });
});

test('pending and slow_down enforce progressively longer intervals', async () => {
  let tokenCalls = 0;
  const f = fixture(url => url.endsWith('/token') ? json({ error: ++tokenCalls === 1 ? 'authorization_pending' : 'slow_down' }, 400) : undefined);
  const flow = await f.client.start('PC');
  f.advance(5000);
  assert.deepEqual(await f.client.poll(flow.flowId), { state: 'pending', intervalMs: 5000 });
  f.advance(5000);
  assert.deepEqual(await f.client.poll(flow.flowId), { state: 'pending', intervalMs: 10000 });
  f.advance(5000);
  assert.deepEqual(await f.client.poll(flow.flowId), { state: 'pending', intervalMs: 5000 });
  assert.equal(tokenCalls, 2);
  f.advance(5000);
  assert.deepEqual(await f.client.poll(flow.flowId), { state: 'pending', intervalMs: 15000 });
  f.client.dispose();
});

test('retries configuration after a network failure without consuming the token twice', async () => {
  let providerCalls = 0;
  const f = fixture(url => {
    if (url.endsWith('/provider') && ++providerCalls === 1) throw new Error('private raw network data router-secret-fixture');
  });
  const flow = await f.client.start('PC');
  f.advance(5000);
  await assert.rejects(f.client.poll(flow.flowId), error => error.code === 'network' && error.retryable && !error.message.includes('secret'));
  f.advance(5000);
  assert.equal((await f.client.poll(flow.flowId)).state, 'ready');
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
});

test('overlapping polls share one token request; cancellation discards a late response', async () => {
  let release;
  const f = fixture(url => url.endsWith('/token') ? new Promise(resolve => { release = resolve; }) : undefined);
  const flow = await f.client.start('PC');
  f.advance(5000);
  const first = f.client.poll(flow.flowId);
  const second = f.client.poll(flow.flowId);
  assert.equal(first, second);
  const rejected = assert.rejects(first, { code: 'cancelled' });
  f.client.cancel(flow.flowId);
  release(json({ api_key: 'late-secret' }));
  await rejected;
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
});

test('restarting invalidates in-flight start and old cancellation does not stop the new flow', async () => {
  let release;
  let starts = 0;
  const f = fixture(url => url.endsWith('/api/device/codex') && ++starts === 1 ? new Promise(resolve => { release = resolve; }) : undefined);
  const first = f.client.start('FIRST');
  const firstRejected = assert.rejects(first, { code: 'cancelled' });
  const second = await f.client.start('SECOND');
  release(json(device));
  await firstRejected;
  f.client.cancel('old-flow-id');
  assert.equal(f.client.verificationUri(second.flowId), device.verification_uri_complete);
  f.client.dispose();
});

test('host expiry clears the flow without requiring a renderer poll', async () => {
  const f = fixture();
  const flow = await f.client.start('PC');
  f.advance(600_000);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.client.poll(flow.flowId), { code: 'expired' });
  assert.throws(() => f.client.verificationUri(flow.flowId), { code: 'expired' });
  assert.equal(f.calls.length, 1);
});

test('denial, expiration and authentication failures finish the flow with safe errors', async () => {
  for (const [value, status, code] of [
    [{ error: 'access_denied', detail: 'private-secret' }, 400, 'denied'],
    [{ error: 'expired_token' }, 400, 'expired'],
    [{ detail: 'private-secret' }, 401, 'unauthorized'],
    [{ detail: 'private-secret' }, 403, 'forbidden'],
  ]) {
    const f = fixture(url => url.endsWith('/token') ? json(value, status) : undefined);
    const flow = await f.client.start('PC');
    f.advance(5000);
    await assert.rejects(f.client.poll(flow.flowId), error => error.code === code && !error.message.includes('private-secret'));
    assert.equal(f.timers.size, 0);
    await assert.rejects(f.client.poll(flow.flowId), { code });
  }
});

test('401 and 403 while fetching config discard the consumed key', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const f = fixture(url => url.endsWith('/defaults') ? json({ secret: 'private-secret' }, status) : undefined);
    const flow = await f.client.start('PC');
    f.advance(5000);
    await assert.rejects(f.client.poll(flow.flowId), { code });
    await assert.rejects(f.client.poll(flow.flowId), { code });
    assert.equal(f.timers.size, 0);
  }
});

test('only the exact portal device page and matching code can be opened', async () => {
  for (const uri of [
    'https://evil.example/device?code=BCDF-GHJK', `${PORTAL_ORIGIN}/other?code=BCDF-GHJK`,
    `${PORTAL_ORIGIN}/device?code=OTHER`, `${PORTAL_ORIGIN}/device?code=BCDF-GHJK&token=secret`,
    `${PORTAL_ORIGIN}/device?code=BCDF-GHJK#secret`, `${PORTAL_ORIGIN}/device?code=BCDF-GHJK&code=BCDF-GHJK`,
    'https://user:password@coder-portal.encycam.com/device?code=BCDF-GHJK',
  ]) {
    const f = fixture(() => json({ ...device, verification_uri_complete: uri }));
    await assert.rejects(f.client.start('PC'), { code: 'invalid_response' });
    assert.equal(f.timers.size, 0);
  }
});

test('validates provider and defaults without permitting unrelated config or TOML table injection', async () => {
  const cases = [
    ['/defaults', { ...defaults, model_provider: 'router.evil' }],
    ['/defaults', { ...defaults, model_provider: '__proto__' }],
    ['/defaults', { ...defaults, model_provider: 'constructor' }],
    ['/defaults', { ...defaults, model: 'bad\nmodel' }],
    ['/defaults', { ...defaults, model_context_window: -1 }],
    ['/defaults', { ...defaults, model_auto_compact_token_limit: 2000000 }],
    ['/defaults', { ...defaults, model_reasoning_summary: 'unknown' }],
    ['/defaults', { ...defaults, hide_agent_reasoning: 'false' }],
    ['/defaults', { ...defaults, developer_instructions: 'hidden' }],
    ['/defaults', { ...defaults, model: 'router-secret-fixture' }],
    ['/defaults', { model: 'gpt-5.6-terra', model_provider: 'router' }],
    ['/provider', { ...provider, base_url: 'http://router.encycam.com/v1' }],
    ['/provider', { ...provider, base_url: 'https://user:pass@router.encycam.com/v1' }],
    ['/provider', { ...provider, base_url: 'https://router.encycam.com/v1?token=secret' }],
    ['/provider', { ...provider, requires_openai_auth: true }],
    ['/provider', { ...provider, wire_api: 'chat' }],
    ['/provider', { ...provider, env_key: 'SECRET' }],
    ['/provider', { ...provider, name: 'router-secret-fixture' }],
    ['/provider', { ...provider, base_url: 'https://router.encycam.com/router-secret-fixture/v1' }],
    ['/provider', JSON.parse('{"__proto__":{},"name":"router"}')],
  ];
  for (const [suffix, value] of cases) {
    const f = fixture(url => url.endsWith(suffix) ? json(value) : undefined);
    const flow = await f.client.start('PC');
    f.advance(5000);
    await assert.rejects(f.client.poll(flow.flowId), { code: 'invalid_response' });
    assert.equal(f.timers.size, 0);
  }
});

test('response byte limit stops streaming before buffering an entire body', async () => {
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(40_000)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(f.client.start('PC'), { code: 'invalid_response' });
  assert.equal(cancelled, true);
  assert.equal(f.timers.size, 0);
});

test('request timeout also covers an unresponsive response stream', async () => {
  let streamStarted;
  const started = new Promise(resolve => { streamStarted = resolve; });
  const f = fixture(() => new Response(new ReadableStream({ start() { streamStarted(); } })));
  const pending = f.client.start('PC');
  const rejected = assert.rejects(pending, { code: 'timeout' });
  await started;
  f.advance(15_000);
  await rejected;
  assert.equal(f.timers.size, 0);
});

test('expiry discards the key retained for a configuration retry', async () => {
  const f = fixture(url => { if (url.endsWith('/provider')) throw new Error('offline'); });
  const flow = await f.client.start('PC');
  f.advance(5000);
  await assert.rejects(f.client.poll(flow.flowId), { code: 'network' });
  f.advance(595_000);
  await assert.rejects(f.client.poll(flow.flowId), { code: 'expired' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.timers.size, 0);
});

test('request deadline rejects even if a fetch implementation ignores abort', async () => {
  const f = fixture(() => new Promise(() => {}));
  const pending = f.client.start('PC');
  const rejected = assert.rejects(pending, { code: 'timeout' });
  f.advance(15_000);
  await rejected;
  assert.equal(f.timers.size, 0);
});

test('unsupported API and malformed JSON never expose response text', async () => {
  for (const response of [new Response('private-body', { status: 404 }), new Response('{ invalid private-body')]) {
    const f = fixture(() => response);
    await assert.rejects(f.client.start('PC'), error => !error.message.includes('private-body') && !error.retryable);
    assert.equal(f.timers.size, 0);
  }
});

test('dispose aborts requests and prevents new ones', async () => {
  const f = fixture();
  const flow = await f.client.start('PC');
  f.client.dispose();
  await assert.rejects(f.client.poll(flow.flowId), { code: 'cancelled' });
  await assert.rejects(f.client.start('PC'), { code: 'cancelled' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});
