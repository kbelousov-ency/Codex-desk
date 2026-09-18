import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import Conversation from './Conversation';
import type { Item, TurnWork } from './types';
import './chat-search.css';

type Props = {
  items: Item[];
  turnWork: Record<string, TurnWork>;
  open: boolean;
  active: boolean;
  onClose(): void;
  hasEarlier?: boolean;
  loading?: boolean;
  onLoadEarlier?(): void;
};

type Match = { range: Range; key: string };
let highlightOwner: object | null = null;

// Read only rendered public text. Ranges preserve React nodes, Markdown links and code.
function findMatches(root: HTMLElement, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const containers = root.querySelectorAll<HTMLElement>('.message-content, .work-reasoning .markdown, .work-commentary .markdown, .work-plan .markdown, .work-tool-body');
  for (const container of containers) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.textContent || !parent || parent.closest('script, style, summary, .link-error, .inline-error [role="alert"], button:not(.work-file-link), [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const groups: { text: string; nodes: { node: Text; start: number; end: number }[] }[] = [];
    let lastBlock: Element | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const block = node.parentElement?.closest('p, pre, li, h1, h2, h3, h4, h5, h6, td, th, .work-meta, .work-file-link, .diff-code > span') || container;
      if (!groups.length || block !== lastBlock) groups.push({ text: '', nodes: [] });
      lastBlock = block;
      const group = groups[groups.length - 1];
      const value = node.textContent || '';
      group.nodes.push({ node: node as Text, start: group.text.length, end: group.text.length + value.length });
      group.text += value;
    }
    let ordinal = 0;
    for (const group of groups) {
      for (const result of group.text.matchAll(pattern)) {
        const offset = result.index;
        const end = offset + result[0].length;
        const first = group.nodes.find(part => part.end > offset);
        const last = group.nodes.find(part => part.start < end && part.end >= end);
        if (first && last) {
          const range = document.createRange();
          range.setStart(first.node, offset - first.start);
          range.setEnd(last.node, end - last.start);
          const item = container.closest<HTMLElement>('[data-item-id]');
          matches.push({ range, key: `${item?.dataset.itemId || ''}:${ordinal++}` });
        }
      }
    }
  }
  return matches;
}

export default function ChatSearch({ items, turnWork, open, active, onClose, hasEarlier, loading, onLoadEarlier }: Props) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [current, setCurrent] = useState(0);
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const openedDetails = useRef(new Set<HTMLDetailsElement>());
  const owner = useRef({});
  const previousQuery = useRef('');
  const selectedKey = useRef('');
  const revealedMatch = useRef('');
  const searching = open && !!query;

  const restoreDetails = () => {
    for (const details of openedDetails.current) if (details.isConnected) details.open = false;
    openedDetails.current.clear();
  };
  useEffect(() => {
    if (open && active) { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); }
  }, [open, active]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useLayoutEffect(() => {
    if (!searching) restoreDetails();
  }, [searching]);
  useEffect(() => () => restoreDetails(), []);

  // Keep matches current when a lazy tool body, Markdown error or live answer changes.
  useEffect(() => {
    if (!open || !rootRef.current) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRevision(value => value + 1));
    });
    observer.observe(rootRef.current, { childList: true, characterData: true, subtree: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [open]);

  useLayoutEffect(() => {
    const next = rootRef.current && searching ? findMatches(rootRef.current, query) : [];
    const sameQuery = previousQuery.current === query;
    const preserved = sameQuery ? next.findIndex(match => match.key === selectedKey.current) : -1;
    setMatches(next);
    setCurrent(preserved >= 0 ? preserved : 0);
    previousQuery.current = query;
  }, [items, turnWork, searching, query, revision]);

  useLayoutEffect(() => {
    if (!open || !active) return;
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>('.chat-scroll');
    if (!root || !scroller) return;
    const update = () => scroller.style.setProperty('--chat-search-offset', `${(toolbarRef.current?.getBoundingClientRect().height || 0) + 8}px`);
    update();
    const observer = new ResizeObserver(update);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    return () => { observer.disconnect(); scroller.style.removeProperty('--chat-search-offset'); };
  }, [open, active]);

  useLayoutEffect(() => {
    if (!active || !open) return;
    const token = owner.current;
    highlightOwner = token;
    const registry = (CSS as any).highlights;
    const HighlightConstructor = (window as any).Highlight;
    if (registry && HighlightConstructor) {
      const results = new HighlightConstructor();
      for (const match of matches) results.add(match.range);
      registry.set('chat-search-results', results);
      registry.set('chat-search-current', new HighlightConstructor(...(matches[current] ? [matches[current].range] : [])));
    }
    const match = matches[current];
    const target = match?.range.startContainer.parentElement;
    const item = target?.closest<HTMLElement>('[data-item-id]');
    if (item) item.dataset.chatSearchCurrent = 'true';
    selectedKey.current = match?.key || '';
    const revealKey = match ? `${query}\u0000${match.key}` : '';
    const shouldReveal = revealedMatch.current !== revealKey;
    if (!match) revealedMatch.current = '';
    let frame = 0;
    if (target && match && shouldReveal) {
      let parent: HTMLElement | null = target;
      while (parent && parent !== rootRef.current) {
        if (parent instanceof HTMLDetailsElement && !parent.open) { openedDetails.current.add(parent); parent.open = true; }
        parent = parent.parentElement;
      }
      frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        const scroller = root?.closest<HTMLElement>('.chat-scroll');
        if (!root || !scroller || !match.range.startContainer.isConnected) return;
        // Reveal matches in bounded code/output panes first; never scroll the window or other tabs.
        let nested: HTMLElement | null = target;
        while (nested && nested !== scroller) {
          const style = getComputedStyle(nested);
          const rect = match.range.getBoundingClientRect();
          const box = nested.getBoundingClientRect();
          if (/(auto|scroll)/.test(style.overflowY) && nested.scrollHeight > nested.clientHeight) nested.scrollTop += rect.top - box.top - nested.clientHeight / 2;
          if (/(auto|scroll)/.test(style.overflowX) && nested.scrollWidth > nested.clientWidth) nested.scrollLeft += rect.left - box.left - nested.clientWidth / 2;
          nested = nested.parentElement;
        }
        const rect = match.range.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        const topSpace = (toolbarRef.current?.getBoundingClientRect().height || 0) + 42;
        scroller.scrollTop += rect.top - box.top - topSpace - Math.max(0, scroller.clientHeight - topSpace) / 3;
        revealedMatch.current = revealKey;
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      if (item) delete item.dataset.chatSearchCurrent;
      if (highlightOwner === token) {
        registry?.delete('chat-search-results'); registry?.delete('chat-search-current'); highlightOwner = null;
      }
    };
  }, [matches, current, active, open]);

  const move = (direction: number) => setCurrent(value => matches.length ? (value + direction + matches.length) % matches.length : 0);
  return <>
    {open && <div className="chat-search-toolbar" ref={toolbarRef} role="search" aria-label="Поиск в текущем чате" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === 'Enter' && event.target === inputRef.current) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
    }}>
      <div className="chat-search-row"><Search size={14} /><input ref={inputRef} type="text" aria-label="Найти в чате" placeholder="Найти в чате" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        {query && <button className="icon-button small" type="button" aria-label="Очистить поиск по чату" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={12} /></button>}
        <span className="chat-search-count" role="status" aria-live="polite">{!query ? 'Введите текст' : matches.length ? `${current + 1} из ${matches.length}` : 'Нет совпадений'}</span>
        <button className="icon-button small" type="button" aria-label="Предыдущее совпадение" title="Предыдущее совпадение (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}><ArrowUp size={14} /></button>
        <button className="icon-button small" type="button" aria-label="Следующее совпадение" title="Следующее совпадение (Enter)" disabled={!matches.length} onClick={() => move(1)}><ArrowDown size={14} /></button>
        <button className="icon-button small" type="button" aria-label="Закрыть поиск по чату" title="Закрыть поиск (Esc)" onClick={onClose}><X size={14} /></button>
      </div>
      {hasEarlier && <div className="chat-search-history"><span>Поиск по загруженной части чата.</span>{onLoadEarlier && <button type="button" disabled={loading} onClick={onLoadEarlier}>{loading ? 'Загружаем…' : 'Искать в более ранних сообщениях'}</button>}</div>}
    </div>}
    <div className="chat-search-content" ref={rootRef}><Conversation items={items} turnWork={turnWork} searchable={searching} /></div>
  </>;
}
