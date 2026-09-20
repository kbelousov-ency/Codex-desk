import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, EllipsisVertical, GitFork, Pencil, Trash2 } from 'lucide-react';
import type { ThreadAction } from './types';
import './archive.css';

export type { ThreadAction } from './types';

export default function ThreadMenu({ title, threadId, archived = false, archivable = true, active = true, disabled = false, onAction }: {
  title: string;
  threadId: string;
  archived?: boolean;
  /** Claude Code history has no archive state; rename, fork and delete remain available. */
  archivable?: boolean;
  active?: boolean;
  disabled?: boolean;
  onAction(action: ThreadAction): void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(0);
  const id = useId();
  const visible = open && active && !disabled;
  const actions = archived
    ? [{ action: 'delete' as const, label: 'Удалить', icon: Trash2 }, { action: 'restore' as const, label: 'Восстановить', icon: ArchiveRestore }]
    : [{ action: 'rename' as const, label: 'Переименовать', icon: Pencil }, { action: 'fork' as const, label: 'Ответвить', icon: GitFork }, ...(archivable ? [{ action: 'archive' as const, label: 'В архив', icon: Archive }] : []), { action: 'delete' as const, label: 'Удалить', icon: Trash2 }];
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const show = (last = false) => {
    if (!active || disabled) return;
    initialFocus.current = last ? actions.length - 1 : 0;
    setPosition({ visibility: 'hidden' });
    setOpen(true);
    document.dispatchEvent(new CustomEvent('codex:thread-menu', { detail: id }));
  };

  useEffect(() => { if (!active || disabled) setOpen(false); }, [active, disabled]);
  useEffect(() => {
    const otherMenu = (event: Event) => { if ((event as CustomEvent).detail !== id) setOpen(false); };
    document.addEventListener('codex:thread-menu', otherMenu);
    return () => document.removeEventListener('codex:thread-menu', otherMenu);
  }, [id]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const edge = 8;
    const width = Math.min(174, window.innerWidth - edge * 2);
    const height = Math.min(menu.current?.scrollHeight || 120, window.innerHeight - edge * 2);
    setPosition({
      position: 'fixed', visibility: 'visible', width, maxHeight: window.innerHeight - edge * 2,
      left: Math.max(edge, Math.min(bounds.right - width, window.innerWidth - width - edge)),
      top: Math.max(edge, Math.min(bounds.bottom + 5 + height <= window.innerHeight - edge ? bounds.bottom + 5 : bounds.top - height - 5, window.innerHeight - height - edge)),
    });
  }, [visible]);
  useLayoutEffect(() => {
    if (visible && position.visibility === 'visible') menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[initialFocus.current]?.focus({ preventScroll: true });
  }, [visible, position]);

  return <>
    <button ref={trigger} type="button" className={`thread-menu-trigger ${visible ? 'open' : ''}`} aria-label={`Действия диалога ${title}`} title={disabled ? 'Действия недоступны, пока диалог занят' : 'Действия диалога'} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined} data-thread-menu-id={threadId} disabled={disabled} onClick={() => visible ? close(true) : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
    }}><EllipsisVertical size={14} /></button>
    {visible && createPortal(<div ref={menu} id={id} className="thread-action-menu" role="menu" aria-label="Действия диалога" style={position} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !trigger.current?.contains(event.relatedTarget as Node | null)) close();
    }} onKeyDown={event => {
      const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
        entries[next]?.focus();
      } else if (event.key === 'Tab') { event.preventDefault(); close(true); }
    }}>{actions.map(({ action, label, icon: Icon }) => <button type="button" role="menuitem" tabIndex={-1} className={action === 'delete' ? 'destructive' : ''} key={action} onClick={() => { close(true); onAction(action); }}><Icon size={13} /><span>{label}</span></button>)}</div>, document.body)}
  </>;
}
