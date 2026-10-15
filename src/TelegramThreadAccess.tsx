import { useId, useState } from 'react';
import { LoaderCircle, Smartphone } from 'lucide-react';
import type { TelegramThreadAccessProps } from './types';
import './telegram-thread-access.css';

/**
 * «Разрешить доступ из Telegram» for one conversation. Off by default, and only ever switched on
 * from the computer. The component picks no session and never reads a global active tab: the
 * parent `App` hands it the state of its own conversation and the handler.
 */
export function TelegramThreadAccess({ state, busy, disabled = false, onChange }: TelegramThreadAccessProps) {
  const [pending, setPending] = useState(false);
  const describedBy = useId();

  if (!state || !state.threadId) return null;

  const locked = disabled || busy || pending;
  const enabled = state.enabled;
  // A conversation that cannot be allowed yet still shows the switch, off and explained.
  const blocked = !enabled && !state.canEnable;

  const toggle = async (next: boolean) => {
    if (locked || (next && blocked)) return;
    setPending(true);
    try { await onChange(next); }
    finally { setPending(false); }
  };

  return <div className="telegram-thread-access" data-telegram-access={enabled ? 'on' : 'off'}>
    {/* An explicit label keeps the accessible name stable while the вкл/выкл chip changes. */}
    <button type="button" role="switch" aria-checked={enabled} aria-describedby={describedBy}
      aria-label="Разрешить доступ из Telegram"
      className={`telegram-thread-switch ${enabled ? 'enabled' : ''}`}
      disabled={locked || blocked}
      onClick={() => void toggle(!enabled)}>
      {pending ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Smartphone size={13} aria-hidden="true" />}
      <span>Разрешить доступ из Telegram</span>
      <span className="telegram-thread-value">{enabled ? 'вкл' : 'выкл'}</span>
    </button>
    <small id={describedBy}>
      {enabled
        ? 'Беседа видна в боте: выбор, текст, состояние, последний ответ и остановка. Отозвать можно в любой момент, даже во время задачи.'
        : blocked
          ? state.reason || 'Разрешить доступ пока нельзя.'
          : 'Пока выключено: бот не покажет ни название этой беседы, ни её ответы.'}
    </small>
  </div>;
}

export default TelegramThreadAccess;
