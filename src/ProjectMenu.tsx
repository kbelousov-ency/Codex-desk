import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisVertical, FolderMinus, GitBranchPlus, ListTree } from 'lucide-react';
import './project-menu.css';

export default function ProjectMenu({ name, active, disabled, onClose, onWorktree, onTasks, children }: {
  name: string; active: boolean; disabled: boolean; onClose(): void; onWorktree?(): void; onTasks?(): void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const id = useId();
  const visible = open && active && !disabled;
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const show = (point?: { x: number; y: number }) => {
    if (!active || disabled) return;
    pointer.current = point || null;
    setPosition({ visibility: 'hidden' }); setOpen(true);
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
    const outside = (event: PointerEvent) => { if (!row.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true); window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll);
    };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const edge = 8, width = Math.min(180, window.innerWidth - edge * 2), height = menu.current?.scrollHeight || 42;
    const point = pointer.current;
    setPosition({ position: 'fixed', visibility: 'visible', width, maxHeight: window.innerHeight - edge * 2,
      left: Math.max(edge, Math.min(point?.x ?? bounds.right - width, window.innerWidth - width - edge)),
      top: Math.max(edge, Math.min(point?.y ?? bounds.bottom + 5, window.innerHeight - height - edge)) });
  }, [visible]);
  useLayoutEffect(() => { if (visible && position.visibility === 'visible') menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }); }, [visible, position]);
  return <div ref={row} className="folder-tree-row" onContextMenu={event => { event.preventDefault(); show({ x: event.clientX, y: event.clientY }); }} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); show(); }
  }}>
    {children}
    <button ref={trigger} type="button" className={`icon-button small project-menu-trigger ${visible ? 'open' : ''}`} aria-label={`Действия проекта ${name}`} data-tooltip="Действия проекта" aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined} disabled={disabled} onClick={() => visible ? close(true) : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
    }}><EllipsisVertical size={14} /></button>
    {visible && createPortal(<div ref={menu} id={id} className="thread-action-menu project-action-menu" role="menu" aria-label={`Действия проекта ${name}`} style={position} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !row.current?.contains(event.relatedTarget as Node | null)) close();
    }} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); close(true); } }}>
      {onWorktree && <button type="button" role="menuitem" onClick={() => { close(true); onWorktree(); }}><GitBranchPlus size={14} /><span>Новая задача в отдельной ветке…</span></button>}
      {onTasks && <button type="button" role="menuitem" onClick={() => { close(true); onTasks(); }}><ListTree size={14} /><span>Задачи проекта…</span></button>}
      <button type="button" role="menuitem" onClick={() => { close(true); onClose(); }}><FolderMinus size={14} /><span>Закрыть проект</span></button>
    </div>, document.body)}
  </div>;
}
