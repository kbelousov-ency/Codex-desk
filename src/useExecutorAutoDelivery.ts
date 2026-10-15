import { useEffect, useRef, useState } from 'react';
import { reviewParentKey, selectExecutorReviewDelivery, type ExecutorAutoReviewState, type ReviewEvent, type ReviewParent } from './executor-auto-review';

type DeliverySession = {
  parent: ReviewParent | null; state?: ExecutorAutoReviewState; blocked: boolean; pauseRevision: number;
  get(parent: ReviewParent): ExecutorAutoReviewState | undefined;
  update(parent: ReviewParent, event: ReviewEvent): ExecutorAutoReviewState | undefined;
  canSend(revision: number): boolean;
  send(text: string, attachments: [], silent: boolean, id: string): Promise<boolean>;
  reconcile(id: string): Promise<{ accepted: boolean; rejected?: boolean }>;
  flush?(): Promise<void>;
};

/** A single automatic slot behind the user's queue, sharing its send, guards and receipts. */
export function useExecutorAutoDelivery(session: DeliverySession) {
  const current = useRef(session); current.current = session;
  const flight = useRef(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const pause = useRef(session.pauseRevision);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const s = current.current;
    if (pause.current !== s.pauseRevision) {
      pause.current = s.pauseRevision;
      if (s.parent && s.state?.enabled) s.update(s.parent, { type: 'disable' });
      return;
    }
    if (!s.parent || s.blocked || flight.current || !s.canSend(s.pauseRevision)) return;
    const state = s.get(s.parent);
    const delivery = state && selectExecutorReviewDelivery(state);
    if (!delivery) return;
    const parent = s.parent, fence = s.pauseRevision;
    flight.current = true;
    const reserved = s.update(parent, { type: 'reserve', delivery });
    if (reserved?.delivery?.id !== delivery.id || reserved.delivery.status !== 'reserved') { flight.current = false; return; }
    const valid = () => {
      const now = current.current, record = now.get(parent);
      return alive.current && now.parent && reviewParentKey(now.parent) === reviewParentKey(parent) && !now.blocked
        && now.canSend(fence) && record?.enabled && record.delivery?.id === delivery.id && record.delivery.status === 'reserved'
        && record.revision === delivery.revision;
    };
    void (async () => {
      let committed = false;
      try {
        await s.flush?.();
        if (!valid()) { s.update(parent, { type: 'release', id: delivery.id }); return; }
        const record = s.update(parent, { type: 'commit', id: delivery.id });
        if (record?.delivery?.id !== delivery.id || record.delivery.status !== 'uncertain') return;
        committed = true;
        // No await between the final validity check, claim and the guarded native send.
        const accepted = await current.current.send(delivery.text, [], false, delivery.id);
        s.update(parent, { type: 'receipt', id: delivery.id, accepted });
      } catch (e) {
        s.update(parent, committed ? { type: 'receipt', id: delivery.id, accepted: false }
          : { type: 'release', id: delivery.id, notice: 'Не удалось сохранить сводку. Сообщение не отправлено.' });
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      } finally { flight.current = false; if (alive.current) setRevision(value => value + 1); }
    })();
  }, [session.state, session.blocked, session.parent?.threadId, session.parent?.cwd, session.parent?.provider, session.pauseRevision, revision]);
  const reconcile = async () => {
    const s = current.current, delivery = s.state?.delivery;
    if (!s.parent || !delivery || delivery.status !== 'uncertain' || flight.current) return;
    flight.current = true; setChecking(true); setError('');
    try { const receipt = await s.reconcile(delivery.id); s.update(s.parent, { type: 'receipt', id: delivery.id, ...receipt }); await s.flush?.(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { flight.current = false; if (alive.current) setChecking(false); }
  };
  return { reconcile, checking, error };
}
