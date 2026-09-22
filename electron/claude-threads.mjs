import path from 'node:path';
import { claudeSessionId } from './claude-history.mjs';

/** Rename and delete for native Claude Code sessions.
 * Rename of an open, connected tab goes through the CLI's `rename_session` control request;
 * everything else uses the official SDK session mutators on the transcript store.
 * Archive/restore do not exist in native Claude history and are rejected explicitly.
 */
export class ClaudeThreadManagement {
  constructor({ coordinator, history, getSessions, assertActive = () => {} }) {
    this.coordinator = coordinator; this.history = history; this.getSessions = getSessions; this.assertActive = assertActive;
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
  async manageThread(options) {
    if (!options || typeof options !== 'object') throw new Error('Неизвестное действие с диалогом.');
    const { action, threadId, cwd } = options;
    if (action === 'archive' || action === 'restore') throw new Error('Архив недоступен для диалогов Claude Code: у его истории нет такого состояния.');
    if (!['rename', 'delete'].includes(action)) throw new Error('Неизвестное действие с диалогом.');
    if (typeof threadId !== 'string' || !threadId.startsWith('claude:')) throw new Error('Некорректный идентификатор диалога Claude.');
    const sessionId = claudeSessionId(threadId);
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096 || !path.isAbsolute(cwd)) throw new Error('Некорректная папка диалога.');
    const name = typeof options.name === 'string' ? options.name.trim() : '';
    if (action === 'rename' && (!name || name.length > 200 || /[\r\n\0]/.test(name))) throw new Error('Название должно содержать от 1 до 200 символов в одной строке.');
    this.assertActive();
    this.assertIdle(threadId);
    const release = this.coordinator.reserve(threadId);
    try {
      const folder = await this.history.cwd(cwd);
      // Also proves the session belongs to this project folder.
      const { thread } = await this.history.read({ cwd: folder, threadId, includeTurns: false });
      this.assertActive();
      this.assertIdle(threadId);
      const affected = this.affectedSessions(threadId);
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
      this.coordinator.blocked.set(threadId, 'delete');
      return { affectedThreadIds: [threadId] };
    } finally { release(); }
  }
}
