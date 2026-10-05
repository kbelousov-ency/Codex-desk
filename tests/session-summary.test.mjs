import assert from 'node:assert/strict';
import test from 'node:test';
import { sameSessionSummary } from '../src/session-summary.ts';

const base = () => ({
  cwd: 'E:/project', title: 'Диалог', threadId: 'thread-1', initialized: true, terminalOpen: false,
  busy: true, loading: false, connection: 'ready', pending: 0, pendingDelivery: false,
  changedFiles: ['src/a.ts', 'src/b.ts'], settings: { model: 'gpt-5', effort: 'high', access: 'workspace-write' },
});

test('a repeated report is recognised even with fresh objects and arrays', () => {
  assert.equal(sameSessionSummary(base(), base()), true);
  assert.equal(sameSessionSummary(undefined, base()), false);
});

test('any visible change is reported as different', () => {
  assert.equal(sameSessionSummary(base(), { ...base(), busy: false }), false);
  assert.equal(sameSessionSummary(base(), { ...base(), title: 'Другой' }), false);
  assert.equal(sameSessionSummary(base(), { ...base(), pending: 1 }), false);
  assert.equal(sameSessionSummary(base(), { ...base(), changedFiles: ['src/a.ts'] }), false);
  assert.equal(sameSessionSummary(base(), { ...base(), changedFiles: ['src/b.ts', 'src/a.ts'] }), false);
  assert.equal(sameSessionSummary(base(), { ...base(), settings: { model: 'gpt-5', effort: 'low', access: 'workspace-write' } }), false);
});

test('an absent flag equals an explicit false', () => {
  const previous = base(); delete previous.pendingDelivery;
  assert.equal(sameSessionSummary(previous, base()), true);
  const withoutFiles = { ...base(), changedFiles: undefined };
  assert.equal(sameSessionSummary(withoutFiles, { ...base(), changedFiles: [] }), true);
});
