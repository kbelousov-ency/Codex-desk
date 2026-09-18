import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const sourceSuffix = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i;
const controlCharacters = /[\u0000-\u001f\u007f]/;

function checkedTarget(target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 32768 || controlCharacters.test(target)) {
    throw new Error('Некорректная ссылка или путь.');
  }
  return target;
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { return value; } // A literal percent sign is a valid character in a file name.
}

function localPath(value, pathImpl) {
  if (controlCharacters.test(value) || /^[\\/]{2}/.test(value) || /^\\(?:\?\?|Device)\\/i.test(value)) {
    throw new Error('Сетевые и служебные пути не поддерживаются.');
  }
  const windows = pathImpl.sep === '\\';
  if (windows && /^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error('Поддерживаются только локальные файлы и ссылки HTTP(S).');
  }
  if (windows) {
    const withoutDrive = value.replace(/^[a-z]:/i, '');
    if (/[<>:"|?*]/.test(withoutDrive) || withoutDrive.split(/[\\/]/).some(segment => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment.replace(/[ .]+$/g, '')))) {
      throw new Error('Некорректное имя локального файла.');
    }
  }
  return value;
}

/** Pure parser; path.win32 can be supplied to exercise Windows links on any OS. */
export function localLinkCandidates(target, cwd, pathImpl = path) {
  checkedTarget(target);
  if (typeof cwd !== 'string' || !cwd || !pathImpl.isAbsolute(cwd)) throw new Error('Сначала выберите проект.');
  localPath(cwd, pathImpl);
  let value = target;
  const isFileUrl = /^file:/i.test(value);
  if (isFileUrl) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Некорректная ссылка на файл.'); }
    if (url.hostname || url.search) throw new Error('Сетевые ссылки на файлы и параметры URL не поддерживаются.');
    // Keep a literal # filename ahead of the source-location interpretation.
    value = url.pathname + url.hash;
  }
  const literal = value;
  value = decodePath(value);
  if (controlCharacters.test(value)) throw new Error('Некорректная ссылка или путь.');
  // Reject encoded unsafe paths too, even if their literal spelling looks local.
  localPath(value.replace(sourceSuffix, ''), pathImpl);
  // Raw Markdown paths can contain a literal "%20"; file URLs always use URI escaping.
  const spellings = isFileUrl ? [value] : [literal, value];
  const variants = [...new Set([...spellings, ...spellings.map(item => item.replace(sourceSuffix, ''))])];
  const candidates = [];
  let lastError;
  for (const variant of variants) {
    try {
      const parsed = localPath(variant, pathImpl);
      const resolved = pathImpl.resolve(cwd, parsed);
      localPath(resolved, pathImpl);
      candidates.push(resolved);
    } catch (error) { lastError = error; }
  }
  if (!candidates.length) throw lastError;
  return [...new Set(candidates)];
}

function insideProject(root, candidate, pathImpl = path) {
  const relative = pathImpl.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(relative);
}

/** Canonicalize both ends so junctions/symlinks cannot reveal another project. */
export async function resolveLocalLink(target, cwd) {
  const candidates = localLinkCandidates(target, cwd);
  let root;
  try { root = await realpath(cwd); }
  catch { throw new Error('Рабочая папка недоступна. Выберите существующую папку проекта.'); }
  localPath(root, path);
  let outsideProject = false;
  for (const candidate of candidates) {
    // An encoded absolute path can look outside cwd until decoded (My%20projects).
    // Check every spelling, but never resolve or open an out-of-project candidate.
    if (!insideProject(cwd, candidate)) { outsideProject = true; continue; }
    let resolved;
    try { resolved = await realpath(candidate); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) continue;
      throw new Error(`Не удалось получить доступ к файлу: ${error.message}`);
    }
    localPath(resolved, path);
    if (!insideProject(root, resolved)) { outsideProject = true; continue; }
    const info = await stat(resolved);
    if (!info.isFile() && !info.isDirectory()) throw new Error('Поддерживаются только обычные файлы и папки.');
    return resolved;
  }
  if (outsideProject) throw new Error('Файл находится за пределами выбранного проекта.');
  throw new Error('Файл или папка не найдены. Возможно, путь изменился или файл удалён.');
}

/** Electron shell is injected so tests never launch a real file or executable. */
export async function openLink({ target, cwd, shell, assertActive = () => {} }) {
  checkedTarget(target);
  if (/^https?:\/\//i.test(target)) {
    let url;
    try { url = new URL(target); } catch { throw new Error('Некорректная веб-ссылка.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Неподдерживаемая веб-ссылка.');
    assertActive();
    await shell.openExternal(url.href);
    return;
  }
  const resolved = await resolveLocalLink(target, cwd);
  assertActive();
  const error = await shell.openPath(resolved);
  if (error) throw new Error(`Не удалось открыть файл: ${error}`);
}

export async function showLocalPathMenu({ target, cwd, shell, Menu, window, assertActive = () => {} }) {
  await resolveLocalLink(target, cwd);
  assertActive();
  return new Promise((resolve, reject) => {
    let selected = false;
    const menu = Menu.buildFromTemplate([{
      label: 'Открыть в проводнике',
      click: () => {
        selected = true;
        // Check again after the user has chosen: the file or tab may have changed.
        void resolveLocalLink(target, cwd).then(resolved => {
          assertActive();
          shell.showItemInFolder(resolved);
        }).then(resolve, reject);
      },
    }]);
    menu.popup({ window, callback: () => setImmediate(() => { if (!selected) resolve(); }) });
  });
}
