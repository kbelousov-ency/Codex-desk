import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeImage } from './host-utils.mjs';

export const COMPOSER_FILE_LIMIT = 20;
const IMAGE_LIMIT = 10;
const IMAGE_BYTES = 20 * 1024 * 1024;
const TOTAL_IMAGE_BYTES = 60 * 1024 * 1024;
const imageMime = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' };

function checkedLocalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)
    || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) {
    throw new Error('Выберите обычный локальный файл с абсолютным путём.');
  }
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || /[:<>"|?*]/.test(value.slice(2))) throw new Error('Сетевые и служебные пути не поддерживаются.');
    const parts = value.slice(3).split(/[\\/]/).filter(part => part && part !== '.' && part !== '..');
    if (parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw new Error('Сетевые и служебные пути не поддерживаются.');
    }
  }
  return value;
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const changedFile = () => new Error('Файл изменился во время добавления. Выберите его ещё раз.');

async function readImage(file, assertActive) {
  assertActive();
  const handle = await open(file.canonical, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(before, file.info)) throw changedFile();
    assertActive();
    // Explicitly bound reads: a growing file must never allocate unbounded data.
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      assertActive();
      if (!bytesRead) throw changedFile();
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat({ bigint: true });
    if (extra.bytesRead || !sameFile(before, after) || await realpath(file.selected) !== file.canonical
      || !sameFile(before, await stat(file.canonical, { bigint: true }))) throw changedFile();
    assertActive();
    const dataUrl = `data:image/${file.mime};base64,${bytes.toString('base64')}`;
    decodeImage({ dataUrl });
    return { name: path.basename(file.canonical), dataUrl };
  } finally { await handle.close(); }
}

/**
 * Accept only paths from the host's native picker/clipboard, never renderer paths.
 * Explicitly selected links resolve to their ordinary local target, including
 * targets outside the project. Non-image files are references: no content read,
 * copy, execution or model request. Batch failure never returns partial results.
 */
export async function prepareComposerFiles(filePaths, { imageSlots = IMAGE_LIMIT, imagesSupported = true, assertActive = () => {} } = {}) {
  if (!Array.isArray(filePaths) || filePaths.length > COMPOSER_FILE_LIMIT) throw new Error('За один раз можно выбрать не больше 20 файлов.');
  if (!Number.isSafeInteger(imageSlots) || imageSlots < 0 || imageSlots > IMAGE_LIMIT || typeof imagesSupported !== 'boolean') {
    throw new Error('Некорректные параметры добавления файлов.');
  }
  assertActive();
  const selected = [];
  const seen = new Set();
  try {
    for (const entry of filePaths) {
      checkedLocalPath(entry);
      const canonical = checkedLocalPath(await realpath(entry));
      assertActive();
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) continue;
      const info = await stat(canonical, { bigint: true });
      if (!info.isFile()) throw new Error('Добавлять можно только обычные файлы, без папок.');
      selected.push({ selected: entry, canonical, info, mime: imageMime[path.extname(canonical).toLowerCase()] });
      seen.add(key);
      assertActive();
    }
    const imageFiles = imagesSupported ? selected.filter(file => file.mime) : [];
    if (imageFiles.length > imageSlots) throw new Error('В одном сообщении можно добавить не больше 10 изображений. Удалите лишние изображения и повторите выбор.');
    if (imageFiles.some(file => file.info.size > BigInt(IMAGE_BYTES))) throw new Error('Размер одного изображения не должен превышать 20 МБ.');
    if (imageFiles.reduce((sum, file) => sum + file.info.size, 0n) > BigInt(TOTAL_IMAGE_BYTES)) throw new Error('Общий размер изображений не должен превышать 60 МБ.');
    const images = [];
    for (const file of imageFiles) images.push(await readImage(file, assertActive));
    assertActive();
    return {
      images,
      paths: selected.filter(file => !imagesSupported || !file.mime).map(file => file.canonical),
      ...(!imagesSupported && selected.some(file => file.mime)
        ? { message: 'Текущая модель не принимает изображения: добавлены пути к файлам.' } : {}),
    };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Выбранный файл не найден. Возможно, он был перемещён или удалён.');
    if (['EPERM', 'EACCES'].includes(error.code)) throw new Error('Нет доступа к выбранному файлу.');
    throw error;
  }
}
