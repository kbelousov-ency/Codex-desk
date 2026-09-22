import assert from 'node:assert/strict';
import test from 'node:test';
import { getTokenMetrics } from '../src/token-metrics.ts';

test('token metrics keep nested cache and reasoning subsets out of total arithmetic', () => {
  const usage = getTokenMetrics({
    last: { inputTokens: 10000, cachedInputTokens: 8000, cacheWriteInputTokens: 1500, outputTokens: 1000, reasoningOutputTokens: 700, totalTokens: 11000 },
    total: { inputTokens: 150000, cachedInputTokens: 120000, cacheWriteInputTokens: 25000, outputTokens: 15000, reasoningOutputTokens: 10000, totalTokens: 165000 },
    modelContextWindow: 200000,
  });
  assert.equal(usage.last.totalTokens, 11000);
  assert.equal(usage.last.uncachedInputTokens, 2000, 'uncached input includes writes');
  assert.equal(usage.last.ordinaryInputTokens, 500);
  assert.equal(usage.last.nonReasoningOutputTokens, 300);
  assert.equal(usage.last.cachedSharePercent, 80);
  assert.equal(usage.total.totalTokens, 165000);
  assert.equal(usage.total.ordinaryInputTokens, 5000);
  assert.equal(usage.lastInputContextPercent, 5, 'capacity proxy must use last input, never cumulative total');
  assert.deepEqual(usage.last.issues, []);
});

test('missing usage and missing fields stay unknown rather than becoming zero', () => {
  for (const source of [undefined, null, {}, [], 'invalid']) {
    const metrics = getTokenMetrics(source);
    assert.equal(metrics.last.totalTokens, null);
    assert.equal(metrics.total.inputTokens, null);
    assert.equal(metrics.last.uncachedInputTokens, null);
    assert.equal(metrics.last.cachedSharePercent, null);
    assert.equal(metrics.modelContextWindow, null);
    assert.equal(metrics.lastInputContextPercent, null);
  }
  const partial = getTokenMetrics({ last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 12 } });
  assert.equal(partial.last.uncachedInputTokens, 20);
  assert.equal(partial.last.cacheWriteInputTokens, null);
  assert.equal(partial.last.ordinaryInputTokens, null);
  assert.equal(partial.last.nonReasoningOutputTokens, null);
  assert.equal(partial.last.totalTokens, null, 'never invent the provider total');
  assert.deepEqual(partial.last.issues, []);
});

test('reported zero counts remain known while empty-input ratios are undefined', () => {
  const metrics = getTokenMetrics({ last: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, modelContextWindow: 100 });
  assert.equal(metrics.last.totalTokens, 0);
  assert.equal(metrics.last.ordinaryInputTokens, 0);
  assert.equal(metrics.last.uncachedInputTokens, 0);
  assert.equal(metrics.last.nonReasoningOutputTokens, 0);
  assert.equal(metrics.last.cachedSharePercent, null);
  assert.equal(metrics.lastInputContextPercent, 0);
});

test('invalid numbers do not propagate into counters or plausible-looking arithmetic', () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity, '20', false, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const metrics = getTokenMetrics({ last: { inputTokens: invalid, cachedInputTokens: 10, totalTokens: invalid }, modelContextWindow: invalid });
    assert.equal(metrics.last.inputTokens, null);
    assert.equal(metrics.last.totalTokens, null);
    assert.equal(metrics.last.uncachedInputTokens, null);
    assert.equal(metrics.last.cachedSharePercent, null);
    assert.equal(metrics.lastInputContextPercent, null);
    assert.deepEqual(metrics.last.issues, ['invalid_value']);
  }
});

test('contradictory cache and reasoning data are exposed without clamping to zero', () => {
  const metrics = getTokenMetrics({ last: { inputTokens: 100, cachedInputTokens: 120, cacheWriteInputTokens: 150, outputTokens: 20, reasoningOutputTokens: 21 } });
  assert.equal(metrics.last.cachedInputTokens, 120, 'preserve valid raw server counts for inspection');
  assert.equal(metrics.last.uncachedInputTokens, null);
  assert.equal(metrics.last.ordinaryInputTokens, null);
  assert.equal(metrics.last.cachedSharePercent, null);
  assert.equal(metrics.last.nonReasoningOutputTokens, null);
  assert.deepEqual(metrics.last.issues, ['cached_exceeds_input', 'cache_write_exceeds_input', 'cache_parts_exceed_input', 'reasoning_exceeds_output']);

  const overlap = getTokenMetrics({ last: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 30 } });
  assert.equal(overlap.last.uncachedInputTokens, 20, 'valid read-only difference does not depend on the write subset');
  assert.equal(overlap.last.ordinaryInputTokens, null, 'overlapping parts must not become a fabricated zero');
  assert.deepEqual(overlap.last.issues, ['cache_parts_exceed_input']);
});

test('context proxy retains percentages beyond capacity and does not use output totals', () => {
  const metrics = getTokenMetrics({ last: { inputTokens: 150, outputTokens: 90, totalTokens: 240 }, modelContextWindow: 100 });
  assert.equal(metrics.lastInputContextPercent, 150, 'visual bars may clamp their width, metrics must not');
  for (const capacity of [0, undefined, null]) {
    assert.equal(getTokenMetrics({ last: { inputTokens: 150 }, modelContextWindow: capacity }).lastInputContextPercent, null);
  }
});
