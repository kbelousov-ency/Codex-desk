import { Fragment, useState } from 'react';
import { ChevronRight, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import AgentLogo from './AgentLogo';
import { folderName } from './useCodex';
import { executorCountText } from './executor-agents';
import type { Thread } from './types';
import ThreadMenu, { type ThreadAction } from './ThreadMenu';
import ProjectMenu from './ProjectMenu';
import { BulkArchiveBar, BulkThreadCheckbox, bulkActive, type BulkArchiveControls } from './BulkArchive';
import { bulkThreadTitle } from './bulk-archive';
import type { BulkRow, BulkScope } from './bulk-archive';
import type { ExecutorThread } from './types';

export const projectKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
export type ProjectHistory = { threads: Thread[]; cursor: string | null; loaded: boolean; loading: boolean; error: string };
export type ProjectTreeControls = BulkArchiveControls & {
  openLibrary?(): void;
  projects: string[];
  expanded: Record<string, boolean>;
  histories: Record<string, ProjectHistory>;
  threadNames?: Record<string, string>;
  /** Dependent conversations of each folder, read separately from its history page. */
  childHistories?: Record<string, ProjectHistory>;
  /** Collapsed state per parent group, keyed by `projectKey|parentId`. */
  expandedGroups?: Record<string, boolean>;
  toggleGroup?(cwd: string, parentId: string): void;
  refreshChildren?(cwd: string, cursor?: string): void;
  /** Executor agents of one conversation. `cwd` is stated because a tree row may belong to a
   * folder that has no open tab to read it from. */
  childThreads?(parentThreadId: string, cwd?: string): ExecutorThread[];
  childCount?(threadId: string, cwd?: string): number;
  childParentOf?(threadId: string): string | undefined;
  /** Opens an executor keeping it under its parent: an already open tab is activated, otherwise
   * the parent tab is opened first and the executor appears selected in its «Исполнители» row. */
  openChildThread?(cwd: string, thread: ExecutorThread): void;
  /** Breadcrumb navigation from an executor back to the conversation it belongs to. */
  openParentThread?(cwd: string, parentThreadId: string): void;
  activeCwd: string;
  activeThreadId?: string;
  opening: boolean;
  archiveOpen?: boolean;
  archiveThreads?: Thread[];
  archiveLoading?: boolean;
  archiveError?: string;
  archiveCursor?: string | null;
  archiveThreadId?: string;
  actionBusy?: boolean;
  searchRevision?: number;
  toggleArchive?(): void;
  refreshArchive?(cursor?: string): void;
  openArchivedThread?(thread: Thread): void;
  threadAction?(action: ThreadAction, cwd: string, thread: Thread): void;
  threadLocked?(threadId: string): boolean;
  addProject(): void;
  closeProject?(cwd: string): void;
  newWorktree?(cwd: string): void;
  showTasks?(cwd: string): void;
  newChat(cwd: string): void;
  toggleProject(cwd: string): void;
  refreshProject(cwd: string, cursor?: string): void;
  openThread(cwd: string, thread: Thread): void;
};

export default function ProjectTree({ controls, active = true }: { controls: ProjectTreeControls; active?: boolean }) {
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  return <nav className="project-tree" aria-label="Рабочие папки и диалоги">
    {controls.projects.map(cwd => {
      const key = projectKey(cwd);
      const name = folderName(cwd);
      const expanded = Boolean(controls.expanded[key]);
      const history = controls.histories[key];
      const activeFolder = projectKey(controls.activeCwd) === key;
      // Multi-select scope for this row of the tree: the loaded history of this folder only.
      const scope: BulkScope = { kind: 'folder', cwd };
      const picking = bulkActive(controls, scope);
      const children = controls.childHistories?.[key];
      // An executor agent is a plain dialog of the same folder, so the history page lists it
      // next to its parent. Deduplicate the page by id, then nest every executor under the
      // parent it belongs to; one whose parent is not on the loaded page stays in the flat
      // list, so nothing can quietly disappear from the folder.
      const page = new Map((history?.threads || []).map(thread => [thread.id, thread]));
      const rows: BulkRow[] = [...page.values()].map(thread => ({ thread, cwd: thread.cwd || cwd }));
      const executors = new Map<string, Thread[]>();
      for (const thread of page.values()) {
        const parentId = controls.childParentOf?.(thread.id);
        if (!parentId || parentId === thread.id || !page.has(parentId)) continue;
        executors.set(parentId, [...(executors.get(parentId) || []), thread]);
      }
      const nested = new Set([...executors.values()].flat().map(thread => thread.id));
      const visibleCount = visibleCounts[key] || 10;
      const displayThreads = [...page.values()].filter(thread => picking || !nested.has(thread.id));
      const hasHiddenThreads = displayThreads.length > visibleCount;
      const showMore = () => {
        setVisibleCounts(previous => ({ ...previous, [key]: visibleCount + 10 }));
        if (!hasHiddenThreads && history?.cursor) controls.refreshProject(cwd, history.cursor);
      };
      type Disclosure = { count: number; open: boolean; toggle(): void };
      // A nested row is an executor: opening it must keep it under its parent, not create a
      // second, independent top-level tab that would also duplicate the «Исполнители» row.
      const openRow = (thread: Thread, executor: boolean) => executor && controls.openChildThread
        ? controls.openChildThread(thread.cwd || cwd, { ...thread, label: controls.threadNames?.[thread.id] || thread.name })
        : controls.openThread(thread.cwd || cwd, thread);
      const renderRow = (thread: Thread, disclosure?: Disclosure, executor = false) => {
        const title = bulkThreadTitle(thread, controls.threadNames);
        const selected = activeFolder && controls.activeThreadId === thread.id;
        const checked = picking && (controls.bulkSelected || []).includes(thread.id);
        const count = disclosure?.count || 0;
        // The counter badge is the disclosure: clicking it reveals the executors of this parent.
        const badge = disclosure && count > 0 && <button type="button" className={`child-count-badge ${disclosure.open ? 'expanded' : ''}`}
          aria-expanded={disclosure.open} aria-label={`${disclosure.open ? 'Свернуть' : 'Развернуть'} ${executorCountText(count)} диалога ${title}`}
          data-tooltip={executorCountText(count)} onClick={disclosure.toggle}>{count}<ChevronRight size={9} className={disclosure.open ? 'folder-chevron expanded' : 'folder-chevron'} /></button>;
        if (picking) return <div className={`folder-thread-row bulk-row ${checked ? 'bulk-selected' : ''}`} key={thread.id}>
          <label className="folder-thread" data-thread-id={thread.id} data-tooltip={title}>
            <BulkThreadCheckbox controls={controls} scope={scope} row={{ thread, cwd: thread.cwd || cwd }} title={title} locked={controls.threadLocked} />
            <AgentLogo provider={thread.id.startsWith('claude:') ? 'claude' : 'codex'} size={12} /><span>{title}</span>
          </label>
        </div>;
        return <div className={`folder-thread-row ${selected ? 'active' : ''}`} key={thread.id}>
          <button className={`folder-thread ${selected ? 'active' : ''}`} data-thread-id={thread.id} aria-current={selected ? 'page' : undefined} data-tooltip={title} disabled={controls.opening} onClick={() => openRow(thread, executor)}><AgentLogo provider={thread.id.startsWith('claude:') ? 'claude' : 'codex'} size={12} /><span>{title}</span>{selected && <span className="folder-thread-dot" />}</button>
          {badge}
          {controls.threadAction && <ThreadMenu allowFork={false} title={title} threadId={thread.id} active={active}
            disabled={controls.opening || controls.actionBusy || controls.threadLocked?.(thread.id)}
            onAction={action => controls.threadAction?.(action, thread.cwd || cwd, thread)}
            />}
        </div>;
      };
      const renderParent = (thread: Thread) => {
        const kids = executors.get(thread.id) || [];
        const open = Boolean(controls.expandedGroups?.[`${key}|${thread.id}`]);
        const title = bulkThreadTitle(thread, controls.threadNames);
        return <Fragment key={thread.id}>
          {renderRow(thread, { count: kids.length, open, toggle: () => controls.toggleGroup?.(cwd, thread.id) })}
          {open && kids.length > 0 && <div className="folder-thread-children" aria-label={`Агенты-исполнители диалога ${title}`}>{kids.map(child => renderRow(child, undefined, true))}</div>}
        </Fragment>;
      };
      return <section className={`folder-tree-entry ${activeFolder ? 'active-folder' : ''}`} data-cwd={cwd} key={key}>
        <ProjectMenu name={name} active={active} disabled={controls.opening || Boolean(controls.actionBusy) || !controls.closeProject} onClose={() => controls.closeProject?.(cwd)} onWorktree={controls.newWorktree ? () => controls.newWorktree?.(cwd) : undefined} onTasks={controls.showTasks ? () => controls.showTasks?.(cwd) : undefined} onBulkArchive={!picking && history?.loaded && rows.length ? () => controls.startBulk?.(scope) : undefined}>
          <button className="folder-toggle" aria-label={`Диалоги папки ${name}`} aria-expanded={expanded} data-tooltip={cwd} onClick={() => controls.toggleProject(cwd)}><span>{name}</span><ChevronRight size={12} className={expanded ? 'folder-chevron expanded' : 'folder-chevron'} /></button>
          {expanded && <button className="icon-button small folder-refresh" aria-label={`Обновить диалоги ${name}`} data-tooltip="Обновить диалоги" disabled={history?.loading || children?.loading} onClick={() => { controls.refreshProject(cwd); controls.refreshChildren?.(cwd); }}><RefreshCw size={12} className={history?.loading || children?.loading ? 'spin' : ''} /></button>}
          <button className="icon-button small folder-add" aria-label={`Новый диалог в папке ${name}`} data-tooltip={`Новый диалог в папке ${name}`} disabled={controls.opening} onClick={() => controls.newChat(cwd)}><Plus size={15} /></button>
        </ProjectMenu>
        {expanded && <div className="folder-threads" aria-label={`Диалоги ${name}`}>
          {picking && <BulkArchiveBar controls={controls} scope={scope} label={`папка ${name}`} rows={rows.slice(0, visibleCount)} morePages={hasHiddenThreads || Boolean(history?.cursor)} locked={controls.threadLocked} />}
          {displayThreads.slice(0, visibleCount).map(thread => picking ? renderRow(thread) : renderParent(thread))}
          {history?.error ? <div className="folder-history-error" role="alert"><span>{history.error}</span><button className="text-button" onClick={() => controls.refreshProject(cwd)}>Повторить</button></div> : history?.loading ? <div className="folder-history-status"><LoaderCircle size={12} className="spin" /><span>Загружаем диалоги…</span></div> : history?.loaded && !history.threads.length ? <p className="folder-history-status">Пока нет диалогов</p> : null}
          {(hasHiddenThreads || history?.cursor) && !history?.error && <button className="text-button folder-history-more" disabled={history?.loading} onClick={showMore}>Показать ещё</button>}
        </div>}
      </section>;
    })}
    {!controls.projects.length && <p className="folder-history-status">Добавьте проект, чтобы открыть диалог.</p>}
  </nav>;
}
