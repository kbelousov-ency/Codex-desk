import { useId, useState } from 'react';
import { Info, LoaderCircle, MessageSquare, Smartphone } from 'lucide-react';
import type { PhoneAccessSettingsProps, RemoteAccessTab } from './types';
import './phone-access.css';

/**
 * «Доступ бесед» — the same per-conversation permission as the switch in the «Агент» topic,
 * gathered in one findable place: every open tab of this window, in tab order.
 *
 * It is a second view of one mechanism, not a second mechanism. Each row calls the very same
 * `setRemoteThreadAccess` with the conversation's own `accessRevision`, so a stale row loses the
 * compare-and-set instead of overwriting a fresher decision. Nothing here can be switched on from
 * the phone, and a tab that has no conversation yet has nothing to allow — it is still listed,
 * switched off and explained, because a silently missing row is what sent the owner looking.
 */

function AccessRow({ tab, disabled }: { tab: RemoteAccessTab; disabled: boolean }) {
  const [pending, setPending] = useState(false);
  const describedBy = useId();
  const state = tab.state;
  const started = Boolean(state?.threadId);
  const enabled = Boolean(state?.enabled);
  // A conversation that exists but cannot be allowed right now keeps the switch and the reason.
  const blocked = started && !enabled && !state!.canEnable;
  const locked = disabled || tab.busy || pending || !started || blocked;

  const toggle = async () => {
    if (locked) return;
    setPending(true);
    try { await tab.change(!enabled); }
    finally { setPending(false); }
  };

  return <li className="phone-access-thread" data-telegram-access={enabled ? 'on' : 'off'}>
    <button type="button" role="switch" aria-checked={enabled} aria-describedby={describedBy}
      aria-label={`Доступ из Telegram: ${tab.title}`}
      className={`phone-access-thread-switch ${enabled ? 'enabled' : ''}`}
      disabled={locked} onClick={() => void toggle()}>
      {pending ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <MessageSquare size={13} aria-hidden="true" />}
      <span className="phone-access-thread-name">
        <strong>{tab.title}</strong>
        <small>{tab.project} · {tab.provider === 'claude' ? 'Claude Code' : 'Codex'}</small>
      </span>
      <span className="phone-access-thread-value">{enabled ? 'вкл' : 'выкл'}</span>
    </button>
    <small id={describedBy} className="phone-access-thread-hint">
      {!started
        ? 'Беседа ещё не начата: разрешать пока нечего.'
        : enabled
          ? 'Видна на телефоне: выбор, текст, состояние, последний ответ и остановка.'
          : blocked
            ? state!.reason || 'Разрешить доступ пока нельзя.'
            : 'Пока выключено: на телефоне не видно ни названия, ни ответов этой беседы.'}
    </small>
  </li>;
}

export function PhoneAccessSettings({ tabs, disabled = false }: PhoneAccessSettingsProps) {
  const allowed = tabs.filter(tab => tab.state?.enabled).length;

  return <section className="phone-access" aria-label="Доступ бесед">
    <h3><Smartphone size={13} aria-hidden="true" />Доступ бесед</h3>

    <p>Открытые вкладки этого окна. Переключатель здесь — тот же, что в настройках вкладки, раздел «Агент»: по умолчанию выключен, включается только на компьютере и в любой момент отзывается отсюда же.</p>

    <div className="phone-access-status" role="status">
      <span>{tabs.length ? `Разрешено бесед: ${allowed} из ${tabs.length}` : 'Открытых бесед нет'}</span>
    </div>

    {tabs.length > 0 && <ul className="phone-access-threads">
      {tabs.map(tab => <AccessRow key={tab.sessionId} tab={tab} disabled={disabled} />)}
    </ul>}

    <div className="settings-explanation">
      <Info size={14} aria-hidden="true" />
      <p>На сервер уходят только название разрешённой беседы, агент, короткое имя папки, состояние и длина очереди. Переписка, ответы модели, пути и настройки не передаются. С телефона нельзя выдать доступ, расширить его или открыть новую беседу.</p>
    </div>
  </section>;
}

export default PhoneAccessSettings;
