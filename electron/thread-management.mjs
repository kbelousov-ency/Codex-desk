import path from 'node:path';
import { WindowSession } from './window-session.mjs';
import { directoryPath } from './host-utils.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sourceKinds = ['appServer', 'cli', 'vscode'];
const allSourceKinds = [...sourceKinds, 'exec', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const active = thread => thread?.status?.type === 'active' || thread?.turns?.some(turn => turn.status === 'inProgress');
function checkId(id) { if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Некорректный идентификатор диалога.'); }
function checkCursor(cursor) { if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 16384)) throw new Error('Некорректная страница истории.'); }

/** Shared across windows. Local writers cannot race a thread lifecycle operation. */
export class ThreadActionCoordinator {
  constructor() { this.locks = new Map(); this.blocked = new Map(); this.threads = new Map(); }
  remember(thread) { if (thread?.id) this.threads.set(thread.id, thread); }
  related(id, ancestor) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === ancestor) return true;
      seen.add(id);
      id = this.threads.get(id)?.parentThreadId;
    }
    return false;
  }
  assertAllowed(id) {
    if (!id) return;
    if (this.blocked.has(id)) throw new Error(this.blocked.get(id) === 'delete' ? 'Диалог удалён. Откройте другой диалог.' : 'Диалог в архиве. Сначала восстановите его.');
    for (const locked of this.locks.keys()) if (this.related(id, locked)) throw new Error('Дождитесь завершения операции с диалогом.');
  }
  reserve(id) {
    for (const locked of this.locks.keys()) if (this.related(id, locked) || this.related(locked, id)) throw new Error('Операция с этим диалогом уже выполняется.');
    const token = Symbol(id);
    this.locks.set(id, token);
    return () => { if (this.locks.get(id) === token) this.locks.delete(id); };
  }
}

/** An isolated App Server for archive reads and explicitly requested mutations. */
export class ThreadManagement {
  constructor({ coordinator = new ThreadActionCoordinator(), getSessions = () => [], getSettings = async () => ({}),
    assertActive = () => {}, resolveDirectory = directoryPath, fallbackCwd = process.cwd(),
    createSession = settings => new WindowSession({ settings }), onRestore = async () => {} } = {}) {
    Object.assign(this, { coordinator, getSessions, getSettings, assertActive, resolveDirectory, fallbackCwd, createSession, onRestore });
    this.session = null;
    this.queue = Promise.resolve();
    this.archived = new Set();
    this.disposed = false;
  }
  check() { if (this.disposed) throw new Error('Окно уже закрыто.'); this.assertActive(); }
  enqueue(work) {
    this.check();
    const job = this.queue.catch(() => {}).then(async () => { this.check(); return work(await this.connection()); });
    this.queue = job;
    return job;
  }
  async connection() {
    this.check();
    if (!this.session) {
      const settings = await this.getSettings();
      this.check();
      let cwd;
      try { cwd = await this.resolveDirectory(settings.cwd || this.fallbackCwd); }
      catch { cwd = await this.resolveDirectory(this.fallbackCwd); }
      this.check();
      this.session = this.createSession({ ...settings, cwd });
    }
    await this.session.start();
    this.check();
    const session = this.session, client = session.client, generation = session.generation;
    return async (method, params) => {
      this.check();
      session.assertActive(generation);
      if (session.client !== client) throw new Error('Подключение Codex изменилось.');
      // Workspace operations deliberately avoid the tab RPC cwd override.
      const result = await client.request(method, params);
      this.check();
      session.assertActive(generation);
      if (session.client !== client) throw new Error('Подключение Codex изменилось.');
      return result;
    };
  }
  async archivedPage(request, cursor) {
    const result = await request('thread/list', { archived: true, limit: 100, sortKey: 'updated_at', sourceKinds, modelProviders: [], ...(cursor ? { cursor } : {}) });
    for (const thread of result.data ?? []) { this.archived.add(thread.id); this.coordinator.remember(thread); }
    return { data: result.data ?? [], nextCursor: result.nextCursor ?? null };
  }
  listArchivedThreads(cursor) {
    checkCursor(cursor);
    return this.enqueue(async request => {
      if (!cursor) this.archived.clear();
      return this.archivedPage(request, cursor);
    });
  }
  searchThreads(options) {
    if (!options || typeof options.query !== 'string' || !options.query.trim() || options.query.length > 500 || /[\r\n\0]/.test(options.query)) throw new Error('Введите название диалога для поиска (до 500 символов).');
    if (typeof options.archived !== 'boolean') throw new Error('Укажите область поиска диалогов.');
    checkCursor(options.cursor);
    const query = options.query.trim(), archived = options.archived, cursor = options.cursor;
    return this.enqueue(async request => {
      const result = await request('thread/list', { searchTerm: query, archived, limit: 100, sortKey: 'updated_at', sourceKinds, modelProviders: [], ...(cursor ? { cursor } : {}) });
      for (const thread of result.data ?? []) this.coordinator.remember(thread);
      return { data: result.data ?? [], nextCursor: result.nextCursor ?? null };
    });
  }
  async requireArchived(request, threadId) {
    // Verify against the server even if the UI cached the thread before a restore
    // in another client; Thread itself has no archived property in this protocol.
    let cursor;
    const seen = new Set();
    do {
      const page = await this.archivedPage(request, cursor);
      if (page.data.some(thread => thread.id === threadId)) return;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex повторил страницу архива.');
      seen.add(cursor);
    } while (cursor);
    this.archived.delete(threadId);
    throw new Error('Диалог уже не находится в архиве. Обновите список.');
  }
  readArchivedThread(options) {
    checkId(options?.threadId); checkCursor(options?.cursor);
    return this.enqueue(async request => {
      const { threadId, cursor } = options;
      await this.requireArchived(request, threadId);
      let { thread } = await request('thread/read', { threadId, includeTurns: false });
      if (thread?.id !== threadId) throw new Error('Codex вернул другой диалог.');
      this.coordinator.remember(thread);
      if (thread.historyMode === 'paginated') {
        const page = await request('thread/items/list', { threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
        return { thread, items: [...(page.data ?? [])].reverse().map(entry => ({ ...entry.item, turnId: entry.turnId, complete: true })), turns: [], nextCursor: page.nextCursor ?? null };
      }
      if (cursor) throw new Error('Для этой истории нет следующей страницы.');
      ({ thread } = await request('thread/read', { threadId, includeTurns: true }));
      if (thread?.id !== threadId) throw new Error('Codex вернул другой диалог.');
      const turns = thread.turns ?? [];
      return { thread, items: turns.flatMap(turn => (turn.items ?? []).map(item => ({ ...item, turnId: turn.id, complete: true }))), turns, nextCursor: null };
    });
  }
  readArchivedMetadata(threadId) {
    checkId(threadId);
    return this.enqueue(async request => {
      await this.requireArchived(request, threadId);
      const { thread } = await request('thread/read', { threadId, includeTurns: false });
      if (thread?.id !== threadId || typeof thread.cwd !== 'string') throw new Error('Codex вернул другой диалог.');
      return thread;
    });
  }
  affectedSessions(threadId) {
    return [...this.getSessions()].filter(session => !session.disposed && [session.currentThreadId, session.terminal?.threadId, ...session.activeThreadTurns.keys(), ...session.pendingThreadIds.keys()].some(id => id && this.coordinator.related(id, threadId)));
  }
  assertIdle(threadId) {
    for (const session of this.affectedSessions(threadId)) {
      if (session.terminal || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size) throw new Error('Дождитесь завершения работы и подтверждений диалога; закройте его терминал.');
    }
  }
  manageThread(options) {
    this.check();
    if (!options || !['rename', 'archive', 'delete', 'restore'].includes(options.action)) throw new Error('Неизвестное действие с диалогом.');
    const { action, threadId, cwd } = options;
    checkId(threadId);
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096 || !path.isAbsolute(cwd)) throw new Error('Некорректная папка диалога.');
    const name = typeof options.name === 'string' ? options.name.trim() : '';
    if (action === 'rename' && (!name || name.length > 200 || /[\r\n\0]/.test(name))) throw new Error('Название должно содержать от 1 до 200 символов в одной строке.');
    this.assertIdle(threadId);
    const release = this.coordinator.reserve(threadId);
    const job = this.enqueue(async request => {
      const { thread } = await request('thread/read', { threadId, includeTurns: false });
      if (thread?.id !== threadId) throw new Error('Codex вернул другой диалог.');
      if (!thread.cwd || key(thread.cwd) !== key(cwd)) throw new Error('Диалог находится в другой рабочей папке.');
      this.coordinator.remember(thread);
      // Resolve known open threads' parent chains before touching descendants.
      for (const session of this.getSessions()) {
        const ids = new Set([session.currentThreadId, session.terminal?.threadId, ...session.pendingThreadIds.keys(), ...session.activeThreadTurns.keys()]);
        for (let id of ids) {
          const seen = new Set();
          while (id && !seen.has(id) && id !== threadId) {
            seen.add(id);
            let metadata = this.coordinator.threads.get(id);
            if (!metadata) {
              try { metadata = (await request('thread/read', { threadId: id, includeTurns: false })).thread; }
              catch { break; } // An unrelated old tab may refer to a removed thread.
              this.coordinator.remember(metadata);
            }
            id = metadata?.parentThreadId;
          }
        }
      }
      this.assertIdle(threadId);
      if (active(thread)) throw new Error('Дождитесь завершения работы диалога.');
      if (action === 'restore') await this.requireArchived(request, threadId);
      const affected = new Set([threadId]);
      const eventName = { archive: 'thread/archived', delete: 'thread/deleted', restore: 'thread/unarchived', rename: 'thread/name/updated' }[action];
      const client = this.session.client;
      const observe = data => {
        if (data.method !== eventName || typeof data.params?.threadId !== 'string') return;
        affected.add(data.params.threadId);
        if (action === 'archive' || action === 'delete') this.coordinator.blocked.set(data.params.threadId, action);
      };
      client.on('notification', observe);
      let result;
      try {
        const method = { archive: 'thread/archive', delete: 'thread/delete', restore: 'thread/unarchive', rename: 'thread/name/set' }[action];
        result = await request(method, { threadId, ...(action === 'rename' ? { name } : {}) });
        if (action === 'archive' || action === 'delete') {
          const related = new Set([...this.coordinator.threads.keys()].filter(id => this.coordinator.related(id, threadId)));
          // The ACK can precede notification frames. Keep observing through a
          // read barrier, and reconcile archive's best-effort descendant changes.
          // Delete's documented success means every spawned descendant is gone.
          if (action === 'delete') for (const id of related) affected.add(id);
          try {
            let cursor;
            const seen = new Set();
            do {
              const page = await request('thread/list', { archived: true, limit: 100, sortKey: 'updated_at', sourceKinds: allSourceKinds, modelProviders: [], ...(cursor ? { cursor } : {}) });
              if (action === 'archive') {
                for (const entry of page.data ?? []) if (related.has(entry.id)) affected.add(entry.id);
              }
              cursor = action === 'archive' && [...related].some(id => !affected.has(id)) ? page.nextCursor : null;
              if (cursor && seen.has(cursor)) break;
              seen.add(cursor);
            } while (cursor);
          } catch { /* The mutation already succeeded; reads must not reverse it. */ }
        }
      } finally { client.off('notification', observe); }
      if (action === 'archive' || action === 'delete') {
        for (const id of affected) { this.coordinator.blocked.set(id, action); if (action === 'archive') this.archived.add(id); else this.archived.delete(id); }
      } else if (action === 'restore') {
        this.coordinator.blocked.delete(threadId); this.archived.delete(threadId);
        // Restoring the persisted conversation is valid even when cwd was removed.
        await this.onRestore(thread.cwd).catch(() => {});
      }
      const updated = result?.thread ?? (action === 'rename' ? { ...thread, name } : undefined);
      if (updated) this.coordinator.remember(updated);
      return { ...(updated ? { thread: updated } : {}), affectedThreadIds: [...affected] };
    });
    return job.finally(release);
  }
  stop() { this.session?.stop(); }
  dispose() { this.disposed = true; this.session?.dispose(); }
}
