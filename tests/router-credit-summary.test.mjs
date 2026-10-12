import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readRouterCreditSummary } from '../electron/router-credit-summary.mjs';

const now = '2026-10-12T09:12:00.000Z';
const quota = { provider: 'codex', available: true, limit_credits: 32_000, used_credits: 800.25, reset_at: '2026-10-19T03:00:00Z' };
const turns = credits => ({ totals: { credits, calls: 1 }, sources: { core: true, ledger: true }, turns: [{ credits }] });
const ok = value => ({ ok: true, value });

function fixture({ quotaValue = quota, today = turns(100), bySession = {}, portal, error } = {}) {
  const calls = [];
  const routerClient = { async requestJson(path, key) {
    calls.push({ path, key });
    const url = new URL(path, 'https://router.example.test');
    if (error) return error;
    if (url.pathname.endsWith('/limit/agents')) return ok(quotaValue);
    const session = url.searchParams.get('session');
    return ok(session ? bySession[session] || turns(0) : today);
  } };
  const portalClient = { async read(key) { assert.equal(key, 'secret'); return portal; } };
  return { calls, read: extra => readRouterCreditSummary({ routerClient, portalClient, apiKey: 'secret', now, ...extra }) };
}

test('credit summary uses exact quota and full totals, preserving fractional credits', async () => {
  const { calls, read } = fixture({ bySession: { root: turns(1.25), child: turns(2.75) } });
  const result = await read({ threadIds: ['root', 'child', 'root', '', ' child '] });
  assert.equal(result.provider, 'codex');
  assert.equal(result.available, true);
  assert.equal(result.limits[0].limitCredits, 32_000);
  assert.equal(result.limits[0].remainingCredits, 31_199.75);
  assert.equal(result.limits[0].usedCredits, 800.25);
  assert.equal(result.limits[0].resetAt, '2026-10-19T03:00:00.000Z');
  assert.deepEqual(result.spend.session, { credits: 4, threadCount: 2 });
  assert.equal(result.spend.today.credits, 100);
  assert.equal(calls.length, 4);
  for (const { path, key } of calls) {
    assert.equal(key, 'secret');
    assert.doesNotMatch(path, /secret/);
    assert.equal(new URL(path, 'https://router.example.test').searchParams.get('provider'), 'codex');
  }
  for (const { path } of calls.filter(call => call.path.includes('session='))) {
    const params = new URL(path, 'https://router.example.test').searchParams;
    assert.equal(params.has('since'), false);
    assert.equal(params.has('until'), false);
    assert.equal(params.get('limit'), '1');
  }
});

test('Claude uses its own quota, provider filter and Fable, never the Codex portal row', async () => {
  const { read, calls } = fixture({ quotaValue: { ...quota, provider: 'claude', limit_credits: 24_000, used_credits: 6000 },
    portal: { available: true, limits: [{ name: 'Codex', limitCredits: 99 }, { name: 'Claude', left: 1, bands: [
      { name: 'Fable', left: 25, resetAt: '2026-10-19T03:00:00Z' }, { name: 'Other', left: 70 },
    ] }] } });
  const result = await read({ provider: 'claude' });
  assert.equal(result.limits[0].limitCredits, 24_000);
  assert.equal(result.limits[0].left, 75);
  assert.equal(result.limits[0].bands.length, 1);
  assert.equal(result.limits[0].bands[0].name, 'Fable');
  assert.equal(result.limits[0].bands[0].left, 25);
  assert.ok(calls.every(call => call.path.includes('provider=claude')));
});

test('unknown, negative and nonfinite amounts never become zero or a daily substitute', async () => {
  for (const invalid of [null, undefined, '', false, [], {}, 'invalid', -1, Infinity, NaN]) {
    const { read } = fixture({ quotaValue: { ...quota, limit_credits: invalid, used_credits: invalid }, today: turns(invalid) });
    const result = await read();
    assert.equal(result.limits[0].limitCredits, null);
    assert.equal(result.limits[0].usedCredits, null);
    assert.equal(result.limits[0].remainingCredits, null);
    assert.equal(result.spend.today.credits, null);
    assert.equal(result.spend.today.partial, true);
    assert.ok(result.limitReason);
  }
});

test('real zeros, a zero quota, and overspend retain their distinct meanings', async () => {
  const zero = await fixture({ quotaValue: { ...quota, limit_credits: 0, used_credits: 0 }, today: turns(0) }).read();
  assert.equal(zero.limits[0].remainingCredits, 0);
  assert.equal(zero.limits[0].left, null);
  assert.deepEqual(zero.spend.session, { credits: 0, threadCount: 0 });
  assert.equal(zero.spend.today.credits, 0);
  assert.equal(zero.spend.today.partial, undefined);
  const over = await fixture({ quotaValue: { ...quota, limit_credits: 10, used_credits: 12 } }).read();
  assert.equal(over.limits[0].remainingCredits, 0);
  assert.equal(over.limits[0].usedPercent, 120);
  assert.equal(over.limits[0].left, 0);
  const huge = await fixture({ quotaValue: { ...quota, limit_credits: Number.MIN_VALUE, used_credits: Number.MAX_VALUE } }).read();
  assert.equal(huge.limits[0].usedPercent, null);
});

test('incomplete sources cannot produce an authoritative zero', async () => {
  for (const sources of [false, undefined, {}, { core: false, ledger: true }, { core: true, ledger: false }]) {
    const result = await fixture({ today: { ...turns(0), sources } }).read();
    assert.equal(result.spend.today.credits, null);
    assert.equal(result.spend.today.partial, true);
  }
  const positive = await fixture({ today: { ...turns(3), sources: { core: false, ledger: true } } }).read();
  assert.equal(positive.spend.today.credits, 3);
  assert.equal(positive.spend.today.partial, true);
  const bool = await fixture({ today: { ...turns(0), sources: true } }).read();
  assert.equal(bool.spend.today.credits, 0);
  assert.equal(bool.spend.today.partial, undefined);
});

test('Claude and session queries do not depend on the unrelated Codex ledger', async () => {
  const result = await fixture({ quotaValue: { ...quota, provider: 'claude' },
    today: { ...turns(0), sources: { core: true, ledger: false } },
    bySession: { root: { ...turns(0), sources: { core: true, ledger: false } } },
  }).read({ provider: 'claude', threadIds: ['root'] });
  assert.equal(result.spend.today.credits, 0);
  assert.deepEqual(result.spend.session, { credits: 0, threadCount: 1 });
});

test('NULL prices and incomplete coverage are visible even when SUM returned zero', async () => {
  const unpriced = await fixture({ today: { ...turns(0), turns: [{ credits: null }] } }).read();
  assert.equal(unpriced.spend.today.credits, null);
  assert.match(unpriced.spend.today.reason, /кредитах/);
  const partial = await fixture({ today: { ...turns(3), coverage: { core: { complete: false } } } }).read();
  assert.equal(partial.spend.today.credits, 3);
  assert.equal(partial.spend.today.partial, true);
});

test('partial child session keeps the known sum and marks it incomplete', async () => {
  const result = await fixture({ bySession: { root: turns(4.25), child: { ...turns(0), sources: false } } }).read({ threadIds: ['root', 'child'] });
  assert.equal(result.spend.session.credits, 4.25);
  assert.equal(result.spend.session.partial, true);
  assert.equal(result.spend.session.threadCount, 2);
});

test('existing UUID without journal matches is unknown, while observed zero-cost calls and a new dialog stay zero', async () => {
  const empty = { totals: { credits: 0, calls: 0 }, sources: { core: true, ledger: true }, turns: [] };
  const unknown = await fixture({ bySession: { expired: empty } }).read({ threadIds: ['expired'] });
  assert.equal(unknown.spend.session.credits, null);
  assert.equal(unknown.spend.session.partial, true);
  assert.equal(unknown.spend.session.reason, 'В журнале нет данных этого диалога.');
  const observed = await fixture({ bySession: { free: turns(0) } }).read({ threadIds: ['free'] });
  assert.deepEqual(observed.spend.session, { credits: 0, threadCount: 1 });
  const fresh = await fixture().read({ threadIds: [] });
  assert.deepEqual(fresh.spend.session, { credits: 0, threadCount: 0 });
  const today = await fixture({ today: empty }).read();
  assert.equal(today.spend.today.credits, 0);
  assert.equal(today.spend.today.partial, undefined);
});

test('session totals require a valid count before zero can be trusted', async () => {
  for (const calls of [undefined, null, false, -1, Infinity, 1.5, 'bad']) {
    const result = await fixture({ bySession: { root: { ...turns(0), totals: { credits: 0, calls } } } }).read({ threadIds: ['root'] });
    assert.equal(result.spend.session.credits, null);
    assert.equal(result.spend.session.partial, true);
    assert.match(result.spend.session.reason, /число запросов/);
  }
});

test('portal fallback keeps only the own product and does not invent credit totals from percentages', async () => {
  const result = await fixture({ quotaValue: { available: false }, portal: { available: true, limits: [
    { name: 'Codex', limitCredits: 32_000, usedCredits: 9000 }, { name: 'Claude', left: 80, resetAt: '2026-10-19T03:00:00Z' },
  ] } }).read({ provider: 'claude' });
  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].name, 'Claude');
  assert.equal(result.limits[0].left, 80);
  assert.equal(result.limits[0].limitCredits, null);
  assert.ok(result.limitReason);
  const missing = await fixture({ quotaValue: { ...quota, provider: 'codex' }, portal: { available: true, limits: [{ name: 'Codex', left: 70 }] } }).read({ provider: 'claude' });
  assert.deepEqual(missing.limits, []);
});

test('new absolute portal fallback remains authoritative without adding ledger or bonuses twice', async () => {
  const result = await fixture({ quotaValue: { available: false }, portal: { available: true, limits: [
    { name: 'Codex', available: true, limitCredits: 100, usedCredits: 10, remainingCredits: 3, ledgerUsedCredits: 999, bonusCredits: 25 },
  ] } }).read();
  assert.equal(result.limits[0].limitCredits, 100);
  assert.equal(result.limits[0].usedCredits, 10);
  assert.equal(result.limits[0].remainingCredits, 90);
});

test('request values are encoded and session concurrency is bounded', async () => {
  const ids = ['id&provider=claude', 'id?x=# /Ю', ...Array.from({ length: 9 }, (_, index) => `child${index}`)];
  let active = 0, maximum = 0;
  const seen = [];
  const result = await readRouterCreditSummary({ apiKey: 'secret', now, threadIds: [...ids, ids[0]],
    routerClient: { async requestJson(path) {
      const url = new URL(path, 'https://router.example.test');
      assert.equal(url.searchParams.get('provider'), 'codex');
      if (url.pathname.endsWith('/limit/agents')) return ok(quota);
      if (!url.searchParams.has('session')) return ok(turns(20));
      seen.push(url.searchParams.get('session'));
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return ok(turns(1));
    } },
  });
  assert.deepEqual(seen, ids);
  assert.ok(maximum <= 4);
  assert.ok(maximum > 1);
  assert.equal(result.spend.session.credits, ids.length);
});

test('today starts at local calendar midnight, including both DST transition days', () => {
  const script = `import { readRouterCreditSummary } from './electron/router-credit-summary.mjs';
    const results = [];
    for (const now of ['2026-03-29T12:00:00Z','2026-10-25T12:00:00Z']) {
      const result = await readRouterCreditSummary({ apiKey:'secret', now, routerClient:{requestJson:async()=>({ok:false})} });
      results.push(result.spend.today.since);
    }
    process.stdout.write(JSON.stringify(results));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: 'Europe/Berlin' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['2026-03-28T23:00:00.000Z', '2026-10-24T22:00:00.000Z']);
});

test('missing keys and unsupported providers cannot trigger clients or expose private errors', async () => {
  const never = { requestJson() { assert.fail('network'); }, read() { assert.fail('network'); } };
  for (const extra of [{ apiKey: '' }, { apiKey: 'secret\ninvalid' }, { apiKey: 'secret', provider: 'other' }]) {
    const result = await readRouterCreditSummary({ routerClient: never, portalClient: never, now, ...extra });
    assert.equal(result.available, false);
    assert.equal(result.spend.today.credits, null);
  }
  const result = await fixture({ error: { ok: false, reason: 'secret leaked body' } }).read({ threadIds: ['root'] });
  assert.equal(result.available, false);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
