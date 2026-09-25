import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import type { CodexBridge, RouterLimit, RouterUsageSnapshot } from './types';
import { resetText } from './UsageLimit';
import './router-usage.css';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const summary = (value: unknown): string | null => text(value) || (value && typeof value === 'object' ? JSON.stringify(value).slice(0, 400) : null);

function at(root: RecordValue, paths: string[][]): unknown {
  for (const path of paths) {
    let current: unknown = root;
    for (const key of path) { const record = object(current); current = record?.[key]; }
    if (current !== undefined && current !== null) return current;
  }
  return null;
}

function formatCredits(value: unknown): string | null {
  const amount = number(value);
  if (amount === null) return text(value);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount);
}

function limitUsage(limit: RouterLimit) {
  const ledger = number(limit.ledger_used_credits);
  const total = number(limit.limit_credits);
  // The ledger matches the period spend. API remaining/percent belong to
  // used_credits and must not be mixed with a different ledger amount.
  if (ledger !== null) return {
    used: ledger,
    total,
    remaining: total !== null && total >= 0 ? Math.max(0, total - ledger) : null,
    percent: total !== null && total > 0 ? ledger / total * 100 : null,
  };
  const used = number(limit.used_credits);
  return {
    used,
    total,
    remaining: number(limit.remaining_credits),
    percent: number(limit.used_percent) ?? (used !== null && total !== null && total > 0 ? used / total * 100 : null),
  };
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value) + '%';
}

function details(snapshot: RouterUsageSnapshot) {
  const root = object(snapshot.overview) || {};
  const last24h = object(at(root, [['last_24h'], ['last24h']])) || {};
  const dayCredits = formatCredits(at(last24h, [['credits']]));
  const requests = formatCredits(at(last24h, [['requests']]));
  const failures = formatCredits(at(last24h, [['failures']]));
  const email = text(at(root, [['email'], ['user', 'email'], ['account', 'email'], ['me', 'email']]));
  const tier = text(at(root, [['tier'], ['plan'], ['subscription']]));
  const state = text(at(root, [['state'], ['status']]));
  const coverage = summary(at(root, [['coverage']]));
  const sources = at(root, [['sources']]);
  return { dayCredits, requests, failures, email, tier, state, coverage, sources };
}

function LimitCard({ limit, index, now }: { limit: RouterLimit; index: number; now: number }) {
  const name = limit.key || `Ключ ${index + 1}`;
  const resetAt = limit.reset_at ? Date.parse(limit.reset_at) : NaN;
  const hasReset = Number.isFinite(resetAt);
  const resetDate = hasReset ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(resetAt) : '—';
  const { used, total, remaining, percent } = limitUsage(limit);
  const incomplete = [used, total, remaining].some(value => value === null);
  return <section className="router-limit-card" aria-label={`Лимит: ${name}`} data-router-limit>
    <h3>{name}</h3>
    {(limit.tier || limit.state) && <p className="router-usage-note">{[limit.tier, limit.state].filter(Boolean).join(' · ')}</p>}
    <dl>
      <div data-limit-field="percent"><dt>Использовано</dt><dd>{formatPercent(percent)}</dd></div>
      <div data-limit-field="used"><dt>Потрачено</dt><dd>{formatCredits(used) ?? '—'}</dd></div>
      <div data-limit-field="total"><dt>Всего</dt><dd>{formatCredits(total) ?? '—'}</dd></div>
      <div data-limit-field="remaining"><dt>Осталось</dt><dd>{formatCredits(remaining) ?? '—'}</dd></div>
      <div data-limit-field="reset"><dt>Сброс</dt><dd>{hasReset ? <time dateTime={limit.reset_at!}>{resetDate}</time> : '—'}{hasReset && <small>{resetAt > now ? resetText(limit.reset_at, now) : 'Дата сброса прошла. Обновите данные.'}</small>}</dd></div>
    </dl>
    <p className="router-usage-note">Суммы указаны в кредитах текущего периода.</p>
    {incomplete && <p className="router-usage-note router-limit-missing">Роутер не передал часть сумм. «—» означает отсутствие данных.</p>}
    {percent === null && <p className="router-usage-note router-limit-missing">Недостаточно данных для расчёта процента лимита. Расход за 24 часа ниже — отдельная величина.</p>}
    {limit.available === false && <p className="router-usage-error">Лимит этого ключа недоступен.</p>}
  </section>;
}

export default function RouterUsage({ bridge, enabled, ready, active = true }: { bridge: CodexBridge; enabled: boolean; ready: boolean; active?: boolean }) {
  const [snapshot, setSnapshot] = useState<RouterUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const [now, setNow] = useState(Date.now);
  const id = useId();
  const refresh = useCallback(async () => {
    if (!bridge.getRouterUsage || !enabled || !ready) return;
    const sequence = ++request.current;
    setLoading(true);
    try { const result = await bridge.getRouterUsage(); if (sequence === request.current) { setSnapshot(result); setNow(Date.now()); } }
    catch { if (sequence === request.current) setSnapshot({ available: false, reason: 'Не удалось получить статистику роутера.' }); }
    finally { if (sequence === request.current) setLoading(false); }
  }, [bridge, enabled, ready]);
  useEffect(() => { if (active) void refresh(); else setOpen(false); return () => { request.current++; }; }, [active, refresh]);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => { if (open && active) void refresh(); }, [open, active, refresh]);
  useEffect(() => {
    if (!open || !active) return;
    const outside = (event: PointerEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, active]);
  if (!enabled || !bridge.getRouterUsage) return null;
  const info = snapshot && snapshot.available ? details(snapshot) : null;
  const singleLimit = snapshot?.limits?.length === 1 ? snapshot.limits[0] : null;
  const percent = singleLimit ? limitUsage(singleLimit).percent : null;
  // Without a published quota a percentage cannot be computed, so the badge falls
  // back to the measured daily spend instead of an empty «Роутер · —».
  const label = percent !== null ? 'Роутер · ' + formatPercent(percent)
    : info?.dayCredits ? 'Роутер · ' + info.dayCredits + ' кр./сут'
    : 'Роутер';
  const title = !snapshot?.available ? snapshot?.reason || 'Статистика роутера ещё не получена.'
    : percent !== null ? 'Использовано лимита: ' + formatPercent(percent)
    : singleLimit ? 'Недостаточно данных для расчёта процента лимита; показан расход за 24 часа.'
    : 'Статистика роутера';
  return <div ref={root} className="router-usage">
    <button ref={trigger} type="button" className={`router-usage-trigger ${open ? 'open' : ''}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={title} disabled={!ready} onClick={() => setOpen(value => !value)}>
      <Gauge size={13} /><span>{label}</span>
    </button>
    {open && <section id={id} className="router-usage-popover" role="dialog" aria-label="Статистика роутера">
      <header><strong>Статистика роутера</strong><button type="button" className="icon-button small" aria-label="Обновить статистику роутера" data-tooltip="Обновить" disabled={loading || !ready} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? 'spin' : ''} /></button></header>
      {!snapshot && <p className="router-usage-muted">Загружаем…</p>}
      {snapshot && !snapshot.available && <p className="router-usage-error">{snapshot.reason || 'Статистика недоступна.'}</p>}
      {snapshot?.available && info && <>
        {info.email && <p className="router-usage-row"><span>Аккаунт</span><strong>{info.email}</strong></p>}
        <div className="router-limits"><h2>Лимит</h2>
          {snapshot.limits?.map((limit, index) => <LimitCard key={`${limit.key}:${index}`} limit={limit} index={index} now={now} />)}
          {snapshot.limitReason && <p className="router-usage-error">Не удалось обновить лимиты: {snapshot.limitReason}</p>}
          {!snapshot.limits?.length && !snapshot.limitReason && <p className="router-usage-note">Роутер не передал лимиты ключей.</p>}
        </div>
        {!snapshot.limits?.length && info.tier && <p className="router-usage-row"><span>Тариф</span><strong>{info.tier}</strong></p>}
        {!snapshot.limits?.length && info.state && <p className="router-usage-row"><span>Состояние</span><strong>{info.state}</strong></p>}
        <p className="router-usage-note">За последние 24 часа · все ваши ключи</p>
        {snapshot.overviewReason && <p className="router-usage-error">Суточная статистика недоступна: {snapshot.overviewReason}</p>}
        {info.dayCredits && <p className="router-usage-row"><span>За 24 часа</span><strong>{info.dayCredits} кредитов</strong></p>}
        {info.requests && <p className="router-usage-row"><span>Запросы за 24 часа</span><strong>{info.requests}</strong></p>}
        {info.failures && <p className="router-usage-row"><span>Ошибки за 24 часа</span><strong>{info.failures}</strong></p>}
        {info.coverage && <p className="router-usage-note">Покрытие: {info.coverage}</p>}
        {info.sources && <p className="router-usage-note">Источники: {summary(info.sources)}</p>}
        <p className="router-usage-note">Обновлено: {new Date(snapshot.fetchedAt || Date.now()).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</p>
      </>}
    </section>}
  </div>;
}
