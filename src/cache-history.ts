type CacheTurn = { id?: string; status?: string; error?: unknown; completedAt?: unknown; startedAt?: unknown; items?: { type?: string }[]; itemsView?: string };
type CacheItem = { turnId?: string; type?: string };

/** App Server turn timestamps are Unix seconds; never replace missing history with now. */
export function responseTime(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value * 1000;
  return Number.isSafeInteger(milliseconds) && milliseconds <= now ? milliseconds : null;
}

/** Input order is explicit: turn pages descend, full thread transcripts ascend. */
export function historicalCacheActivity(turns: CacheTurn[], items: CacheItem[], descending: boolean, now: number): number | null {
  const latest = descending ? turns[0] : turns.at(-1);
  if (!latest || latest.status !== 'completed' || latest.error || turns.some(turn => turn.status === 'inProgress')) return null;
  const at = responseTime(latest.completedAt, now);
  if (at === null) return null;
  if (typeof latest.startedAt === 'number' && latest.startedAt * 1000 > at) return null;
  const latestItems = [...(latest.items || []), ...items.filter(item => item.turnId === latest.id)];
  // A compaction's finish time is not the time of a normal assistant response.
  if (latestItems.some(item => item.type === 'contextCompaction')) return null;
  if (!latestItems.some(item => ['agentMessage', 'reasoning', 'plan'].includes(item.type || ''))) return null;
  return at;
}
