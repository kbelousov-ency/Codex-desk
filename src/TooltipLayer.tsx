import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import './tooltips.css';

type Hint = { target: HTMLElement; text: string };

/** One tooltip for all plain UI descriptions, including controls added by dialogs. */
export default function TooltipLayer() {
  const id = useId();
  const [hint, setHint] = useState<Hint | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: Hint | null = null;
    let anchor: DOMRect | null = null;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let dismissed: HTMLElement | null = null;
    let overBubble = false;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let observer: MutationObserver | undefined;
    const visible = (target: HTMLElement) => target.isConnected && target.getClientRects().length > 0 && !target.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(target).visibility !== 'hidden';
    const owner = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null;
    const inBubble = (node: EventTarget | null) => node instanceof Node && Boolean(bubble.current?.contains(node));
    const cancelTimers = () => { clearTimeout(showTimer); clearTimeout(closeTimer); };
    const unlink = () => {
      if (!current) return;
      const ids = (current.target.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id);
      if (ids.length) current.target.setAttribute('aria-describedby', ids.join(' '));
      else current.target.removeAttribute('aria-describedby');
    };
    const hide = () => {
      cancelTimers(); observer?.disconnect(); cancelAnimationFrame(frame);
      unlink(); current = null; overBubble = false; setHint(null);
    };
    const validate = () => {
      if (!current) return;
      const text = current.target.dataset.tooltip?.trim();
      if (!text || !visible(current.target)) { hide(); return; }
      const rect = current.target.getBoundingClientRect();
      if (text !== current.text || !anchor || rect.x !== anchor.x || rect.y !== anchor.y || rect.width !== anchor.width || rect.height !== anchor.height) {
        anchor = rect; current = { target: current.target, text }; setHint(current);
      }
    };
    const show = (target: HTMLElement) => {
      const text = target.dataset.tooltip?.trim();
      if (!text || !visible(target) || dismissed === target) return;
      window.dispatchEvent(new CustomEvent('codex-desk:tooltip-open', { detail: id }));
      hide();
      current = { target, text }; anchor = target.getBoundingClientRect();
      const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      ids.add(id); target.setAttribute('aria-describedby', [...ids].join(' '));
      setPosition({ visibility: 'hidden' }); setHint(current);
      // Observe only while a tooltip is visible. Ignore our own portal and aria updates.
      observer = new MutationObserver(records => {
        if (!target.isConnected || records.some(record => record.target instanceof Element && record.target.contains(target))) {
          cancelAnimationFrame(frame); frame = requestAnimationFrame(validate);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip', 'class', 'style', 'hidden', 'aria-hidden', 'inert'] });
    };
    const request = (target: HTMLElement | null, immediate = false) => {
      cancelTimers();
      if (!target || dismissed === target) return;
      if (current?.target === target) return;
      if (current) hide();
      if (immediate) show(target);
      else showTimer = setTimeout(() => { if (hovered === target) show(target); }, 400);
    };
    const scheduleHide = () => {
      clearTimeout(showTimer); clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!current || (!overBubble && hovered !== current.target && focused !== current.target)) hide();
      }, 140);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (inBubble(event.target)) { overBubble = true; clearTimeout(closeTimer); return; }
      const target = owner(event.target);
      if (hovered === target) return;
      hovered = target;
      if (dismissed !== target) dismissed = null;
      if (target) request(target); else scheduleHide();
    };
    const pointerOut = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (inBubble(event.relatedTarget)) { overBubble = true; clearTimeout(closeTimer); return; }
      if (inBubble(event.target)) overBubble = false;
      const target = owner(event.relatedTarget);
      if (hovered !== target) {
        hovered = target;
        if (dismissed !== target) dismissed = null;
        if (target) request(target); else scheduleHide();
      } else if (!target) scheduleHide();
    };
    const focusIn = (event: FocusEvent) => {
      focused = owner(event.target);
      // Pointer clicks already describe themselves through their action.
      if (focused?.matches(':focus-visible')) { dismissed = null; request(focused, true); }
    };
    const focusOut = () => { focused = null; scheduleHide(); };
    const dismiss = () => { dismissed = current?.target || hovered || focused; hide(); };
    const pointerDown = (event: PointerEvent) => { if (!inBubble(event.target)) dismiss(); };
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const scroll = (event: Event) => { if (!inBubble(event.target)) dismiss(); };
    const otherTooltip = (event: Event) => { if ((event as CustomEvent).detail !== id) dismiss(); };
    document.addEventListener('pointerover', pointerOver, true);
    document.addEventListener('pointerout', pointerOut, true);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('codex-desk:tooltip-open', otherTooltip);
    return () => {
      hide();
      document.removeEventListener('pointerover', pointerOver, true);
      document.removeEventListener('pointerout', pointerOut, true);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('codex-desk:tooltip-open', otherTooltip);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!hint || !bubble.current) return;
    const target = hint.target.getBoundingClientRect();
    const box = bubble.current.getBoundingClientRect();
    const edge = 8, gap = 8;
    const below = target.bottom + gap;
    const top = below + box.height <= innerHeight - edge ? below : target.top - gap - box.height;
    setPosition({
      left: Math.max(edge, Math.min(target.left + (target.width - box.width) / 2, innerWidth - edge - box.width)),
      top: Math.max(edge, Math.min(top, innerHeight - edge - box.height)),
      visibility: 'visible',
    });
  }, [hint]);

  return hint && createPortal(<div ref={bubble} id={id} role="tooltip" className="app-tooltip" style={position}>{hint.text}</div>, document.body);
}
