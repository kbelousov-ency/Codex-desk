import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ChevronRight, LoaderCircle, MessageSquare, Plus, RefreshCw, Search, X } from 'lucide-react';
import ProjectTree, { projectKey, type ProjectTreeControls } from './ProjectTree';
import ThreadMenu from './ThreadMenu';
import { DiagnosticsButton } from './Diagnostics';
import { folderName } from './useCodex';
import type { Thread } from './types';
import './archive.css';
import './dialog-search.css';

function groupThreads(threads: Thread[]) {
  const folders = new Map<string, { cwd: string; threads: Thread[] }>();
  for (const thread of threads) {
    const cwd = thread.cwd || '';
    const key = projectKey(cwd);
    const group = folders.get(key) || { cwd, threads: [] };
    group.threads.push(thread);
    folders.set(key, group);
  }
  return [...folders.entries()];
}

function DialogSearch({ controls, archived, active, query, onQuery }: {
  controls: ProjectTreeControls; archived: boolean; active: boolean; query: string; onQuery(value: string): void;
}) {
  const normalized = query.trim();
  const requestKey = JSON.stringify([normalized, archived, controls.searchRevision, active]);
  const currentKey = useRef(requestKey);
  currentKey.current = requestKey;
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  const [result, setResult] = useState<{ key: string; data: Thread[]; cursor: string | null; loading: boolean; error: string }>({ key: '', data: [], cursor: null, loading: false, error: '' });
  const current = result.key === requestKey;
  const groups = useMemo(() => groupThreads(current ? result.data : []), [current, result.data]);
  const searching = Boolean(normalized);
  const loading = searching && (!current || result.loading);

  async function load(cursor?: string) {
    if (!active || !normalized || (cursor && pending.current)) return;
    const generation = ++sequence.current, key = requestKey;
    pending.current = true;
    setResult(previous => ({ key, data: cursor && previous.key === key ? previous.data : [], cursor: cursor || null, loading: true, error: '' }));
    try {
      const page = await window.codex.searchThreads({ query: normalized, archived, ...(cursor ? { cursor } : {}) });
      if (sequence.current !== generation || currentKey.current !== key) return;
      setResult(previous => {
        const threads = new Map((cursor ? previous.data : []).map(thread => [thread.id, thread]));
        for (const thread of page.data) threads.set(thread.id, thread);
        return { key, data: [...threads.values()], cursor: page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null, loading: false, error: '' };
      });
    } catch (error) {
      if (sequence.current !== generation || currentKey.current !== key) return;
      setResult(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
    } finally { if (sequence.current === generation) pending.current = false; }
  }

  useEffect(() => {
    if (!active || !normalized) return;
    const timer = window.setTimeout(() => void load(), 250);
    return () => { window.clearTimeout(timer); sequence.current++; pending.current = false; };
  }, [requestKey]);

  const clear = () => { onQuery(''); input.current?.focus(); };
  return <>
    <div className="dialog-search-control">
      <div className="dialog-search-input"><Search size={13} /><input ref={input} type="text" autoComplete="off" maxLength={500} aria-label={archived ? 'Поиск в архиве' : 'Поиск диалогов'} placeholder="Найти диалог…" value={query} onChange={event => onQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); } }} />{query && <button type="button" className="icon-button small" aria-label="Очистить поиск диалогов" title="Очистить поиск" onClick={clear}><X size={12} /></button>}</div>
      {searching && <span className="dialog-search-hint">По названию диалога</span>}
    </div>
    {searching && <nav className="dialog-search-results" aria-label="Результаты поиска диалогов" aria-busy={loading}>
      {groups.map(([key, group]) => <section className="folder-tree-entry dialog-search-folder" data-cwd={group.cwd} key={key}>
        <div className="dialog-search-folder-heading" title={group.cwd}><span>{group.cwd ? folderName(group.cwd) : 'Без рабочей папки'}</span><span className="archive-folder-count">{group.threads.length}</span></div>
        <div className="folder-threads">{group.threads.map(thread => {
          const title = thread.name || thread.preview || 'Новый диалог';
          const selected = (archived ? controls.archiveThreadId : controls.activeThreadId) === thread.id;
          return <div key={thread.id} className={`folder-thread-row ${selected ? 'active' : ''}`}>
            <button className={`folder-thread ${archived ? 'archived-thread archive-thread' : ''} ${selected ? 'active' : ''}`} data-thread-id={thread.id} title={title} aria-current={selected ? 'page' : undefined} disabled={controls.opening} onClick={() => archived ? controls.openArchivedThread?.(thread) : controls.openThread(group.cwd, thread)}><MessageSquare size={12} /><span>{title}</span>{selected && <span className="folder-thread-dot" />}</button>
            {controls.threadAction && <ThreadMenu title={title} threadId={thread.id} archived={archived} active={active} disabled={controls.opening || controls.actionBusy || controls.threadLocked?.(thread.id)} onAction={action => controls.threadAction?.(action, group.cwd, thread)} />}
          </div>;
        })}</div>
      </section>)}
      {current && result.error ? <div className="folder-history-error" role="alert"><span>{result.error}</span><button className="text-button" onClick={() => void load(result.cursor || undefined)}>Повторить</button></div> : loading ? <div className="folder-history-status" role="status"><LoaderCircle size={12} className="spin" /><span>Ищем диалоги…</span></div> : !groups.length ? <p className="folder-history-status" role="status">Диалоги не найдены</p> : null}
      {current && result.cursor && !result.error && <button className="text-button folder-history-more" disabled={loading} onClick={() => void load(result.cursor!)}>Загрузить ещё</button>}
    </nav>}
  </>;
}

export default function ProjectSidebar({ controls, active = true }: { controls: ProjectTreeControls; active?: boolean }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [archiveQuery, setArchiveQuery] = useState('');
  const groups = useMemo(() => groupThreads(controls.archiveThreads || []), [controls.archiveThreads]);
  const archiveOpen = Boolean(controls.archiveOpen);

  return <div className="project-sidebar">
    <div className="project-sidebar-content">
      <div className="project-sidebar-main" hidden={archiveOpen}>
        <button className="new-project" aria-label="Новый проект" title="Выбрать новую рабочую папку" disabled={controls.opening} onClick={controls.addProject}><Plus size={15} /><span>Новый проект</span></button>
        <DialogSearch controls={controls} query={query} onQuery={setQuery} archived={false} active={active && !archiveOpen} />
        {!query.trim() && <ProjectTree controls={controls} active={active && !archiveOpen} />}
      </div>
      {archiveOpen && <section className="archive-panel" role="region" aria-label="Архив диалогов">
        <div className="archive-heading">
          <button className="icon-button small" aria-label="К проектам" title="К проектам" onClick={controls.toggleArchive}><ArrowLeft size={15} /></button>
          <strong>Архив</strong>
          <button className="icon-button small archive-refresh" aria-label="Обновить архив" title="Обновить архив" disabled={controls.archiveLoading || controls.actionBusy} onClick={() => controls.refreshArchive?.()}><RefreshCw size={12} className={controls.archiveLoading ? 'spin' : ''} /></button>
        </div>
        <DialogSearch controls={controls} query={archiveQuery} onQuery={setArchiveQuery} archived active={active} />
        {!archiveQuery.trim() && <nav className="archive-tree" aria-label="Архив по папкам">
          {groups.map(([key, group]) => {
            const name = group.cwd ? folderName(group.cwd) : 'Без рабочей папки';
            const expanded = !collapsed[key];
            return <section key={key} className="folder-tree-entry archive-folder" data-cwd={group.cwd}>
              <div className="folder-tree-row"><button className="folder-toggle" aria-label={`Архив папки ${name}`} aria-expanded={expanded} title={group.cwd || name} onClick={() => setCollapsed(previous => ({ ...previous, [key]: !previous[key] }))}><span>{name}</span><ChevronRight size={12} className={expanded ? 'folder-chevron expanded' : 'folder-chevron'} /></button><span className="archive-folder-count">{group.threads.length}</span></div>
              {expanded && <div className="folder-threads" aria-label={`Архив ${name}`}>{group.threads.map(thread => {
                const title = thread.name || thread.preview || 'Новый диалог';
                const selected = controls.archiveThreadId === thread.id;
                return <div key={thread.id} className={`folder-thread-row ${selected ? 'active' : ''}`}>
                  <button className={`folder-thread archived-thread archive-thread ${selected ? 'active' : ''}`} data-thread-id={thread.id} title={title} aria-current={selected ? 'page' : undefined} disabled={controls.opening} onClick={() => controls.openArchivedThread?.(thread)}><MessageSquare size={12} /><span>{title}</span>{selected && <span className="folder-thread-dot" />}</button>
                  {controls.threadAction && <ThreadMenu title={title} threadId={thread.id} archived active={active} disabled={controls.opening || controls.actionBusy || controls.threadLocked?.(thread.id)} onAction={action => controls.threadAction?.(action, group.cwd, thread)} />}
                </div>;
              })}</div>}
            </section>;
          })}
          {controls.archiveError ? <div className="folder-history-error" role="alert"><span>{controls.archiveError}</span><button className="text-button" disabled={controls.archiveLoading} onClick={() => controls.refreshArchive?.()}>Повторить</button></div> : controls.archiveLoading ? <div className="folder-history-status"><LoaderCircle size={12} className="spin" /><span>Загружаем архив…</span></div> : !groups.length ? <div className="archive-empty"><Archive size={24} /><p>Архив пуст</p><span>Архивированные диалоги появятся здесь.</span></div> : null}
          {controls.archiveCursor && !controls.archiveError && <button className="text-button folder-history-more" disabled={controls.archiveLoading} onClick={() => controls.refreshArchive?.(controls.archiveCursor!)}>Загрузить ещё</button>}
        </nav>}
      </section>}
    </div>
    {controls.toggleArchive && <button className={`archive-toggle ${archiveOpen ? 'active' : ''}`} aria-label="Архив" aria-expanded={archiveOpen} onClick={controls.toggleArchive}><Archive size={14} /><span>Архив</span><ChevronRight size={12} className={archiveOpen ? 'archive-toggle-chevron expanded' : 'archive-toggle-chevron'} /></button>}
    <DiagnosticsButton active={active} />
  </div>;
}
