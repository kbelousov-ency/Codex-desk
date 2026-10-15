import { fail, isRecord, stringField } from './security.ts';
import type { CommandAction, CommandOutcome, CommandResult, CommandStatus } from './commands.ts';

const SAFE_CODES = new Set(['access_denied', 'stale_target', 'stale_turn', 'ambiguous_owner', 'unavailable', 'blocked',
  'queue_full', 'invalid_command', 'request_conflict', 'persistence_failed', 'not_found', 'expired', 'unknown_tab', 'not_connected', 'uncertain_delivery']);
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) fail(400, 'invalid_command_result'); return value; }
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'invalid_command_result');
  return value;
}
function opaque(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  return stringField(value, 256);
}

/** Explicit projection: no remote message/reason, unknown fields or response content are persisted. */
export function normalizeCommandResult(value: unknown): CommandResult {
  const result = record(value), commandId = stringField(result.commandId, 64), tabId = stringField(result.tabId, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(commandId) || !/^[A-Za-z0-9_-]+$/.test(tabId)) fail(400, 'invalid_command_result');
  date(result.at);
  const status = result.status as CommandStatus, outcome = result.outcome as CommandOutcome;
  if (!['queued', 'accepted', 'executed', 'uncertain', 'rejected'].includes(status)) fail(400, 'invalid_command_result');
  if (status === 'executed' ? typeof outcome !== 'string' || !['succeeded', 'interrupted', 'failed'].includes(outcome) : outcome !== null) fail(400, 'invalid_command_result');
  let detailCode: string | null = null, requiresComputer = false;
  if (result.detail !== null && result.detail !== undefined) {
    const detail = record(result.detail);
    if (typeof detail.requiresComputer !== 'boolean') fail(400, 'invalid_command_result');
    const knownCode = typeof detail.code === 'string' && SAFE_CODES.has(detail.code);
    detailCode = knownCode ? String(detail.code) : 'unavailable';
    requiresComputer = knownCode ? detail.requiresComputer === true : true;
  }
  return { commandId, tabId, status, outcome, detailCode, requiresComputer };
}

/** Only called for the requested action, current grant and a successful direct command_result. */
export function normalizeReadPayload(action: CommandAction, value: unknown, expectedTabId: string): unknown {
  if (value === undefined || value === null) return undefined;
  const payload = record(value);
  if (action === 'get_last_answer') {
    if (payload.answer === null) return { answer: null };
    const answer = record(payload.answer);
    if (typeof answer.text !== 'string' || typeof answer.truncated !== 'boolean') fail(400, 'invalid_read_payload');
    return { answer: { answerId: opaque(answer.answerId, true), turnId: opaque(answer.turnId, true), text: answer.text.slice(0, 100000),
      truncated: answer.truncated || answer.text.length > 100000, completedAt: answer.completedAt === null ? null : date(answer.completedAt) } };
  }
  if (action === 'get_state') {
    const state = record(payload.state), actions = record(state.actions);
    if (state.tabId !== expectedTabId || typeof state.agent !== 'string' || !['codex', 'claude'].includes(state.agent) ||
      typeof state.status !== 'string' || !['idle', 'running', 'blocked', 'unavailable', 'ambiguous'].includes(state.status) ||
      !Number.isInteger(state.queueLength) || Number(state.queueLength) < 0 || Number(state.queueLength) > 50 ||
      typeof state.queuePaused !== 'boolean' || typeof actions.send !== 'boolean' || typeof actions.stop !== 'boolean') fail(400, 'invalid_read_payload');
    const project = state.project === '' ? '' : stringField(state.project, 80); if (/[\\/:]/.test(project)) fail(400, 'invalid_read_payload');
    return { state: { tabId: expectedTabId, title: stringField(state.title, 120), agent: state.agent, project, status: state.status,
      queueLength: state.queueLength, queuePaused: state.queuePaused, updatedAt: date(state.updatedAt),
      activeTurnId: state.activeTurnId === null ? null : opaque(state.activeTurnId), actions: { send: actions.send, stop: actions.stop } } };
  }
  return undefined;
}
