import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 64 * 1024 * 1024;
const phases = new Set(['received', 'queued', 'accepted', 'completed', 'blocked', 'stale', 'rejected', 'uncertain', 'cancelled']);
const stages = new Set(['reserved', 'delegated', 'dispatching', 'settled']);
const errorCodes = new Set(['access_denied', 'stale_target', 'stale_turn', 'ambiguous_owner', 'unavailable', 'blocked', 'queue_full', 'invalid_command', 'request_conflict', 'persistence_failed', 'not_found']);
export const REMOTE_BLOCK_REASONS = new Set(['busy', 'approval', 'question', 'terminal', 'restoring', 'uncertain_delivery', 'disconnected', 'queue_paused', 'queue_not_empty', 'queue_full', 'local_action', 'closing', 'settings_changing', 'model_unavailable', 'compacting', 'unsupported', 'ambiguous_owner']);

const invalid = () => { throw new Error('Некорректное хранилище удалённого управления.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const string = (value, limit = 256, empty = false) => typeof value === 'string' && value.length <= limit && (empty || value.length > 0) ? value : invalid();
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const boolean = value => typeof value === 'boolean' ? value : invalid();
const nullableString = (value, limit = 256) => value === null ? null : string(value, limit);
const provider = value => ['codex', 'claude'].includes(value) ? value : invalid();
const exactKeys = (value, allowed) => { if (Object.keys(value).some(key => !allowed.includes(key))) invalid(); };

export function validateRemoteTarget(value) {
  object(value);
  exactKeys(value, ['grantId', 'generation', 'provider', 'threadId', 'projectKey', 'sessionId', 'runtimeId']);
  return { grantId: string(value.grantId), generation: integer(value.generation), provider: provider(value.provider), threadId: string(value.threadId),
    projectKey: string(value.projectKey), sessionId: string(value.sessionId), runtimeId: string(value.runtimeId) };
}

export function validateRemoteCommand(value) {
  object(value);
  if (!['send', 'enqueue', 'steer', 'stop'].includes(value.kind)) invalid();
  const keys = ['requestId', 'target', 'kind'];
  if (value.kind !== 'stop') keys.push('text');
  if (['steer', 'stop'].includes(value.kind)) keys.push('expectedTurnId');
  exactKeys(value, keys);
  const result = { requestId: string(value.requestId, 200), target: validateRemoteTarget(value.target), kind: value.kind };
  if (value.kind !== 'stop') {
    result.text = string(value.text, 32_000);
    if (!result.text.trim() || result.text.trimStart().startsWith('/')) invalid();
  }
  if (['steer', 'stop'].includes(value.kind)) result.expectedTurnId = string(value.expectedTurnId);
  return result;
}

function safeError(value) {
  if (value === null) return null;
  object(value);
  if (!errorCodes.has(value.code) || (value.reason !== undefined && !REMOTE_BLOCK_REASONS.has(value.reason))) invalid();
  return { code: value.code, message: string(value.message, 1000), requiresComputer: boolean(value.requiresComputer), ...(value.reason ? { reason: value.reason } : {}) };
}

/** The only durable controller data. No provider config, transcripts or runtime adapters. */
export function validateRemoteControlData(value) {
  object(value);
  if (value.version !== 1 || !Array.isArray(value.grants) || !Array.isArray(value.operations)) invalid();
  const grantIds = new Set(), tuples = new Set(), projectKeys = new Map();
  const grants = value.grants.map(source => {
    object(source);
    const grant = { grantId: string(source.grantId), provider: provider(source.provider), threadId: string(source.threadId), cwd: string(source.cwd, 4096),
      projectKey: string(source.projectKey), title: string(source.title, 300, true), enabled: boolean(source.enabled), generation: integer(source.generation), binding: null };
    if (!path.isAbsolute(grant.cwd)) invalid();
    const tuple = JSON.stringify([grant.provider, grant.cwd, grant.threadId]);
    if (grantIds.has(grant.grantId) || tuples.has(tuple) || (projectKeys.has(grant.projectKey) && projectKeys.get(grant.projectKey) !== grant.cwd)) invalid();
    grantIds.add(grant.grantId); tuples.add(tuple); projectKeys.set(grant.projectKey, grant.cwd);
    if (source.binding !== null) { object(source.binding); grant.binding = { sessionId: string(source.binding.sessionId), runtimeId: string(source.binding.runtimeId) }; }
    return grant;
  });
  const operationIds = new Set(), requestIds = new Set(), messageIds = new Set();
  const operations = value.operations.map(source => {
    object(source);
    const command = validateRemoteCommand(source.command);
    const target = validateRemoteTarget(source.target);
    if (!phases.has(source.phase) || !stages.has(source.stage) || ![null, 'succeeded', 'interrupted', 'failed'].includes(source.outcome)) invalid();
    const operation = { operationId: string(source.operationId), requestId: string(source.requestId, 200), target, kind: command.kind,
      phase: source.phase, revision: integer(source.revision), clientUserMessageId: nullableString(source.clientUserMessageId), expectedTurnId: nullableString(source.expectedTurnId),
      executionTurnId: nullableString(source.executionTurnId), queuePosition: source.queuePosition === null ? null : integer(source.queuePosition), outcome: source.outcome,
      error: safeError(source.error), createdAt: string(source.createdAt, 64), updatedAt: string(source.updatedAt, 64), command, stage: source.stage,
      consumed: boolean(source.consumed) };
    if (!grantIds.has(target.grantId) || operationIds.has(operation.operationId) || requestIds.has(operation.requestId)
      || command.requestId !== operation.requestId || source.kind !== command.kind || JSON.stringify(command.target) !== JSON.stringify(target)
      || (command.expectedTurnId ?? null) !== operation.expectedTurnId || (command.kind === 'stop') !== (operation.clientUserMessageId === null)) invalid();
    const grant = grants.find(item => item.grantId === target.grantId);
    if (grant.provider !== target.provider || grant.threadId !== target.threadId || grant.projectKey !== target.projectKey || target.generation > grant.generation) invalid();
    if (operation.clientUserMessageId) { if (messageIds.has(operation.clientUserMessageId)) invalid(); messageIds.add(operation.clientUserMessageId); }
    operationIds.add(operation.operationId); requestIds.add(operation.requestId);
    return operation;
  });
  return { version: 1, grants, operations };
}

/** Atomic, serialized, fail-closed ledger. A failed read never silently creates an empty ledger. */
export function createRemoteControlStore(userData, { io = fs, maxBytes = MAX_BYTES, platform = process.platform, sleep = delay } = {}) {
  const filename = path.join(userData, 'remote-control.json');
  let queue = Promise.resolve(), fault = null, loaded = false;
  const serial = work => { const result = queue.catch(() => {}).then(work); queue = result; return result; };
  const assertHealthy = () => { if (fault) throw new Error('Хранилище удалённого управления недоступно. Требуется действие на компьютере.'); };
  return {
    filename,
    read() { return serial(async () => {
      assertHealthy();
      try {
        const stat = await io.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) invalid();
        const value = validateRemoteControlData(JSON.parse(await io.readFile(filename, 'utf8')));
        loaded = true;
        return value;
      } catch (error) {
        if (error.code === 'ENOENT' && !loaded) { loaded = true; return { version: 1, grants: [], operations: [] }; }
        fault = error;
        // Preserve the original, including when this backup itself cannot be written.
        try { await io.copyFile(filename, `${filename}.invalid-${Date.now()}-${randomUUID()}`, constants.COPYFILE_EXCL); } catch { /* fail closed */ }
        throw new Error('Не удалось прочитать разрешения и операции удалённого управления. Хранилище не сброшено.');
      }
    }); },
    save(value) {
      let serialized;
      try {
        serialized = JSON.stringify(validateRemoteControlData(value));
        if (Buffer.byteLength(serialized) > maxBytes) throw new Error('Хранилище удалённого управления переполнено.');
      } catch (error) { return Promise.reject(error); }
      return serial(async () => {
        assertHealthy();
        const temporary = `${filename}.${randomUUID()}.tmp`;
        let handle;
        try {
          await io.mkdir(userData, { recursive: true });
          handle = await io.open(temporary, 'wx', 0o600);
          await handle.writeFile(serialized, 'utf8');
          await handle.sync();
          await handle.close(); handle = null;
          for (let attempt = 0; ; attempt++) {
            try { await io.rename(temporary, filename); break; }
            catch (error) {
              if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
              await sleep(Math.min(25 * (attempt + 1), 100));
            }
          }
          loaded = true;
        } catch (error) { fault = error; throw new Error('Не удалось сохранить удалённую команду. Отправка остановлена.'); }
        finally { if (handle) await handle.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
      });
    },
    async flush() { let current; do { current = queue; await current; } while (current !== queue); },
  };
}
