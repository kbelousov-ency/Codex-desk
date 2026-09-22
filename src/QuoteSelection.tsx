import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquareQuote } from 'lucide-react';
import './quote-selection.css';

type Quote = { text: string; x: number; y: number };

/** A quote must come wholly from the public content of one message. */
export function selectedMessageQuote(root: HTMLElement, selection = window.getSelection()): Quote | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || root.closest('[hidden]')) return null;
  const range = selection.getRangeAt(0);
  const container = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.message-content');
  const first = container(range.startContainer);
  if (!first || first !== container(range.endContainer) || !root.contains(first)) return null;
  if (range.cloneContents().querySelector('button, input, textarea, select, [role="button"]')) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  const scroller = root.closest('.chat-scroll')?.getBoundingClientRect();
  if (scroller && (rect.bottom < scroller.top || rect.top > scroller.bottom)) return null;
  return { text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 235)), y: Math.max(8, Math.min(rect.bottom + 7, window.innerHeight - 44)) };
}

export default function QuoteSelection({ children, onQuote, active = true }: { children: ReactNode; onQuote?(text: string): void; active?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    if (!onQuote || !active) { setQuote(null); return; }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Tabbing to the action may collapse the browser selection. Preserve it only there.
        if (toolbarRef.current?.contains(document.activeElement)) return;
        setQuote(rootRef.current ? selectedMessageQuote(rootRef.current) : null);
      });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setQuote(null); return; }
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.code !== 'KeyR' || event.altKey || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      const selected = rootRef.current && selectedMessageQuote(rootRef.current);
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      onQuote(selected.text);
      window.getSelection()?.removeAllRanges();
      setQuote(null);
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('keydown', keydown);
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [onQuote, active]);
  return <div className="quote-selection-root" ref={rootRef}>
    {children}
    {quote && onQuote && active && createPortal(<div className="quote-selection-toolbar" ref={toolbarRef} style={{ left: quote.x, top: quote.y }}>
      <button type="button" aria-keyshortcuts="Control+Shift+R" data-tooltip="Добавить цитату в сообщение (Ctrl+Shift+R)" onMouseDown={event => event.preventDefault()} onClick={() => {
        onQuote(quote.text);
        window.getSelection()?.removeAllRanges();
        setQuote(null);
      }}><MessageSquareQuote size={14} />Ответить на выделенное</button>
    </div>, document.body)}
  </div>;
}
