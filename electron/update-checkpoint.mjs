import { readFile, writeFile, rename, unlink, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanSettings } from './window-session.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const modes = new Set(['inherited', 'read-only', 'workspace-write', 'auto', 'danger-full-access']);
const text = (value, limit, optional = false) => {
  if (optional && value == null) return undefined;
  if (typeof value !== 'string' || value.length > limit) throw new Error('Некорректный снимок окна.');
  return value;
};
function thread(value) {
  if (!value) return undefined;
  const id = text(value.id, 256);
  if (!id) throw new Error('Нет идентификатора диалога.');
  return { id, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 300) } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: text(value.cwd, 4096) } : {}),
    ...(['paginated', 'legacy'].includes(value.historyMode) ? { historyMode: value.historyMode } : {}) };
}
function attachments(value) {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Некорректные вложения снимка.');
  return value.map(item => {
    const dataUrl = text(item.dataUrl, 28_000_000);
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl)) throw new Error('Некорректное изображение снимка.');
    return { name: text(item.name, 1024), dataUrl };
  });
}

/** Never persist chat transcripts/config or secrets; only explicitly open UI state. */
export function captureUpdateCheckpoint(snapshot, sessions) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.tabs) || snapshot.tabs.length > 100 || !Number.isInteger(snapshot.activeIndex)) throw new Error('Некорректный снимок окна.');
  const seen = new Set();
  const tabs = snapshot.tabs.map(tab => {
    if (tab.archivedThread) return { archivedThread: thread(tab.archivedThread), draft: '', attachments: [] };
    if (typeof tab.sessionId !== 'string' || seen.has(tab.sessionId)) throw new Error('Некорректная сессия снимка.');
    seen.add(tab.sessionId);
    const session = sessions.get(tab.sessionId);
    if (!session || session.disposed) throw new Error('Сессия снимка закрыта.');
    const settings = { ...cleanSettings(session.getSettings()), ...cleanSettings(tab.settings), cwd: session.currentCwd };
    // Executable and cwd are host-owned; selection controls can only override these three keys.
    settings.executable = session.getSettings().executable;
    if (settings.access && !modes.has(settings.access)) throw new Error('Некорректный режим снимка.');
    const selected = thread(tab.thread);
    if (selected) selected.cwd = session.currentCwd;
    return { cwd: session.currentCwd, settings, thread: selected, draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments) };
  });
  if (seen.size !== sessions.size) throw new Error('Состав вкладок изменился.');
  if (snapshot.activeIndex < 0 || snapshot.activeIndex >= Math.max(1, tabs.length)) throw new Error('Некорректная активная вкладка.');
  const result = { version: 1, activeIndex: snapshot.activeIndex, tabs };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('Черновики слишком велики для автоматического перезапуска.');
  return result;
}

export function createUpdateCheckpoint(userData) {
  const filename = path.join(userData, 'nightly-update-workspace.json');
  let queue = Promise.resolve();
  const serial = work => { const result = queue.catch(() => {}).then(work); queue = result; return result; };
  return {
    save(value) { return serial(async () => {
      await mkdir(userData, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
      finally { await unlink(temporary).catch(() => {}); }
    }); },
    async read() {
      try {
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid checkpoint');
        const value = JSON.parse(await readFile(filename, 'utf8'));
        if (value?.version !== 1 || !Array.isArray(value.tabs) || value.tabs.length > 100 || !Number.isInteger(value.activeIndex) || value.activeIndex < 0 || value.activeIndex >= Math.max(1, value.tabs.length)) throw new Error('Invalid checkpoint');
        const tabs = value.tabs.map(tab => {
          if (tab.archivedThread) return { archivedThread: thread(tab.archivedThread), draft: '', attachments: [] };
          const cwd = text(tab.cwd, 4096);
          if (!path.isAbsolute(cwd)) throw new Error('Invalid directory');
          const settings = { ...cleanSettings(tab.settings), cwd };
          if (settings.access && !modes.has(settings.access)) throw new Error('Invalid access');
          return { cwd, settings, thread: thread(tab.thread), draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments) };
        });
        return { version: 1, activeIndex: value.activeIndex, tabs };
      } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Не удалось восстановить вкладки после обновления. Снимок сохранён в папке данных Nightly.'); }
    },
    clear() { return serial(async () => { await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }); },
  };
}
