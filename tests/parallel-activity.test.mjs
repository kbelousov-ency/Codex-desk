import assert from 'node:assert/strict';
import test from 'node:test';
import { activityPath, collectActiveChangedFiles, parallelActivity } from '../src/parallel-activity.ts';

const session = (id, extra = {}) => ({ id, cwd: 'C:/Projects/Shared', title: id, threadId: `thread-${id}`, busy: true, changedFiles: ['src/App.tsx'], ...extra });
const work = { old: { id: 'old', status: 'completed' }, current: { id: 'current', status: 'inProgress' } };
const change = (id, extra = {}) => ({ id, type: 'fileChange', turnId: 'current', status: 'completed', changes: [{ path: `${id}.ts` }], ...extra });

test('same Windows folder ignores slashes, case, dot segments; worktrees remain separate', () => {
  const activity = parallelActivity([session('a'), session('b', { cwd: 'c:\\projects\\shared\\.\\src\\..\\', changedFiles: ['C:\\PROJECTS\\SHARED\\src\\app.tsx'] }), session('worktree', { cwd: 'C:/Projects/Shared-task' })], 'a');
  assert.deepEqual(activity.sessions.map(item => item.id), ['a', 'b']);
  assert.deepEqual(activity.overlaps, [{ path: 'C:/Projects/Shared/src/App.tsx', label: 'src/App.tsx', sessionIds: ['a', 'b'] }]);
  assert.equal(parallelActivity([session('a'), session('worktree', { cwd: 'C:/Projects/Shared-task' })], 'a'), null);
  assert.equal(activityPath('C:/../'), 'C:/');
  assert.equal(activityPath('\\\\server\\share\\folder\\..\\'), '//server/share');
  assert.equal(activityPath('\\\\?\\UNC\\server\\share\\..\\src'), '//server/share/src');
  assert.equal(activityPath('\\\\?\\C:\\project\\.\\src'), 'C:/project/src');
});

test('historical, denied, failed and merely proposed edits never enter current activity', () => {
  const items = [change('old', { turnId: 'old' }), change('failed', { status: 'failed' }), change('declined', { status: 'declined' }), change('proposed', { status: 'inProgress' }), change('unknown', { status: undefined, complete: true }), change('unscoped', { turnId: undefined }), change('applied'), change('command', { type: 'commandExecution' })];
  assert.deepEqual(collectActiveChangedFiles(items, work, true), ['applied.ts']);
  assert.deepEqual(collectActiveChangedFiles(items, work, false), []);
  assert.deepEqual(collectActiveChangedFiles(items, { ...work, current: { id: 'current', status: 'completed' } }, true), []);
  assert.deepEqual(collectActiveChangedFiles([change('malformed', { changes: {} })], work, true), []);
});

test('both ends of a successful rename participate; one turn cannot conflict with itself', () => {
  const paths = collectActiveChangedFiles([change('renamed', { changes: [{ path: 'src/old.ts', kind: { type: 'update', move_path: 'src/new.ts' } }] })], work, true);
  assert.deepEqual(paths, ['src/old.ts', 'src/new.ts']);
  const activity = parallelActivity([session('a', { changedFiles: [...paths, 'src/OLD.ts'] }), session('b', { changedFiles: ['src/new.ts'] })], 'a');
  assert.equal(activity.overlaps.length, 1);
  assert.equal(activity.overlaps[0].label, 'src/new.ts');
  assert.deepEqual(activity.overlaps[0].sessionIds, ['a', 'b']);
});

test('duplicate views of a conversation and archived tabs do not create parallel tasks', () => {
  assert.equal(parallelActivity([session('a'), session('copy', { threadId: 'thread-a' }), session('archived', { archived: true })], 'a'), null);
  const activity = parallelActivity([session('a'), session('b', { busy: false }), session('b-live', { threadId: 'thread-b' }), session('b-copy', { threadId: 'thread-b' })], 'a');
  assert.deepEqual(activity.sessions.map(item => item.id), ['a', 'b-live']);
  assert.deepEqual(activity.overlaps[0].sessionIds, ['a', 'b-live']);
  assert.equal(parallelActivity([session('a', { archived: true }), session('b')], 'a'), null);
  assert.equal(parallelActivity([session('a', { cwd: '' }), session('b', { cwd: '' })], 'a'), null);
});

test('completed, loading and terminal-owned sessions stay visible without active overlaps', () => {
  for (const extra of [{ busy: false }, { loading: true }, { terminalOpen: true }, { changedFiles: [] }]) {
    const activity = parallelActivity([session('a'), session('b', extra)], 'a');
    assert.equal(activity.sessions.length, 2);
    assert.deepEqual(activity.overlaps, []);
  }
});

test('idle active tab can reveal overlaps between two other running conversations', () => {
  const activity = parallelActivity([session('idle', { busy: false, threadId: undefined }), session('a'), session('b'), session('other-agent', { threadId: 'thread-a', provider: 'claude', changedFiles: ['readme.md'] })], 'idle');
  assert.equal(activity.sessions.length, 4);
  assert.deepEqual(activity.overlaps[0].sessionIds, ['a', 'b']);
});
