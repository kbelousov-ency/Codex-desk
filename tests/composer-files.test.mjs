import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { prepareComposerFiles, COMPOSER_FILE_LIMIT } from '../electron/composer-files.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const artifacts = path.resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, 'composer-files-'));
  assert.equal(path.dirname(base), artifacts);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, file: async (name, content = 'private content') => {
    const target = path.join(base, name);
    await writeFile(target, content);
    return target;
  } };
}

async function sparseImage(target, size) {
  const handle = await open(target, 'w');
  try { await handle.write(png); await handle.truncate(size); }
  finally { await handle.close(); }
}

test('native picker supports mixed files, Unicode and spaces, while ordinary files remain plain paths', async t => {
  const { file } = await fixture(t);
  const image = await file('Снимок экрана.PNG', png);
  const refs = await Promise.all(['Отчёт %20.pdf', 'Текст.txt', 'Данные.zip', 'app.exe', 'vector.svg', 'photo.avif'].map(name => file(name)));
  const result = await prepareComposerFiles([image, ...refs]);
  assert.deepEqual(result.images, [{ name: 'Снимок экрана.PNG', dataUrl: `data:image/png;base64,${png.toString('base64')}` }]);
  assert.deepEqual(result.paths, await Promise.all(refs.map(target => realpath(target))));
  assert.equal(result.message, undefined);
  assert.equal(JSON.stringify(result).includes('private content'), false);
});

test('native picker deduplicates canonical selections and accepts cancellation as an empty batch', async t => {
  const { base, file } = await fixture(t);
  const image = await file('one.png', png), ref = await file('report.pdf');
  await mkdir(path.join(base, 'nested'));
  const result = await prepareComposerFiles([image, ref, image, path.join(base, 'nested', '..', 'report.pdf')]);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.paths, [await realpath(ref)]);
  assert.deepEqual(await prepareComposerFiles([]), { images: [], paths: [] });
});

test('native picker keeps unsupported model image selections as visible paths without decoding or size limits', async t => {
  const { file } = await fixture(t);
  const broken = await file('not-an-image.jpg');
  const large = await file('large.png');
  await sparseImage(large, 20 * 1024 * 1024 + 1);
  const result = await prepareComposerFiles([broken, large], { imageSlots: 0, imagesSupported: false });
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.paths, await Promise.all([broken, large].map(target => realpath(target))));
  assert.match(result.message, /не принимает изображения.*пути/);
});

test('native picker accepts all supported image signatures and rejects mismatched or invalid content', async t => {
  const { file } = await fixture(t);
  const inputs = [
    ['valid.png', png, 'png'],
    ['valid.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'],
    ['valid.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'],
    ['valid.webp', Buffer.from('RIFFxxxxWEBP'), 'webp'],
    ['valid.gif', Buffer.from('GIF89a'), 'gif'],
  ];
  const paths = await Promise.all(inputs.map(([name, bytes]) => file(name, bytes)));
  const result = await prepareComposerFiles(paths);
  assert.deepEqual(result.images.map(image => image.dataUrl.split(';')[0]), inputs.map(([, , mime]) => `data:image/${mime}`));
  for (const [name, bytes] of [['bad.png', 'not an image'], ['wrong.jpg', png], ['short.gif', 'GIF89'], ['empty.webp', '']]) {
    await assert.rejects(prepareComposerFiles([paths[0], await file(name, bytes)]), /не является поддерживаемым изображением/);
  }
});

test('native picker rejects relative, network, device, invalid paths, directories and missing files', async t => {
  const { base } = await fixture(t);
  for (const target of ['', '.', 'relative.txt', null, 42, `${base}\nfile.txt`, '\\\\server\\share\\image.png', '\\\\?\\C:\\file.png', '\\\\.\\NUL', '//server/share/image.png']) {
    await assert.rejects(prepareComposerFiles([target]), /локальный файл/);
  }
  if (process.platform === 'win32') {
    for (const target of ['C:relative.txt', 'C:\\NUL', 'C:\\COM1.txt', 'C:\\COM¹.txt', 'C:\\name.txt:stream', 'C:\\name.', 'C:\\dir \\file.txt']) {
      await assert.rejects(prepareComposerFiles([target]), /локальный файл|служебные пути/);
    }
  }
  await assert.rejects(prepareComposerFiles([base]), /только обычные файлы/);
  await assert.rejects(prepareComposerFiles([path.join(base, 'missing.pdf')]), /не найден/);
});

test('native picker validates selection count and image budgets before reading selected files', async t => {
  const { file } = await fixture(t);
  for (const value of [null, undefined, {}, 'file']) await assert.rejects(prepareComposerFiles(value), /20 файлов/);
  await assert.rejects(prepareComposerFiles(Array(COMPOSER_FILE_LIMIT + 1).fill('invalid')), /20 файлов/);
  for (const imageSlots of [-1, 11, 0.1, NaN, Infinity, '1', null]) await assert.rejects(prepareComposerFiles([], { imageSlots }), /параметры/);
  for (const imagesSupported of [null, 0, 'true']) await assert.rejects(prepareComposerFiles([], { imagesSupported }), /параметры/);
  const first = await file('one.png', png), second = await file('two.png', png);
  await assert.rejects(prepareComposerFiles([first], { imageSlots: 0 }), /не больше 10 изображений/);
  await assert.rejects(prepareComposerFiles([first, second], { imageSlots: 1 }), /не больше 10 изображений/);
  assert.equal((await prepareComposerFiles([first], { imageSlots: 1 })).images.length, 1);
  const pdf = await file('large.pdf');
  await sparseImage(pdf, 20 * 1024 * 1024 + 1);
  assert.deepEqual((await prepareComposerFiles([pdf], { imageSlots: 0 })).paths, [await realpath(pdf)]);
  await sparseImage(first, 20 * 1024 * 1024 + 1);
  await assert.rejects(prepareComposerFiles([first]), /20 МБ/);
  const large = await Promise.all(Array.from({ length: 4 }, (_, i) => file(`large-${i}.png`)));
  for (const target of large) await sparseImage(target, 16 * 1024 * 1024);
  await assert.rejects(prepareComposerFiles(large), /60 МБ/);
});

test('native picker permits explicitly selected directory links to local ordinary file targets and deduplicates them', async t => {
  const { base, file } = await fixture(t);
  const original = await file('real.pdf');
  const alias = path.join(base, 'linked-dir');
  try { await symlink(base, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Directory links unavailable: ${error.code}`); return; }
    throw error;
  }
  assert.deepEqual((await prepareComposerFiles([path.join(alias, 'real.pdf'), original])).paths, [await realpath(original)]);
  await assert.rejects(prepareComposerFiles([alias]), /только обычные файлы/);
});

test('native picker drops stale sessions and fails image batches changed during their bounded read', async t => {
  const { file } = await fixture(t);
  const image = await file('one.png', png);
  for (const failAt of [1, 2, 3, 4, 5, 6]) {
    let checks = 0;
    await assert.rejects(prepareComposerFiles([image], { assertActive: () => {
      if (++checks === failAt) throw new Error('session changed');
    } }), /session changed/);
  }
  let checks = 0;
  await assert.rejects(prepareComposerFiles([image], { assertActive: () => {
    if (++checks === 5) writeFileSync(image, Buffer.concat([png, Buffer.from('changed')]));
  } }), /Файл изменился/);
});
