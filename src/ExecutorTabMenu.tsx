import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Link2Off, Pencil, X } from 'lucide-react';
import type { ExecutorAction, ExecutorThread } from './types';

/** Right-click menu of an executor sub-tab in the «Исполнители» row.
 *
 * The blocks are the ThreadMenu ones: nothing that touches the conversation is offered while
 * the workspace is busy or while that conversation is working. An executor that has not sent
 * anything yet has no conversation at all, so only its tab can be closed. «Отвязать от
 * родителя» drops the navigation link alone — the dialog itself stays in the folder. */
export default function ExecutorTabMenu({ thread, title, x, y, locked = false, onAction, onClose }: {
  thread: ExecutorThread;
  title: string;
  x: number;
  y: number;
  /** The workspace is busy, or this conversation is working with an open terminal. */
  locked?: boolean;
  onAction(action: ExecutorAction): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [onClose]);
  // Before the first send the executor lives as a tab only: there is no conversation to rename,
  // unlink or archive yet.
  const started = !thread.id.startsWith('session:');
  const entries: { action: ExecutorAction; label: string; icon: typeof Pencil; disabled: boolean; hint?: string }[] = [
    { action: 'rename', label: 'Переименовать', icon: Pencil, disabled: locked || !started },
    { action: 'unlink', label: 'Отвязать от родителя', icon: Link2Off, disabled: Boolean(thread.unlinkBlockedReason) || !started, hint: thread.unlinkBlockedReason || (!started ? 'Сначала отправьте сообщение исполнителю' : 'Диалог останется в папке как обычный') },
    { action: 'archive', label: 'В архив', icon: Archive, disabled: locked || !started },
    { action: 'close', label: 'Закрыть вкладку', icon: X, disabled: !thread.sessionId || Boolean(thread.closeBlockedReason), hint: thread.closeBlockedReason || (!thread.sessionId ? 'Вкладка уже закрыта' : thread.closeWhenComplete ? 'Закроется по завершении' : undefined) },
  ];
  const style = { left: Math.max(8, Math.min(x, window.innerWidth - 280)), top: Math.max(8, Math.min(y, window.innerHeight - 200)) };
  return createPortal(<div ref={menu} className="tab-context-menu executor-tab-menu" role="menu" aria-label={`Агент-исполнитель: ${title}`} style={style} onKeyDown={event => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (event.key === 'Tab') onClose();
  }}>
    {entries.map(({ action, label, icon: Icon, disabled, hint }) => <button type="button" role="menuitem" key={action} disabled={disabled} data-executor-action={action} data-tooltip={hint} onClick={() => { onClose(); onAction(action); }}><Icon size={14} />{label}</button>)}
  </div>, document.body);
}
