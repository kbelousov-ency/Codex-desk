import type { TurnWork } from './types';

type TurnTiming = { id?: string; status?: string; startedAt?: number | null; completedAt?: number | null; durationMs?: number | null };
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Read server timing without using the current clock for restored history. */
export function readTurnWork(turn: TurnTiming): TurnWork | undefined {
  if (!turn.id) return;
  const work: TurnWork = { id: turn.id, status: turn.status || 'unknown' };
  if (validTime(turn.startedAt)) work.startedAt = turn.startedAt * 1000;
  if (validTime(turn.completedAt)) work.completedAt = turn.completedAt * 1000;
  if (validTime(turn.durationMs)) work.durationMs = turn.durationMs;
  else if (work.startedAt != null && work.completedAt != null && work.completedAt >= work.startedAt) work.durationMs = work.completedAt - work.startedAt;
  return work;
}

/** Only live lifecycle notifications may supply an observed clock fallback. */
export function observeTurnWork(previous: TurnWork | undefined, turn: TurnTiming, observedAt: number): TurnWork | undefined {
  const incoming = readTurnWork(turn);
  if (!incoming) return previous;
  // A delayed turn/start RPC or duplicate notification cannot restart a finished turn.
  if (previous && previous.status !== 'inProgress' && previous.status !== 'unknown' && incoming.status === 'inProgress') return previous;
  const work = { ...previous, ...incoming };
  if (work.status === 'inProgress') work.startedAt ??= observedAt;
  else if (['completed', 'failed', 'interrupted'].includes(work.status)) {
    work.completedAt ??= observedAt;
    if (work.durationMs == null && work.startedAt != null && work.completedAt >= work.startedAt) work.durationMs = work.completedAt - work.startedAt;
  }
  return work;
}

/** Resume can finish after live events: current streamed metadata always wins. */
export function mergeHistoricalTurnWork(current: Record<string, TurnWork>, turns: TurnTiming[]) {
  const next = { ...current };
  for (const turn of turns) {
    const loaded = readTurnWork(turn);
    if (loaded) next[loaded.id] = { ...loaded, ...current[loaded.id] };
  }
  return next;
}
