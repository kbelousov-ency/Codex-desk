import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BookmarkStore } from '../electron/bookmarks.mjs';

const cwd = path.resolve('bookmark-project');
const threadId = '01911111-1111-7111-8111-111111111111';
const data = (itemId = 'message', extra = {}) => ({ provider: 'codex', cwd, threadId, itemId, turnId: 'turn', threadName: 'Решение', excerpt: 'Полезный ответ\nс командой', label: 'Моя подпись', ...extra });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bookmarks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new BookmarkStore(directory) };
}

test('bookmarks persist a bounded excerpt, source IDs and custom label across restarts without reading history', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  const saved = await store.save(data('message', { excerpt: 'я'.repeat(5000), archived: true }));
  const restored = await new BookmarkStore(directory).list({ cwd, provider: 'all' });
  assert.deepEqual(restored, [saved]);
  assert.equal(saved.excerpt.length, 4000);
  assert.equal(saved.label, 'Моя подпись');
  assert.equal(saved.archived, true);
  assert.equal(saved.turnId, 'turn');
  assert.deepEqual(await readdir(directory), ['bookmarks.json']);
});

test('duplicate message saves update one bookmark and do not mix agent or project filters', async t => {
  const { store } = await fixture(t);
  const first = await store.save(data());
  const second = await store.save(data('message', { label: '  Изменено  ', excerpt: 'Новый фрагмент' }));
  const claude = await store.save(data('message', { provider: 'claude', threadId: `claude:${threadId}` }));
  const other = await store.save(data('other', { cwd: path.resolve('other-bookmark-project') }));
  assert.equal(first.id, second.id);
  assert.equal(first.createdAt, second.createdAt);
  assert.equal(second.label, 'Изменено');
  const { label: _label, ...unlabeled } = data('message', { excerpt: 'Новый фрагмент' });
  const repeated = await store.save(unlabeled);
  assert.equal(repeated.label, 'Изменено', 'saving from a message again preserves the user label');
  assert.deepEqual(await store.list({ cwd, provider: 'codex' }), [repeated]);
  assert.deepEqual(await store.list({ provider: 'claude' }), [claude]);
  assert.equal((await store.list()).length, 3);
  assert.deepEqual(await store.remove(first.id), { removed: true });
  assert.deepEqual(await store.remove(first.id), { removed: false });
  assert.equal((await store.list()).some(item => item.id === other.id), true);
  await assert.rejects(store.save({ ...second, label: 'Resurrect' }), /удалена/);
});

test('simultaneous saves through two windows preserve all other bookmarks', async t => {
  const { directory, store } = await fixture(t), another = new BookmarkStore(directory);
  const items = await Promise.all(Array.from({ length: 30 }, (_, n) => (n % 2 ? store : another).save(data(`message-${n}`))));
  assert.equal((await store.list()).length, 30);
  await Promise.all(items.map((item, n) => n % 2 ? store.remove(item.id) : another.save({ ...item, label: 'Updated' })));
  const remaining = await store.list();
  assert.equal(remaining.length, 15);
  assert.ok(remaining.every(item => item.label === 'Updated'));
  assert.deepEqual(await readdir(directory), ['bookmarks.json']);
});

test('flush waits for accepted writes and later caller mutations do not change queued contents', async t => {
  const { directory, store } = await fixture(t);
  const payload = data(), pending = store.save(payload);
  payload.excerpt = 'Changed after enqueue';
  payload.label = 'Changed after enqueue';
  await store.flush();
  const disk = JSON.parse(await readFile(path.join(directory, 'bookmarks.json'), 'utf8'));
  assert.equal(disk.bookmarks[0].excerpt, 'Полезный ответ\nс командой');
  assert.equal(disk.bookmarks[0].label, 'Моя подпись');
  await pending;
});

test('corrupt and newer-format stores are preserved; writes resume after external recovery', async t => {
  const { directory, store } = await fixture(t), filename = path.join(directory, 'bookmarks.json');
  const saved = await store.save(data());
  const valid = await readFile(filename, 'utf8');
  for (const invalid of ['{broken-json', JSON.stringify({ version: 2, bookmarks: [saved] }), JSON.stringify({ version: 1, bookmarks: [saved, saved] })]) {
    await writeFile(filename, invalid);
    await assert.rejects(store.list(), /сохранён без изменений/);
    await assert.rejects(store.save(data('next')), /сохранён без изменений/);
    await assert.rejects(store.remove(saved.id), /сохранён без изменений/);
    assert.equal(await readFile(filename, 'utf8'), invalid);
  }
  await writeFile(filename, valid);
  assert.equal((await store.list())[0].id, saved.id);
  await store.save({ ...saved, label: 'Recovered' });
  assert.equal((await store.list())[0].label, 'Recovered');
});

test('validation and mismatched updates never change the saved file', async t => {
  const { directory, store } = await fixture(t);
  const first = await store.save(data());
  const original = await readFile(path.join(directory, 'bookmarks.json'), 'utf8');
  for (const invalid of [data('', {}), data('x', { threadId: '../other' }), data('x', { provider: 'claude' }),
    data('x', { provider: 'other' }), data('x', { cwd: 'relative' }), data('x', { label: 'x'.repeat(201) }),
    data('x', { excerpt: 'null\0' }), data('x', { archived: 'yes' })]) {
    assert.throws(() => store.save(invalid));
  }
  await assert.rejects(store.save({ ...first, itemId: 'different' }), /перенести/);
  await assert.rejects(store.save({ ...first, cwd: path.resolve('different') }), /перенести/);
  assert.throws(() => store.remove('invalid'));
  assert.throws(() => store.list({ cwd: 'relative' }));
  assert.throws(() => store.list({ provider: 'other' }));
  assert.equal(await readFile(path.join(directory, 'bookmarks.json'), 'utf8'), original);
});
