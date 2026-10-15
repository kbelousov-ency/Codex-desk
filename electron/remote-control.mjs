import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteControlStore, validateRemoteCommand, validateRemoteTarget, REMOTE_BLOCK_REASONS } from './remote-control-store.mjs';

const clone = value => structuredClone(value);
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const cleanLabel = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
const canonical = cwd => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
const sameTuple = (a, b) => a.provider === b.provider && a.threadId === b.threadId && a.cwd === b.cwd;
const sameBinding = (a, b) => a?.sessionId === b?.sessionId && a?.runtimeId === b?.runtimeId;
const sameTarget = (a, b) => a && b && ['grantId', 'generation', 'provider', 'threadId', 'projectKey', 'sessionId', 'runtimeId'].every(key => a[key] === b[key]);
const terminalPhases = new Set(['completed', 'blocked', 'stale', 'rejected', 'cancelled']);
const ok = value => ({ ok: true, value: clone(value) });
const messages = {
  access_denied: 'Доступ к беседе не разрешён.', stale_target: 'Адрес беседы изменился. Выберите беседу заново.',
  stale_turn: 'Задача уже сменилась. Обновите состояние беседы.', ambiguous_owner: 'Беседа открыта в нескольких вкладках. Требуется действие на компьютере.',
  unavailable: 'Беседа сейчас недоступна. Требуется действие на компьютере.', blocked: 'Действие сейчас недоступно.',
  queue_full: 'Очередь беседы заполнена.', invalid_command: 'Некорректная команда.', request_conflict: 'Этот идентификатор уже принадлежит другой команде.',
  persistence_failed: 'Не удалось сохранить удалённую команду. Требуется действие на компьютере.', not_found: 'Запись недоступна.',
};
function error(code, reason) {
  const requiresComputer = ['ambiguous_owner', 'unavailable', 'persistence_failed'].includes(code)
    || ['approval', 'question', 'terminal', 'restoring', 'uncertain_delivery', 'disconnected', 'queue_paused', 'local_action', 'closing', 'settings_changing', 'model_unavailable', 'compacting'].includes(reason);
  const message = ['approval', 'question'].includes(reason) ? 'Требуется действие на компьютере'
    : reason === 'uncertain_delivery' ? 'Отправка не подтверждена. Требуется проверка на компьютере.' : messages[code] || messages.blocked;
  return { code, message, requiresComputer, ...(reason && REMOTE_BLOCK_REASONS.has(reason) ? { reason } : {}) };
}
const fail = (code, reason) => ({ ok: false, error: error(code, reason) });
function thrown(code, reason) { return Object.assign(new Error(error(code, reason).message), { remoteError: error(code, reason) }); }
function publicOperation(operation) {
  const { command: _command, stage: _stage, consumed: _consumed, ...result } = operation;
  return clone(result);
}
function answerDto(value) {
  if (!value || !text(value.answerId) || !text(value.turnId) || typeof value.text !== 'string') return null;
  return { answerId: value.answerId, turnId: value.turnId, text: value.text.slice(0, 100_000),
    completedAt: typeof value.completedAt === 'string' && value.completedAt.length <= 64 ? value.completedAt : null,
    truncated: value.truncated === true || value.text.length > 100_000 };
}

/** Small main-process coordinator. The renderer adapter owns the existing FIFO and sender. */
export function createRemoteControl({ userData, store = createRemoteControlStore(userData), now = () => new Date().toISOString(), createId = randomUUID } = {}) {
  let data = { version: 1, grants: [], operations: [] }, initialization = null, queue = Promise.resolve(), fault = false, stopped = false;
  const runtimes = new Map(), fenced = new Set(), permits = new Map(), consumedPermits = new Set();
  const listeners = new Set(), events = new Map(), answers = new Map(), dispatches = new Map(), completions = new Map();
  const completionKey = (target, turnId) => JSON.stringify([target.sessionId, target.runtimeId, target.threadId, turnId]);
  const serial = work => { const promise = queue.catch(() => {}).then(work); queue = promise; return promise; };
  const save = async next => {
    if (fault) throw thrown('persistence_failed');
    try { await store.save(next); data = next; }
    catch { fault = true; permits.clear(); throw thrown('persistence_failed'); }
  };
  const operation = id => data.operations.find(item => item.operationId === id);
  const grantFor = runtime => data.grants.find(grant => sameTuple(grant, runtime));
  const owners = grant => [...runtimes.values()].filter(runtime => runtime.provider === grant.provider && runtime.threadId === grant.threadId);
  const targetFor = grant => grant.binding ? { grantId: grant.grantId, generation: grant.generation, provider: grant.provider,
    threadId: grant.threadId, projectKey: grant.projectKey, ...grant.binding } : null;
  const live = (target, { allowFault = false } = {}) => {
    if (fault && !allowFault) return fail('persistence_failed');
    if (stopped) return fail('unavailable');
    try { validateRemoteTarget(target); } catch { return fail('invalid_command'); }
    const grant = data.grants.find(item => item.grantId === target.grantId);
    if (!grant?.enabled || fenced.has(target.grantId)) return fail('access_denied');
    const owned = owners(grant);
    if (owned.length > 1) return fail('ambiguous_owner');
    if (!sameTarget(target, targetFor(grant))) return fail('stale_target');
    const runtime = owned[0];
    if (!runtime?.ready || !sameTuple(grant, runtime) || !sameBinding(runtime, target)) return fail('unavailable');
    return { ok: true, grant, runtime };
  };
  const emit = event => {
    if (!live(event.target).ok) return;
    const value = { eventId: createId(), at: now(), ...clone(event) };
    events.set(value.eventId, value);
    if (events.size > 2000) events.delete(events.keys().next().value);
    // A subscriber can never interrupt the durable operation it observes.
    queueMicrotask(() => { for (const listener of listeners) { try { listener({ eventId: value.eventId }); } catch { /* isolated listener */ } } });
  };
  const emitOperation = value => emit({ kind: 'operation_changed', target: value.target, operation: publicOperation(value) });
  const revise = (value, patch) => ({ ...value, ...patch, revision: value.revision + 1, updatedAt: now() });
  const updateOperation = async (id, patch) => serial(async () => {
    const current = operation(id);
    if (!current) throw thrown('not_found');
    if (terminalPhases.has(current.phase)) return current;
    const changes = typeof patch === 'function' ? patch(current) : patch;
    if (!changes || Object.keys(changes).every(key => JSON.stringify(changes[key]) === JSON.stringify(current[key]))) return current;
    const next = clone(data), updated = revise(current, changes);
    next.operations[next.operations.findIndex(item => item.operationId === id)] = updated;
    await save(next); emitOperation(updated); return updated;
  });

  const start = () => {
    initialization ??= serial(async () => {
      try {
        data = await store.read();
        const next = clone(data); let changed = false;
        for (const grant of next.grants) {
          if (grant.binding) { grant.binding = null; grant.generation++; changed = true; }
        }
        for (let i = 0; i < next.operations.length; i++) {
          const value = next.operations[i];
          if (terminalPhases.has(value.phase)) continue;
          if (value.phase === 'accepted') continue; // a durable ACK remains an ACK after restart
          if (['dispatching', 'delegated'].includes(value.stage) || value.phase === 'uncertain') {
            next.operations[i] = revise(value, { phase: 'uncertain', error: error('blocked', 'uncertain_delivery') }); changed = true;
          } else {
            next.operations[i] = revise(value, { phase: 'cancelled', stage: 'settled', error: error('stale_target') }); changed = true;
          }
        }
        if (changed) await save(next);
      } catch { fault = true; throw thrown('persistence_failed'); }
    });
    return initialization;
  };
  const ready = async () => { await start(); if (fault) throw thrown('persistence_failed'); if (stopped) throw thrown('unavailable'); };
  const safe = work => async (...args) => { try { await ready(); return await work(...args); } catch (cause) { return { ok: false, error: cause?.remoteError || error('unavailable') }; } };

  function stateDto(snapshot, target, runtime) {
    const blockers = Array.isArray(snapshot?.blockers) ? [...new Set(snapshot.blockers.filter(value => REMOTE_BLOCK_REASONS.has(value)))] : ['disconnected'];
    const count = Number.isSafeInteger(snapshot?.queue?.count) && snapshot.queue.count >= 0 ? snapshot.queue.count : 0;
    const activeTurnId = text(snapshot?.activeTurnId) ? snapshot.activeTurnId : null;
    const phase = ['idle', 'running', 'blocked', 'unavailable'].includes(snapshot?.phase) ? snapshot.phase : 'unavailable';
    const actions = { send: snapshot?.actions?.send === true, enqueue: snapshot?.actions?.enqueue === true,
      steer: snapshot?.actions?.steer === true, stop: snapshot?.actions?.stop === true };
    if (count >= 50) actions.enqueue = false;
    if (count > 0) actions.send = false;
    if (activeTurnId || phase !== 'idle') actions.send = false;
    if (!activeTurnId) { actions.steer = false; actions.stop = false; }
    if (['approval', 'question', 'uncertain_delivery', 'terminal', 'restoring', 'disconnected', 'closing', 'settings_changing', 'model_unavailable', 'compacting', 'local_action'].some(item => blockers.includes(item))) { actions.send = false; actions.steer = false; }
    if (['terminal', 'restoring', 'closing', 'disconnected'].some(item => blockers.includes(item))) actions.stop = false;
    const incoming = Number.isSafeInteger(snapshot?.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
    runtime.revision = Math.max(runtime.revision, incoming);
    return { target: clone(target), revision: runtime.revision, phase, activeTurnId, queue: { count, limit: 50, paused: snapshot?.queue?.paused === true },
      blockers, actions, requiresComputer: snapshot?.requiresComputer === true || blockers.some(reason => error('blocked', reason).requiresComputer), updatedAt: now() };
  }
  async function readState(target, { internal = false } = {}) {
    const before = live(target);
    if (!before.ok) return before;
    let snapshot;
    try { snapshot = await before.runtime.getState(); } catch { return fail('unavailable'); }
    const after = live(target);
    if (!after.ok) return after;
    if (after.runtime !== before.runtime) return fail('stale_target');
    const value = stateDto(snapshot, target, after.runtime);
    if (internal && text(snapshot?.reservationOperationId)) value.reservationOperationId = snapshot.reservationOperationId;
    return ok(value);
  }
  function actionFailure(command, state, transport = false, operationId = null) {
    if (['steer', 'stop'].includes(command.kind) && state.activeTurnId !== command.expectedTurnId) return error('stale_turn');
    if (command.kind === 'enqueue' && !transport && state.queue.count >= 50) return error('queue_full', 'queue_full');
    if (transport && ['send', 'enqueue'].includes(command.kind)) {
      if (state.activeTurnId) return error('blocked', 'busy');
      // The renderer has already reserved its sender; its own reservation/head is not another task.
      const blocker = state.blockers.find(reason => !['busy', 'queue_not_empty', 'queue_full'].includes(reason)
        && !(reason === 'uncertain_delivery' && state.reservationOperationId === operationId));
      if (blocker || (command.kind === 'enqueue' && state.queue.paused)) return error('blocked', blocker || 'queue_paused');
      return null;
    }
    if (transport && command.kind === 'steer' && state.reservationOperationId === operationId) {
      const blocker = state.blockers.find(reason => !['busy', 'queue_not_empty', 'queue_full', 'queue_paused', 'uncertain_delivery'].includes(reason));
      if (!blocker) return null;
    }
    if (state.actions[command.kind]) return null;
    if (command.kind === 'send' && state.queue.count) return error('blocked', 'queue_not_empty');
    if (command.kind === 'send' && (state.activeTurnId || state.phase === 'running')) return error('blocked', 'busy');
    return error('blocked', state.blockers[0] || (state.queue.paused ? 'queue_paused' : 'local_action'));
  }

  async function cancelWaiting(grantIds, reason = 'stale_target') {
    const ids = new Set(grantIds), cancelled = [];
    await serial(async () => {
      const next = clone(data);
      for (let i = 0; i < next.operations.length; i++) {
        const value = next.operations[i];
        if (!ids.has(value.target.grantId) || !['received', 'queued'].includes(value.phase) || value.stage === 'dispatching') continue;
        const grant = next.grants.find(item => item.grantId === value.target.grantId);
        // A fresh command can race the asynchronous cleanup of a previous incarnation.
        if (grant?.enabled && !fenced.has(grant.grantId) && sameTarget(value.target, targetFor(grant))) continue;
        next.operations[i] = revise(value, { phase: 'cancelled', stage: 'settled', error: error(reason) }); cancelled.push(next.operations[i]);
      }
      if (cancelled.length) await save(next);
    });
    for (const runtime of runtimes.values()) {
      const operationIds = cancelled.filter(value => sameBinding(value.target, runtime)).map(value => value.operationId);
      if (operationIds.length && runtime.cancelPending) { try { await runtime.cancelPending({ operationIds, reason }); } catch { /* journal fencing remains authoritative */ } }
    }
  }

  async function syncBindings() {
    const changedIds = [];
    await serial(async () => {
      const next = clone(data);
      for (const grant of next.grants) {
        const owned = owners(grant), runtime = owned.length === 1 && sameTuple(owned[0], grant) && owned[0].ready ? owned[0] : null;
        const binding = grant.enabled && runtime ? { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId } : null;
        if ((binding || grant.binding) && !sameBinding(binding, grant.binding)) {
          grant.generation++; grant.binding = binding; changedIds.push(grant.grantId);
        }
        if (runtime && grant.title !== runtime.title) grant.title = runtime.title;
      }
      if (JSON.stringify(next.grants) !== JSON.stringify(data.grants)) await save(next);
    });
    if (changedIds.length) await cancelWaiting(changedIds);
  }

  const getThreadAccess = async sessionId => {
    await ready();
    const runtime = runtimes.get(sessionId);
    if (!runtime) throw thrown('unavailable');
    const grant = grantFor(runtime), ambiguous = owners(runtime).length > 1;
    const canEnable = runtime.ready && Boolean(runtime.threadId) && !ambiguous;
    return { provider: runtime.provider, threadId: runtime.threadId || null, accessRevision: runtime.accessRevision,
      enabled: Boolean(grant?.enabled && !fenced.has(grant.grantId)), canEnable,
      reason: ambiguous ? messages.ambiguous_owner : !runtime.ready ? messages.unavailable : !runtime.threadId ? 'Сначала откройте существующую беседу.' : null,
      target: grant && !ambiguous && runtime.ready && grant.enabled && !fenced.has(grant.grantId) ? targetFor(grant) : null };
  };

  async function registerRuntime(adapter) {
    await ready();
    if (!adapter || !text(adapter.sessionId) || !text(adapter.runtimeId) || !['codex', 'claude'].includes(adapter.provider)
      || (adapter.threadId !== null && adapter.threadId !== undefined && (!text(adapter.threadId) || (adapter.provider === 'claude') !== adapter.threadId.startsWith('claude:'))) || !text(adapter.cwd, 4096) || !path.isAbsolute(adapter.cwd)
      || typeof adapter.getState !== 'function' || typeof adapter.dispatch !== 'function') throw thrown('invalid_command');
    const identity = { ...adapter, cwd: canonical(adapter.cwd), threadId: adapter.threadId || null, title: cleanLabel(adapter.title), ready: adapter.ready === true };
    const old = runtimes.get(adapter.sessionId);
    if (old && old.runtimeId === identity.runtimeId && sameTuple(old, identity) && old.ready === identity.ready) {
      Object.assign(old, identity); // replacing closures is not a new incarnation
    } else {
      runtimes.set(adapter.sessionId, { ...identity, accessRevision: createId(), revision: 0 });
    }
    await syncBindings();
    return getThreadAccess(adapter.sessionId);
  }

  function unregisterRuntime(sessionId, runtimeId) {
    const runtime = runtimes.get(sessionId);
    if (!runtime || (runtimeId !== undefined && runtime.runtimeId !== runtimeId)) return Promise.resolve();
    runtimes.delete(sessionId); answers.delete(`${sessionId}:${runtime.runtimeId}`);
    for (const [token, permit] of permits) if (sameBinding(permit.target, runtime)) permits.delete(token);
    return ready().then(syncBindings);
  }

  async function setThreadAccess(sessionId, options) {
    await ready();
    if (!options || typeof options.enabled !== 'boolean' || !options.expected) throw thrown('invalid_command');
    let changedId;
    await serial(async () => {
      const runtime = runtimes.get(sessionId), expected = options.expected;
      if (!runtime || expected.provider !== runtime.provider || expected.threadId !== runtime.threadId || expected.accessRevision !== runtime.accessRevision) throw thrown('stale_target');
      if (options.enabled && (!runtime.ready || !runtime.threadId || owners(runtime).length !== 1)) throw thrown(owners(runtime).length > 1 ? 'ambiguous_owner' : 'unavailable');
      const next = clone(data); let grant = next.grants.find(value => sameTuple(value, runtime));
      if (!grant) {
        if (!options.enabled) return;
        const existingProject = next.grants.find(value => value.cwd === runtime.cwd);
        grant = { grantId: createId(), provider: runtime.provider, threadId: runtime.threadId, cwd: runtime.cwd,
          projectKey: existingProject?.projectKey || createId(), title: runtime.title, enabled: false, generation: 0, binding: null };
        next.grants.push(grant);
      }
      if (grant.enabled === options.enabled && (options.enabled || !grant.binding)) return;
      changedId = grant.grantId;
      if (!options.enabled) fenced.add(grant.grantId); // before the awaited durable write or renderer cancellation
      grant.enabled = options.enabled; grant.generation++;
      grant.binding = options.enabled ? { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId } : null;
      await save(next);
      if (options.enabled) fenced.delete(grant.grantId);
      runtime.accessRevision = createId();
    });
    if (changedId && !options.enabled) await cancelWaiting([changedId], 'access_denied');
    return getThreadAccess(sessionId);
  }

  async function dispatchResult(id, result) {
    const current = operation(id);
    if (!current || terminalPhases.has(current.phase)) return current;
    const phase = result?.phase;
    if (phase === 'accepted' || phase === 'completed') {
      await recordReceipt({ operationId: id, accepted: true, turnId: result.turnId, consumed: result.consumed, ...(phase === 'completed' ? { status: result.outcome === 'interrupted' ? 'interrupted' : result.outcome === 'failed' ? 'failed' : 'completed' } : {}) });
      return operation(id);
    }
    if (phase === 'queued') {
      if (current.phase === 'accepted' || current.stage === 'dispatching') return current;
      return updateOperation(id, latest => latest.phase === 'accepted' || latest.stage === 'dispatching' ? {} : {
        phase: 'queued', stage: 'settled', queuePosition: Number.isSafeInteger(result.queuePosition) && result.queuePosition >= 0 ? result.queuePosition : null, error: null });
    }
    if (['blocked', 'stale', 'rejected'].includes(phase) && current.stage !== 'dispatching' && current.phase !== 'accepted') {
      const supplied = result.error;
      const reason = REMOTE_BLOCK_REASONS.has(supplied?.reason) ? supplied.reason : undefined;
      return updateOperation(id, { phase, stage: 'settled', error: error(phase === 'stale' ? 'stale_turn' : phase === 'rejected' ? 'blocked' : supplied?.code === 'queue_full' ? 'queue_full' : 'blocked', reason) });
    }
    if (current.phase === 'accepted' || current.phase === 'completed') return current;
    return updateOperation(id, latest => latest.phase === 'accepted' ? {} : { phase: 'uncertain', error: error('blocked', 'uncertain_delivery') });
  }

  async function execute(commandInput) {
    let command;
    try { command = validateRemoteCommand(commandInput); } catch { return fail('invalid_command'); }
    const address = live(command.target);
    if (!address.ok) return address;
    const reserved = await serial(async () => {
      const checked = live(command.target); if (!checked.ok) return checked;
      const found = data.operations.find(item => item.requestId === command.requestId);
      if (found) return JSON.stringify(found.command) === JSON.stringify(command) ? { ok: true, existing: true, value: found } : fail('request_conflict');
      const at = now();
      const value = { operationId: createId(), requestId: command.requestId, target: command.target, kind: command.kind, phase: 'received', revision: 0,
        clientUserMessageId: command.kind === 'stop' ? null : createId(), expectedTurnId: command.expectedTurnId ?? null, executionTurnId: null,
        queuePosition: null, outcome: null, error: null, createdAt: at, updatedAt: at, command, stage: 'reserved', consumed: false };
      const next = clone(data); next.operations.push(value); await save(next); emitOperation(value);
      return { ok: true, existing: false, value };
    });
    if (!reserved.ok) return reserved;
    if (reserved.existing) return ok(publicOperation(reserved.value));
    const id = reserved.value.operationId;
    const state = await readState(command.target);
    const actionError = state.ok ? actionFailure(command, state.value) : state.error;
    if (actionError) {
      const changed = await updateOperation(id, { phase: ['stale_target', 'stale_turn'].includes(actionError.code) ? 'stale' : 'blocked', stage: 'settled', error: actionError });
      return ok(publicOperation(changed));
    }
    const delegated = await updateOperation(id, { stage: 'delegated' });
    const checked = live(command.target);
    if (!checked.ok) {
      const changed = await updateOperation(id, { phase: 'cancelled', stage: 'settled', error: checked.error });
      return ok(publicOperation(changed));
    }
    const job = (async () => {
      let result;
      try { result = await checked.runtime.dispatch({ command: clone(command), operation: publicOperation(delegated) }); }
      catch { result = { phase: 'uncertain' }; }
      try { await dispatchResult(id, result); }
      catch {
        // Dispatching is already durable. Conservative uncertainty is derivable after restart.
        const value = operation(id);
        if (value && !terminalPhases.has(value.phase)) Object.assign(value, { phase: 'uncertain', error: error('blocked', 'uncertain_delivery') });
      }
      return ok(publicOperation(operation(id)));
    })();
    dispatches.set(id, job);
    try { return await job; } finally { dispatches.delete(id); }
  }

  async function authorizeTransport({ operationId, target, kind, clientUserMessageId = null, expectedTurnId = null } = {}) {
    await ready();
    const before = operation(operationId);
    if (!before || before.kind !== kind || !sameTarget(before.target, target) || before.clientUserMessageId !== clientUserMessageId || before.expectedTurnId !== expectedTurnId) throw thrown('invalid_command');
    const state = await readState(target, { internal: true }); if (!state.ok) throw Object.assign(new Error(state.error.message), { remoteError: state.error });
    const blocked = actionFailure(before.command, state.value, true, operationId);
    if (blocked) throw Object.assign(new Error(blocked.message), { remoteError: blocked });
    return serial(async () => {
      const checked = live(target); if (!checked.ok) throw Object.assign(new Error(checked.error.message), { remoteError: checked.error });
      const value = operation(operationId);
      if (!value || value.stage === 'dispatching' || !['received', 'queued'].includes(value.phase)) throw thrown('blocked', value?.phase === 'uncertain' ? 'uncertain_delivery' : 'local_action');
      const next = clone(data), updated = revise(value, { stage: 'dispatching', error: null });
      next.operations[next.operations.findIndex(item => item.operationId === operationId)] = updated;
      await save(next);
      const after = live(target); if (!after.ok) throw Object.assign(new Error(after.error.message), { remoteError: after.error });
      const token = createId();
      const permit = { token, operationId, target: clone(target), kind, clientUserMessageId, expectedTurnId };
      permits.set(token, permit);
      return clone(permit);
    });
  }

  function consumeTransportPermit(permit) {
    const issued = permits.get(permit?.token);
    permits.delete(permit?.token);
    if (!issued || !sameTarget(issued.target, permit.target) || issued.operationId !== permit.operationId || issued.kind !== permit.kind
      || issued.clientUserMessageId !== permit.clientUserMessageId || issued.expectedTurnId !== permit.expectedTurnId) throw thrown('invalid_command');
    const checked = live(issued.target); if (!checked.ok) throw Object.assign(new Error(checked.error.message), { remoteError: checked.error });
    const value = operation(issued.operationId);
    if (!value || value.stage !== 'dispatching' || consumedPermits.has(value.operationId)) throw thrown('invalid_command');
    consumedPermits.add(value.operationId);
    return publicOperation(value);
  }

  async function recordReceipt(receipt) {
    await start();
    return updateOperation(receipt.operationId, value => {
      if (value.phase === 'completed' || (terminalPhases.has(value.phase) && value.stage !== 'dispatching')) return {};
      if (receipt.accepted === true) {
        const executionTurnId = text(receipt.turnId) ? receipt.turnId : value.executionTurnId || (value.kind === 'stop' ? value.expectedTurnId : null);
        const earlierCompletion = executionTurnId && completions.get(completionKey(value.target, executionTurnId));
        const consumed = value.consumed || receipt.consumed === true || Boolean(earlierCompletion?.clientUserMessageIds.includes(value.clientUserMessageId));
        const status = earlierCompletion?.status || receipt.status;
        const finished = ['completed', 'interrupted', 'failed'].includes(status)
          && (value.kind !== 'steer' || value.target.provider !== 'claude' || consumed);
        return { phase: finished ? 'completed' : 'accepted', stage: 'settled', executionTurnId, consumed, queuePosition: null, error: null,
          outcome: finished ? status === 'completed' ? 'succeeded' : status : null };
      }
      if (receipt.rejected === true && value.phase !== 'accepted') return { phase: 'rejected', stage: 'settled', error: error('blocked') };
      return {}; // absence from history never proves rejection
    });
  }

  async function observeReceipt(receipt) {
    await start();
    const matches = data.operations.filter(value => sameBinding(value.target, receipt) && value.target.threadId === receipt.threadId && value.clientUserMessageId === receipt.clientUserMessageId);
    for (const value of matches) await recordReceipt({ ...receipt, operationId: value.operationId });
  }

  async function recordCompletion({ sessionId, runtimeId, threadId, turnId, status, clientUserMessageIds = [] } = {}) {
    await start();
    if (!['completed', 'interrupted', 'failed'].includes(status) || !text(turnId)) return;
    completions.set(completionKey({ sessionId, runtimeId, threadId }, turnId), { status,
      clientUserMessageIds: Array.isArray(clientUserMessageIds) ? clientUserMessageIds.filter(value => text(value)) : [] });
    if (completions.size > 1000) completions.delete(completions.keys().next().value);
    const ids = new Set(clientUserMessageIds);
    for (const value of [...data.operations]) {
      if (!sameBinding(value.target, { sessionId, runtimeId }) || value.target.threadId !== threadId || terminalPhases.has(value.phase)) continue;
      if (value.stage !== 'dispatching' && !['accepted', 'uncertain'].includes(value.phase)) continue;
      const exactMessage = value.clientUserMessageId && ids.has(value.clientUserMessageId);
      if (value.kind === 'stop' ? value.expectedTurnId !== turnId : !exactMessage && value.executionTurnId !== turnId) continue;
      if (value.kind === 'steer' && value.target.provider === 'claude' && !exactMessage && !value.consumed) continue;
      await recordReceipt({ operationId: value.operationId, accepted: true, turnId, status, consumed: Boolean(exactMessage) || value.consumed });
    }
  }

  async function getOperation({ target, requestId } = {}) {
    const checked = live(target); if (!checked.ok) return checked;
    if (!text(requestId, 200)) return fail('invalid_command');
    let value = data.operations.find(item => item.requestId === requestId && item.target.grantId === target.grantId);
    if (!value) return fail('not_found');
    if (['uncertain', 'accepted'].includes(value.phase) && checked.runtime.reconcile) {
      try {
        const receipt = await checked.runtime.reconcile({ operation: publicOperation(value), clientUserMessageId: value.clientUserMessageId, expectedTurnId: value.expectedTurnId });
        if (receipt?.accepted || receipt?.rejected) await recordReceipt({ ...receipt, operationId: value.operationId });
      } catch { /* checking is read-only and can leave uncertainty unresolved */ }
    }
    const after = live(target); if (!after.ok) return after;
    value = operation(value.operationId);
    return ok(publicOperation(value));
  }

  async function getLastAnswer(target) {
    const checked = live(target); if (!checked.ok) return checked;
    let answer = answers.get(`${target.sessionId}:${target.runtimeId}`) || null;
    if (checked.runtime.getLastAnswer) {
      try { answer = answerDto(await checked.runtime.getLastAnswer()) || answer; } catch { return fail('unavailable'); }
    }
    const after = live(target); return after.ok ? ok(answer) : after;
  }

  async function notifyState(sessionId) {
    await ready();
    const runtime = runtimes.get(sessionId), grant = runtime && grantFor(runtime), target = grant && targetFor(grant);
    if (!target) return;
    const state = await readState(target); if (!state.ok) return;
    const fingerprint = JSON.stringify({ ...state.value, revision: 0, updatedAt: '' });
    if (runtime.lastStateFingerprint === fingerprint) return;
    runtime.lastStateFingerprint = fingerprint;
    emit({ kind: 'state_changed', target, state: state.value });
    const pending = state.value.blockers.find(reason => ['approval', 'question'].includes(reason));
    if (pending && runtime.lastComputerReason !== pending) emit({ kind: 'computer_action_required', target, message: 'Требуется действие на компьютере' });
    runtime.lastComputerReason = pending;
  }

  async function publishAnswer({ sessionId, runtimeId, answer: input, requestId = null } = {}) {
    await ready();
    const runtime = runtimes.get(sessionId); if (!runtime || runtime.runtimeId !== runtimeId) return;
    const answer = answerDto(input); if (!answer) return;
    const key = `${sessionId}:${runtimeId}`, previous = answers.get(key);
    answers.set(key, answer);
    if (previous?.answerId === answer.answerId && previous?.turnId === answer.turnId) return;
    const grant = grantFor(runtime), target = grant && targetFor(grant);
    if (target) emit({ kind: 'answer_ready', target, answer, requestId: text(requestId, 200) ? requestId : null });
  }

  const remote = Object.freeze({
    listThreads: safe(async () => ok(data.grants.filter(grant => grant.enabled && !fenced.has(grant.grantId)).map(grant => {
      const count = owners(grant).length, target = targetFor(grant), accessible = target && live(target).ok;
      return { grantId: grant.grantId, title: grant.title || 'Беседа', projectLabel: path.basename(grant.cwd), provider: grant.provider,
        target: accessible ? target : null, availability: count > 1 ? 'ambiguous' : accessible ? 'available' : 'unavailable' };
    }))),
    getThreadState: safe(target => readState(target)), getLastAnswer: safe(getLastAnswer), execute: safe(execute), getOperation: safe(getOperation),
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('listener'); listeners.add(listener); return () => listeners.delete(listener); },
    readEvent: safe(async eventId => {
      if (!text(eventId)) return fail('invalid_command');
      const event = events.get(eventId); if (!event) return fail('not_found');
      const checked = live(event.target); return checked.ok ? ok(event) : checked;
    }),
  });

  async function stop() {
    if (stopped) return;
    stopped = true; runtimes.clear(); permits.clear(); events.clear(); listeners.clear();
    try { await start(); await syncBindings(); await store.flush?.(); } catch { /* shutdown remains fail closed */ }
  }

  return { remote, start, stop, registerRuntime, unregisterRuntime, getThreadAccess, setThreadAccess, authorizeTransport, consumeTransportPermit,
    recordReceipt, observeReceipt, recordCompletion, notifyState, publishAnswer };
}
