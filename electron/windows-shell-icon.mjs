import { watch } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** Explorer cannot read an ASAR path; an updated channel directory also disappears briefly. */
export async function persistShellIcon({ source, userData }) {
  const bytes = await readFile(source);
  const directory = path.join(userData, 'shell-icons');
  const icon = path.join(directory, `icon-${createHash('sha256').update(bytes).digest('hex')}.ico`);
  await mkdir(directory, { recursive: true });
  try { if ((await readFile(icon)).equals(bytes)) return icon; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Never expose a partial ICO to Explorer; also recover an interrupted older write.
  const temporary = path.join(directory, '.icon-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, icon);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return icon;
}

const sameWindowsPath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();

/** Preserve Electron's toast CLSID and the user's launch options; never claim a foreign shortcut. */
export function repairShellShortcutIcon({ shell, shortcut, executable, appId, icon }) {
  let current;
  try { current = shell.readShortcutLink(shortcut); } catch { return false; }
  if (!sameWindowsPath(current.target, executable) || current.appUserModelId !== appId) return false;
  if (sameWindowsPath(current.icon, icon) && current.iconIndex === 0) return false;
  if (!shell.writeShortcutLink(shortcut, 'update', { icon, iconIndex: 0 })) {
    throw new Error('Could not update the application shortcut icon.');
  }
  return true;
}

/** Electron creates the notification shortcut asynchronously and may later recreate it without an icon. */
export function watchShellShortcutIcon(options, { watchDirectory = watch, onError = () => {} } = {}) {
  let timer;
  let closed = false;
  const repair = () => {
    if (closed) return;
    try { repairShellShortcutIcon(options); } catch (error) { onError(error); }
  };
  const watcher = watchDirectory(path.dirname(options.shortcut), { persistent: false }, (_event, filename) => {
    if (closed || (filename && String(filename).toLowerCase() !== path.basename(options.shortcut).toLowerCase())) return;
    clearTimeout(timer);
    timer = setTimeout(repair, 150);
    timer.unref?.();
  });
  watcher.on('error', onError);
  repair();
  return () => { closed = true; clearTimeout(timer); watcher.close(); };
}
