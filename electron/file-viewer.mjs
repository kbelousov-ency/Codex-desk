import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const FILE_SEARCH_PAGE_SIZE = 200;
export const FILE_TEXT_LIMIT = 1024 * 1024;
export const FILE_IMAGE_LIMIT = 20 * 1024 * 1024;
const SEARCH_ENTRY_LIMIT = 40000;
const SEARCH_DIRECTORY_LIMIT = 3000;
const ignoredDirectories = new Set(['.git', 'node_modules']);
const languages = { js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', css: 'CSS', json: 'JSON', html: 'HTML', htm: 'HTML', svg: 'SVG', sh: 'Shell', ps1: 'PowerShell', yaml: 'YAML', yml: 'YAML', toml: 'TOML', rs: 'Rust', go: 'Go', cpp: 'C++', cs: 'C#' };
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function relativeParts(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f\x7f:]/.test(value)
    || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Нужен путь к файлу внутри рабочей папки.');
  const parts = value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('Файл находится за пределами выбранного проекта.');
  if (parts.some(part => /[<>"|?*]/.test(part) || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Некорректное имя файла.');
  return parts;
}

async function projectRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Сначала выберите рабочую папку.');
  try {
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw new Error();
    return root;
  } catch { throw new Error('Рабочая папка недоступна.'); }
}

async function checkedFile(root, parts) {
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Просмотр через ссылки на файлы и папки недоступен.');
  }
  const canonical = await realpath(target);
  if (!contains(root, canonical)) throw new Error('Файл находится за пределами выбранного проекта.');
  return canonical;
}

/** Read-only, bounded search. Symlinks/junctions are never followed. */
export async function searchProjectFiles({ cwd, query = '', cursor, assertActive = () => {} }) {
  if (typeof query !== 'string' || query.length > 500 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Некорректный поисковый запрос.');
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^(?:0|[1-9]\d{0,4})$/.test(cursor) || Number(cursor) > SEARCH_ENTRY_LIMIT)) throw new Error('Некорректная страница файлов.');
  assertActive();
  const root = await projectRoot(cwd);
  const words = query.trim().replaceAll('\\', '/').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const queue = [{ relative: '', depth: 0 }];
  const matches = [];
  let visited = 0, directoryCount = 0, truncated = false;
  for (let index = 0; index < queue.length; index++) {
    assertActive();
    if (++directoryCount > SEARCH_DIRECTORY_LIMIT || visited >= SEARCH_ENTRY_LIMIT) { truncated = true; break; }
    const { relative, depth } = queue[index];
    let directory;
    try {
      const target = relative ? await checkedFile(root, relative.split('/')) : root;
      directory = await opendir(target);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(error.code)) { truncated = true; continue; }
      if (relative) { truncated = true; continue; }
      throw error;
    }
    for await (const entry of directory) {
      assertActive();
      if (++visited > SEARCH_ENTRY_LIMIT) { truncated = true; break; }
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase())) {
        if (depth >= 32) { truncated = true; continue; }
        queue.push({ relative: relativePath, depth: depth + 1 });
      } else if (entry.isFile() && words.every(word => relativePath.toLocaleLowerCase().includes(word))) {
        matches.push({ path: relativePath, name: entry.name });
      }
    }
  }
  assertActive();
  const exact = query.trim().toLocaleLowerCase();
  matches.sort((a, b) => Number(b.name.toLocaleLowerCase() === exact) - Number(a.name.toLocaleLowerCase() === exact)
    || a.path.localeCompare(b.path, 'ru', { numeric: true, sensitivity: 'base' }) || (a.path < b.path ? -1 : 1));
  const offset = Number(cursor || 0);
  return { files: matches.slice(offset, offset + FILE_SEARCH_PAGE_SIZE), nextCursor: offset + FILE_SEARCH_PAGE_SIZE < matches.length ? String(offset + FILE_SEARCH_PAGE_SIZE) : null, truncated };
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Open a project file without executing HTML/SVG or loading remote resources. */
export async function readProjectFile({ cwd, path: relativePath, assertActive = () => {} }) {
  const parts = relativeParts(relativePath);
  const portablePath = parts.join('/');
  assertActive();
  const root = await projectRoot(cwd);
  let handle;
  try {
    const target = await checkedFile(root, parts);
    const beforeOpen = await stat(target);
    if (!beforeOpen.isFile()) throw new Error('Выбранный путь не является файлом.');
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Выбранный путь не является файлом.');
    // Verify again after opening. The handle keeps reading the same file if it
    // is replaced while reading; no later read reopens a user-controlled path.
    if (await checkedFile(root, parts) !== target) throw new Error('Путь к файлу изменился. Откройте его заново.');
    const current = await stat(target);
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Error('Файл изменился. Откройте его заново.');
    const verify = async () => {
      assertActive();
      if (await checkedFile(root, parts) !== target) throw new Error('Путь к файлу изменился. Откройте его заново.');
      const [fileInfo, handleInfo] = await Promise.all([stat(target), handle.stat()]);
      if (fileInfo.ino !== info.ino || fileInfo.dev !== info.dev || handleInfo.size !== info.size || handleInfo.mtimeMs !== info.mtimeMs || handleInfo.ctimeMs !== info.ctimeMs) throw new Error('Файл изменился во время чтения. Откройте его заново.');
      assertActive();
    };
    assertActive();
    const probe = Buffer.alloc(Math.min(info.size, 12));
    await handle.read(probe, 0, probe.length, 0);
    const mime = imageMime(probe);
    if (mime && info.size > FILE_IMAGE_LIMIT) { await verify(); return { path: portablePath, kind: 'unsupported', message: 'Изображение больше 20 МБ. Откройте его во внешней программе.' }; }
    const limit = mime ? FILE_IMAGE_LIMIT : FILE_TEXT_LIMIT;
    const bytes = Buffer.alloc(Math.min(info.size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      assertActive();
      const result = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    await verify();
    const data = bytes.subarray(0, offset);
    if (mime) return { path: portablePath, kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    const truncated = info.size > limit;
    let encoding = 'utf-8';
    if (data[0] === 255 && data[1] === 254) encoding = 'utf-16le';
    if (data[0] === 254 && data[1] === 255) encoding = 'utf-16be';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(data, { stream: truncated }); }
    catch { return { path: portablePath, kind: 'unsupported', message: 'Двоичный файл или неподдерживаемая кодировка. Откройте его во внешней программе.' }; }
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { path: portablePath, kind: 'unsupported', message: 'Предпросмотр двоичного файла недоступен. Откройте его во внешней программе.' };
    const extension = path.extname(portablePath).slice(1).toLowerCase();
    return { path: portablePath, kind: ['md', 'markdown', 'mdown'].includes(extension) ? 'markdown' : 'text', text, language: languages[extension] || 'Текст', truncated,
      ...(truncated ? { message: 'Показан первый 1 МБ файла. Полный файл можно открыть во внешней программе.' } : {}) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Файл не найден. Возможно, он перемещён или удалён.');
    if (['EPERM', 'EACCES'].includes(error.code)) throw new Error('Нет доступа к этому файлу.');
    throw error;
  } finally { await handle?.close(); }
}
