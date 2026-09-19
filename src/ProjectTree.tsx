import { ChevronRight, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import AgentLogo from './AgentLogo';
import { folderName } from './useCodex';
import type { Thread } from './types';
import ThreadMenu, { type ThreadAction } from './ThreadMenu';
import ProjectMenu from './ProjectMenu';

export const projectKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
export type ProjectHistory = { threads: Thread[]; cursor: string | null; loaded: boolean; loading: boolean; error: string };
export type ProjectTreeControls = {
  openLibrary?(): void;
  projects: string[];
  expanded: Record<string, boolean>;
  histories: Record<string, ProjectHistory>;
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
  newChat(cwd: string): void;
  toggleProject(cwd: string): void;
  refreshProject(cwd: string, cursor?: string): void;
  openThread(cwd: string, thread: Thread): void;
};

export default function ProjectTree({ controls, active = true }: { controls: ProjectTreeControls; active?: boolean }) {
  return <nav className="project-tree" aria-label="Рабочие папки и диалоги">
    {controls.projects.map(cwd => {
      const key = projectKey(cwd);
      const name = folderName(cwd);
      const expanded = Boolean(controls.expanded[key]);
      const history = controls.histories[key];
      const activeFolder = projectKey(controls.activeCwd) === key;
      return <section className={`folder-tree-entry ${activeFolder ? 'active-folder' : ''}`} data-cwd={cwd} key={key}>
        <ProjectMenu name={name} active={active} disabled={controls.opening || Boolean(controls.actionBusy) || !controls.closeProject} onClose={() => controls.closeProject?.(cwd)} onWorktree={controls.newWorktree ? () => controls.newWorktree?.(cwd) : undefined}>
          <button className="folder-toggle" aria-label={`Диалоги папки ${name}`} aria-expanded={expanded} title={cwd} onClick={() => controls.toggleProject(cwd)}><span>{name}</span><ChevronRight size={12} className={expanded ? 'folder-chevron expanded' : 'folder-chevron'} /></button>
          {expanded && <button className="icon-button small folder-refresh" aria-label={`Обновить диалоги ${name}`} title="Обновить диалоги" disabled={history?.loading} onClick={() => controls.refreshProject(cwd)}><RefreshCw size={12} className={history?.loading ? 'spin' : ''} /></button>}
          <button className="icon-button small folder-add" aria-label={`Новый диалог в папке ${name}`} title={`Новый диалог в папке ${name}`} disabled={controls.opening} onClick={() => controls.newChat(cwd)}><Plus size={15} /></button>
        </ProjectMenu>
        {expanded && <div className="folder-threads" aria-label={`Диалоги ${name}`}>
          {history?.threads.map(thread => {
            const title = thread.name || thread.preview || 'Новый диалог';
            const selected = activeFolder && controls.activeThreadId === thread.id;
            return <div className={`folder-thread-row ${selected ? 'active' : ''}`} key={thread.id}>
              <button className={`folder-thread ${selected ? 'active' : ''}`} data-thread-id={thread.id} aria-current={selected ? 'page' : undefined} title={title} disabled={controls.opening} onClick={() => controls.openThread(cwd, thread)}><AgentLogo provider={thread.id.startsWith('claude:') ? 'claude' : 'codex'} size={12} /><span>{title}</span>{selected && <span className="folder-thread-dot" />}</button>
              {controls.threadAction && <ThreadMenu title={title} threadId={thread.id} archivable={!thread.id.startsWith('claude:')} active={active} disabled={controls.opening || controls.actionBusy || controls.threadLocked?.(thread.id)} onAction={action => controls.threadAction?.(action, cwd, thread)} />}
            </div>;
          })}
          {history?.error ? <div className="folder-history-error" role="alert"><span>{history.error}</span><button className="text-button" onClick={() => controls.refreshProject(cwd)}>Повторить</button></div> : history?.loading ? <div className="folder-history-status"><LoaderCircle size={12} className="spin" /><span>Загружаем диалоги…</span></div> : history?.loaded && !history.threads.length ? <p className="folder-history-status">Пока нет диалогов</p> : null}
          {history?.cursor && !history.error && <button className="text-button folder-history-more" disabled={history.loading} onClick={() => controls.refreshProject(cwd, history.cursor!)}>Загрузить ещё</button>}
        </div>}
      </section>;
    })}
    {!controls.projects.length && <p className="folder-history-status">Добавьте проект, чтобы открыть диалог.</p>}
  </nav>;
}
