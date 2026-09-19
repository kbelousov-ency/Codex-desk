import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark as BookmarkIcon, LoaderCircle, Search, Trash2, X } from 'lucide-react';
import type { AgentProvider, Bookmark, HistoryTarget } from './types';
import './history-library.css';

export default function HistoryLibrary({ projects, initialCwd, onClose, onOpen }: { projects: string[]; initialCwd: string; onClose(): void; onOpen(target: HistoryTarget): void }) {
  const [mode, setMode] = useState<'search' | 'bookmarks'>('search');
  const [cwd, setCwd] = useState(initialCwd || projects[0] || '');
  const [provider, setProvider] = useState<AgentProvider | 'all'>('all');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<HistoryTarget[]>([]);
  const [saved, setSaved] = useState<Bookmark[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const generation = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]') || [])];
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { generation.current++; document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { generation.current++; setMatches([]); setCursor(null); setScanned(0); setSearched(false); setError(''); setWarnings([]); setBusy(false); }, [cwd, provider, query, mode]);
  useEffect(() => {
    if (mode !== 'bookmarks') return;
    const version = ++generation.current; setBusy(true); setError(''); setSaved([]);
    void window.codex.listBookmarks({ ...(cwd ? { cwd } : {}), provider }).then(values => { if (version === generation.current) setSaved(values); }).catch(cause => { if (version === generation.current) setError(String(cause.message || cause)); }).finally(() => { if (version === generation.current) setBusy(false); });
  }, [mode, cwd, provider]);
  const search = async (more = false) => {
    if (busy || !cwd || !query.trim()) return;
    const version = ++generation.current;
    setBusy(true); setError('');
    try {
      const page = await window.codex.searchHistory({ cwd, provider, query, ...(more && cursor ? { cursor } : {}) });
      if (version !== generation.current) return;
      setMatches(previous => [...(more ? previous : []), ...page.matches]); setCursor(page.nextCursor); setScanned(page.scannedThreads); setWarnings(previous => [...new Set([...(more ? previous : []), ...(page.warnings || [])])]); setSearched(true);
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  };
  const updateLabel = async (bookmark: Bookmark, label: string) => {
    if (label === bookmark.label) return;
    try { const { createdAt, updatedAt, ...value } = bookmark; const result = await window.codex.saveBookmark({ ...value, label }); setSaved(previous => previous.map(value => value.id === result.id ? result : value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openTarget = async (target: HistoryTarget) => {
    if (busy) return;
    const version = ++generation.current; setBusy(true); setError('');
    try {
      const thread = await window.codex.resolveHistoryTarget({ cwd: target.cwd, provider: target.provider, threadId: target.thread.id });
      if (version === generation.current) onOpen({ ...target, thread, archived: thread.archived === true });
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  };
  return createPortal(<div className="history-library-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="history-library" role="dialog" aria-modal="true" aria-label="История и закладки">
    <header><div><small>БИБЛИОТЕКА ПРОЕКТА</small><h2>История и закладки</h2></div><button className="icon-button" aria-label="Закрыть историю и закладки" onClick={onClose}><X size={18} /></button></header>
    <div className="library-tabs"><button aria-pressed={mode === 'search'} onClick={() => { if (!cwd) setCwd(initialCwd || projects[0] || ''); setMode('search'); }}><Search size={14} />Поиск сообщений</button><button aria-pressed={mode === 'bookmarks'} onClick={() => setMode('bookmarks')}><BookmarkIcon size={14} />Закладки</button></div>
    <div className="library-filters"><label>Проект<select aria-label="Проект истории" value={cwd} onChange={event => setCwd(event.target.value)}>{mode === 'bookmarks' && <option value="">Все проекты</option>}{projects.map(project => <option value={project} key={project}>{project}</option>)}</select></label><label>Агент<select aria-label="Агент истории" value={provider} onChange={event => setProvider(event.target.value as AgentProvider | 'all')}><option value="all">Все агенты</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label></div>
    {mode === 'search' && <form className="library-search" onSubmit={event => { event.preventDefault(); void search(); }}><Search size={16} /><input ref={input} aria-label="Поиск по содержимому истории" placeholder="Фраза из сообщения…" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} /><button className="primary-button" disabled={busy || !cwd || !query.trim()}>Искать</button></form>}
    {error && <p className="library-error" role="alert">{error}</p>}
    <div className="library-results">{mode === 'search' ? <>
      {matches.map((target, index) => <button className="library-result" key={`${target.thread.id}:${target.itemId}:${index}`} disabled={busy} onClick={() => void openTarget(target)}><small>{target.provider === 'claude' ? 'Claude Code' : 'Codex'}{target.archived || target.thread.archived ? ' · Архив' : ''}</small><strong>{target.thread.name || target.thread.preview || 'Диалог'}</strong><p>{target.snippet}</p></button>)}
      {!busy && !matches.length && searched && <p className="library-empty">Совпадений в проверенной части истории нет.</p>}
      {!searched && !busy && <p className="library-empty">Поиск читает сообщения выбранного проекта. Большая история просматривается частями.</p>}
      {cursor && <button className="secondary-button" disabled={busy} onClick={() => void search(true)}>Искать дальше</button>}
      {searched && <p className="library-note">Проверено диалогов: {scanned}. {cursor ? 'Осталась ещё история.' : warnings.length ? 'Поиск завершён с пропусками.' : 'Поиск завершён.'}</p>}
      {warnings.map(warning => <p className="library-note" key={warning}>{warning}</p>)}
    </> : <>
      {saved.map(bookmark => <article className="library-bookmark" key={bookmark.id}><button className="library-result" disabled={busy} onClick={() => void openTarget({ cwd: bookmark.cwd, provider: bookmark.provider, thread: { id: bookmark.threadId, cwd: bookmark.cwd, name: bookmark.threadName, provider: bookmark.provider }, itemId: bookmark.itemId, turnId: bookmark.turnId, archived: bookmark.archived, excerpt: bookmark.excerpt })}><small>{bookmark.provider === 'claude' ? 'Claude Code' : 'Codex'} · {bookmark.threadName}</small><p>{bookmark.excerpt}</p></button><div><input key={`${bookmark.id}:${bookmark.updatedAt}`} aria-label={`Подпись закладки ${bookmark.threadName}`} placeholder="Своя подпись…" maxLength={200} defaultValue={bookmark.label} onBlur={event => void updateLabel(bookmark, event.target.value)} /><button className="icon-button" aria-label={`Удалить закладку ${bookmark.threadName}`} onClick={() => void window.codex.removeBookmark(bookmark.id).then(() => setSaved(previous => previous.filter(value => value.id !== bookmark.id))).catch(cause => setError(String(cause.message || cause)))}><Trash2 size={14} /></button></div></article>)}
      {!busy && !saved.length && <p className="library-empty">Закладки можно сохранить кнопкой рядом с сообщением.</p>}
    </>}{busy && <p className="library-note" role="status"><LoaderCircle className="spin" size={14} />Читаем историю…</p>}</div>
  </section></div>, document.body);
}
