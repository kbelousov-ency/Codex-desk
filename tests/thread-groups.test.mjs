import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { ThreadGroupStore, groupThreadId } from '../electron/thread-groups.mjs';

const A = path.resolve('C:/Fixtures/PROJECT_A');
const B = path.resolve('C:/Fixtures/PROJECT_B');
const codex = '01a12214-250e-7873-87c7-81c9c121b8be';
const codex2 = '01a12212-e234-7ec0-b02a-ba4a18fd28c0';
const codex3 = '01a121fe-6302-75e3-a2cf-29676d4c6a70';
const claude = 'claude:11111111-2222-3333-4444-555555555555';

const fresh = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-groups-'));
  return { directory, store: new ThreadGroupStore(directory), cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 10 }) };
};
const read = async directory => JSON.parse(await readFile(path.join(directory, 'thread-groups.json'), 'utf8'));

test('a thread id may be a Codex uuid or a namespaced Claude id, and nothing else', () => {
  assert.equal(groupThreadId(codex), codex);
  assert.equal(groupThreadId(claude), claude);
  for (const bad of ['', 'not-a-uuid', 'claude:nope', 42, null, undefined, { id: codex }, `claude:${codex}x`, 'x'.repeat(200)]) {
    assert.throws(() => groupThreadId(bad), /Некорректный идентификатор диалога/);
  }
});

test('a group is created with a name, a folder and an optional root conversation', async () => {
  const { directory, store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: '  Рефакторинг панели  ', cwd: A, rootThreadId: codex });
    assert.match(group.id, /^g-[0-9a-f-]{36}$/);
    assert.equal(group.name, 'Рефакторинг панели', 'the name is trimmed');
    assert.equal(group.cwd, A);
    assert.equal(group.rootThreadId, codex);
    assert.deepEqual(group.members.map(member => member.threadId), [codex], 'the root is also a member');
    const stored = await read(directory);
    assert.equal(stored.version, 1);
    assert.equal(stored.groups.length, 1);
  } finally { await cleanup(); }
});

test('names and folders are validated, so nothing unusable reaches the file', async () => {
  const { store, cleanup } = await fresh();
  try {
    for (const name of ['', '   ', 'x'.repeat(101), 'две\nстроки', 'ноль\u0000']) {
      await assert.rejects(store.manage({ action: 'create', name, cwd: A }), /Название группы/);
    }
    for (const cwd of ['', 'relative/path', 42, null]) {
      await assert.rejects(store.manage({ action: 'create', name: 'Группа', cwd }), /рабочая папка/);
    }
    await assert.rejects(store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: 'nope' }), /идентификатор диалога/);
    await assert.rejects(store.manage({ action: 'nonsense' }), /Неизвестное действие/);
    await assert.rejects(store.manage('create'), /Некорректная операция/);
    assert.deepEqual(await store.list(), []);
  } finally { await cleanup(); }
});

test('Codex and Claude conversations join the same group', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Смешанная', cwd: A });
    await store.manage({ action: 'assign', groupId: group.id, threadId: codex });
    const { group: withClaude } = await store.manage({ action: 'assign', groupId: group.id, threadId: claude });
    assert.deepEqual(withClaude.members.map(member => member.threadId), [codex, claude]);
  } finally { await cleanup(); }
});

test('a conversation belongs to at most one group: assigning moves it', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group: first } = await store.manage({ action: 'create', name: 'Первая', cwd: A, rootThreadId: codex });
    const { group: second } = await store.manage({ action: 'create', name: 'Вторая', cwd: A });
    await store.manage({ action: 'assign', groupId: second.id, threadId: codex });
    const groups = await store.list();
    assert.deepEqual(groups.find(group => group.id === first.id).members, [], 'it left the first group');
    assert.equal(groups.find(group => group.id === first.id).rootThreadId, null, 'and stopped being its root');
    assert.deepEqual(groups.find(group => group.id === second.id).members.map(member => member.threadId), [codex]);
  } finally { await cleanup(); }
});

test('assigning the same conversation twice does not duplicate it', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A });
    await store.manage({ action: 'assign', groupId: group.id, threadId: codex });
    const { group: again } = await store.manage({ action: 'assign', groupId: group.id, threadId: codex });
    assert.deepEqual(again.members.map(member => member.threadId), [codex]);
  } finally { await cleanup(); }
});

test('a member can be promoted to root of its group', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A });
    await store.manage({ action: 'assign', groupId: group.id, threadId: codex, root: true });
    const { group: updated } = await store.manage({ action: 'assign', groupId: group.id, threadId: codex2 });
    assert.equal(updated.rootThreadId, codex);
    assert.deepEqual(updated.members.map(member => member.threadId), [codex, codex2]);
  } finally { await cleanup(); }
});

test('removing a conversation from a group leaves the conversation alone', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: codex });
    await store.manage({ action: 'assign', groupId: group.id, threadId: codex2 });
    await store.manage({ action: 'unassign', threadId: codex2 });
    const [stored] = await store.list();
    assert.deepEqual(stored.members.map(member => member.threadId), [codex], 'only the membership is gone');
    // Removing the root clears the root but keeps the group itself.
    await store.manage({ action: 'unassign', threadId: codex });
    const [after] = await store.list();
    assert.equal(after.rootThreadId, null);
    assert.deepEqual(after.members, []);
    assert.equal((await store.list()).length, 1, 'an empty group is not deleted behind the user');
  } finally { await cleanup(); }
});

test('unassigning an unknown conversation is a no-op and writes nothing', async () => {
  const { directory, store, cleanup } = await fresh();
  try {
    await store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: codex });
    const before = await readFile(path.join(directory, 'thread-groups.json'), 'utf8');
    const result = await store.manage({ action: 'unassign', threadId: codex3 });
    assert.deepEqual(result, { removedThreadId: codex3 });
    assert.equal(await readFile(path.join(directory, 'thread-groups.json'), 'utf8'), before);
  } finally { await cleanup(); }
});

test('deleting a group removes the grouping only', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: codex });
    const result = await store.manage({ action: 'delete', groupId: group.id });
    assert.deepEqual(result, { removedGroupId: group.id });
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.manage({ action: 'delete', groupId: group.id }), /Группа не найдена/);
    await assert.rejects(store.manage({ action: 'rename', groupId: group.id, name: 'Новая' }), /Группа не найдена/);
    await assert.rejects(store.manage({ action: 'assign', groupId: group.id, threadId: codex }), /Группа не найдена/);
  } finally { await cleanup(); }
});

test('renaming validates the new name and keeps the members', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Старое', cwd: A, rootThreadId: codex });
    await assert.rejects(store.manage({ action: 'rename', groupId: group.id, name: '  ' }), /Название группы/);
    const { group: renamed } = await store.manage({ action: 'rename', groupId: group.id, name: 'Новое' });
    assert.equal(renamed.name, 'Новое');
    assert.deepEqual(renamed.members.map(member => member.threadId), [codex]);
  } finally { await cleanup(); }
});

test('groups are listed per folder and the whole set is available', async () => {
  const { store, cleanup } = await fresh();
  try {
    await store.manage({ action: 'create', name: 'A-группа', cwd: A });
    await store.manage({ action: 'create', name: 'B-группа', cwd: B });
    assert.deepEqual((await store.list(A)).map(group => group.name), ['A-группа']);
    assert.deepEqual((await store.list(B)).map(group => group.name), ['B-группа']);
    assert.equal((await store.list()).length, 2);
    if (process.platform === 'win32') assert.deepEqual((await store.list(A.toUpperCase())).map(group => group.name), ['A-группа'], 'Windows folders match without case');
  } finally { await cleanup(); }
});

test('a deleted conversation is forgotten by every group', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: codex });
    await store.manage({ action: 'assign', groupId: group.id, threadId: codex2 });
    assert.equal(await store.forget([codex, codex3]), true);
    const [stored] = await store.list();
    assert.equal(stored.rootThreadId, null);
    assert.deepEqual(stored.members.map(member => member.threadId), [codex2]);
    assert.equal(await store.forget([codex3]), false, 'an unknown id changes nothing');
    assert.equal(await store.forget([]), false);
  } finally { await cleanup(); }
});

test('the file is written atomically and leaves no temporary behind', async () => {
  const { directory, store, cleanup } = await fresh();
  try {
    await store.manage({ action: 'create', name: 'Группа', cwd: A });
    const files = await readdir(directory);
    assert.deepEqual(files, ['thread-groups.json']);
  } finally { await cleanup(); }
});

test('a damaged or foreign file is reported and never overwritten', async () => {
  for (const content of ['{ not json', JSON.stringify({ version: 2, groups: [] }), JSON.stringify({ version: 1, groups: {} }), JSON.stringify({ version: 1, groups: [{ id: 'nope', name: 'x', cwd: A }] })]) {
    const { directory, store, cleanup } = await fresh();
    try {
      const file = path.join(directory, 'thread-groups.json');
      await writeFile(file, content);
      await assert.rejects(store.list(), /thread-groups\.json/);
      await assert.rejects(store.manage({ action: 'create', name: 'Группа', cwd: A }), /thread-groups\.json/);
      assert.equal(await readFile(file, 'utf8'), content, 'the damaged file is kept for recovery');
    } finally { await cleanup(); }
  }
});

test('a missing file simply means there are no groups yet', async () => {
  const { store, cleanup } = await fresh();
  try { assert.deepEqual(await store.list(), []); } finally { await cleanup(); }
});

test('saved groups survive a fresh store over the same folder', async () => {
  const { directory, store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A, rootThreadId: codex });
    await store.manage({ action: 'assign', groupId: group.id, threadId: claude });
    const reopened = new ThreadGroupStore(directory);
    const [stored] = await reopened.list();
    assert.equal(stored.name, 'Группа');
    assert.equal(stored.rootThreadId, codex);
    assert.deepEqual(stored.members.map(member => member.threadId), [codex, claude]);
  } finally { await cleanup(); }
});

test('concurrent operations are serialized without losing any of them', async () => {
  const { store, cleanup } = await fresh();
  try {
    const { group } = await store.manage({ action: 'create', name: 'Группа', cwd: A });
    await Promise.all([codex, codex2, codex3, claude].map(threadId => store.manage({ action: 'assign', groupId: group.id, threadId })));
    const [stored] = await store.list();
    assert.deepEqual(stored.members.map(member => member.threadId).sort(), [codex, codex2, codex3, claude].sort());
  } finally { await cleanup(); }
});
