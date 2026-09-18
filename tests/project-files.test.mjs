import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { FILE_PAGE_SIZE, listProjectFiles } from '../electron/project-files.mjs';

async function fixture(t) {
  const artifacts = path.resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, 'project-files-'));
  assert.equal(path.dirname(base), artifacts);
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'Проект с пробелами');
  await mkdir(cwd);
  return { base, cwd };
}

test('files tree lists only immediate children, directories first with natural order and visible dotfiles', async t => {
  const { cwd } = await fixture(t);
  await Promise.all(['Каталог 10', 'Каталог 2', '.git'].map(name => mkdir(path.join(cwd, name))));
  await Promise.all(['file10.txt', 'file2.txt', 'Пример %20.txt', '.gitignore'].map(name => writeFile(path.join(cwd, name), name)));
  await writeFile(path.join(cwd, 'Каталог 2', 'Вложенный файл.txt'), 'inside');
  const root = await listProjectFiles({ cwd });
  assert.equal(root.path, '');
  assert.equal(root.nextCursor, null);
  assert.deepEqual(root.entries.slice(0, 3).map(entry => [entry.name, entry.type]), [['.git', 'directory'], ['Каталог 2', 'directory'], ['Каталог 10', 'directory']]);
  assert.equal(root.entries.length, 7);
  assert.ok(root.entries.find(entry => entry.name === '.gitignore'));
  assert.ok(root.entries.find(entry => entry.name === 'Пример %20.txt'));
  assert.ok(root.entries.findIndex(entry => entry.name === 'file2.txt') < root.entries.findIndex(entry => entry.name === 'file10.txt'));
  const child = await listProjectFiles({ cwd, relativePath: 'Каталог 2' });
  assert.deepEqual(child, { path: 'Каталог 2', entries: [{ name: 'Вложенный файл.txt', path: 'Каталог 2/Вложенный файл.txt', type: 'file' }], nextCursor: null });
});

test('large directories page without duplicates and empty directories return an empty final page', async t => {
  const { cwd } = await fixture(t);
  const total = FILE_PAGE_SIZE + 3;
  await Promise.all(Array.from({ length: total }, (_, index) => writeFile(path.join(cwd, `файл ${index}.txt`), 'test')));
  const first = await listProjectFiles({ cwd });
  assert.equal(first.entries.length, FILE_PAGE_SIZE);
  assert.equal(first.nextCursor, FILE_PAGE_SIZE);
  const second = await listProjectFiles({ cwd, cursor: first.nextCursor });
  assert.equal(second.entries.length, 3);
  assert.equal(second.nextCursor, null);
  const combined = [...first.entries, ...second.entries];
  assert.equal(new Set(combined.map(entry => entry.path)).size, total);
  assert.equal(combined[0].name, 'файл 0.txt');
  assert.equal(combined.at(-1).name, `файл ${total - 1}.txt`);
  await mkdir(path.join(cwd, 'empty'));
  assert.deepEqual(await listProjectFiles({ cwd, relativePath: 'empty' }), { path: 'empty', entries: [], nextCursor: null });
});

test('tree rejects absolute paths, parent traversal, invalid cursors and non-directories', async t => {
  const { base, cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'file.txt'), 'test');
  for (const relativePath of ['..', '../', 'inside/../../outside', 'inside\\..\\outside', base, 'C:\\Windows', '\\\\server\\share', 'file.txt:stream', '\u0000', null, 42]) {
    await assert.rejects(listProjectFiles({ cwd, relativePath }), undefined, String(relativePath));
  }
  for (const cursor of [-1, 0.2, NaN, Infinity, '500', null, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(listProjectFiles({ cwd, cursor }), /страница/);
  await assert.rejects(listProjectFiles({ cwd, relativePath: 'file.txt' }), /не является папкой/);
  await assert.rejects(listProjectFiles({ cwd, relativePath: 'missing' }), /не найдена/);
  await assert.rejects(listProjectFiles({ cwd: path.join(cwd, 'missing') }), /недоступна/);
});

test('links are shown but cannot be expanded into another project or loop back to the root', async t => {
  const { base, cwd } = await fixture(t);
  const outside = path.join(base, 'Другой проект');
  await mkdir(outside);
  await mkdir(path.join(cwd, 'inside'));
  await writeFile(path.join(outside, 'private.txt'), 'private');
  try {
    await symlink(outside, path.join(cwd, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(cwd, path.join(cwd, 'root-loop'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(cwd, 'inside'), path.join(cwd, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Directory links unavailable: ${error.code}`); return; }
    throw error;
  }
  const tree = await listProjectFiles({ cwd });
  for (const relativePath of ['outside-link', 'root-loop', 'inside-link']) {
    assert.equal(tree.entries.find(entry => entry.name === relativePath)?.type, 'link');
    await assert.rejects(listProjectFiles({ cwd, relativePath }), /Ссылки на папки/);
  }
  await assert.rejects(listProjectFiles({ cwd, relativePath: 'outside-link/private.txt' }), /Ссылки на папки/);
});

test('closed or changed sessions do not receive a directory response', async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'file.txt'), 'test');
  let checks = 0;
  await assert.rejects(listProjectFiles({ cwd, assertActive: () => {
    if (++checks === 2) throw new Error('session changed');
  } }), /session changed/);
  assert.equal(checks, 2);
});
