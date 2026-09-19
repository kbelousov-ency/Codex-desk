import type { ScrollAnchor } from './types';

// A message identity survives prepending history pages and changed viewport sizes.
export function readScrollAnchor(scroller: HTMLElement): ScrollAnchor | undefined {
  const top = scroller.getBoundingClientRect().top;
  for (const node of scroller.querySelectorAll<HTMLElement>('.message[data-item-id]')) {
    const bounds = node.getBoundingClientRect();
    if (bounds.height && bounds.bottom > top) return { itemId: node.dataset.itemId!, offset: bounds.top - top };
  }
}

export function restoreScrollAnchor(scroller: HTMLElement, anchor: ScrollAnchor): boolean {
  const message = [...scroller.querySelectorAll<HTMLElement>('.message[data-item-id]')].find(node => node.dataset.itemId === anchor.itemId);
  if (!message) return false;
  scroller.scrollTop += message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  return true;
}
