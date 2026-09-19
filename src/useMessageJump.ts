import { useEffect, useRef, type RefObject } from 'react';
import type { Item } from './types';

export type MessageJump = { itemId: string; turnId?: string; key: number; excerpt?: string };
export function useMessageJump({ jump, active, loading, ready, items, hasEarlier, loadEarlier, container, onMissing, onJump }: {
  jump?: MessageJump; active: boolean; loading: boolean; ready: boolean; items: Item[]; hasEarlier: boolean;
  loadEarlier(): void; container: RefObject<HTMLDivElement | null>; onMissing(): void; onJump(): void;
}) {
  const completed = useRef<number | undefined>(undefined);
  const pendingPage = useRef<string>('');
  useEffect(() => {
    if (!jump || !active || loading || !ready || completed.current === jump.key) return;
    const scroller = container.current;
    if (!scroller) return;
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const excerpt = normalize(jump.excerpt || '');
    const matchesExcerpt = (item: Item) => {
      const text = item.type === 'userMessage' ? (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : item.text || '';
      return normalize(text).startsWith(excerpt);
    };
    const exact = items.find(item => item.id === jump.itemId);
    const nodes = [...scroller.querySelectorAll<HTMLElement>('[data-item-id]')];
    let node = exact && (!excerpt || matchesExcerpt(exact)) ? nodes.find(element => element.dataset.itemId === jump.itemId) : undefined;
    // Claude's stream and native transcript can number sibling blocks differently.
    // Use a unique saved excerpt within the same native API message as fallback.
    const messageId = jump.itemId.match(/^(.*):text:\d+$/)?.[1];
    if (!node && excerpt && messageId) {
      const candidates = items.filter(item => {
        return item.type === 'agentMessage' && item.id.startsWith(`${messageId}:text:`) && matchesExcerpt(item);
      });
      if (candidates.length === 1) node = nodes.find(element => element.dataset.itemId === candidates[0].id);
    }
    if (node) {
      const target = node;
      completed.current = jump.key; pendingPage.current = '';
      for (let parent = target.parentElement; parent && parent !== scroller; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      onJump();
      requestAnimationFrame(() => {
        scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 22;
        target.classList.add('message-jump-highlight'); target.tabIndex = -1; target.focus({ preventScroll: true });
        setTimeout(() => target.classList.remove('message-jump-highlight'), 4000);
      });
    } else if (hasEarlier) {
      const key = `${jump.key}:${items.length}:${items[0]?.id || ''}`;
      if (pendingPage.current === key) { completed.current = jump.key; onMissing(); return; }
      pendingPage.current = key; loadEarlier();
    } else { completed.current = jump.key; onMissing(); }
  }, [jump, active, loading, ready, items, hasEarlier]);
}
