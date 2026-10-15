import { useEffect, useRef, useState } from 'react';
import type { Attachment, MessageQueueState, RemoteDispatchContext } from './types';

type QueueSession = {
  busy: boolean; blocked: boolean; completion: number; pause: { revision: number; reason: string };
  canSend(pauseRevision?: number): boolean;
  send(text: string, attachments: Attachment[], silentCompletion?: boolean, messageId?: string): Promise<boolean>;
  sendRemote?(text: string, attachments: Attachment[], context: RemoteDispatchContext): Promise<boolean>;
  /** Identity/grant validity, independent of temporary busy or this queue's inFlight. */
  canRemote?(context: RemoteDispatchContext): boolean;
  reconcile?(id: string): Promise<{ accepted: boolean; rejected?: boolean }>;
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
  // Remote enqueue is admitted by the host and persisted by App separately from
  // this hook's normal queue snapshot. Keep its head inert until the caller has
  // durably committed the operation and explicitly releases it.
  const heldRemoteRef = useRef(new Set<string>());
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
    if (!first || heldRemoteRef.current.has(first.id) || first.state === 'uncertain' || current.current.paused || flightRef.current || editing || session.busy || session.blocked || !mayAdvance.current || !session.canSend()) return;
    if (first.remote && (!session.sendRemote || !session.canRemote?.(first.remote))) {
      update({ ...current.current, items: current.current.items.filter(item => item.id !== first.id), paused: true, reason: 'Удалённое сообщение отменено: доступ или привязка беседы изменились.' });
      mayAdvance.current = false;
      return;
    }
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
        if (first.remote && !sessionRef.current.canRemote?.(first.remote)) {
          update({ ...current.current, items: current.current.items.filter(item => item.id !== first.id), paused: true, reason: 'Удалённое сообщение отменено: доступ или привязка беседы изменились.' });
          return;
        }
        if (current.current.paused || sessionRef.current.blocked || !sessionRef.current.canSend(pauseFence)) {
          update({ ...current.current, items: current.current.items.map(item => item.id === first.id ? { ...item, state: 'waiting' } : item) });
          pause('Отправка отложена. Нажмите «Продолжить очередь», когда диалог будет готов.');
          return;
        }
        started = true;
        const sent = first.remote
          ? await sessionRef.current.sendRemote!(first.text, first.attachments, first.remote)
          : await sessionRef.current.send(first.text, first.attachments, false, first.id);
        if (!alive.current) return;
        if (sent) { heldRemoteRef.current.delete(first.id); update({ ...current.current, items: current.current.items.filter(item => item.id !== first.id) }); }
        else if (first.remote && sessionRef.current.reconcile) {
          const receipt = await sessionRef.current.reconcile(first.id);
          if (!alive.current) return;
          if (receipt.accepted || receipt.rejected) { heldRemoteRef.current.delete(first.id); update({ ...current.current, items: current.current.items.filter(item => item.id !== first.id) }); }
          pause(receipt.accepted ? 'Сообщение уже принято. Повторная отправка не нужна.'
            : receipt.rejected ? 'Удалённое сообщение не передано агенту. Очередь приостановлена.'
              : 'Отправка не подтверждена. Проверьте историю: сообщение могло быть принято.');
        } else pause('Отправка не подтверждена. Проверьте историю: сообщение могло быть принято.');
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
    enqueue: (text: string, attachments: Attachment[], options?: { id?: string; remote?: RemoteDispatchContext; holdUntilPersisted?: boolean }) => {
      if ((!text.trim() && !attachments.length) || current.current.items.length >= 50) return false;
      const remote = options?.remote;
      if (remote && (remote.kind !== 'enqueue' || !remote.clientUserMessageId || attachments.length || !sessionRef.current.canRemote?.(remote))) return false;
      const id = options?.id || remote?.clientUserMessageId || crypto.randomUUID();
      if ((remote && id !== remote.clientUserMessageId) || current.current.items.some(item => item.id === id)) return false;
      if (remote && options?.holdUntilPersisted) heldRemoteRef.current.add(id);
      if (!current.current.paused && !sessionRef.current.busy) mayAdvance.current = true;
      update({ ...current.current, items: [...current.current.items, { id, text, attachments, state: 'waiting', ...(remote ? { remote } : {}) }] });
      return true;
    },
    releaseRemote: (id: string) => {
      if (!heldRemoteRef.current.delete(id)) return false;
      // A new object identity wakes the queue effect after admission has been
      // durably committed; no local draft or ordering field is changed.
      update({ ...current.current });
      return true;
    },
    cancelRemote: (matches: (context: RemoteDispatchContext) => boolean) => {
      const removed = current.current.items.filter(item => item.remote && item.state !== 'uncertain' && flightRef.current !== item.id && matches(item.remote));
      if (!removed.length) return [];
      const ids = new Set(removed.map(item => item.id));
      for (const id of ids) heldRemoteRef.current.delete(id);
      update({ ...current.current, items: current.current.items.filter(item => !ids.has(item.id)) });
      return [...ids];
    },
    remove: (id: string) => {
      if (flightRef.current === id || current.current.items.find(item => item.id === id)?.remote) return;
      if (editing === id) setEditing(null);
      update({ ...current.current, items: current.current.items.filter(item => item.id !== id) });
    },
    edit: (id: string, text: string, attachments: Attachment[]) => {
      if (flightRef.current === id || current.current.items.find(item => item.id === id)?.remote || (!text.trim() && !attachments.length)) return;
      update({ ...current.current, items: current.current.items.map(item => item.id === id ? { ...item, text, attachments } : item) });
      setEditing(null);
    },
    markWaiting: async (id: string) => {
      if (flightRef.current || !sessionRef.current.reconcile) return;
      flightRef.current = id; setInFlight(id);
      try {
        const receipt = await sessionRef.current.reconcile(id);
        if (!alive.current) return;
        if (receipt.accepted) update({ ...current.current, paused: true, reason: 'Сообщение уже принято. Оно удалено из очереди без повторной отправки.', items: current.current.items.filter(item => item.id !== id) });
        else if (receipt.rejected && current.current.items.find(item => item.id === id)?.remote) update({ ...current.current, paused: true, reason: 'Агент отклонил сообщение с телефона. Запись удалена без повторной отправки; новый запрос отправьте отдельно.', items: current.current.items.filter(item => item.id !== id) });
        else if (receipt.rejected) update({ ...current.current, paused: true, reason: 'Сервер отклонил сообщение. Можно изменить его и продолжить очередь.', items: current.current.items.map(item => item.id === id ? { ...item, state: 'waiting' } : item) });
        else pause('Подтверждение не найдено. Сообщение могло быть принято; повторная отправка заблокирована. Проверьте позже.');
      } catch { if (alive.current) pause('Проверка отправки недоступна. Повторная отправка заблокирована.'); }
      finally { flightRef.current = null; if (alive.current) setInFlight(null); }
    },
    pause,
    resume: () => {
      if (current.current.items.some(item => item.state === 'uncertain')) return;
      mayAdvance.current = !sessionRef.current.busy;
      update({ ...current.current, paused: false, reason: undefined });
    },
  };
}
