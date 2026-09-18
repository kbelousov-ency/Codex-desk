/** Numeric counts reported by App Server; unknown values remain unknown. */
export type TokenCount = number | null;

export type TokenMetricsIssue =
  | 'invalid_value'
  | 'cached_exceeds_input'
  | 'cache_write_exceeds_input'
  | 'cache_parts_exceed_input'
  | 'reasoning_exceeds_output';

export type TokenBreakdownMetrics = {
  totalTokens: TokenCount;
  inputTokens: TokenCount;
  cachedInputTokens: TokenCount;
  cacheWriteInputTokens: TokenCount;
  outputTokens: TokenCount;
  reasoningOutputTokens: TokenCount;
  /** Input minus cache reads. Includes cache writes, when reported. */
  uncachedInputTokens: TokenCount;
  /** Input outside both cache reads and cache writes; requires all three counts. */
  ordinaryInputTokens: TokenCount;
  /** Output excluding its reasoning subset; not necessarily visible answer text. */
  nonReasoningOutputTokens: TokenCount;
  /** Cache reads as a percentage of reported input; unknown when input is zero. */
  cachedSharePercent: number | null;
  issues: TokenMetricsIssue[];
};

export type TokenMetrics = {
  last: TokenBreakdownMetrics;
  total: TokenBreakdownMetrics;
  modelContextWindow: TokenCount;
  /** Last reported input / capacity, NOT a measurement of current context usage. */
  lastInputContextPercent: number | null;
};

const countFields = [
  'totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens',
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function count(value: unknown): TokenCount {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function breakdown(value: unknown): TokenBreakdownMetrics {
  const source = record(value);
  const counts = Object.fromEntries(countFields.map(field => [field, count(source[field])])) as
    Record<typeof countFields[number], TokenCount>;
  const issues: TokenMetricsIssue[] = [];
  if (countFields.some(field => source[field] != null && counts[field] === null)) issues.push('invalid_value');

  const { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: writing,
    outputTokens: output, reasoningOutputTokens: reasoning } = counts;
  const validReads = input !== null && cached !== null && cached <= input;
  const validParts = validReads && writing !== null && writing <= input - cached;
  const validReasoning = output !== null && reasoning !== null && reasoning <= output;

  if (input !== null && cached !== null && cached > input) issues.push('cached_exceeds_input');
  if (input !== null && writing !== null && writing > input) issues.push('cache_write_exceeds_input');
  if (input !== null && cached !== null && writing !== null && writing > input - cached) issues.push('cache_parts_exceed_input');
  if (output !== null && reasoning !== null && reasoning > output) issues.push('reasoning_exceeds_output');

  return {
    ...counts,
    uncachedInputTokens: validReads ? input - cached : null,
    ordinaryInputTokens: validParts ? input - cached - writing : null,
    nonReasoningOutputTokens: validReasoning ? output - reasoning : null,
    cachedSharePercent: validReads && input > 0 ? cached / input * 100 : null,
    issues,
  };
}

/**
 * Reads ThreadTokenUsage without conflating last-call and cumulative counts.
 * Cached input is inside input; reasoning output is inside output. Consequently
 * totalTokens is the server's value, never the sum of every displayed row.
 * These counters cannot reveal cached messages/files or predict compaction savings.
 */
export function getTokenMetrics(value: unknown): TokenMetrics {
  const source = record(value);
  const last = breakdown(source.last);
  const total = breakdown(source.total);
  const capacity = count(source.modelContextWindow);
  const modelContextWindow = capacity !== null && capacity > 0 ? capacity : null;
  return {
    last,
    total,
    modelContextWindow,
    lastInputContextPercent: modelContextWindow !== null && last.inputTokens !== null
      ? last.inputTokens / modelContextWindow * 100
      : null,
  };
}
