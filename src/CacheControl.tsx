import { useAgentName } from './AgentContext';
import { useEffect, useRef } from 'react';
import { Timer, RefreshCw } from 'lucide-react';
import { useCacheKeepAlive, type CacheSession } from './useCacheKeepAlive';

const formatTokens = (value: number) => value.toLocaleString('ru');
const clock = (milliseconds: number) => {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export default function CacheControl({ session, tokens, active = true }: { session: CacheSession; tokens: any; active?: boolean }) {
  const engineName = useAgentName();
  const panel = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const cache = useCacheKeepAlive(session);
  useEffect(() => {
    const element = panel.current;
    if (!active) { if (element) element.open = false; return; }
    const outside = (event: PointerEvent) => {
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) {
        const focused = document.activeElement;
        element.open = false;
        if (focused instanceof HTMLElement && element.contains(focused)) focused.blur();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !element?.open) return;
      const restoreFocus = element.contains(document.activeElement);
      element.open = false;
      event.preventDefault();
      if (restoreFocus) {
        trigger.current?.setAttribute('data-dismissed-focus', 'true');
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [active]);
  const remaining = cache.expiresAt === null ? null : cache.expiresAt - cache.now;
  const title = remaining === null ? 'Кэш: нет данных' : remaining <= 0 ? 'Кэш: возможно остыл' : `Кэш ≈ ${clock(remaining)}`;
  const last = tokens?.last;
  const valid = Number.isFinite(last?.inputTokens) && Number.isFinite(last?.cachedInputTokens) && last.inputTokens >= 0 && last.cachedInputTokens >= 0 && last.cachedInputTokens <= last.inputTokens;
  const writing = Number.isFinite(last?.cacheWriteInputTokens) && last.cacheWriteInputTokens > 0 ? last.cacheWriteInputTokens : null;
  return <details ref={panel} className="cache-control">
    <summary ref={trigger} aria-label="Настройки кэша" data-tooltip="Нажмите, чтобы настроить кэш"
      onPointerDown={event => event.currentTarget.setAttribute('data-dismissed-focus', 'true')}
      onBlur={event => event.currentTarget.removeAttribute('data-dismissed-focus')}
      onKeyDown={event => { if (event.key !== 'Escape') event.currentTarget.removeAttribute('data-dismissed-focus'); }}><Timer size={13} /><span className="cache-countdown">{title}</span>{cache.enabled && <span className="cache-auto">Автопинг</span>}</summary>
    <div className="cache-settings">
      <p className="cache-explanation">Это оценка по последнему ответу {engineName}. Провайдер не сообщает точный срок и может очистить кэш раньше.</p>
      {session.activityAt !== null && <p className="cache-explanation cache-last-response">Последний ответ: <time dateTime={new Date(session.activityAt).toISOString()}>{new Date(session.activityAt).toLocaleString('ru-RU')}</time>. В истории используется время завершения запроса.</p>}
      <div className="cache-metrics">{valid ? <><span>Без кэша: {formatTokens(last.inputTokens - last.cachedInputTokens)}</span><span>Из кэша: {formatTokens(last.cachedInputTokens)}</span>{writing !== null && <span>Запись кэша: {formatTokens(writing)}</span>}</> : <span>Токены кэша: данных пока нет</span>}</div>
      <div className="cache-metrics-note">Входные токены последнего запроса по данным {engineName}. «Без кэша» включает запись нового кэша, если она учитывается провайдером.</div>
      <div className="cache-options">
        <label>Срок кэша, минут<input aria-label="Срок кэша, минут" type="number" min="2" max="1440" step="1" value={cache.minutes} onChange={event => cache.changeMinutes(event.currentTarget.valueAsNumber)} /></label>
        <label className="cache-enable"><input aria-label="Автопинг кэша" type="checkbox" checked={cache.enabled} disabled={!session.threadId || session.connection !== 'ready' || !cache.message.trim()} onChange={event => cache.toggle(event.target.checked)} />Автопинг за 1 минуту до срока</label>
      </div>
      <label className="cache-ping-label">Сообщение, которое будет отправлено в чат<textarea aria-label="Текст пинга" maxLength={2000} rows={2} value={cache.message} onChange={event => cache.changeMessage(event.target.value)} /></label>
      <div className="cache-actions"><button type="button" className="secondary-button" disabled={!cache.available || cache.sending || !cache.message.trim()} onClick={() => void cache.ping()}><RefreshCw size={13} className={cache.sending ? 'spin' : ''} />Пинг сейчас</button><span>Пингов отправлено: {cache.pingCount}</span></div>
      <p className="cache-explanation">Пинг — настоящий запрос с текущими моделью и настройками: расходует токены и остаётся в истории. Работает и в фоновой вкладке, пока приложение открыто. Во время задачи или ожидания подтверждения пинг откладывается; после пропуска срока автопинг выключается.</p>
      {cache.notice && <p className="cache-notice" role="status">{cache.notice}</p>}
    </div>
  </details>;
}
