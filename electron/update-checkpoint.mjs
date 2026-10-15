import * as fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cleanSettings } from './window-session.mjs';
import { decodeImage } from './host-utils.mjs';
import { validateRemoteTarget } from './remote-control-store.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const modes = new Set(['inherited', 'read-only', 'workspace-write', 'auto', 'rules', 'danger-full-access']);
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
const reviewMemberStatuses = new Set(['waiting', 'running', 'completed', 'failed', 'interrupted', 'excluded']);
const reviewDeliveryStatuses = new Set(['reserved', 'uncertain', 'sent']);
const reviewIdentifier = value => {
  const id = text(value, 256);
  if (!id) throw new Error('Нет идентификатора авто-проверки.');
  return id;
};
const reviewRevision = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Некорректная версия авто-проверки.');
  return value;
};
const sameReviewFolder = (left, right) => path.resolve(left).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === path.resolve(right).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
function executorAutoReview(value, { cwd, provider, threadId }) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('Некорректная авто-проверка.');
  const parent = value.parent;
  const parentCwd = text(parent?.cwd, 4096);
  const parentThreadId = reviewIdentifier(parent?.threadId);
  if (!path.isAbsolute(parentCwd) || !cwd || !sameReviewFolder(parentCwd, cwd) || !threadId || parentThreadId !== threadId
    || !['codex', 'claude'].includes(parent?.provider) || parent.provider !== provider) throw new Error('Авто-проверка относится к другому диалогу, папке или агенту.');
  const roundId = text(value.roundId, 256);
  const revision = reviewRevision(value.revision);
  if (!Array.isArray(value.members) || value.members.length > 100) throw new Error('Некорректные участники авто-проверки.');
  const seen = new Set();
  const members = value.members.map(member => {
    const id = reviewIdentifier(member?.id);
    if (seen.has(id) || !reviewMemberStatuses.has(member?.status)) throw new Error('Некорректный участник авто-проверки.');
    seen.add(id);
    if (member.pending !== undefined && typeof member.pending !== 'boolean') throw new Error('Некорректное ожидание участника авто-проверки.');
    return { id, label: text(member.label, 256), status: member.status,
      ...(member.threadId !== undefined ? { threadId: reviewIdentifier(member.threadId) } : {}),
      ...(member.turnId !== undefined ? { turnId: reviewIdentifier(member.turnId) } : {}),
      ...(member.result !== undefined ? { result: text(member.result, 100_000) } : {}),
      ...(member.error !== undefined ? { error: text(member.error, 4000) } : {}),
      ...(member.pending !== undefined ? { pending: member.pending } : {}) };
  });
  const result = { parent: { cwd, provider, threadId }, enabled: false, roundId, revision, members };
  if (value.notice !== undefined) result.notice = text(value.notice, 4000);
  if (value.delivery !== undefined) {
    const delivery = value.delivery;
    if (!reviewDeliveryStatuses.has(delivery?.status)) throw new Error('Некорректная отправка авто-проверки.');
    const deliveryRoundId = reviewIdentifier(delivery.roundId);
    const deliveryRevision = reviewRevision(delivery.revision);
    if (deliveryRevision > revision) throw new Error('Отправка относится к будущей версии авто-проверки.');
    // A saved reservation may already have reached RPC when the renderer exits.
    result.delivery = { id: reviewIdentifier(delivery.id), roundId: deliveryRoundId, revision: deliveryRevision,
      text: text(delivery.text, 2_000_000), status: delivery.status === 'reserved' ? 'uncertain' : delivery.status };
  }
  return result;
}
function remoteContext(value, messageId, threadId, provider, kinds) {
  if (!value || typeof value !== 'object' || !['send', 'enqueue', 'steer'].includes(value.kind)) throw new Error('Некорректная удалённая отправка.');
  const target = validateRemoteTarget(value.target);
  if (target.threadId !== threadId || target.provider !== provider || !kinds.includes(value.kind) || value.clientUserMessageId !== messageId) throw new Error('Удалённая отправка относится к другой беседе.');
  const result = { operationId: text(value.operationId, 256), target, kind: value.kind, clientUserMessageId: messageId };
  if (!result.operationId) throw new Error('Нет идентификатора удалённой отправки.');
  if (value.kind === 'steer') {
    result.expectedTurnId = text(value.expectedTurnId, 256);
    if (!result.expectedTurnId) throw new Error('Нет ожидаемого хода уточнения.');
  }
  return result;
}

function viewState(tab, context) {
  const result = {};
  if (tab.pinned === true) result.pinned = true;
  if (tab.childOf !== undefined) {
    result.childOf = reviewIdentifier(tab.childOf);
    if (result.childOf === tab.thread?.id) throw new Error('Исполнитель не может быть родителем самого себя.');
    if (tab.childLabel !== undefined) result.childLabel = text(tab.childLabel, 256);
  } else if (tab.childLabel !== undefined) throw new Error('У подписи исполнителя нет родительского диалога.');
  if (tab.executorAutoReview !== undefined) result.executorAutoReview = executorAutoReview(tab.executorAutoReview, context);
  if (tab.pendingMessage !== undefined) {
    const pending = tab.pendingMessage;
    const threadId = text(pending?.threadId, 256);
    const clientUserMessageId = text(pending?.clientUserMessageId, 256);
    if (!threadId || !clientUserMessageId || !['start', 'steer'].includes(pending?.kind)) throw new Error('Некорректная неподтверждённая отправка.');
    if (tab.thread?.id && tab.thread.id !== threadId) throw new Error('Неподтверждённая отправка относится к другому диалогу.');
    result.pendingMessage = { threadId, clientUserMessageId, kind: pending.kind, text: text(pending.text, 2_000_000), attachments: attachments(pending.attachments) };
    if (pending.remote !== undefined || pending.origin === 'remote') {
      result.pendingMessage.origin = 'remote';
      if (pending.attachments?.length) throw new Error('Удалённые вложения не поддерживаются.');
      result.pendingMessage.remote = remoteContext(pending.remote, clientUserMessageId, threadId, context.provider, pending.kind === 'steer' ? ['steer'] : ['send', 'enqueue']);
    }
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
      if (item.remote !== undefined && item.attachments?.length) throw new Error('Удалённые вложения не поддерживаются.');
      return { id, text: text(item.text, 2_000_000), attachments: attachments(item.attachments), ...(item.state ? { state: item.state } : {}),
        ...(item.remote !== undefined ? { remote: remoteContext(item.remote, id, tab.thread?.id, context.provider, ['enqueue']) } : {}) };
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
    const selected = thread(tab.thread);
    return { cwd, settings, thread: selected, draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments), ...viewState(tab, { cwd, provider: settings.provider || 'codex', threadId: selected?.id }) };
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
    // Source changes are committed by the host after credential validation and
    // process shutdown; a stale/pending renderer selection is not authoritative.
    if (session.getSettings().connectionSource) settings.connectionSource = session.getSettings().connectionSource;
    else delete settings.connectionSource;
    if (settings.access && !modes.has(settings.access)) throw new Error("Некорректный режим снимка.");
    const selected = thread(tab.thread);
    if (selected) selected.cwd = session.currentCwd;
    return { cwd: session.currentCwd, settings, thread: selected, draft: text(tab.draft, 2_000_000), attachments: attachments(tab.attachments), ...viewState(tab, { cwd: session.currentCwd, provider: settings.provider || 'codex', threadId: selected?.id }) };
  });
  if (seen.size !== sessions.size) throw new Error("Состав вкладок изменился.");
  return boundedSnapshot({ version: 1, activeIndex: snapshot.activeIndex, tabs });
}

export function createSnapshotStore(userData, { basename, resetFullAccess = false, preserveInvalid = false, readError, io = fs, platform = process.platform, sleep = delay }) {
  const filename = path.join(userData, basename);
  let queue = Promise.resolve();
  let writeBlocked = false;
  let writeError = null;
  const serial = work => { const result = queue.catch(() => {}).then(work); queue = result; return result; };
  const serialWrite = work => serial(async () => {
    try { await work(); writeError = null; }
    catch (error) { writeError = error; throw error; }
  });
  return {
    save(value) {
      // Freeze the validated bytes before queueing so caller mutations cannot affect writes.
      const serialized = JSON.stringify(validateStoredCheckpoint(value, { resetFullAccess }));
      return serialWrite(async () => {
        if (writeBlocked) throw new Error('Предыдущий снимок не удалось сохранить отдельно. Автосохранение остановлено, чтобы не потерять его.');
        await io.mkdir(userData, { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await io.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
          // Retry only Windows' atomic replacement, never the save caller/CLI request.
          // Keep the previous snapshot in place even if every replacement fails.
          for (let attempt = 0; ; attempt++) {
            try { await io.rename(temporary, filename); break; }
            catch (error) {
              if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
              await sleep(Math.min(25 * (attempt + 1), 100));
            }
          }
        } finally { await io.unlink(temporary).catch(() => {}); }
      });
    },
    read() { return serial(async () => {
      try {
        const stat = await io.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid checkpoint');
        return validateStoredCheckpoint(JSON.parse(await io.readFile(filename, 'utf8')), { resetFullAccess });
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (preserveInvalid) {
          try {
            const stat = await io.lstat(filename);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid snapshot file');
            const backup = `${filename}.invalid-${Date.now()}-${randomUUID()}`;
            await io.copyFile(filename, backup, constants.COPYFILE_EXCL);
          } catch { writeBlocked = true; }
        }
        throw new Error(readError);
      }
    }); },
    clear() { return serialWrite(async () => { await io.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }); },
    async flush() {
      let current;
      do { current = queue; await current; } while (current !== queue);
      // Reading the old snapshot must not turn an unsuccessful save into a flush ACK.
      if (writeError) throw writeError;
    },
  };
}
export function createUpdateCheckpoint(userData) {
  return createSnapshotStore(userData, { basename: 'nightly-update-workspace.json', readError: "Не удалось восстановить вкладки после обновления. Снимок сохранён в папке данных Nightly." });
}
