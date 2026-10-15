import { randomUUID } from 'node:crypto';
import { findAcceptedMessage, uncertainDelivery } from './message-status.mjs';

const failed = () => Object.assign(new Error('REMOTE_BLOCKED: Удалённая команда больше недоступна.'), { code: 'REMOTE_BLOCKED' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const targetFields = ['grantId', 'generation', 'provider', 'threadId', 'projectKey', 'sessionId', 'runtimeId'];
const sameTarget = (a, b) => a && b && targetFields.every(key => a[key] === b[key]);

/** Private host adapter. Only registered, mounted renderers own dispatch and FIFO. */
export function createRemoteControlHost({ controller, windows, assertAllowed, timeoutMs = 35_000 }) {
  const entries = new Map(), pending = new Map(), operations = new Map();
  const send = (entry, channel, data) => {
    if (entry.record.rendererGone || entry.record.window.isDestroyed()) throw failed();
    entry.record.window.webContents.send(channel, { sessionId: entry.id, ...data });
  };
  const current = entry => Boolean(entry?.session) && entries.get(entry.id) === entry && !entry.session.disposed
    && entry.session.remoteRuntimeId === entry.runtimeId
    && entry.session.currentThreadId === entry.threadId && entry.session.client && entry.session.bootstrap;
  const assertCurrent = entry => { if (!current(entry)) throw failed(); assertAllowed(entry.record, entry.session); };
  const emitAccess = async entry => {
    if (entries.get(entry.id) !== entry) return;
    const state = await controller.getThreadAccess(entry.id);
    if (entries.get(entry.id) === entry) send(entry, 'remoteControl:access', { state });
  };
  const dispatch = (entry, request) => {
    assertCurrent(entry);
    const { command, operation } = request;
    operations.set(operation.operationId, { entry, command, operation });
    const dispatchId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(dispatchId); reject(new Error('Remote dispatch acknowledgement timed out')); }, timeoutMs);
      pending.set(dispatchId, { entry, resolve, reject, timer });
      try { send(entry, 'remoteControl:dispatch', { dispatchId, ...request }); }
      catch (error) { clearTimeout(timer); pending.delete(dispatchId); reject(error); }
    });
  };
  const invalidate = (id) => {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve();
    entries.delete(id);
    for (const [key, call] of pending) if (call.entry === entry) {
      clearTimeout(call.timer); pending.delete(key); call.reject(new Error('Remote runtime ended'));
    }
    // unregisterRuntime removes its binding synchronously, before durable fencing awaits.
    return controller.unregisterRuntime(id, entry.runtimeId);
  };
  return {
    invalidate,
    async publish(record, id, snapshot) {
      const session = record.sessions.get(id);
      if (!session || !snapshot || !['codex', 'claude'].includes(snapshot.provider)) throw failed();
      if ((session.settings.provider || 'codex') !== snapshot.provider) throw failed();
      const threadId = snapshot.threadId === session.currentThreadId ? snapshot.threadId : null;
      const valid = Boolean(threadId && snapshot.ready && session.client && session.bootstrap);
      let entry = entries.get(id);
      if (entry && (entry.runtimeId !== session.remoteRuntimeId || entry.threadId !== threadId)) { await invalidate(id); entry = null; }
      if (!entry) { entry = { id, record, session, runtimeId: session.remoteRuntimeId, threadId }; entries.set(id, entry); }
      entry.snapshot = structuredClone(snapshot);
      const owned = entry;
      const access = await controller.registerRuntime({
        sessionId: id, runtimeId: entry.runtimeId, provider: snapshot.provider, threadId,
        cwd: session.currentCwd, title: String(snapshot.title || 'Беседа').slice(0, 256), ready: valid,
        getState: async () => { assertCurrent(owned); return structuredClone(owned.snapshot); },
        getLastAnswer: async () => { assertCurrent(owned); return owned.snapshot.lastAnswer || null; },
        dispatch: request => dispatch(owned, request),
        reconcile: async ({ operation }) => {
          assertCurrent(owned);
          if (!operation.clientUserMessageId) return { accepted: false, rejected: false };
          const receipt = await session.request('message/status', { threadId: owned.threadId, clientUserMessageId: operation.clientUserMessageId });
          assertCurrent(owned);
          if (snapshot.provider === 'claude' && operation.kind === 'steer' && receipt.accepted) {
            // A cached steer echo can still refer to the previous turn. Canonical completed
            // history must contain its UUID before claiming that Claude consumed it.
            const read = await session.request('thread/read', { threadId: owned.threadId, includeTurns: true });
            assertCurrent(owned);
            if (read.thread?.id !== owned.threadId) throw failed();
            const exact = findAcceptedMessage(read.thread, operation.clientUserMessageId);
            return exact ? { ...exact, consumed: ['completed', 'interrupted', 'failed'].includes(exact.status) }
              : { ...receipt, status: undefined, consumed: false };
          }
          return { ...receipt, consumed: snapshot.provider !== 'claude' };
        },
        cancelPending: async request => { send(owned, 'remoteControl:cancel', request); await emitAccess(owned); },
      });
      if (entries.get(id) !== owned || session.remoteRuntimeId !== owned.runtimeId) throw failed();
      if (valid) await controller.notifyState(id);
      return access;
    },
    async getAccess(record, id) {
      if (!id || !record.sessions.has(id)) throw failed();
      return controller.getThreadAccess(id);
    },
    async setAccess(record, id, options) {
      if (!id || !record.sessions.has(id)) throw failed();
      if (options?.enabled) assertCurrent(entries.get(id) || {});
      const result = await controller.setThreadAccess(id, options);
      const entry = entries.get(id);
      if (entry) send(entry, 'remoteControl:access', { state: result });
      return result;
    },
    complete(record, id, response) {
      const call = pending.get(response?.dispatchId);
      if (!call || call.entry.record !== record || call.entry.id !== id || !current(call.entry)) throw failed();
      if (!response.result || !['received', 'queued', 'accepted', 'completed', 'blocked', 'stale', 'rejected', 'uncertain', 'cancelled'].includes(response.result.phase)) throw failed();
      clearTimeout(call.timer); pending.delete(response.dispatchId); call.resolve(response.result);
    },
    async request(record, id, method, params) {
      const context = params?._remote;
      if (!context) return record.sessions.get(id).request(method, params);
      const saved = operations.get(context.operationId), entry = entries.get(id);
      // Compare immutable command input as well as its destination. Never accept generic RPC.
      if (!saved || saved.entry !== entry || !sameTarget(saved.command.target, context.target)
        || saved.command.kind !== context.kind || saved.operation.clientUserMessageId !== context.clientUserMessageId) throw failed();
      const expectedMethod = context.kind === 'stop' ? 'turn/interrupt' : context.kind === 'steer' ? 'turn/steer' : 'turn/start';
      if (method !== expectedMethod || params.threadId !== entry.threadId) throw failed();
      if (context.kind === 'stop' ? params.turnId !== saved.command.expectedTurnId
        : !same(params.input, [{ type: 'text', text: saved.command.text.trim(), text_elements: [] }])
          || params.clientUserMessageId !== saved.operation.clientUserMessageId) throw failed();
      if (['stop', 'steer'].includes(context.kind) && (context.expectedTurnId !== saved.command.expectedTurnId
        || (context.kind === 'steer' && params.expectedTurnId !== saved.command.expectedTurnId))) throw failed();
      let permit;
      try {
        assertCurrent(entry);
        permit = await controller.authorizeTransport(context);
        assertCurrent(entry);
        const nativeTurn = entry.session.activeThreadTurns.get(entry.threadId);
        if (['stop', 'steer'].includes(context.kind) ? nativeTurn !== context.expectedTurnId : Boolean(nativeTurn)) throw failed();
        if (context.kind !== 'stop' && entry.session.requests.size) throw failed();
        controller.consumeTransportPermit(permit);
      } catch {
        // This scope contains no native request: a lost fence is a proven non-delivery.
        // A concurrent duplicate may be rejected by authorizeTransport while the ORIGINAL
        // request is already in flight. Only this call's unconsumed permit proves non-delivery.
        if (permit) await controller.recordReceipt({ operationId: context.operationId, accepted: false, rejected: true }).catch(() => {});
        throw failed();
      }
      const { _remote, ...native } = params;
      // No await between final fences and actual transport; CLI configuration comes from normal sender.
      try {
        const result = await entry.session.request(method, native);
        await controller.recordReceipt({ operationId: context.operationId, accepted: true,
          turnId: result?.turn?.id || result?.turnId || context.expectedTurnId,
          status: result?.turn?.status, consumed: entry.session.settings.provider !== 'claude' });
        return result;
      } catch (error) {
        // A transport exception/failed ACK journal is not proof that the agent rejected input.
        if (typeof error.code === 'number' && !uncertainDelivery(error)) await controller.recordReceipt({ operationId: context.operationId, accepted: false, rejected: true }).catch(() => {});
        throw error;
      }
    },
    observe(id, type, data) {
      const entry = entries.get(id);
      if (!entry || !current(entry) || type !== 'notification') return;
      const p = data.params || {}, base = { sessionId: id, runtimeId: entry.runtimeId, threadId: p.threadId };
      if (p.threadId !== entry.threadId) return;
      if (data.method === 'message/receipt') void controller.observeReceipt({ ...base, ...p }).catch(() => {});
      if (['item/started', 'item/completed'].includes(data.method) && p.item?.type === 'userMessage') {
        for (const clientUserMessageId of new Set([p.item.clientId, p.item.clientUserMessageId, p.item.id].filter(Boolean))) {
          void controller.observeReceipt({ ...base, clientUserMessageId, accepted: true, turnId: p.turnId,
            consumed: entry.session.settings.provider !== 'claude' }).catch(() => {});
        }
      }
      if (data.method === 'turn/completed') {
        const ids = (p.turn?.items || []).filter(item => item.type === 'userMessage').flatMap(item => [item.id, item.clientId, item.clientUserMessageId]).filter(Boolean);
        void controller.recordCompletion({ ...base, turnId: p.turn?.id, status: p.turn?.status, clientUserMessageIds: ids }).catch(() => {});
      }
    },
    async publishAnswer(record, id, answer) {
      const entry = entries.get(id);
      if (!entry || entry.record !== record || !answer || typeof answer.text !== 'string' || answer.text.length > 100_000) throw failed();
      assertCurrent(entry);
      await controller.publishAnswer({ sessionId: id, runtimeId: entry.runtimeId, answer });
    },
    async stop() { await Promise.all([...entries.keys()].map(invalidate)); },
  };
}
