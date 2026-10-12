import { directoryPath } from './host-utils.mjs';
import { checkHistoryCursor, folderReader } from './project-history.mjs';

/** Every subagent source kind. The interactive lists deliberately keep using
 * ['appServer','cli','vscode'], so dependent conversations are read separately and
 * never mixed into the folder history page or its cursor. */
export const childSourceKinds = ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];

/**
 * Read the dependent (child) conversations of one registered folder.
 *
 * Measured on Codex App Server 0.156.1: `parentThreadId` is populated only when all three
 * hold at once — `sourceKinds` includes the subAgent kinds, a `cwd` filter is passed, and
 * `useStateDbOnly` is not set. The field is filled by the JSONL scan-and-repair pass, not by
 * the state DB, so none of the three may be dropped as an optimisation.
 *
 * Read-only: one `thread/list`. No mutation, no model turn, no change to any tab's settings.
 */
export async function listThreadChildren({ record, workspaceStore, cwd, cursor, limit = 100, assertWindow, createHistorySession, resolveDirectory = directoryPath }) {
  checkHistoryCursor(cursor);
  const { registered, request } = await folderReader({ record, workspaceStore, cwd, assertWindow, createHistorySession, resolveDirectory });
  const result = await request('thread/list', {
    cwd: registered, limit, sortKey: 'updated_at', sourceKinds: childSourceKinds,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  // `archived` is left unset: the protocol then returns only non-archived threads, so an
  // archived child cannot reappear in the sidebar through this path.
  return { data: (result.data ?? []).filter(thread => thread && typeof thread.id === 'string'), nextCursor: result.nextCursor ?? null };
}
