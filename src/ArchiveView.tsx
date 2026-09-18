import { useEffect, useRef, useState } from 'react';
import { Archive, LoaderCircle, RefreshCw, RotateCcw, Search, Terminal } from 'lucide-react';
import type { Item, Thread, TurnWork } from './types';
import type { WorkspaceControls } from './App';
import { BridgeContext } from './BridgeContext';
import { BuildBadge } from './BuildInfo';
import ProjectSidebar from './ProjectSidebar';
import ChatSearch from './ChatSearch';
import { mergeHistoricalTurnWork } from './turn-work';
import { errorText, folderName } from './useCodex';
import './archive-view.css';

export default function ArchiveView({ thread, active, workspace }: { thread: Thread; active: boolean; workspace: WorkspaceControls }) {
  const [items, setItems] = useState<Item[]>([]);
  const [turnWork, setTurnWork] = useState<Record<string, TurnWork>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const load = async (next?: string) => {
    const request = ++requestRef.current;
    setLoading(true); setError('');
    try {
      const page = await window.codex.readArchivedThread({ threadId: thread.id, ...(next ? { cursor: next } : {}) });
      if (request !== requestRef.current) return;
      setItems(previous => next ? [...page.items.filter(item => !previous.some(old => old.id === item.id)), ...previous] : page.items);
      setTurnWork(previous => mergeHistoricalTurnWork(next ? previous : {}, page.turns || []));
      setCursor(page.nextCursor);
    } catch (e) { if (request === requestRef.current) setError(errorText(e)); }
    finally { if (request === requestRef.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { requestRef.current++; }; }, [thread.id]);
  const openSearch = () => {
    setShowSearch(true);
    requestAnimationFrame(() => chatRef.current?.querySelector<HTMLInputElement>('[aria-label="Найти в чате"]')?.focus());
  };
  useEffect(() => {
    if (!active) return;
    const find = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.altKey && !document.querySelector('[aria-modal="true"]')) { event.preventDefault(); openSearch(); }
    };
    document.addEventListener('keydown', find); return () => document.removeEventListener('keydown', find);
  }, [active]);
  const readonlyBridge = {
    ...window.codex,
    openPath: (target: string) => window.codex.openArchivedPath({ threadId: thread.id, target }),
    showPathMenu: (target: string) => window.codex.openArchivedPath({ threadId: thread.id, target, menu: true }),
  };
  return <BridgeContext.Provider value={readonlyBridge}><div className="app-shell panel-hidden archive-view">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Terminal size={19} strokeWidth={2.4} /></div><span>codex<span className="brand-light"> desk</span></span><BuildBadge /></div>
      <ProjectSidebar controls={workspace} active={active} />
      <div className="sidebar-bottom"><div className="local-engine"><Archive size={12} /><span>Архив Codex</span></div></div>
    </aside>
    <main className="main-column">
      <header className="topbar"><Archive size={16} /><div className="breadcrumbs"><span>{folderName(thread.cwd || '') || 'Архив'}</span><strong>{thread.name || thread.preview || 'Диалог'}</strong></div><button ref={searchButtonRef} type="button" className="icon-button" aria-label="Поиск в чате" title="Поиск в чате (Ctrl+F)" aria-expanded={showSearch} onClick={openSearch}><Search size={17} /></button><span className="archive-readonly-badge">Только чтение</span></header>
      <div ref={chatRef} className="chat-scroll"><div className="conversation">
        {cursor && !showSearch && <button className="secondary-button load-earlier" disabled={loading} onClick={() => void load(cursor)}>Загрузить предыдущие сообщения</button>}
        {loading && <div className="loading-chat"><LoaderCircle size={16} className="spin" />Загружаем архивный диалог…</div>}
        {error && <div className="alert error-alert" role="alert"><span>{error}</span><button className="text-button" onClick={() => void load()}><RefreshCw size={13} />Повторить</button></div>}
        <ChatSearch items={items} turnWork={turnWork} open={showSearch} active={active} onClose={() => { setShowSearch(false); searchButtonRef.current?.focus({ preventScroll: true }); }} hasEarlier={Boolean(cursor)} loading={loading} onLoadEarlier={() => { if (cursor) void load(cursor); }} />
        {!loading && !error && !items.length && <p className="muted">В этом диалоге нет сообщений.</p>}
      </div></div>
      <div className="archive-readonly-footer"><Archive size={16} /><span>Диалог в архиве. Восстановите его, чтобы продолжить переписку.</span><button className="secondary-button" disabled={workspace.actionBusy} onClick={() => workspace.threadAction?.('restore', thread.cwd || '', thread)}><RotateCcw size={14} />Восстановить</button></div>
    </main>
  </div></BridgeContext.Provider>;
}
