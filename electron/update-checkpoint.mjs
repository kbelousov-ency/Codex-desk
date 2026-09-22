import { readFile, writeFile, rename, unlink, mkdir, lstat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cleanSettings } from './window-session.mjs';
import { decodeImage } from './host-utils.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const modes = new Set(['inherited', 'read-only', 'workspace-write', 'auto', 'danger-full-access']);
const text = (value, limit, optional = false) => {
  if (optional && value == null) return undefined;
  if (typeof value !== 'string' || value.length > limit) throw new Error("Некорректный снимок окна.");
  return value;
};
function thread(value) {
  if (!value) return undefined;
  const id = text(value.id, 256);
  if (!id) throw new Error("Нет идентификатора диалога.");
  return { id, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 300) } : {}),
    ...(value.provider === 'claude' || id.startsWith('claude:') ? { provider: 'claude' } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: text(value.cwd, 4096) } : {}),
    ...(['paginated', 'legacy'].includes(value.historyMode) ? { historyMode: value.historyMode } : {}) };
}
function attachments(value) {
  if (!Array.isArray(value) || value.length > 10) throw new Error("Некорректные вложения снимка.");
  return value.map(item => {
    const dataUrl = text(item.dataUrl, 28_000_000);
    decodeImage({ dataUrl });
    return { name: text(item.name, 1024), dataUrl };
  });
}
function viewState(tab) {
  const result = {};
  if (tab.pinned === true) result.pinned = true;
  if (tab.pendingMessage !== undefined) {
    const pending = tab.pendingMessage;
    const threadId = text(pending?.threadId, 256);
    const clientUserMessageId = text(pending?.clientUserMessageId, 256);
    if (!threadId || !clientUserMessageId || !['start', 'steer'].includes(pending?.kind)) throw new Error('Некорректная неподтверждённая отправка.');
    if (tab.thread?.id && tab.thread.id !== threadId) throw new Error('Неподтверждённая отправка относится к другому диалогу.');
    result.pendingMessage = { threadId, clientUserMessageId, kind: pending.kind, text: text(pending.text, 2_000_000), attachments: attachments(pending.attachments) };
  }
  if (tab.preservedDraft !== undefined) result.preservedDraft = {
    text: text(tab.preservedDraft?.text, 2_000_000), attachments: attachments(tab.preservedDraft?.attachments),
  };
  if (tab.scrollAnchor !== undefined) {
    const itemId = text(tab.scrollAnchor?.itemId, 256);
    const offset = tab.scrollAnchor?.offset;
    if (!itemId || !Number.isFinite(offset) || Math.abs(offset) > 100_000_000) throw new Error('Некорректная позиция сообщения.');
    result.scrollAnchor = { itemId, offset };
  }
  if (tab.scrollTop !== undefined) {
    if (!Number.isFinite(tab.scrollTop) || tab.scrollTop < 0 || tab.scrollTop > 100_000_000) throw new Error("Некорректная прокрутка снимка.");
    result.scrollTop = tab.scrollTop;
  }
  if (tab.queue !== undefined) {
    if (!Array.isArray(tab.queue?.items) || tab.queue.items.length > 50) throw new Error("Некорректная очередь снимка.");
    const seen = new Set();
    const items = tab.queue.items.map(item => {
      const id = text(item.id, 256);
      if (!id || seen.has(id)) throw new Error("Некорректное сообщение очереди.");
      seen.add(id);
      if (item.state !== undefined && !['waiting', 'uncertain'].includes(item.state)) throw new Error("Некорректное состояние очереди.");
      return { id, text: text(item.text, 2_000_000), attachments: attachments(item.attachments), ...(item.state ? { state: item.state } : {}) };
    });
    // Never restart queued model work implicitly.
    result.queue = { items, paused: true, ...(tab.queue.threadId !== undefined ? { threadId: text(tab.queue.threadId, 256) } : {}),
      ...(tab.queue.cwd !== undefined ? { cwd: text(tab.queue.cwd, 4096) } : {}), ...(typeof tab.queue.reason === 'string' ? { reason: text(tab.queue.reason, 1000) } : {}) };
  }
  return result;
}
function snapshotShape(value) {
  if (value?.version !== 1 || !Array.isArray(value.tabs) || value.tabs.length > 100 || !Number.isInteger(value.activeIndex)
    || value.activeIndex < 0 || value.activeIndex >= Math.max(1, value.tabs.length)) throw new Error("Некорректный снимок окна.");
}
function boundedSnapshot(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error("Черновики слишком велики для сохранения рабочего места.");
  return value;
}

/** Disk and renderer snapshots share an allowlist, with no chat transcripts or config credentials. */
export function validateStoredCheckpoint(value, { resetFullAccess = false } = {}) {
  snapshotShape(value);
  const tabs = value.tabs.map(tab => {
    if (tab.archivedThread) return { archivedThread: thread(tab.archivedThread), draft: '', attachments: [], ...viewState({ pinned: tab.pinned, scrollTop: tab.scrollTop, scrollAnchor: tab.scrollAnchor }) };
    const cwd = text(tab.cwd, 4096);
    if (!path.isAbsolute(cwd)) throw new Error('Invalid directory');
    const settings = { ...cleanSettings(tab.settings), cwd };
    if (settings.access && !modes.has(settings.access)) throw new Error('Invalid access');
    if (resetFullAccess && settings.access === 'danger-full-access') settings.access = 'workspace-write';
    return { cwd, settings, thread: thread(tab.thread), draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments), ...viewState(tab) };
  });
  return boundedSnapshot({ version: 1, activeIndex: value.activeIndex, tabs });
}

/** Capture UI even during model work/terminal handoff; update readiness is checked separately by the host. */
export function captureUpdateCheckpoint(snapshot, sessions) {
  snapshotShape(snapshot);
  const seen = new Set();
  const tabs = snapshot.tabs.map(tab => {
    if (tab.archivedThread) return { archivedThread: thread(tab.archivedThread), draft: '', attachments: [], ...viewState({ pinned: tab.pinned, scrollTop: tab.scrollTop, scrollAnchor: tab.scrollAnchor }) };
    if (typeof tab.sessionId !== 'string' || seen.has(tab.sessionId)) throw new Error("Некорректная сессия снимка.");
    seen.add(tab.sessionId);
    const session = sessions.get(tab.sessionId);
    if (!session || session.disposed) throw new Error("Сессия снимка закрыта.");
    const settings = { ...cleanSettings(session.getSettings()), ...cleanSettings(tab.settings), cwd: session.currentCwd };
    settings.executable = session.getSettings().executable;
    if (session.getSettings().provider) settings.provider = session.getSettings().provider;
    else delete settings.provider;
    if (settings.access && !modes.has(settings.access)) throw new Error("Некорректный режим снимка.");
    const selected = thread(tab.thread);
    if (selected) selected.cwd = session.currentCwd;
    return { cwd: session.currentCwd, settings, thread: selected, draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments), ...viewState(tab) };
  });
  if (seen.size !== sessions.size) throw new Error("Состав вкладок изменился.");
  return boundedSnapshot({ version: 1, activeIndex: snapshot.activeIndex, tabs });
}

export function createSnapshotStore(userData, { basename, resetFullAccess = false, preserveInvalid = false, readError }) {
  const filename = path.join(userData, basename);
  let queue = Promise.resolve();
  let writeBlocked = false;
  const serial = work => { const result = queue.catch(() => {}).then(work); queue = result; return result; };
  return {
    save(value) {
      // Freeze the validated bytes before queueing so caller mutations cannot affect writes.
      const serialized = JSON.stringify(validateStoredCheckpoint(value, { resetFullAccess }));
      return serial(async () => {
        if (writeBlocked) throw new Error('Предыдущий снимок не удалось сохранить отдельно. Автосохранение остановлено, чтобы не потерять его.');
        await mkdir(userData, { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
        finally { await unlink(temporary).catch(() => {}); }
      });
    },
    read() { return serial(async () => {
      try {
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid checkpoint');
        return validateStoredCheckpoint(JSON.parse(await readFile(filename, 'utf8')), { resetFullAccess });
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (preserveInvalid) {
          try {
            const stat = await lstat(filename);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid snapshot file');
            const backup = `${filename}.invalid-${Date.now()}-${randomUUID()}`;
            await copyFile(filename, backup, constants.COPYFILE_EXCL);
          } catch { writeBlocked = true; }
        }
        throw new Error(readError);
      }
    }); },
    clear() { return serial(async () => { await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }); },
    async flush() { let current; do { current = queue; await current.catch(() => {}); } while (current !== queue); },
  };
}
export function createUpdateCheckpoint(userData) {
  return createSnapshotStore(userData, { basename: 'nightly-update-workspace.json', readError: "Не удалось восстановить вкладки после обновления. Снимок сохранён в папке данных Nightly." });
}
