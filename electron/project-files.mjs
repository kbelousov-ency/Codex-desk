import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const FILE_PAGE_SIZE = 500;
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function checkedRelative(value) {
  if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Некорректный путь к папке.');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes(':')) throw new Error('Нужен путь внутри рабочей папки.');
  const parts = value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error('Папка находится за пределами выбранного проекта.');
  return parts;
}

/** Lists one directory, never recursively. Paths stay relative to this session. */
export async function listProjectFiles({ cwd, relativePath = '', cursor = 0, assertActive = () => {} }) {
  const parts = checkedRelative(relativePath);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Некорректная страница файлов.');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Сначала выберите рабочую папку.');
  assertActive();
  let root;
  try { root = await realpath(cwd); }
  catch { throw new Error('Рабочая папка недоступна. Выберите существующую папку проекта.'); }
  let requested = root;
  try {
    // Directory links are visible but not traversable, including links back to
    // the root. This prevents both cross-project access and expansion loops.
    for (const part of parts) {
      requested = path.resolve(requested, part);
      if (!contains(root, requested)) throw new Error('Папка находится за пределами выбранного проекта.');
      if ((await lstat(requested)).isSymbolicLink()) throw new Error('Ссылки на папки не раскрываются в дереве.');
    }
    const canonical = await realpath(requested);
    if (!contains(root, canonical)) throw new Error('Папка находится за пределами выбранного проекта.');
    if (!(await stat(canonical)).isDirectory()) throw new Error('Выбранный путь не является папкой.');
    const relative = parts.join('/');
    const entries = (await readdir(canonical, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      .map(entry => ({
        name: entry.name,
        path: relative ? `${relative}/${entry.name}` : entry.name,
        type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
      }))
      .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory')
        || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    assertActive();
    return {
      path: relative,
      entries: entries.slice(cursor, cursor + FILE_PAGE_SIZE),
      nextCursor: cursor + FILE_PAGE_SIZE < entries.length ? cursor + FILE_PAGE_SIZE : null,
    };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Папка не найдена. Возможно, она была перемещена или удалена.');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('Нет доступа к этой папке.');
    throw error;
  }
}
