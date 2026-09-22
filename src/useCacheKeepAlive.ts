import { useEffect, useRef, useState } from 'react';

export const DEFAULT_CACHE_PING = 'Пинг для поддержания кэша. Ответь только «ОК», без инструментов и изменений файлов.';
export const CACHE_PING_LEAD_MS = 60_000;

export type CacheSession = {
  activityAt: number | null;
  generation: number;
  completed: number;
  threadId?: string;
  busy: boolean;
  loading: boolean;
  connection: string;
  pending: number;
  blocked?: boolean;
  sendPing(text: string): Promise<boolean>;
};

/** Only schedules ordinary visible messages; cache availability remains an estimate. */
export function useCacheKeepAlive(session: CacheSession) {
  const [minutes, setMinutes] = useState(60);
  const [message, setMessage] = useState(DEFAULT_CACHE_PING);
  const [enabled, setEnabled] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [pingCount, setPingCount] = useState(0);
  const enabledRef = useRef(false);
  const inFlight = useRef(false);
  const attempted = useRef<{ generation: number; completed: number } | null>(null);
  const mounted = useRef(true);
  const generationRef = useRef(session.generation);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const disable = (reason = '') => {
    enabledRef.current = false; setEnabled(false);
    if (reason) setNotice(reason);
  };
  const available = Boolean(session.threadId) && session.connection === 'ready' && !session.busy && !session.loading && !session.pending && !session.blocked;
  const send = async () => {
    const current = sessionRef.current;
    if (inFlight.current || !current.threadId || current.connection !== 'ready' || current.busy || current.loading || current.pending || current.blocked || !message.trim()) return;
    inFlight.current = true; setSending(true); setNotice('Отправляем пинг…');
    attempted.current = { generation: current.generation, completed: current.completed };
    try {
      const accepted = await current.sendPing(message.trim());
      if (!mounted.current || sessionRef.current.generation !== current.generation) return;
      if (accepted) {
        setPingCount(count => count + 1);
        setNotice(sessionRef.current.completed > current.completed ? 'Пинг обработан Codex.' : 'Пинг отправлен в беседу. Ожидаем ответа Codex.');
      } else disable('Пинг не отправлен. Автопинг выключен; можно повторить вручную.');
    } catch (error) {
      if (mounted.current && sessionRef.current.generation === current.generation) disable(`Автопинг выключен: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const at = Date.now(); setNow(at);
    if (generationRef.current !== session.generation) {
      generationRef.current = session.generation;
      attempted.current = null;
      disable(enabledRef.current ? 'Автопинг выключен: сеанс остановлен, переподключён или его параметры изменились.' : '');
      return;
    }
    if (!enabledRef.current || !available || inFlight.current || session.activityAt === null) return;
    const remaining = session.activityAt + minutes * 60_000 - at;
    if (remaining <= 0) {
      disable('Срок оценки истёк. Автопинг остановлен; отправьте сообщение или нажмите «Пинг сейчас».');
      return;
    }
    if (remaining > CACHE_PING_LEAD_MS) return;
    // An accepted turn/start is not proof of a refreshed cache. Wait for completion.
    if (attempted.current?.generation === session.generation && attempted.current.completed === session.completed) return;
    void send();
  };
  useEffect(() => {
    mounted.current = true;
    const interval = setInterval(() => tickRef.current(), 1000);
    return () => { mounted.current = false; clearInterval(interval); };
  }, []);
  useEffect(() => { tickRef.current(); }, [session.generation, session.activityAt, session.completed, available]);
  useEffect(() => {
    if (attempted.current?.generation === session.generation && session.completed > attempted.current.completed) {
      setNotice(previous => previous === 'Пинг отправлен в беседу. Ожидаем ответа Codex.' ? 'Пинг обработан Codex.' : previous);
    }
  }, [session.completed, session.generation]);

  const toggle = (value: boolean) => {
    if (!value) { disable(); setNotice('Автопинг выключен.'); return; }
    if (!session.threadId || session.connection !== 'ready' || !message.trim()) return;
    enabledRef.current = true; setEnabled(true); setNotice('Автопинг включён для этой вкладки.');
    tickRef.current();
  };
  const changeMinutes = (value: number) => {
    if (!Number.isFinite(value) || value < 2 || value > 1440) return;
    setMinutes(Math.floor(value));
    if (enabledRef.current) disable('Интервал изменён. Включите автопинг для нового интервала.');
  };
  const changeMessage = (value: string) => {
    setMessage(value);
    if (enabledRef.current) disable('Текст пинга изменён. Включите автопинг для нового сообщения.');
  };
  return { minutes, message, enabled, now, notice, sending, pingCount, available,
    changeMinutes, changeMessage, toggle, ping: send,
    expiresAt: session.activityAt === null ? null : session.activityAt + minutes * 60_000 };
}
