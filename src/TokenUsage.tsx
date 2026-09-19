import { useAgentName } from './AgentContext';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2, Pin, PinOff, LoaderCircle, X } from 'lucide-react';
import { getTokenMetrics, type TokenBreakdownMetrics } from './token-metrics';
import './token-usage.css';

const format = (value: number | null) => value === null ? 'Нет данных' : value.toLocaleString('ru');
const percent = (value: number | null) => value === null ? 'Нет данных' : `${value.toLocaleString('ru', { maximumFractionDigits: 1 })}%`;

/** Share of the context window above which the trigger and the panel warn about plan usage. */
export const CONTEXT_WARN_PERCENT = 60;
export const CONTEXT_CRITICAL_PERCENT = 85;

export default function TokenUsage({ tokens, active = true, sessionKey, openSignal = 0, canCompact = false, compactSupported = true, compacting = false, onCompact }: { tokens: unknown; active?: boolean; sessionKey: string; openSignal?: number; canCompact?: boolean; compactSupported?: boolean; compacting?: boolean; onCompact?(): void }) {
  const engineName = useAgentName();
  const metrics = useMemo(() => getTokenMetrics(tokens), [tokens]);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinRef = useRef(false);
  const suppressFocus = useRef(false);
  const id = useId();
  const visible = active && open;
  const cancelClose = () => { if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const show = () => { cancelClose(); if (active) setOpen(true); };
  const close = (focus = false) => {
    cancelClose(); pinRef.current = false; setPinned(false); setOpen(false);
    if (focus) { suppressFocus.current = true; trigger.current?.focus({ preventScroll: true }); suppressFocus.current = false; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pinRef.current && !panel.current?.matches(':hover') && !trigger.current?.matches(':hover') && !panel.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };
  const togglePin = () => {
    cancelClose(); pinRef.current = !pinRef.current; setPinned(pinRef.current); setOpen(true);
    if (!pinRef.current && panel.current?.contains(document.activeElement)) {
      suppressFocus.current = true; trigger.current?.focus({ preventScroll: true }); suppressFocus.current = false;
      scheduleClose();
    }
  };
  useEffect(() => { close(); }, [active, sessionKey]);
  useEffect(() => { if (openSignal && active) { cancelClose(); pinRef.current = true; setPinned(true); setOpen(true); } }, [openSignal]);
  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(Boolean(panel.current?.contains(document.activeElement))); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      if (!button) return;
      const edge = 10, gap = 8;
      const width = Math.min(440, innerWidth - edge * 2);
      const above = Math.max(0, button.top - edge - gap);
      const below = Math.max(0, innerHeight - button.bottom - edge - gap);
      const upwards = above >= below;
      const maxHeight = Math.min(660, upwards ? above : below);
      const height = Math.min(panel.current?.scrollHeight || 660, maxHeight);
      setPosition({ position: 'fixed', width, maxHeight, left: Math.max(edge, Math.min(button.right - width, innerWidth - edge - width)), top: upwards ? Math.max(edge, button.top - gap - height) : button.bottom + gap, visibility: 'visible' });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) place(); };
    document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', onScroll, true); };
  }, [visible, metrics]);

  // Every request resends the whole context, so a full window is the main driver of plan usage.
  const contextShare = metrics.lastInputContextPercent;
  const contextLevel = contextShare === null ? null : contextShare >= CONTEXT_CRITICAL_PERCENT ? 'critical' : contextShare >= CONTEXT_WARN_PERCENT ? 'warn' : null;
  return <>
    <button ref={trigger} type="button" data-context-level={contextLevel ?? undefined} className={`token-usage token-usage-trigger ${pinned ? 'pinned' : ''} ${contextLevel ? `context-${contextLevel}` : ''}`} aria-label="Подробности токенов" aria-haspopup="dialog" aria-expanded={visible} aria-pressed={pinned} aria-controls={visible ? id : undefined}
      onPointerEnter={show} onPointerLeave={scheduleClose} onFocus={() => { if (!suppressFocus.current) show(); }} onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node | null)) scheduleClose(); }} onClick={togglePin}>
      {metrics.last.totalTokens === null ? 'Токены: нет данных' : `${format(metrics.last.totalTokens)} токенов`}{contextLevel && <span className="token-context-badge" data-level={contextLevel}>{Math.round(contextShare!)} % окна</span>}{pinned && <Pin size={10} />}
    </button>
    {visible && createPortal(<div ref={panel} id={id} role="dialog" aria-label="Использование токенов" className="token-details" style={position} onPointerEnter={cancelClose} onPointerLeave={scheduleClose} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) scheduleClose();
    }}>
      <header className="token-details-header"><div><strong>Использование токенов</strong><small>{pinned ? 'Закреплено' : 'Нажмите на счётчик, чтобы закрепить'}</small></div><button className="icon-button small" type="button" aria-label={pinned ? 'Открепить сведения о токенах' : 'Закрепить сведения о токенах'} aria-pressed={pinned} onClick={togglePin}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button><button type="button" className="icon-button small" aria-label="Закрыть сведения о токенах" onClick={() => close(true)}><X size={15} /></button></header>
      <section className="token-details-section">
        <p className="token-details-note">Счётчик под сообщением — <b>всего за последний запрос</b> по данным {engineName}. Это не размер файлов и не точный объём текущего контекста.</p>
        <UsageBreakdown title="Последний запрос" name="last" data={metrics.last} />
      </section>
      <section className="token-details-section"><UsageBreakdown title="За весь диалог" name="total" data={metrics.total} /><p className="token-details-note">Накопленные расходы: один и тот же контекст может учитываться повторно в нескольких запросах.</p></section>
      <section className="token-details-section" data-token-section="cache"><h3>Что входит в кэш</h3><p>«Из кэша» — входные токены повторно использованного префикса запроса. «Запись кэша» — токены, для которых провайдер сообщил создание новой записи. Это счётчики запросов, а не размер всего сохранённого кэша.</p><p>В префикс могут входить инструкции, история диалога и описания инструментов. <b>Разбивку по файлам, сообщениям, изображениям и инструкциям {engineName} не передаёт.</b> Определить их доли по этим данным нельзя.</p><p>Кэш сокращает повторную обработку входа; токены из кэша всё равно входят в запрос и занимают контекст.</p></section>
      <section className="token-details-section" data-token-section="context"><h3>Контекст модели</h3><dl><Metric name="Окно контекста" value={metrics.modelContextWindow} field="window" /><div className="token-metric" data-token-field="context-share"><dt>Вход последнего запроса / окно</dt><dd>{percent(metrics.lastInputContextPercent)}</dd></div></dl><p className="token-details-note">Сопоставление последнего входа с лимитом модели. Оно не учитывает последующие изменения диалога.</p>{contextLevel && <p className={`token-context-warning ${contextLevel}`} role="status" data-token-warning={contextLevel}>Контекст заполнен на {Math.round(contextShare!)} %. Каждый запрос отправляет весь контекст заново, поэтому расход лимита растёт с каждым сообщением{contextLevel === 'critical' ? ', а место для ответа сокращается' : ''}. Сожмите контекст или начните новый диалог для новой темы.</p>}</section>
      <section className="token-details-section"><button type="button" className="secondary-button token-compact-action" aria-label="Сжать контекст" title={!compactSupported ? `Сжатие ${engineName} из приложения пока недоступно` : undefined} disabled={!compactSupported || !canCompact || compacting} onClick={() => { cancelClose(); pinRef.current = true; setPinned(true); onCompact?.(); }}>{compacting ? <LoaderCircle size={14} className="spin" /> : <Minimize2 size={14} />}{compacting ? 'Сжимаем контекст…' : 'Сжать контекст'}<code>/compact</code></button></section>
    </div>, document.body)}
  </>;
}

function Metric({ name, value, field, detail }: { name: string; value: number | null; field: string; detail?: boolean }) {
  return <div className={`token-metric ${detail ? 'token-metric-part' : ''}`} data-token-field={field}><dt>{name}</dt><dd>{format(value)}</dd></div>;
}

function UsageBreakdown({ title, name, data }: { title: string; name: string; data: TokenBreakdownMetrics }) {
  return <div data-token-section={name}><h3>{title}</h3><dl>
    <Metric name="Всего" value={data.totalTokens} field="total" />
    <Metric name="Входные" value={data.inputTokens} field="input" />
    <Metric name="Из кэша" value={data.cachedInputTokens} field="cached" detail />
    <Metric name="Запись нового кэша" value={data.cacheWriteInputTokens} field="write" detail />
    <Metric name="Без чтения кэша" value={data.uncachedInputTokens} field="uncached" detail />
    <Metric name="Вне чтения и записи кэша" value={data.ordinaryInputTokens} field="ordinary" detail />
    <Metric name="Выходные" value={data.outputTokens} field="output" />
    <Metric name="Из них рассуждения (reasoning)" value={data.reasoningOutputTokens} field="reasoning" detail />
    <Metric name="Остальные выходные" value={data.nonReasoningOutputTokens} field="other-output" detail />
    <div className="token-metric" data-token-field="cache-share"><dt>Доля входа из кэша</dt><dd>{percent(data.cachedSharePercent)}</dd></div>
  </dl><p className="token-details-note">Кэш входит во входные, reasoning — в выходные. «Без чтения кэша» включает запись нового кэша. Эти вложенные значения не прибавляются к общему расходу.</p>
    {data.issues.length > 0 && <p className="token-details-warning">Часть счётчиков некорректна или не согласуется между собой. Недостоверные производные значения не рассчитаны.</p>}
  </div>;
}
