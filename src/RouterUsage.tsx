import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import type { CodexBridge, RouterBand, RouterCreditSpend, RouterLimit, RouterUsageSnapshot } from './types';
import './router-usage.css';

type CreditSpend = RouterCreditSpend & { since?: string };
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const creditsFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const formatCredits = (value: number | null) => value === null ? '—' : creditsFormat.format(value);
const formatPercent = (value: number | null) => value === null ? '—' : percentFormat.format(value) + '%';
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** The legacy ledger and the portal's personal quota are different accounting contracts. */
function limitUsage(limit: RouterLimit | RouterBand | null) {
  if (!limit) return { total: null, remaining: null, left: null };
  const legacy = limit as RouterLimit;
  const total = number(limit.limitCredits) ?? number(legacy.limit_credits);
  const portal = limit.limitCredits !== undefined || limit.usedCredits !== undefined || limit.left !== undefined;
  let used: number | null;
  let remaining: number | null;
  let usedPercent: number | null;
  if (portal) {
    used = number(limit.usedCredits);
    remaining = number(limit.remainingCredits) ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
    usedPercent = number(limit.usedPercent) ?? (total !== null && total > 0 && used !== null ? used / total * 100 : null);
    const reportedLeft = number(limit.left);
    const left = usedPercent !== null ? clampPercent(100 - usedPercent)
      : reportedLeft !== null ? clampPercent(reportedLeft)
      : total !== null && total > 0 && remaining !== null ? clampPercent(remaining / total * 100) : null;
    return { total, remaining, left };
  }
  const ledger = number(legacy.ledger_used_credits);
  used = ledger ?? number(legacy.used_credits);
  // With a ledger but no quota, unrelated server remaining/percent values cannot fill the gap.
  remaining = ledger !== null ? (total !== null ? Math.max(0, total - ledger) : null)
    : number(legacy.remaining_credits) ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
  usedPercent = ledger !== null ? (total !== null && total > 0 ? ledger / total * 100 : null)
    : number(legacy.used_percent) ?? (total !== null && total > 0 && used !== null ? used / total * 100 : null);
  return { total, remaining, left: usedPercent === null ? null : clampPercent(100 - usedPercent) };
}

function DateValue({ value }: { value?: string | null }) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return <>—</>;
  const title = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(timestamp);
  return <time dateTime={value!} title={title}>{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp)}</time>;
}

function BalanceBar({ left, label }: { left: number | null; label: string }) {
  return <div className={'router-credit-bar' + (left === null ? ' is-unknown' : '')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left ?? undefined} aria-valuetext={left === null ? 'Нет данных' : formatPercent(left) + ' осталось'}><span style={{ width: (left ?? 0) + '%' }} /></div>;
}

function SpendValue({ kind, value, threadId }: { kind: 'session' | 'today'; value?: CreditSpend; threadId?: string | null }) {
  const amount = number(value?.credits);
  const session = kind === 'session';
  const baseline = session ? (threadId ? 'Текущий диалог' : 'Новый диалог') : 'С 00:00 · этот агент';
  const note = amount === null ? 'Нет данных' : value?.partial ? 'Учтено частично' : baseline;
  const explanation = value?.reason || (session
    ? (value?.threadCount && value.threadCount > 1 ? 'Диалог и подагенты. Кредиты по серверной статистике.' : 'Кредиты текущего диалога по серверной статистике.')
    : 'Расход этого агента по аккаунту с местной полуночи.' + (value?.since ? ' Начало периода: ' + new Date(value.since).toLocaleString('ru-RU') + '.' : ''));
  return <div className="router-credit-stat" data-spend={kind}>
    <span>{session ? 'За сессию' : 'Сегодня'}</span>
    <strong title={amount === null ? explanation : formatCredits(amount) + ' кредитов'}>{formatCredits(amount)}</strong>
    <small className={value?.partial ? 'is-partial' : undefined} title={explanation}>{note}</small>
  </div>;
}

export default function RouterUsage({ bridge, enabled, ready, active = true, provider = 'codex', threadId, refreshKey }: {
  bridge: CodexBridge; enabled: boolean; ready: boolean; active?: boolean;
  provider?: 'codex' | 'claude'; threadId?: string | null; refreshKey?: string | number;
}) {
  const identity = provider + ':' + (threadId ?? '');
  const [stored, setStored] = useState<{ identity: string; value: RouterUsageSnapshot } | null>(null);
  const snapshot = enabled && ready && stored?.identity === identity ? stored.value : null;
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const lastStarted = useRef(0);
  const previousTurn = useRef({ identity, refreshKey });
  const id = useId();
  const refresh = useCallback(async function refreshUsage(afterTurn = false) {
    if (!bridge.getRouterUsage || !enabled || !ready || !active) return;
    if (inFlight.current) { if (afterTurn) queued.current = true; return; }
    // Activation and opening can happen together; share their request.
    if (!afterTurn && Date.now() - lastStarted.current < 1_000) return;
    const sequence = ++request.current;
    inFlight.current = true;
    lastStarted.current = Date.now();
    setLoading(true);
    try {
      const value = await bridge.getRouterUsage({ threadId: threadId ?? null });
      if (sequence === request.current) setStored({ identity, value });
    } catch {
      if (sequence === request.current) setStored({ identity, value: { available: false, reason: 'Не удалось получить лимиты и расход.' } });
    } finally {
      if (sequence === request.current) {
        inFlight.current = false;
        setLoading(false);
        if (queued.current) { queued.current = false; void refreshUsage(true); }
      }
    }
  }, [active, bridge, enabled, identity, ready, threadId]);
  useEffect(() => {
    request.current++;
    inFlight.current = false;
    queued.current = false;
    lastStarted.current = 0;
    setStored(null);
    setLoading(false);
    void refresh();
    return () => { request.current++; inFlight.current = false; queued.current = false; };
  }, [refresh]);
  useEffect(() => { setOpen(false); }, [identity, active, ready]);
  useEffect(() => {
    const before = previousTurn.current;
    previousTurn.current = { identity, refreshKey };
    if (before.identity === identity && before.refreshKey !== refreshKey) void refresh(true);
  }, [identity, refreshKey, refresh]);
  useEffect(() => {
    if (!open || !active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [open, active, refresh]);
  useEffect(() => {
    if (!open || !active) return;
    const outside = (event: PointerEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, active]);
  if (!enabled || !bridge.getRouterUsage) return null;

  // Unknown availability remains a candidate. Never add quotas or pick an arbitrary key.
  const candidates = snapshot?.limits?.filter(limit => limit.available !== false) || [];
  const limit = candidates.length === 1 ? candidates[0] : null;
  const { total, remaining, left } = limitUsage(limit);
  const fable = provider === 'claude' ? limit?.bands?.find(band => /fable/i.test((band.name || '') + ' ' + (band.band || ''))) : null;
  const fableLeft = limitUsage(fable ?? null).left;
  const label = left !== null ? 'Лимит · ' + formatPercent(left) + ' осталось' : 'Лимит';
  const issue = !snapshot ? (loading ? 'Загружаем…' : '') : !snapshot.available ? snapshot.reason || 'Лимиты недоступны.'
    : snapshot.limitReason || (candidates.length > 1 ? 'Несколько лимитов: общая квота неизвестна.'
      : !limit ? 'Данные лимита не переданы.' : limit.blocked ? 'Лимит временно недоступен.' : '');
  const fetchedAt = snapshot?.fetchedAt ? Date.parse(snapshot.fetchedAt) : NaN;
  return <div ref={root} className="router-usage router-credit-usage">
    <button ref={trigger} type="button" className={'router-usage-trigger' + (open ? ' open' : '')} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={issue || (provider === 'claude' ? 'Claude' : 'Codex') + ': ' + (left === null ? 'остаток неизвестен' : formatPercent(left) + ' лимита осталось')} disabled={!ready} onClick={() => setOpen(value => !value)}>
      <Gauge size={13} /><span>{label}</span>
    </button>
    {open && <section id={id} className="router-usage-popover router-credit-popover" role="dialog" aria-label="Лимиты" aria-busy={loading}>
      <header className="router-credit-head"><strong>Лимиты</strong><span>{provider === 'claude' ? 'Claude' : 'Codex'}</span><button type="button" className="icon-button small" aria-label="Обновить лимиты" data-tooltip="Обновить" disabled={loading || !ready} onClick={() => void refresh(true)}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></header>
      <section data-router-limit>
        <div className="router-credit-balance"><span>Остаток лимита</span><strong data-limit-field="percent">{formatPercent(left)}</strong></div>
        <BalanceBar left={left} label="Остаток лимита" />
        <dl className="router-credit-quota">
          <div><dt>Доступно / всего</dt><dd><span data-limit-field="remaining">{formatCredits(remaining)}</span> / <span data-limit-field="total">{formatCredits(total)}</span> кр.</dd></div>
          <div><dt>Обновление лимита</dt><dd data-limit-field="reset"><DateValue value={limit?.resetAt ?? limit?.reset_at} /></dd></div>
        </dl>
        {issue && <p className={'router-credit-status' + (!snapshot ? '' : ' is-warning')} title={limit?.blockedReason || undefined}>{issue}</p>}
      </section>
      <section className="router-credit-spend"><h2>Расход кредитов</h2><div className="router-credit-spend-grid"><SpendValue kind="session" value={snapshot?.spend?.session} threadId={threadId} /><SpendValue kind="today" value={snapshot?.spend?.today} /></div></section>
      {provider === 'claude' && <section className="router-credit-fable" data-router-band="fable"><div><span>Fable</span><strong>{fableLeft === null ? '—' : formatPercent(fableLeft) + ' осталось'}</strong></div><BalanceBar left={fableLeft} label="Остаток Fable" /><small>{fable?.blocked ? 'Лимит недоступен · ' : ''}Обновление <DateValue value={fable?.resetAt} /></small></section>}
      <footer className="router-credit-freshness">Обновлено {Number.isFinite(fetchedAt) ? <time dateTime={snapshot!.fetchedAt}>{new Date(fetchedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time> : '—'}</footer>
    </section>}
  </div>;
}
