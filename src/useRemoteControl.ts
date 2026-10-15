import { useEffect, useRef, useState } from 'react';
import type { CodexBridge, RemoteAnswer, RemoteBlockReason, RemoteDispatchContext, RemoteDispatchRequest, RemoteDispatchResult, RemoteRuntimeSnapshot, RemoteTarget, RemoteThreadAccessState } from './types';
import type { useCodex, WorkLifecycleEvent } from './useCodex';
import type { useMessageQueue } from './useMessageQueue';

const fields: (keyof RemoteTarget)[] = ['grantId', 'generation', 'provider', 'threadId', 'projectKey', 'sessionId', 'runtimeId'];
const sameTarget = (a: RemoteTarget | null | undefined, b: RemoteTarget) => Boolean(a && fields.every(key => a[key] === b[key]));
const blocked = (reason: RemoteBlockReason = 'local_action'): RemoteDispatchResult => ({ phase: 'blocked', error: { code: 'blocked', reason, message: 'Требуется действие на компьютере', requiresComputer: true } });
type Options = {
  bridge: CodexBridge; codex: ReturnType<typeof useCodex>; queue: ReturnType<typeof useMessageQueue>;
  blocked: boolean; externalBlocked: boolean; enqueueBlocked: boolean; closing: boolean;
  flush?(): Promise<void>; onEnqueue(): void;
};

/** A mounted tab owns this adapter even when another tab is selected. Never touches composer. */
export function useRemoteControl(options: Options) {
  const latest = useRef(options); latest.current = options;
  const accessRef = useRef<RemoteThreadAccessState | null>(null);
  const [access, setAccess] = useState<RemoteThreadAccessState | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const revision = useRef(0), lastState = useRef(''), publishing = useRef(false);
  const alive = useRef(true);
  const updateAccess = (value: RemoteThreadAccessState) => {
    accessRef.current = value;
    if (alive.current) setAccess(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
  };
  const valid = (context: RemoteDispatchContext) => {
    const s = latest.current.codex.getRemoteSnapshot();
    return Boolean(accessRef.current?.enabled && sameTarget(accessRef.current.target, context.target)
      && s.threadId === context.target.threadId && s.provider === context.target.provider);
  };
  // Internal useCodex checks its own busy/pending/steering refs, including its own reservation.
  const canDispatch = (context: RemoteDispatchContext) => valid(context)
    && !latest.current.closing && (context.kind === 'stop' || !latest.current.externalBlocked);
  const snapshot = (): RemoteRuntimeSnapshot => {
    const o = latest.current, s = o.codex.getRemoteSnapshot(), q = o.queue.snapshot();
    const blockers: RemoteBlockReason[] = [];
    if (s.busy || s.dispatching || s.steering) blockers.push('busy');
    if (s.approval) blockers.push('approval');
    if (s.question) blockers.push('question');
    if (s.terminal) blockers.push('terminal');
    if (s.restoring || !s.threadReady) blockers.push('restoring');
    if (s.pendingMessage) blockers.push('uncertain_delivery');
    if (s.connection !== 'ready') blockers.push('disconnected');
    if (s.settingsChanging || s.authInProgress) blockers.push('settings_changing');
    if (s.modelUnavailable) blockers.push('model_unavailable');
    if (s.compacting) blockers.push('compacting');
    if (q.paused && q.items.length) blockers.push('queue_paused');
    if (q.items.length) blockers.push('queue_not_empty');
    if (q.items.length >= 50) blockers.push('queue_full');
    if (o.externalBlocked || o.queue.editing) blockers.push('local_action');
    if (o.closing) blockers.push('closing');
    const ready = Boolean(s.threadId && s.threadReady && s.connection === 'ready' && !s.terminal && !s.restoring);
    const base = ready && !o.blocked && !s.pendingMessage && !s.settingsChanging && !s.authInProgress && !s.modelUnavailable;
    const actions = {
      send: base && !s.busy && !s.dispatching && !s.steering && !q.items.length && !o.queue.inFlight,
      enqueue: ready && !o.enqueueBlocked && q.items.length < 50,
      steer: base && s.busy && Boolean(s.activeTurnId) && !s.compacting && !s.steering && !s.dispatching && o.codex.capabilities.steer,
      stop: ready && s.busy && Boolean(s.activeTurnId) && !o.closing,
    };
    // History and live state only contain assistant messages already marked complete.
    const turns = o.codex.turnWork;
    const candidates = o.codex.items.filter(item => item.type === 'agentMessage' && item.complete && item.turnId
      && turns[item.turnId]?.status === 'completed' && item.phase !== 'commentary' && typeof item.text === 'string');
    const last = candidates.at(-1);
    const answer: RemoteAnswer | null = last ? {
      answerId: last.id, turnId: last.turnId!, text: last.text.slice(0, 100_000), truncated: last.text.length > 100_000,
      completedAt: turns[last.turnId!]?.completedAt ? new Date(turns[last.turnId!].completedAt!).toISOString() : null,
    } : null;
    return { threadId: s.threadId, provider: s.provider, ready, title: o.codex.thread?.name || o.codex.thread?.preview || 'Беседа',
      phase: !ready ? 'unavailable' : s.busy ? 'running' : blockers.length ? 'blocked' : 'idle',
      activeTurnId: s.activeTurnId, queue: { count: q.items.length, limit: 50, paused: q.paused }, blockers, actions,
      requiresComputer: blockers.some(value => !['busy', 'queue_not_empty', 'queue_full'].includes(value)),
      revision: revision.current, updatedAt: '', lastAnswer: answer,
      ...(s.pendingMessage?.remote ? { reservationOperationId: s.pendingMessage.remote.operationId } : {}),
    };
  };
  const publish = async (force = false) => {
    if (publishing.current || !latest.current.bridge.publishRemoteState || !alive.current) return;
    const state = snapshot(), encoded = JSON.stringify({ ...state, revision: 0 });
    if (!force && encoded === lastState.current) return;
    publishing.current = true;
    try {
      const result = await latest.current.bridge.publishRemoteState!({ ...state, revision: ++revision.current, updatedAt: new Date().toISOString() });
      if (alive.current) { lastState.current = encoded; updateAccess(result); }
    } catch { /* A stale/unavailable binding is retried by state publication, never by model dispatch. */ }
    finally { publishing.current = false; }
  };
  const execute = async ({ command, operation }: RemoteDispatchRequest): Promise<RemoteDispatchResult> => {
    const o = latest.current;
    const context: RemoteDispatchContext = { operationId: operation.operationId, target: command.target, kind: command.kind,
      clientUserMessageId: operation.clientUserMessageId, ...('expectedTurnId' in command ? { expectedTurnId: command.expectedTurnId } : {}) };
    if (!valid(context)) return { phase: 'stale', error: { code: 'stale_target', message: 'Адрес беседы изменился.', requiresComputer: false } };
    const state = snapshot();
    if (!state.actions[command.kind === 'enqueue' ? 'enqueue' : command.kind]) return blocked(state.blockers[0]);
    if (command.kind === 'enqueue') {
      o.onEnqueue();
      if (!o.queue.enqueue(command.text, [], { id: operation.clientUserMessageId!, remote: context, holdUntilPersisted: true })) return blocked('queue_full');
      try {
        if (!o.flush) throw new Error('Workspace persistence unavailable');
        await o.flush();
      } catch { o.queue.cancelRemote(value => value.operationId === operation.operationId); return blocked('local_action'); }
      if (!valid(context)) { o.queue.cancelRemote(value => value.operationId === operation.operationId); return { phase: 'cancelled' }; }
      o.queue.releaseRemote(operation.clientUserMessageId!);
      return { phase: 'queued', queuePosition: o.queue.snapshot().items.findIndex(item => item.id === operation.clientUserMessageId) + 1 };
    }
    const accepted = command.kind === 'send' ? await o.codex.send(command.text, [], false, operation.clientUserMessageId!, context)
      : command.kind === 'steer' ? await o.codex.steer(command.text, [], context) : await o.codex.stop(context);
    // The main process records the exact native ACK. A later active turn may belong to another send.
    if (accepted) return { phase: 'accepted', ...(command.kind === 'stop' ? { turnId: command.expectedTurnId } : {}) };
    if (o.codex.getRemoteSnapshot().pendingMessage?.remote?.operationId === context.operationId) return { phase: 'uncertain' };
    if (command.kind !== 'send' && o.codex.getRemoteSnapshot().activeTurnId !== command.expectedTurnId) return { phase: 'stale', error: { code: 'stale_turn', message: 'Текущая задача уже сменилась.', requiresComputer: false } };
    return blocked();
  };
  const executeRef = useRef(execute); executeRef.current = execute;
  const publishRef = useRef(publish); publishRef.current = publish;
  useEffect(() => {
    alive.current = true; lastState.current = '';
    const bridge = options.bridge;
    const dispatch = bridge.onRemoteDispatch?.(request => {
      void (async () => {
        let result: RemoteDispatchResult;
        try { result = await executeRef.current(request); }
        catch { result = { phase: 'uncertain' }; }
        await bridge.completeRemoteDispatch?.({ dispatchId: request.dispatchId, result }).catch(() => {});
        void publishRef.current(true);
      })();
    });
    const accessChanged = bridge.onRemoteAccess?.(updateAccess);
    const cancel = bridge.onRemoteCancel?.(request => {
      latest.current.queue.cancelRemote(context => request.operationIds.includes(context.operationId));
      void latest.current.flush?.().catch(() => {});
    });
    const timer = setInterval(() => { void publishRef.current(true); }, 1500);
    return () => { alive.current = false; clearInterval(timer); dispatch?.(); accessChanged?.(); cancel?.(); };
  }, [options.bridge]);
  useEffect(() => { void publish(); });
  const changeAccess = async (enabled: boolean) => {
    const state = accessRef.current;
    if (!state?.threadId || !options.bridge.setRemoteThreadAccess) return;
    setAccessBusy(true);
    try { updateAccess(await options.bridge.setRemoteThreadAccess({ enabled, expected: { provider: state.provider, threadId: state.threadId, accessRevision: state.accessRevision } })); }
    catch { options.codex.setError('Не удалось изменить доступ с телефона. Обновите состояние беседы и повторите.'); }
    finally { setAccessBusy(false); }
  };
  const onWork = (event: WorkLifecycleEvent) => {
    if (event.kind !== 'completed' || !event.result || event.status !== 'completed') return;
    void latest.current.bridge.publishRemoteAnswer?.({ answerId: `turn:${event.turnId}`, turnId: event.turnId,
      text: event.result.slice(0, 100_000), truncated: event.result.length > 100_000, completedAt: new Date().toISOString() }).catch(() => {});
  };
  return { access, accessBusy, changeAccess, canDispatch, valid, onWork };
}
