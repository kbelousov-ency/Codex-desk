import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeArchiveStore } from '../electron/claude-archive.mjs';

const id = 'claude:aaaaaaaa-1111-2222-3333-444444444444';
const other = 'claude:bbbbbbbb-1111-2222-3333-444444444444';
const cwd = path.resolve(process.platform === 'win32' ? 'C:/Projects/demo' : '/projects/demo');
const outside = path.resolve(process.platform === 'win32' ? 'C:/Projects/other' : '/projects/other');
const store = async () => new ClaudeArchiveStore(await mkdtemp(path.join(tmpdir(), 'claude-archive-')));

test('an absent file is an empty archive, not an error', async () => {
  const archive = await store();
  assert.deepEqual(await archive.list(), []);
  assert.deepEqual([...await archive.ids(cwd)], []);
  assert.equal(await archive.has(id), false);
  assert.equal(await archive.find(id), null);
});

test('entries survive a new store instance and keep the dialog snapshot', async () => {
  const archive = await store();
  await archive.add({ id, cwd, name: 'План', preview: 'Первый вопрос', updatedAt: 1700000000, createdAt: 1699000000 });
  const reopened = new ClaudeArchiveStore(archive.userData);
  const [entry] = await reopened.list();
  assert.equal(entry.id, id);
  assert.equal(entry.name, 'План');
  assert.equal(entry.preview, 'Первый вопрос');
  assert.equal(entry.updatedAt, 1700000000);
  assert.equal(entry.createdAt, 1699000000);
  assert.ok(Number.isSafeInteger(entry.archivedAt));
  const saved = JSON.parse(await readFile(path.join(archive.userData, 'claude-archive.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.threads.length, 1);
});

test('ids are scoped to one project folder and archiving twice keeps a single entry', async () => {
  const archive = await store();
  await archive.add({ id, cwd, name: '' });
  await archive.add({ id, cwd, name: 'Переименован' });
  await archive.add({ id: other, cwd: outside, name: '' });
  assert.equal((await archive.list()).length, 2);
  assert.deepEqual([...await archive.ids(cwd)], [id]);
  assert.deepEqual([...await archive.ids(outside)], [other]);
  assert.deepEqual([...await archive.ids()].sort(), [id, other].sort());
  assert.equal((await archive.find(id)).name, 'Переименован');
});

test('folder comparison ignores case on Windows and trailing separators everywhere', async () => {
  const archive = await store();
  await archive.add({ id, cwd: `${cwd}${path.sep}`, name: '' });
  assert.deepEqual([...await archive.ids(cwd)], [id]);
  if (process.platform === 'win32') assert.deepEqual([...await archive.ids(cwd.toUpperCase())], [id]);
});

test('remove reports whether an entry was present and leaves the rest intact', async () => {
  const archive = await store();
  await archive.add({ id, cwd, name: '' });
  await archive.add({ id: other, cwd, name: '' });
  assert.equal(await archive.remove(id), true);
  assert.equal(await archive.remove(id), false);
  assert.deepEqual((await archive.list()).map(entry => entry.id), [other]);
});

test('list is ordered newest first by the dialog time, falling back to the archiving time', async () => {
  const archive = await store();
  await archive.add({ id, cwd, name: 'Старый', updatedAt: 1000 });
  await archive.add({ id: other, cwd, name: 'Новый', updatedAt: 2000 });
  assert.deepEqual((await archive.list()).map(entry => entry.name), ['Новый', 'Старый']);
});

test('foreign ids, relative folders and Codex ids are rejected', async () => {
  const archive = await store();
  await assert.rejects(archive.add({ id: 'aaaaaaaa-1111-2222-3333-444444444444', cwd }), /идентификатор/);
  await assert.rejects(archive.add({ id: 'claude:not-a-uuid', cwd }), /идентификатор/);
  await assert.rejects(archive.add({ id, cwd: 'relative/path' }), /папка/);
  assert.deepEqual(await archive.list(), []);
});

test('a damaged file is reported instead of being silently emptied or overwritten', async () => {
  const archive = await store();
  const file = path.join(archive.userData, 'claude-archive.json');
  await writeFile(file, '{ not json');
  await assert.rejects(archive.list(), /claude-archive\.json/);
  await assert.rejects(archive.add({ id, cwd }), /claude-archive\.json/);
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'the damaged file is left for the user to fix');
});

test('a schema from another version is refused rather than migrated in place', async () => {
  const archive = await store();
  await writeFile(path.join(archive.userData, 'claude-archive.json'), JSON.stringify({ version: 2, threads: [] }));
  await assert.rejects(archive.list(), /claude-archive\.json/);
});

test('writing leaves no temporary files behind', async () => {
  const archive = await store();
  await archive.add({ id, cwd, name: '' });
  await archive.remove(id);
  assert.deepEqual(await readdir(archive.userData), ['claude-archive.json']);
});
