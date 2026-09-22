import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalCacheActivity, responseTime } from '../src/cache-history.ts';

const now = Date.parse('2026-09-18T12:00:00Z');
const completed = (id, minutesAgo) => ({ id, status: 'completed', startedAt: now / 1000 - minutesAgo * 60 - 10, completedAt: now / 1000 - minutesAgo * 60, items: [{ type: 'agentMessage' }] });

test('history uses newest turn completion in the declared order, never opening time', () => {
  const older = completed('older', 70), recent = completed('recent', 20);
  assert.equal(historicalCacheActivity([older, recent], [], false, now), now - 20 * 60_000);
  assert.equal(historicalCacheActivity([recent, older], [], true, now), now - 20 * 60_000);
  assert.equal(historicalCacheActivity([older], [], false, now), now - 70 * 60_000, 'Expired is still an actual timestamp');
  assert.equal(historicalCacheActivity([], [], true, now), null);
});

test('missing, future and invalid historical timestamps never fabricate a fresh hour', () => {
  for (const invalid of [null, undefined, 0, -1, NaN, Infinity, '1789731000', now, now / 1000 + 1]) {
    assert.equal(responseTime(invalid, now), null);
    assert.equal(historicalCacheActivity([{ ...completed('recent', 20), completedAt: invalid }], [], false, now), null);
  }
  assert.equal(historicalCacheActivity([{ ...completed('recent', 20), startedAt: now / 1000 }], [], false, now), null);
});

test('failed, interrupted, active and compaction latest turns do not revive earlier success', () => {
  const older = completed('older', 50);
  for (const status of ['failed', 'interrupted', 'inProgress', 'unknown']) {
    assert.equal(historicalCacheActivity([older, { ...completed('recent', 20), status }], [], false, now), null);
  }
  assert.equal(historicalCacheActivity([{ ...older, error: { message: 'failed' } }], [], false, now), null);
  assert.equal(historicalCacheActivity([{ ...older, items: [{ type: 'contextCompaction' }] }], [], true, now), null);
  assert.equal(historicalCacheActivity([{ ...older, items: [], itemsView: 'notLoaded' }], [{ turnId: 'older', type: 'contextCompaction' }], true, now), null);
  assert.equal(historicalCacheActivity([{ ...older, items: [], itemsView: 'notLoaded' }], [], true, now), null, 'Incomplete items cannot prove a normal response');
  assert.equal(historicalCacheActivity([older], [{ turnId: 'unrelated', type: 'contextCompaction' }], true, now), older.completedAt * 1000);
});
