import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { searchProjectFiles, readProjectFile, FILE_SEARCH_PAGE_SIZE, FILE_TEXT_LIMIT, FILE_IMAGE_LIMIT } from '../electron/file-viewer.mjs';

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'codex-file-viewer-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const cwd = path.join(parent, 'project');
  await mkdir(cwd);
  return { cwd, parent, write: async (name, data) => {
    const target = path.join(cwd, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  } };
}

test('project file search uses literal case-insensitive paths, excludes generated dependency internals, and paginates', async t => {
  const { cwd, write } = await fixture(t);
  await write('src/Русское имя.ts', 'const value = 1;');
  await write('.git/private.txt', 'not searched');
  await write('node_modules/dependency.js', 'not searched');
  await write('docs/project.md', '# docs');
  await write('dist/useful.txt', 'can still preview generated files');
  assert.deepEqual((await searchProjectFiles({ cwd, query: 'SRC русское' })).files, [{ path: 'src/Русское имя.ts', name: 'Русское имя.ts' }]);
  assert.equal((await searchProjectFiles({ cwd, query: '.*' })).files.length, 0);
  const initial = await searchProjectFiles({ cwd });
  assert.equal(initial.files.length, 3);
  assert.equal(initial.truncated, false);
  await Promise.all(Array.from({ length: 205 }, (_, i) => write(`many/file-${String(i).padStart(3, '0')}.txt`, String(i))));
  const first = await searchProjectFiles({ cwd, query: 'many/' });
  const last = await searchProjectFiles({ cwd, query: 'many/', cursor: first.nextCursor });
  assert.equal(first.files.length, FILE_SEARCH_PAGE_SIZE);
  assert.equal(last.files.length, 5);
  assert.equal(new Set([...first.files, ...last.files].map(file => file.path)).size, 205);
  assert.equal(last.nextCursor, null);
});

test('file preview reads UTF-8, UTF-16, Markdown and image signatures without modifying the file', async t => {
  const { cwd, write } = await fixture(t);
  const source = 'const hello = "Привет";\r\n// second line\r\n';
  await write('src/app.ts', source);
  await write('docs/readme.md', '# Привет\n<script>window.injection = true</script>');
  await write('utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('Unicode пример', 'utf16le')]));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CfkAAAAASUVORK5CYII=', 'base64');
  await write('icon.png', image);
  assert.deepEqual(await readProjectFile({ cwd, path: 'src/app.ts' }), { path: 'src/app.ts', kind: 'text', text: source, language: 'TypeScript', truncated: false });
  assert.equal((await readProjectFile({ cwd, path: 'docs/readme.md' })).kind, 'markdown');
  assert.equal((await readProjectFile({ cwd, path: 'utf16.txt' })).text, 'Unicode пример');
  assert.deepEqual(await readProjectFile({ cwd, path: 'icon.png' }), { path: 'icon.png', kind: 'image', dataUrl: `data:image/png;base64,${image.toString('base64')}` });
  assert.equal(await readFile(path.join(cwd, 'src/app.ts'), 'utf8'), source);
});

test('HTML/SVG stay text, fake image extension and binary encodings do not become executable content', async t => {
  const { cwd, write } = await fixture(t);
  await write('file.svg', '<svg onload="alert(1)"/>');
  await write('file.html', '<script>alert(1)</script>');
  await write('false.png', '<svg onload="alert(1)"/>');
  await write('binary.pdf', Buffer.from([37, 80, 68, 70, 0, 1, 2]));
  await write('invalid.txt', Buffer.from([0xc0, 0xaf]));
  for (const file of ['file.svg', 'file.html', 'false.png']) assert.equal((await readProjectFile({ cwd, path: file })).kind, 'text');
  for (const file of ['binary.pdf', 'invalid.txt']) assert.equal((await readProjectFile({ cwd, path: file })).kind, 'unsupported');
});

test('large text preview is bounded and does not corrupt a split UTF-8 sequence; large images are rejected', async t => {
  const { cwd, write } = await fixture(t);
  await write('large.txt', 'x'.repeat(FILE_TEXT_LIMIT - 1) + 'Жtail');
  const result = await readProjectFile({ cwd, path: 'large.txt' });
  assert.equal(result.kind, 'text');
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, FILE_TEXT_LIMIT - 1);
  assert.ok(!result.text.includes('�'));
  const image = Buffer.alloc(FILE_IMAGE_LIMIT + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  await write('large.png', image);
  assert.equal((await readProjectFile({ cwd, path: 'large.png' })).kind, 'unsupported');
});

test('preview rejects absolute, traversal, device, ADS and non-file paths', async t => {
  const { cwd, parent, write } = await fixture(t);
  await write('inside.txt', 'safe');
  await writeFile(path.join(parent, 'outside.txt'), 'outside');
  for (const target of ['../outside.txt', '..\\outside.txt', '/outside.txt', 'C:\\outside.txt', '\\\\server\\share', 'inside.txt:secret', 'NUL', 'con.txt', 'inside.txt\0', 'inside.txt ']) {
    await assert.rejects(readProjectFile({ cwd, path: target }));
  }
  await assert.rejects(readProjectFile({ cwd, path: 'missing.txt' }), /не найден/i);
  await mkdir(path.join(cwd, 'folder'));
  await assert.rejects(readProjectFile({ cwd, path: 'folder' }), /не является файлом/i);
  await assert.rejects(searchProjectFiles({ cwd, query: 'bad\nquery' }));
  await assert.rejects(searchProjectFiles({ cwd, cursor: '-1' }));
});

test('directory junctions and links never escape the project or create traversal loops', async t => {
  const { cwd, parent, write } = await fixture(t);
  await write('inside.txt', 'inside');
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, path.join(cwd, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(cwd, path.join(cwd, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Directory symlinks unavailable');
    throw error;
  }
  assert.deepEqual((await searchProjectFiles({ cwd })).files.map(file => file.path), ['inside.txt']);
  await assert.rejects(readProjectFile({ cwd, path: 'external/secret.txt' }), /ссылки|ссылок/);
  await assert.rejects(readProjectFile({ cwd, path: 'loop/inside.txt' }), /ссылки|ссылок/);
});

test('stale session cancels both file search and preview before returning content', async t => {
  const { cwd, write } = await fixture(t);
  await write('inside.txt', 'private content');
  let checks = 0;
  await assert.rejects(readProjectFile({ cwd, path: 'inside.txt', assertActive() { if (++checks > 1) throw new Error('stale session'); } }), /stale session/);
  checks = 0;
  await assert.rejects(searchProjectFiles({ cwd, assertActive() { if (++checks > 1) throw new Error('stale session'); } }), /stale session/);
});

test('preview rejects a file changed during bounded reading', async t => {
  const { cwd, write } = await fixture(t);
  await write('changing.txt', 'original content');
  let checks = 0;
  await assert.rejects(readProjectFile({ cwd, path: 'changing.txt', assertActive() {
    if (++checks === 3) writeFileSync(path.join(cwd, 'changing.txt'), 'a different content with another size');
  } }), /изменился во время чтения/);
});
