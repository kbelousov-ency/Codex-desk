import type { Thread } from './types';

/** The one clearly named place a multi-select belongs to. A selection never spans two scopes:
 * either the loaded history of a single project folder, or the loaded results of a single query. */
export type BulkScope = { kind: 'folder'; cwd: string } | { kind: 'search'; query: string };
/** A conversation the user picked, together with the folder the archive call needs. */
export type BulkTarget = { id: string; cwd: string; title: string };
export type BulkBlocked = BulkTarget & { reason: string };
export type BulkOutcome = BulkTarget & { ok: boolean; error?: string };
export type BulkRow = { thread: Thread; cwd: string };

export const bulkFolderKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
export const bulkScopeKey = (scope: BulkScope) =>
  scope.kind === 'folder' ? `folder:${bulkFolderKey(scope.cwd)}` : `search:${scope.query.trim().toLowerCase()}`;
export const sameBulkScope = (a?: BulkScope | null, b?: BulkScope | null) =>
  Boolean(a) && Boolean(b) && bulkScopeKey(a!) === bulkScopeKey(b!);
export const bulkThreadTitle = (thread: Thread, names: Record<string, string> = {}) =>
  names[thread.id] || thread.name || thread.preview || 'Новый диалог';

export function conversationCount(count: number) {
  const tail = count % 100 > 10 && count % 100 < 20 ? 0 : count % 10;
  return `${count} ${tail === 1 ? 'диалог' : tail >= 2 && tail <= 4 ? 'диалога' : 'диалогов'}`;
}

/** Spelled out in the toolbar and repeated in the confirmation, so the scope is never implied. */
export function bulkScopeLabel(scope: BulkScope, folderName: (cwd: string) => string) {
  return scope.kind === 'folder' ? `папка ${folderName(scope.cwd)}` : `результаты поиска «${scope.query}»`;
}

/** Why a loaded conversation cannot take part. An empty string means it can. */
export function bulkBlockReason(thread: Thread, cwd: string, locked?: (threadId: string) => boolean) {
  if (thread.archived) return 'уже в архиве';
  if (!cwd.trim()) return 'нет рабочей папки';
  if (locked?.(thread.id)) return 'идёт работа, ожидается подтверждение или открыт терминал';
  return '';
}

export const toggleSelection = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];

/** Select all means all conversations of the stated scope that are loaded and allowed. */
export const selectableIds = (rows: BulkRow[], locked?: (threadId: string) => boolean) =>
  rows.filter(row => !bulkBlockReason(row.thread, row.cwd, locked)).map(row => row.thread.id);

/** Drops ids that left the loaded list or became busy, so a stale pick cannot be archived. */
export const keepSelectable = (ids: string[], rows: BulkRow[], locked?: (threadId: string) => boolean) => {
  const allowed = new Set(selectableIds(rows, locked));
  return ids.filter(id => allowed.has(id));
};

/** Resolves the picked ids against the rows visible right now, in their visible order. */
export function planBulkArchive({ rows, selected, names = {}, locked }: {
  rows: BulkRow[]; selected: string[]; names?: Record<string, string>; locked?(threadId: string): boolean;
}): { targets: BulkTarget[]; blocked: BulkBlocked[] } {
  const picked = new Set(selected);
  const targets: BulkTarget[] = [];
  const blocked: BulkBlocked[] = [];
  const seen = new Set<string>();
  for (const { thread, cwd } of rows) {
    if (!picked.has(thread.id) || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const entry = { id: thread.id, cwd, title: bulkThreadTitle(thread, names) };
    const reason = bulkBlockReason(thread, cwd, locked);
    if (reason) blocked.push({ ...entry, reason }); else targets.push(entry);
  }
  return { targets, blocked };
}

/** Successful archiving is never discarded because a later conversation failed. */
export function bulkArchiveReport({ outcomes, blocked = [], total, stopped = false }: {
  outcomes: BulkOutcome[]; blocked?: BulkBlocked[]; total: number; stopped?: boolean;
}) {
  const archived = outcomes.filter(outcome => outcome.ok);
  const failed = outcomes.filter(outcome => !outcome.ok);
  const untouched = Math.max(0, total - outcomes.length);
  const parts = [`Архивировано: ${archived.length} из ${total}.`];
  if (failed.length) parts.push(`Не удалось: ${failed.length}.`);
  if (untouched) parts.push(stopped ? `Остановлено, не обработано: ${untouched}.` : `Не обработано: ${untouched}.`);
  if (blocked.length) parts.push(`Пропущено как занятые или неподдерживаемые: ${blocked.length}.`);
  return { archived: archived.length, failed, untouched, message: parts.join(' ') };
}
