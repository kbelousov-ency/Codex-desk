import { useEffect, useRef, useState } from 'react';
import type { Attachment, MessageQueueState } from './types';

type QueueSession = {
  busy: boolean; blocked: boolean; completion: number; pause: { revision: number; reason: string };
  canSend(pauseRevision?: number): boolean;
  send(text: string, attachments: Attachment[]): Promise<boolean>;
  flush?(): Promise<void>;
};

export function useMessageQueue(initial: MessageQueueState | undefined, session: QueueSession) {
  const [state, setState] = useState<MessageQueueState>(() => initial?.items.length
    ? { ...initial, paused: true, reason: initial.reason || 'Очередь восстановлена. Проверьте сообщения и нажмите «Продолжить очередь».' }
    : { items: [], paused: false });
  const current = useRef(state);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [inFlight, setInFlight] = useState<string | null>(null);
  const flightRef = useRef<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const completion = useRef(session.completion);
  const pauseRevision = useRef(session.pause.revision);
  const mayAdvance = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const update = (next: MessageQueueState) => { current.current = next; setState(next); };
  const pause = (reason = 'Очередь приостановлена.') => update({ ...current.current, paused: true, reason });

  useEffect(() => {
    if (session.pause.revision !== pauseRevision.current) {
      pauseRevision.current = session.pause.revision;
      if (current.current.items.length) pause(session.pause.reason);
      mayAdvance.current = false;
    }
    if (session.completion !== completion.current) {
      completion.current = session.completion;
      mayAdvance.current = true;
    }
    const first = current.current.items[0];
    if (!first || first.state === 'uncertain' || current.current.paused || flightRef.current || editing || session.busy || session.blocked || !mayAdvance.current || !session.canSend()) return;
    mayAdvance.current = false;
    const pauseFence = session.pause.revision;
    flightRef.current = first.id; setInFlight(first.id);
    // Persist the unacknowledged item before issuing a side-effecting request.
    // A crash or timeout cannot turn it back into an automatic retry.
    update({ ...current.current, items: current.current.items.map(item => item.id === first.id ? { ...item, state: 'uncertain' } : item) });
    void (async () => {
      let started = false;
      try {
        await sessionRef.current.flush?.();
        if (!alive.current) return;
        if (current.current.paused || sessionRef.current.blocked || !sessionRef.current.canSend(pauseFence)) {
          update({ ...current.current, items: current.current.items.map(item => item.id === first.id ? { ...item, state: 'waiting' } : item) });
          pause('Отправка отложена. Нажмите «Продолжить очередь», когда диалог будет готов.');
          return;
        }
        started = true;
        const sent = await sessionRef.current.send(first.text, first.attachments);
        if (!alive.current) return;
        if (sent) update({ ...current.current, items: current.current.items.filter(item => item.id !== first.id) });
        else pause('Отправка не подтверждена. Проверьте историю: сообщение могло быть принято.');
      } catch {
        if (alive.current) {
          if (!started) update({ ...current.current, items: current.current.items.map(item => item.id === first.id ? { ...item, state: 'waiting' } : item) });
          pause(started ? 'Отправка не подтверждена. Проверьте историю.' : 'Не удалось сохранить очередь. Сообщение не отправлено.');
        }
      } finally {
        flightRef.current = null;
        if (alive.current) setInFlight(null);
      }
    })();
  }, [state, session.busy, session.blocked, session.completion, session.pause.revision, editing]);

  return {
    state, inFlight, editing, setEditing,
    snapshot: () => current.current,
    enqueue: (text: string, attachments: Attachment[]) => {
      if (!text.trim() && !attachments.length) return;
      update({ ...current.current, items: [...current.current.items, { id: crypto.randomUUID(), text, attachments, state: 'waiting' }] });
    },
    remove: (id: string) => {
      if (flightRef.current === id) return;
      if (editing === id) setEditing(null);
      update({ ...current.current, items: current.current.items.filter(item => item.id !== id) });
    },
    edit: (id: string, text: string, attachments: Attachment[]) => {
      if (flightRef.current === id || (!text.trim() && !attachments.length)) return;
      update({ ...current.current, items: current.current.items.map(item => item.id === id ? { ...item, text, attachments } : item) });
      setEditing(null);
    },
    markWaiting: (id: string) => update({ ...current.current, paused: true, reason: 'Повторная отправка подготовлена. Нажмите «Продолжить очередь».', items: current.current.items.map(item => item.id === id ? { ...item, state: 'waiting' } : item) }),
    pause,
    resume: () => {
      if (current.current.items.some(item => item.state === 'uncertain')) return;
      mayAdvance.current = !sessionRef.current.busy;
      update({ ...current.current, paused: false, reason: undefined });
    },
  };
}
