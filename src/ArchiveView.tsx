import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, LoaderCircle, RefreshCw, RotateCcw, Search, Terminal } from 'lucide-react';
import type { Item, ScrollAnchor, Thread, TurnWork } from './types';
import type { WorkspaceControls } from './App';
import { BridgeContext } from './BridgeContext';
import { BuildBadge } from './BuildInfo';
import ProjectSidebar from './ProjectSidebar';
import ChatSearch from './ChatSearch';
import UpdateNotice from './UpdateNotice';
import { mergeHistoricalTurnWork } from './turn-work';
import { errorText, folderName } from './useCodex';
import './archive-view.css';
import { readScrollAnchor, restoreScrollAnchor } from './scroll-anchor';
import { useMessageJump, type MessageJump } from './useMessageJump';
import ExportConversation from './ExportConversation';
import { Download } from 'lucide-react';

export default function ArchiveView({ thread, active, initialScrollTop, initialScrollAnchor, workspace, jump }: { thread: Thread; active: boolean; initialScrollTop?: number; initialScrollAnchor?: ScrollAnchor; workspace: WorkspaceControls; jump?: MessageJump }) {
  const [items, setItems] = useState<Item[]>([]);
  const [turnWork, setTurnWork] = useState<Record<string, TurnWork>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(initialScrollTop || 0);
  const scrollAnchor = useRef(initialScrollAnchor);
  const triedCursors = useRef(new Set<string>());
  const restoredScroll = useRef(false);
  const sessionId = `archive:${thread.id}`;
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
      setLoaded(true);
    } catch (e) { if (request === requestRef.current) setError(errorText(e)); }
    finally { if (request === requestRef.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { requestRef.current++; }; }, [thread.id]);
  useMessageJump({ jump, active, loading, ready: loaded && !error, items, hasEarlier: Boolean(cursor), loadEarlier: () => { if (cursor) void load(cursor); }, container: chatRef,
    onJump: () => { restoredScroll.current = true; }, onMissing: () => setError('Сообщение не найдено в доступной истории архива.') });
  useLayoutEffect(() => workspace.registerUpdateCapture?.(sessionId, () => ({
    archivedThread: { id: thread.id, cwd: thread.cwd, name: thread.name }, draft: '', attachments: [], scrollTop: savedScroll.current, scrollAnchor: scrollAnchor.current,
  })), [workspace.registerUpdateCapture, sessionId, thread.id, thread.cwd, thread.name]);
  useLayoutEffect(() => {
    if (!active || loading || !items.length || restoredScroll.current) return;
    const el = chatRef.current;
    if (el && scrollAnchor.current && !restoreScrollAnchor(el, scrollAnchor.current) && cursor && !error && !triedCursors.current.has(cursor)) {
      triedCursors.current.add(cursor);
      void load(cursor);
      return;
    }
    if (el && (!scrollAnchor.current || !restoreScrollAnchor(el, scrollAnchor.current))) el.scrollTop = savedScroll.current;
    restoredScroll.current = true;
  }, [active, loading, items, cursor, error]);
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
      <header className="topbar"><Archive size={16} /><div className="breadcrumbs"><span>{folderName(thread.cwd || '') || 'Архив'}</span><strong>{thread.name || thread.preview || 'Диалог'}</strong></div><button ref={searchButtonRef} type="button" className="icon-button" aria-label="Поиск в чате" title="Поиск в чате (Ctrl+F)" aria-expanded={showSearch} onClick={openSearch}><Search size={17} /></button><button type="button" className="icon-button" aria-label="Экспорт беседы" title="Экспорт беседы" disabled={!items.length || loading} onClick={() => setShowExport(true)}><Download size={17} /></button><span className="archive-readonly-badge">Только чтение</span></header>
      <div ref={chatRef} className="chat-scroll" onScroll={event => {
        if (!active || !restoredScroll.current) return;
        savedScroll.current = event.currentTarget.scrollTop;
        scrollAnchor.current = readScrollAnchor(event.currentTarget);
        workspace.onSessionStateChange?.(sessionId);
      }}><div className="conversation">
        {cursor && !showSearch && <button className="secondary-button load-earlier" disabled={loading} onClick={() => void load(cursor)}>Загрузить предыдущие сообщения</button>}
        {loading && <div className="loading-chat"><LoaderCircle size={16} className="spin" />Загружаем архивный диалог…</div>}
        {error && <div className="alert error-alert" role="alert"><span>{error}</span><button className="text-button" onClick={() => void load()}><RefreshCw size={13} />Повторить</button></div>}
        <ChatSearch items={items} turnWork={turnWork} open={showSearch} active={active} onClose={() => { setShowSearch(false); searchButtonRef.current?.focus({ preventScroll: true }); }} hasEarlier={Boolean(cursor)} loading={loading} onLoadEarlier={() => { if (cursor) void load(cursor); }} onBookmark={async item => {
          const excerpt = item.type === 'userMessage' ? (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : item.text || '';
          await window.codex.saveBookmark({ provider: 'codex', cwd: thread.cwd || '', threadId: thread.id, itemId: item.id, turnId: item.turnId, threadName: (thread.name || 'Архивный диалог').replace(/\s+/g, ' ').slice(0, 500), excerpt: excerpt.slice(0, 4000), archived: true });
        }} />
        {!loading && !error && !items.length && <p className="muted">В этом диалоге нет сообщений.</p>}
      </div></div>
      <div className="composer-area"><UpdateNotice /></div>
      <div className="archive-readonly-footer"><Archive size={16} /><span>Диалог в архиве. Восстановите его, чтобы продолжить переписку.</span><button className="secondary-button" disabled={workspace.actionBusy} onClick={() => workspace.threadAction?.('restore', thread.cwd || '', thread)}><RotateCcw size={14} />Восстановить</button></div>
    </main>
    {showExport && active && <ExportConversation key={thread.id} items={items} turnWork={turnWork} title={thread.name || thread.preview || "Диалог"} provider="Codex" cwd={thread.cwd || ""} hasEarlier={Boolean(cursor)} loading={loading} onLoadEarlier={async () => { if (cursor) await load(cursor); }} onClose={() => setShowExport(false)} onSave={file => window.codex.exportConversation(file)} />}
  </div></BridgeContext.Provider>;
}
