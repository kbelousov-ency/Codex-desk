import path from 'node:path';
import { claudeSessionId } from './claude-history.mjs';

/** Rename, archive and delete for native Claude Code sessions.
 * Rename of an open, connected tab goes through the CLI's `rename_session` control request;
 * everything else uses the official SDK session mutators on the transcript store.
 * Archive/restore have no native counterpart: they only add or remove the session id in the
 * shell's own `ClaudeArchiveStore`, leaving the transcript untouched.
 */
export class ClaudeThreadManagement {
  constructor({ coordinator, history, archive = null, getSessions, assertActive = () => {}, onRestore = async () => {} }) {
    this.coordinator = coordinator; this.history = history; this.archive = archive;
    this.getSessions = getSessions; this.assertActive = assertActive; this.onRestore = onRestore;
  }
  affectedSessions(threadId) {
    return [...this.getSessions()].filter(session => !session.disposed && session.settings?.provider === 'claude'
      && [session.currentThreadId, session.terminal?.threadId, ...session.activeThreadTurns.keys(), ...session.pendingThreadIds.keys()].some(id => id && this.coordinator.related(id, threadId)));
  }
  assertIdle(threadId) {
    for (const session of this.affectedSessions(threadId)) {
      if (session.terminal || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size) throw new Error('Дождитесь завершения работы и подтверждений диалога; закройте его терминал.');
    }
  }
  store() {
    if (!this.archive) throw new Error('Архив диалогов Claude недоступен.');
    return this.archive;
  }
  async manageThread(options) {
    if (!options || typeof options !== 'object') throw new Error('Неизвестное действие с диалогом.');
    const { action, threadId, cwd } = options;
    if (!['rename', 'delete', 'archive', 'restore'].includes(action)) throw new Error('Неизвестное действие с диалогом.');
    if (typeof threadId !== 'string' || !threadId.startsWith('claude:')) throw new Error('Некорректный идентификатор диалога Claude.');
    const sessionId = claudeSessionId(threadId);
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096 || !path.isAbsolute(cwd)) throw new Error('Некорректная папка диалога.');
    const name = typeof options.name === 'string' ? options.name.trim() : '';
    if (action === 'rename' && (!name || name.length > 200 || /[\r\n\0]/.test(name))) throw new Error('Название должно содержать от 1 до 200 символов в одной строке.');
    if (action === 'archive' || action === 'restore') this.store();
    this.assertActive();
    this.assertIdle(threadId);
    const release = this.coordinator.reserve(threadId);
    try {
      if (action === 'restore') {
        // The transcript may be unreadable (folder moved, session deleted in the CLI); the
        // archived entry must still be removable so the archive panel cannot get stuck.
        const entry = await this.store().find(threadId);
        if (!entry) throw new Error('Диалог уже не находится в архиве. Обновите список.');
        this.assertActive();
        await this.store().remove(threadId);
        if (this.coordinator.blocked.get(threadId) === 'archive') this.coordinator.blocked.delete(threadId);
        await this.onRestore(entry.cwd).catch(() => {});
        return { thread: { ...entry, provider: 'claude', historyMode: 'legacy' }, affectedThreadIds: [threadId] };
      }
      const folder = await this.history.cwd(cwd);
      // Also proves the session belongs to this project folder.
      const { thread } = await this.history.read({ cwd: folder, threadId, includeTurns: false });
      this.assertActive();
      this.assertIdle(threadId);
      const affected = this.affectedSessions(threadId);
      if (action === 'archive') {
        if (await this.store().has(threadId)) throw new Error('Диалог уже находится в архиве.');
        // Idle CLI processes of this tab are stopped like on delete; the renderer closes
        // the tabs after the confirmed archiving.
        for (const session of affected) session.client?.stop();
        await this.store().add({ id: threadId, cwd: folder, name: thread.name, preview: thread.preview, updatedAt: thread.updatedAt, createdAt: thread.createdAt });
        this.coordinator.blocked.set(threadId, 'archive');
        return { thread: { ...thread, archived: true }, affectedThreadIds: [threadId] };
      }
      const sdk = await this.history.sdk();
      if (action === 'rename') {
        const open = affected.find(session => session.currentThreadId === threadId && session.client && session.bootstrap);
        if (open) await open.client.request('thread/name/set', { threadId, name });
        else await sdk.renameSession(sessionId, name, { dir: folder });
        const updated = { ...thread, name };
        this.coordinator.remember(updated);
        return { thread: updated, affectedThreadIds: [threadId] };
      }
      // Stop idle CLI processes that still hold the transcript before removing it. The
      // renderer closes these tabs after the confirmed deletion.
      for (const session of affected) session.client?.stop();
      await sdk.deleteSession(sessionId, { dir: folder });
      await this.archive?.remove(threadId).catch(() => {});
      this.coordinator.blocked.set(threadId, 'delete');
      return { affectedThreadIds: [threadId] };
    } finally { release(); }
  }
}
