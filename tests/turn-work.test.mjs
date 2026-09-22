import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHistoricalTurnWork, observeTurnWork, readTurnWork } from '../src/turn-work.ts';

test('turn timing converts server seconds and prefers precise server duration', () => {
  assert.deepEqual(readTurnWork({ id: 'turn', status: 'completed', startedAt: 1700000000, completedAt: 1700000302, durationMs: 302125 }), {
    id: 'turn', status: 'completed', startedAt: 1700000000000, completedAt: 1700000302000, durationMs: 302125,
  });
  assert.equal(readTurnWork({ id: 'turn', startedAt: 100, completedAt: 103 }).durationMs, 3000);
});

test('old history never acquires a fabricated duration', () => {
  assert.deepEqual(readTurnWork({ id: 'old', status: 'completed', startedAt: null, completedAt: null, durationMs: null }), { id: 'old', status: 'completed' });
  assert.deepEqual(readTurnWork({ id: 'old', status: 'failed', startedAt: NaN, completedAt: Infinity, durationMs: -1 }), { id: 'old', status: 'failed' });
  assert.equal(readTurnWork({ id: 'zero', status: 'completed', durationMs: 0 }).durationMs, 0);
});

test('live observations time the turn once and retain final-answer boundary', () => {
  let work = observeTurnWork(undefined, { id: 'live', status: 'inProgress' }, 10000);
  work = observeTurnWork(work, { id: 'live', status: 'inProgress' }, 11000);
  assert.equal(work.startedAt, 10000);
  work = { ...work, answerStartedAt: 14000 };
  work = observeTurnWork(work, { id: 'live', status: 'completed' }, 16000);
  assert.deepEqual(work, { id: 'live', status: 'completed', startedAt: 10000, answerStartedAt: 14000, completedAt: 16000, durationMs: 6000 });
  assert.deepEqual(observeTurnWork(work, { id: 'live', status: 'inProgress' }, 18000), work, 'late start RPC cannot restart a finished timer');
  assert.deepEqual(observeTurnWork(work, { id: 'live', status: 'completed' }, 19000), work, 'duplicate completion without timing retains its original end and duration');
  const precise = observeTurnWork(work, { id: 'live', status: 'completed', durationMs: 6001 }, 19000);
  assert.deepEqual(observeTurnWork(precise, { id: 'live', status: 'completed' }, 21000), precise, 'precise server duration survives a duplicate completion');
});

test('resume timing cannot overwrite a newer completion or answer boundary', () => {
  const live = { id: 'live', status: 'completed', startedAt: 10000, completedAt: 15000, durationMs: 5000, answerStartedAt: 14000 };
  const merged = mergeHistoricalTurnWork({ live }, [{ id: 'live', status: 'inProgress', startedAt: 10 }, { id: 'old', status: 'interrupted', durationMs: 1234 }]);
  assert.deepEqual(merged.live, live);
  assert.deepEqual(merged.old, { id: 'old', status: 'interrupted', durationMs: 1234 });
});

test('interruption records observed end while lost connections cannot restart on delayed reply', () => {
  const started = observeTurnWork(undefined, { id: 'live', status: 'inProgress' }, 10000);
  const interrupted = observeTurnWork(started, { id: 'live', status: 'interrupted' }, 12000);
  assert.equal(interrupted.durationMs, 2000);
  const disconnected = { ...started, status: 'disconnected' };
  assert.deepEqual(observeTurnWork(disconnected, { id: 'live', status: 'inProgress' }, 12000), disconnected);
  assert.equal(disconnected.durationMs, undefined);
});
