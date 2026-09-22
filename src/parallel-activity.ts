import type { Item, TurnWork } from './types';

export type ParallelSession = {
  id: string; cwd: string; title: string; threadId?: string; provider?: string;
  busy?: boolean; terminalOpen?: boolean; pending?: number; loading?: boolean;
  archived?: boolean; changedFiles?: string[];
};
export type ParallelFile = { path: string; label: string; sessionIds: string[] };
export type ParallelActivity = { cwd: string; sessions: ParallelSession[]; overlaps: ParallelFile[] };

/** Lexical Windows path identity; separate worktree folders remain separate. */
export function activityPath(path: string, cwd = ''): string {
  let value = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/^\/([a-z]:\/)/i, '$1');
  if (cwd && !/^(?:[a-z]:\/|\/)/i.test(value)) value = `${activityPath(cwd)}/${value}`;
  const prefix = value.startsWith('//') ? '//' : value.startsWith('/') ? '/' : /^[a-z]:\//i.test(value) ? value.slice(0, 3) : '';
  const segments: string[] = [];
  // The server/share pair of a UNC path cannot be traversed above.
  const floor = prefix === '//' ? 2 : 0;
  for (const segment of value.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length > floor && segments.at(-1) !== '..') segments.pop();
    else if (segment !== '..' || !prefix) segments.push(segment);
  }
  return prefix + segments.join('/');
}

/** Successful public fileChange events only, restricted to currently running turns. */
export function collectActiveChangedFiles(items: Item[], turnWork: Record<string, TurnWork>, busy: boolean): string[] {
  if (!busy) return [];
  const paths = new Set<string>();
  for (const item of items) {
    if (item.type !== 'fileChange' || item.status !== 'completed' || !item.turnId || turnWork[item.turnId]?.status !== 'inProgress' || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      for (const path of [change?.path, change?.kind?.move_path, change?.kind?.movePath]) {
        if (typeof path === 'string' && path.trim()) paths.add(path);
      }
    }
  }
  return [...paths];
}

const folderKey = (cwd: string) => activityPath(cwd).toLowerCase();
const conversationKey = (session: ParallelSession) => session.threadId ? `${session.provider || 'codex'}:${session.threadId}` : `tab:${session.id}`;

/** A repeated view of the same conversation is one task, even across tabs. */
export function parallelActivity(sessions: ParallelSession[], activeId: string): ParallelActivity | null {
  const active = sessions.find(session => session.id === activeId);
  if (!active || active.archived || !active.cwd) return null;
  const cwd = activityPath(active.cwd);
  const grouped = new Map<string, ParallelSession>([[conversationKey(active), active]]);
  for (const session of sessions) {
    if (session.archived || !session.cwd || folderKey(session.cwd) !== folderKey(cwd)) continue;
    const key = conversationKey(session);
    if (key === conversationKey(active)) continue;
    const previous = grouped.get(key);
    if (!previous || session.busy && !previous.busy) grouped.set(key, session);
  }
  const distinct = [...grouped.values()];
  if (distinct.length < 2) return null;
  const files = new Map<string, ParallelFile>();
  for (const session of distinct) {
    if (!session.busy || session.terminalOpen || session.loading) continue;
    for (const changed of session.changedFiles || []) {
      if (!changed.trim()) continue;
      const path = activityPath(changed, cwd), key = path.toLowerCase();
      let file = files.get(key);
      if (!file) {
        const base = cwd.replace(/\/$/, '') + '/';
        file = { path, label: key.startsWith(base.toLowerCase()) ? path.slice(base.length) : path, sessionIds: [] };
        files.set(key, file);
      }
      if (!file.sessionIds.includes(session.id)) file.sessionIds.push(session.id);
    }
  }
  return { cwd, sessions: distinct, overlaps: [...files.values()].filter(file => file.sessionIds.length > 1) };
}
