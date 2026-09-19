import path from 'node:path';
import { directoryPath } from './host-utils.mjs';

const directoryKey = cwd => process.platform === 'win32' ? path.normalize(cwd).toLowerCase() : path.normalize(cwd);

/** Read saved folder history without changing a tab's cwd or starting a model turn. */
export async function listProjectThreads({ record, workspaceStore, cwd, cursor, assertWindow, createHistorySession, resolveDirectory = directoryPath }) {
  assertWindow();
  if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096) throw new Error('Некорректная папка проекта.');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 16384)) throw new Error('Некорректная страница истории.');
  const requested = await resolveDirectory(cwd);
  assertWindow();
  const workspace = await workspaceStore.snapshot();
  assertWindow();
  // Saved entries can be aliases, differ in casing, or refer to deleted folders.
  // Only an exact existing canonical folder is allowed, never a child or parent.
  const projects = await Promise.all(workspace.projects.map(project => resolveDirectory(project).catch(() => null)));
  assertWindow();
  const registered = projects.find(project => project !== null && directoryKey(project) === directoryKey(requested));
  if (!registered) throw new Error('Папка не добавлена в рабочую область.');

  const ready = [...record.sessions].filter(([, session]) => session.settings?.provider !== 'claude' && !session.disposed && !session.terminal && session.client && session.bootstrap);
  const selected = ready.find(([, session]) => session.currentCwd && directoryKey(session.currentCwd) === directoryKey(registered))
    ?? ready[0] ?? [record.defaultSessionId, record.sessions.get(record.defaultSessionId)];
  let [id, session] = selected;
  if (!session || session.settings?.provider === 'claude' || session.disposed || session.terminal) {
    session = await createHistorySession(registered);
    id = null;
    assertWindow();
  }
  const generation = session.generation;
  const assertSession = () => {
    assertWindow();
    if ((id === null ? record.historySession : record.sessions.get(id)) !== session) throw new Error('Сессия уже закрыта.');
    session.assertActive(generation);
  };
  assertSession();
  if (!session.client || !session.bootstrap) {
    await session.start();
    assertSession();
  }
  const owned = session.client;
  if (!owned || !session.bootstrap) throw new Error('Нет подключения к Codex.');
  // This one explicit workspace read deliberately bypasses the session-level
  // request(), whose cwd forcing remains in place for all general tab RPC.
  const result = await owned.request('thread/list', {
    cwd: registered, limit: 40, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'],
    ...(cursor !== undefined ? { cursor } : {}),
  });
  assertSession();
  if (session.client !== owned) throw new Error('Подключение Codex изменилось.');
  return { data: result.data, nextCursor: result.nextCursor ?? null };
}
