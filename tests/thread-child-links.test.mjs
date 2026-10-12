import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ThreadChildLinkStore } from '../electron/thread-child-links.mjs';
import { executorCountText, executorLabel, executorLabelLetter, executorLetter, nextExecutorLabel } from '../src/executor-agents.ts';

const cwd = path.resolve('C:/Fixtures/CHILD_PROJECT');
const parent = '01a12214-250e-7873-87c7-81c9c121b8be';
const child = '01a12212-e234-7ec0-b02a-ba4a18fd28c0';
const claudeChild = 'claude:11111111-2222-3333-4444-555555555555';
const otherChild = '01a1221f-aaaa-7ec0-b02a-ba4a18fd28c0';

test('child links store explicit Codex and Claude parent relations with selected model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-child-links-'));
  try {
    const store = new ThreadChildLinkStore(directory);
    const result = await store.create({ cwd, parentThreadId: parent, childThreadId: child, provider: 'codex', model: 'fixture-beta', effort: 'high' });
    assert.equal(result.link.parentThreadId, parent);
    assert.equal(result.link.model, 'fixture-beta');
    assert.equal(result.link.effort, 'high');
    await store.create({ cwd, parentThreadId: parent, childThreadId: claudeChild, provider: 'claude', model: 'claude-sonnet', effort: 'medium' });
    assert.deepEqual((await store.list(cwd)).map(link => link.childThreadId), [child, claudeChild]);
    const saved = JSON.parse(await readFile(path.join(directory, 'thread-child-links.json'), 'utf8'));
    assert.equal(saved.version, 1);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10 }); }
});

test('child link creation is idempotent and rejects self-relations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-child-links-'));
  try {
    const store = new ThreadChildLinkStore(directory);
    const options = { cwd, parentThreadId: parent, childThreadId: child, provider: 'codex', model: 'fixture-alpha', effort: 'low' };
    const first = await store.create(options);
    const second = await store.create({ ...options, model: 'other-model' });
    assert.equal(second.link.id, first.link.id);
    await assert.rejects(store.create({ ...options, childThreadId: parent }), /собственным родителем/);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10 }); }
});

test('executor label is stored, survives a reload and stays optional for older records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-child-links-'));
  try {
    const store = new ThreadChildLinkStore(directory);
    const stored = await store.create({ cwd, parentThreadId: parent, childThreadId: child, provider: 'codex', label: 'Агент A' });
    assert.equal(stored.link.label, 'Агент A');
    // A record written before the field existed keeps working and simply has no label.
    const legacy = await store.create({ cwd, parentThreadId: parent, childThreadId: claudeChild, provider: 'claude' });
    assert.equal(legacy.link.label, null);
    const file = path.join(directory, 'thread-child-links.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, 1, 'the label must not break the file version');
    assert.deepEqual(saved.links.map(link => link.label), ['Агент A', null]);
    // Restart: the row is rebuilt from the file, so the stored labels must come back as they are.
    const reopened = await new ThreadChildLinkStore(directory).list(cwd);
    assert.deepEqual(reopened.map(link => link.label), ['Агент A', null]);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10 }); }
});

test('executor label is validated: 200 characters pass, longer or multiline names are rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-child-links-'));
  try {
    const store = new ThreadChildLinkStore(directory);
    const limit = 'я'.repeat(200);
    assert.equal((await store.create({ cwd, parentThreadId: parent, childThreadId: child, provider: 'codex', label: limit })).link.label, limit);
    await assert.rejects(store.create({ cwd, parentThreadId: parent, childThreadId: otherChild, provider: 'codex', label: 'я'.repeat(201) }), /имя агента-исполнителя/);
    await assert.rejects(store.create({ cwd, parentThreadId: parent, childThreadId: otherChild, provider: 'codex', label: 'Агент\nA' }), /имя агента-исполнителя/);
    assert.deepEqual((await store.list(cwd)).map(link => link.childThreadId), [child], 'a rejected label must not add a link');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10 }); }
});

test('unlinking an executor drops only its own record and survives a reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-child-links-'));
  try {
    const store = new ThreadChildLinkStore(directory);
    await store.create({ cwd, parentThreadId: parent, childThreadId: child, provider: 'codex', label: 'Агент A' });
    await store.create({ cwd, parentThreadId: parent, childThreadId: claudeChild, provider: 'claude', label: 'Агент B' });
    const removed = await store.manage({ action: 'unlink', childThreadId: child });
    assert.equal(removed.changed, true);
    assert.equal(removed.link, null);
    // The sibling of the same parent keeps its own record: unlinking is never a cascade.
    assert.deepEqual((await store.list(cwd)).map(link => [link.childThreadId, link.label]), [[claudeChild, 'Агент B']]);
    // Unlinking twice is not an error and changes nothing the second time.
    assert.equal((await store.manage({ action: 'unlink', childThreadId: child })).changed, false);
    // Restart: the dropped link must not come back, so the dialog stays a plain one.
    assert.deepEqual((await new ThreadChildLinkStore(directory).list(cwd)).map(link => link.childThreadId), [claudeChild]);
    // A rename writes the new name into the link so the row and the next free letter agree.
    const renamed = await store.manage({ action: 'relabel', childThreadId: claudeChild, label: 'Рефакторинг парсера' });
    assert.equal(renamed.changed, true);
    assert.equal(renamed.link.label, 'Рефакторинг парсера');
    assert.deepEqual((await new ThreadChildLinkStore(directory).list(cwd)).map(link => link.label), ['Рефакторинг парсера']);
    await assert.rejects(store.manage({ action: 'relabel', childThreadId: claudeChild, label: 'я'.repeat(201) }), /имя агента-исполнителя/);
    await assert.rejects(store.manage({ action: 'merge', childThreadId: claudeChild }), /Неизвестная операция/);
    await assert.rejects(store.manage({ action: 'unlink', childThreadId: 'not-a-thread' }), /идентификатор диалога/);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10 }); }
});

test('default executor names walk the Latin letters and fill the first free one', () => {
  assert.equal(nextExecutorLabel([]), 'Агент A');
  assert.equal(nextExecutorLabel(['Агент A']), 'Агент B');
  assert.equal(nextExecutorLabel(['Агент A', 'Агент B', 'Агент C']), 'Агент D');
  // A closed or renamed executor frees its letter, and the next one reuses the first gap.
  assert.equal(nextExecutorLabel(['Агент A', 'Агент C']), 'Агент B');
  assert.equal(nextExecutorLabel(['Агент B', 'Агент A']), 'Агент C');
  // Titles that are not default names never consume a letter.
  assert.equal(nextExecutorLabel([null, undefined, '', 'Рефакторинг парсера', 'Агент', 'Агент 2', 'Агент AB!']), 'Агент A');
  assert.equal(nextExecutorLabel(['агент a']), 'Агент B', 'the stored name is matched regardless of case');
  // The sequence does not run out after Z.
  assert.equal(executorLetter(25), 'Z');
  assert.equal(executorLetter(26), 'AA');
  assert.equal(executorLetter(27), 'AB');
  assert.equal(executorLabel(0), 'Агент A');
  const alphabet = Array.from({ length: 26 }, (_, index) => executorLabel(index));
  assert.equal(nextExecutorLabel(alphabet), 'Агент AA');
  assert.equal(nextExecutorLabel([...alphabet, 'Агент AA']), 'Агент AB');
  assert.equal(executorLabelLetter('Агент D'), 'D');
  assert.equal(executorLabelLetter('Сабдиалог D'), '');
});

test('executor counts use Russian numerals', () => {
  assert.equal(executorCountText(1), '1 агент-исполнитель');
  assert.equal(executorCountText(2), '2 агента-исполнителя');
  assert.equal(executorCountText(5), '5 агентов-исполнителей');
  assert.equal(executorCountText(11), '11 агентов-исполнителей');
  assert.equal(executorCountText(21), '21 агент-исполнитель');
});
