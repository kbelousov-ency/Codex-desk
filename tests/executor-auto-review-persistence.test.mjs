import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureUpdateCheckpoint, validateStoredCheckpoint } from '../electron/update-checkpoint.mjs';
import { captureWorkspaceState, createWorkspaceState } from '../electron/workspace-state.mjs';

const cwd = path.resolve('fixture-executor-project');
const session = (provider = 'codex') => ({ currentCwd: cwd, getSettings: () => ({ provider, cwd, executable: 'trusted-cli', access: 'workspace-write' }) });
const sessions = provider => new Map([['parent-session', session(provider)]]);
const review = () => ({
  parent: { cwd, provider: 'codex', threadId: 'parent-thread', token: 'discard' }, enabled: true,
  roundId: 'round-1', revision: 4,
  members: [
    { id: 'member-a', threadId: 'child-thread', label: 'Агент A', turnId: 'turn-a', status: 'completed', result: 'Готовый результат', pending: false, transcript: 'discard' },
    { id: 'member-b', label: 'Агент B', status: 'excluded', error: 'Исключён пользователем' },
  ],
  delivery: { id: 'delivery-1', roundId: 'round-1', revision: 3, text: 'Проверь результаты исполнителей.', status: 'reserved', secret: 'discard' },
  notice: 'Ожидает проверки', secret: 'discard',
});
const snapshot = () => ({ version: 1, activeIndex: 0, tabs: [{
  sessionId: 'parent-session', thread: { id: 'parent-thread', cwd: 'untrusted' }, settings: { provider: 'codex', cwd: 'untrusted' },
  draft: 'Черновик родителя', attachments: [], executorAutoReview: review(),
}] });
const capture = value => captureWorkspaceState(value, sessions());

test('review reservation is durably uncertain and disabled, retaining exact receipt identity and reports', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-executor-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceState(directory);
  const source = snapshot();
  const captured = capture(source);
  const state = captured.tabs[0].executorAutoReview;
  assert.equal(state.enabled, false);
  assert.deepEqual(state.parent, { cwd, provider: 'codex', threadId: 'parent-thread' });
  assert.deepEqual(state.delivery, { id: 'delivery-1', roundId: 'round-1', revision: 3, text: 'Проверь результаты исполнителей.', status: 'uncertain' });
  assert.equal(state.members[0].result, 'Готовый результат');
  assert.equal(state.members[1].status, 'excluded');
  assert.equal(source.tabs[0].executorAutoReview.delivery.status, 'reserved', 'Capture does not mutate live state');
  assert.equal(source.tabs[0].executorAutoReview.enabled, true);
  assert.ok(!JSON.stringify(captured).includes('discard'));
  await store.save(captured);
  const disk = JSON.parse(await readFile(path.join(directory, 'workspace-state.json'), 'utf8'));
  assert.deepEqual(disk, captured);
  assert.deepEqual(await store.read(), captured);
  assert.equal(disk.tabs[0].draft, 'Черновик родителя');
});

test('idle, waiting, uncertain and sent review states restore without authorizing new work', () => {
  for (const status of [undefined, 'reserved', 'uncertain', 'sent']) {
    const source = snapshot();
    if (status === undefined) delete source.tabs[0].executorAutoReview.delivery;
    else source.tabs[0].executorAutoReview.delivery.status = status;
    const captured = captureUpdateCheckpoint(source, sessions());
    const restored = validateStoredCheckpoint(captured).tabs[0].executorAutoReview;
    assert.equal(restored.enabled, false);
    assert.equal(restored.delivery?.status, status === 'reserved' ? 'uncertain' : status);
  }
  const source = snapshot();
  source.tabs[0].executorAutoReview = { parent: review().parent, enabled: false, roundId: '', revision: 0, members: [] };
  assert.deepEqual(capture(source).tabs[0].executorAutoReview, { parent: { cwd, provider: 'codex', threadId: 'parent-thread' }, enabled: false, roundId: '', revision: 0, members: [] });
});

test('a newer child round retains the frozen earlier delivery until its acknowledgement is reconciled', () => {
  for (const status of ['uncertain', 'sent']) {
    const source = snapshot();
    const state = source.tabs[0].executorAutoReview;
    state.roundId = 'round-2';
    state.revision = 5;
    state.members = [{ id: 'member-a', threadId: 'child-thread', label: 'Агент A', turnId: 'turn-new', status: 'running' }];
    state.delivery.status = status;
    const restored = validateStoredCheckpoint(capture(source)).tabs[0].executorAutoReview;
    assert.equal(restored.roundId, 'round-2');
    assert.equal(restored.members[0].turnId, 'turn-new');
    assert.deepEqual(restored.delivery, { id: 'delivery-1', roundId: 'round-1', revision: 3, text: 'Проверь результаты исполнителей.', status });
    assert.equal(restored.enabled, false);
  }
});

test('review owner is checked against host cwd, selected thread and host provider, despite forged renderer settings', () => {
  for (const mutate of [
    tab => { tab.executorAutoReview.parent.threadId = 'other-thread'; },
    tab => { tab.executorAutoReview.parent.cwd = path.resolve('other-project'); tab.cwd = tab.executorAutoReview.parent.cwd; tab.settings.cwd = tab.cwd; },
    tab => { tab.executorAutoReview.parent.provider = 'claude'; tab.settings.provider = 'claude'; },
    tab => { delete tab.thread; },
  ]) {
    const source = snapshot(); mutate(source.tabs[0]);
    assert.throws(() => capture(source), /другому диалогу/);
  }
  const claude = snapshot();
  claude.tabs[0].thread.id = 'claude:parent';
  claude.tabs[0].executorAutoReview.parent = { cwd, provider: 'claude', threadId: 'claude:parent' };
  const stored = captureUpdateCheckpoint(claude, sessions('claude'));
  assert.equal(stored.tabs[0].executorAutoReview.parent.provider, 'claude');
  assert.equal(stored.tabs[0].settings.provider, 'claude');
  for (const mutate of [
    tab => { tab.executorAutoReview.parent.threadId = 'other-thread'; },
    tab => { tab.executorAutoReview.parent.cwd = path.resolve('other-project'); },
    tab => { tab.executorAutoReview.parent.provider = 'claude'; },
  ]) {
    const stored = capture(snapshot()); mutate(stored.tabs[0]);
    assert.throws(() => validateStoredCheckpoint(stored), /другому диалогу/);
  }
});

test('strict review shape rejects malformed statuses, ids, booleans, revisions and oversized payloads', () => {
  const invalid = [
    state => { state.enabled = 'true'; },
    state => { state.roundId = 'r'.repeat(257); },
    state => { state.revision = -1; },
    state => { state.revision = 1.5; },
    state => { state.members = Array.from({ length: 101 }, (_, i) => ({ id: `m-${i}`, label: 'A', status: 'waiting' })); },
    state => { state.members.push({ ...state.members[0] }); },
    state => { state.members[0].id = ''; },
    state => { state.members[0].threadId = 'a'.repeat(257); },
    state => { state.members[0].turnId = ''; },
    state => { state.members[0].status = 'disconnected'; },
    state => { state.members[0].pending = 1; },
    state => { state.members[0].label = 'a'.repeat(257); },
    state => { state.members[0].result = 'a'.repeat(100_001); },
    state => { state.members[0].error = 'a'.repeat(4001); },
    state => { state.delivery.id = ''; },
    state => { state.delivery.status = 'retry'; },
    state => { state.delivery.roundId = ''; },
    state => { state.delivery.revision = 5; },
    state => { state.delivery.text = 'a'.repeat(2_000_001); },
    state => { state.notice = 'a'.repeat(4001); },
  ];
  for (const mutate of invalid) {
    const source = snapshot(); mutate(source.tabs[0].executorAutoReview);
    assert.throws(() => capture(source), undefined, mutate.toString());
  }
  const source = snapshot();
  source.tabs[0].executorAutoReview.members = Array.from({ length: 100 }, (_, i) => ({ id: `member-${i}`, label: 'A', status: 'waiting' }));
  source.tabs[0].executorAutoReview.members[0].result = 'r'.repeat(100_000);
  source.tabs[0].executorAutoReview.members[0].error = 'e'.repeat(4000);
  source.tabs[0].executorAutoReview.delivery.text = 't'.repeat(2_000_000);
  assert.equal(capture(source).tabs[0].executorAutoReview.members.length, 100);
});

test('executor parent and label survive host capture and disk restore even before its first thread', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-executor-draft-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = snapshot();
  source.tabs.push({ sessionId: 'draft-session', childOf: 'parent-thread', childLabel: 'Агент C', draft: 'Ещё не отправленное поручение', attachments: [] });
  const hostSessions = sessions(); hostSessions.set('draft-session', session());
  const captured = captureWorkspaceState(source, hostSessions);
  const store = createWorkspaceState(directory);
  await store.save(captured);
  const draft = (await store.read()).tabs[1];
  assert.equal(draft.thread, undefined);
  assert.equal(draft.childOf, 'parent-thread');
  assert.equal(draft.childLabel, 'Агент C');
  assert.equal(draft.draft, 'Ещё не отправленное поручение');
  source.tabs[1].thread = { id: 'child-thread' };
  assert.equal(captureWorkspaceState(source, hostSessions).tabs[1].childOf, 'parent-thread');
  source.tabs[1].childOf = 'child-thread';
  assert.throws(() => captureWorkspaceState(source, hostSessions), /самого себя/);
  delete source.tabs[1].childOf;
  assert.throws(() => captureWorkspaceState(source, hostSessions), /нет родительского/);
});

test('archive and ordinary tabs do not acquire auto-review work or executor metadata', () => {
  const source = snapshot();
  delete source.tabs[0].executorAutoReview;
  source.tabs.push({ archivedThread: { id: 'archived', cwd }, draft: '', attachments: [], childOf: 'parent-thread', childLabel: 'A', executorAutoReview: review() });
  const stored = capture(source);
  assert.equal(stored.tabs[0].executorAutoReview, undefined);
  assert.equal(stored.tabs[1].executorAutoReview, undefined);
  assert.equal(stored.tabs[1].childOf, undefined);
  assert.equal(stored.tabs[1].childLabel, undefined);
});
