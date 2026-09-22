import { useEffect, useId, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import type { UsageLimits, UsageWindow } from './types';

const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${Math.round(Math.min(100, Math.max(0, value)))} %`;
export function resetText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return '';
  const left = at - now;
  if (left <= 0) return 'обновляется';
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return `сброс через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `сброс через ${hours} ч ${String(minutes % 60).padStart(2, '0')} мин`;
  return `сброс ${new Date(at).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** Claude plan rate limits left of the cache control: the 5-hour window inline, every window in a popover.
 * Without plan data the control shows a plain label and sends the CLI's own `/usage` command on click. */
export default function UsageLimit({ usage, loading, active = true, disabled = false, onRefresh, onCommand }: {
  usage: UsageLimits | null; loading: boolean; active?: boolean; disabled?: boolean; onRefresh(): void; onCommand(command: string): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const available = Boolean(usage?.available && usage.windows.length);
  const fiveHour = usage?.windows.find(window => window.key === 'five_hour');
  useEffect(() => {
    if (!open || !active) { if (!active) setOpen(false); return; }
    const outside = (event: PointerEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, active]);
  if (!available) {
    const reason = usage && !usage.available ? (usage.message || 'Лимиты плана недоступны для этого способа входа. Команда /usage покажет данные Claude CLI.') : 'Лимиты ещё не получены. Команда /usage покажет данные Claude CLI.';
    return <button type="button" className="usage-limit usage-limit-plain" data-tooltip={reason} aria-label="Лимит: показать использование командой /usage" disabled={disabled} onClick={() => onCommand('/usage')}><Gauge size={13} /><span>Лимит</span></button>;
  }
  const summary = fiveHour ? `5 ч: ${percent(fiveHour.utilization)}` : `${usage!.windows[0].label}: ${percent(usage!.windows[0].utilization)}`;
  const title = fiveHour ? `Лимит 5-часовой сессии: использовано ${percent(fiveHour.utilization)}${fiveHour.resetsAt ? `, ${resetText(fiveHour.resetsAt)}` : ''}. Нажмите, чтобы увидеть все лимиты.` : 'Нажмите, чтобы увидеть все лимиты.';
  const row = (window: UsageWindow) => <li key={window.key} className="usage-window" data-usage-window={window.key}>
    <div className="usage-window-head"><span>{window.label}</span><strong>{percent(window.utilization)}</strong></div>
    <div className="usage-bar" role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.utilization ?? undefined}><span style={{ width: `${Math.min(100, Math.max(0, window.utilization ?? 0))}%` }} /></div>
    {window.resetsAt && <small>{resetText(window.resetsAt)}</small>}
  </li>;
  return <div ref={root} className="usage-limit">
    <button type="button" className={`usage-limit-trigger ${open ? 'open' : ''}`} data-tooltip={title} aria-label={`Лимит ${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Gauge size={13} /><span className="usage-summary">Лимит {summary}</span></button>
    {open && <section id={id} className="usage-popover" role="dialog" aria-label="Лимиты плана Claude">
      <header><strong>Лимиты плана{usage!.subscription ? ` · ${usage!.subscription}` : ''}</strong><button type="button" className="icon-button small" aria-label="Обновить лимиты" data-tooltip="Обновить" disabled={loading} onClick={onRefresh}><RefreshCw size={13} className={loading ? 'spin' : ''} /></button></header>
      <ul>{usage!.windows.map(row)}</ul>
      <footer><small>Данные claude.ai через установленный Claude CLI{usage!.updatedAt ? `, ${new Date(usage!.updatedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : ''}.</small><button type="button" className="text-button" onClick={() => { setOpen(false); onCommand('/usage'); }}>Команда /usage</button></footer>
    </section>}
  </div>;
}
