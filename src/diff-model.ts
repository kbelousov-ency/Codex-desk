export type DiffSide = { text: string; line?: number; kind: 'context' | 'remove' | 'add' };

export type DiffRow = {
  kind: 'context' | 'change' | 'meta';
  before?: DiffSide;
  after?: DiffSide;
  meta?: string;
  /** Zero-based fragment identifier, shared by its header and content rows. */
  hunk?: number;
  /** Consecutive deletions followed by additions; scoped to this fragment. */
  changeGroup?: number;
};

export type ParsedDiff = { rows: DiffRow[]; hasLineNumbers: boolean };

type Range = { before: number; beforeCount: number; after: number; afterCount: number };
type BodyLine = { kind: 'context' | 'remove' | 'add' | 'meta'; text: string };

const numberedHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const noNewline = '\\ No newline at end of file';
const fileBoundary = /^(?:diff --(?:git|cc|combined) |\*\*\* (?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:|End of File))/;

function readRange(line: string): Range | undefined {
  const match = numberedHeader.exec(line);
  if (!match) return;
  const [before, beforeCount, after, afterCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
  if (![before, beforeCount, after, afterCount, before + beforeCount, after + afterCount].every(Number.isSafeInteger)) return;
  if ((beforeCount > 0 && before === 0) || (afterCount > 0 && after === 0)) return;
  return { before, beforeCount, after, afterCount };
}

function bodyLine(line: string): BodyLine | undefined {
  if (line === noNewline) return { kind: 'meta', text: line };
  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
}

function pairLines(body: BodyLine[], hunk: number, range?: Range): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = range?.before;
  let after = range?.after;
  let removals: DiffSide[] = [];
  let additions: DiffSide[] = [];
  let nextGroup = 0;
  const flush = () => {
    if (!removals.length && !additions.length) return;
    const changeGroup = nextGroup++;
    for (let index = 0; index < Math.max(removals.length, additions.length); index++) {
      rows.push({ kind: 'change', ...(removals[index] ? { before: removals[index] } : {}), ...(additions[index] ? { after: additions[index] } : {}), hunk, changeGroup });
    }
    removals = [];
    additions = [];
  };
  const side = (line: BodyLine, number?: number): DiffSide => ({ text: line.text, kind: line.kind as DiffSide['kind'], ...(number === undefined ? {} : { line: number }) });
  for (const line of body) {
    if (line.kind === 'meta') {
      flush();
      rows.push({ kind: 'meta', meta: line.text, hunk });
    } else if (line.kind === 'context') {
      flush();
      rows.push({ kind: 'context', before: side(line, before), after: side(line, after), hunk });
      if (before !== undefined) before++;
      if (after !== undefined) after++;
    } else if (line.kind === 'remove') {
      // A new deletion after additions starts a separate edit; never reorder edits.
      if (additions.length) flush();
      removals.push(side(line, before));
      if (before !== undefined) before++;
    } else {
      additions.push(side(line, after));
      if (after !== undefined) after++;
    }
  }
  flush();
  return rows;
}

/** Keeps original patch order when rendering paired rows in one column. */
export function toUnifiedRows(rows: DiffRow[]): DiffRow[] {
  const result: DiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    const first = rows[index];
    if (first.kind !== 'change') { result.push(first); index++; continue; }
    let end = index + 1;
    if (first.changeGroup !== undefined) {
      while (end < rows.length && rows[end].kind === 'change' && rows[end].hunk === first.hunk && rows[end].changeGroup === first.changeGroup) end++;
    }
    for (let rowIndex = index; rowIndex < end; rowIndex++) {
      const row = rows[rowIndex];
      if (row.before) { const { after: _after, ...beforeRow } = row; result.push(beforeRow); }
    }
    for (let rowIndex = index; rowIndex < end; rowIndex++) {
      const row = rows[rowIndex];
      if (row.after) { const { before: _before, ...afterRow } = row; result.push(afterRow); }
    }
    index = end;
  }
  return result;
}

/**
 * Parses only supported text patches. Unknown/invalid input remains verbatim
 * metadata: in particular, line numbers are never inferred from an incomplete
 * range or from the apply_patch format, which does not carry source positions.
 */
export function parseDiff(text: string): ParsedDiff {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows: DiffRow[] = [];
  let hasLineNumbers = false;
  let nextHunk = 0;
  let codexFile = false;
  let unsupported = false;
  const raw = (line: string) => rows.push({ kind: 'meta', meta: line });
  const fileHeaders = (index: number) => lines[index]?.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (fileBoundary.test(line)) {
      codexFile = /^\*\*\* (?:Add|Update) File:/.test(line) || (codexFile && line.startsWith('*** Move to:'));
      unsupported = /^diff --(?:cc|combined) /.test(line);
      raw(line);
      index++;
      continue;
    }
    if (line.startsWith('@@@') || line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) unsupported = true;
    if (unsupported) { raw(line); index++; continue; }
    const range = readRange(line);
    const namedHunk = /^@@(?: |$)/.test(line) && !line.includes('@@', 2) && !/^@@ [-+]/.test(line);
    const implicitKind = bodyLine(line)?.kind;
    const implicitHunk = codexFile && implicitKind !== undefined && implicitKind !== 'meta' && !fileHeaders(index);
    if (range || namedHunk || implicitHunk) {
      const start = index;
      const body: BodyLine[] = [];
      let beforeCount = 0;
      let afterCount = 0;
      let cursor = index + (implicitHunk ? 0 : 1);
      while (cursor < lines.length) {
        const candidate = lines[cursor];
        if (candidate.startsWith('@@') || fileBoundary.test(candidate)) break;
        const rangeComplete = range && beforeCount >= range.beforeCount && afterCount >= range.afterCount;
        // Inside a numbered hunk, ---/+++ are ordinary removed/added text.
        if ((rangeComplete || (!range && !codexFile)) && fileHeaders(cursor)) break;
        const content = bodyLine(candidate);
        if (!content || (content.kind === 'meta' && body.length === 0)) break;
        body.push(content);
        if (content.kind === 'context' || content.kind === 'remove') beforeCount++;
        if (content.kind === 'context' || content.kind === 'add') afterCount++;
        cursor++;
      }
      if (range && (beforeCount !== range.beforeCount || afterCount !== range.afterCount)) {
        for (let rawIndex = start; rawIndex < cursor; rawIndex++) raw(lines[rawIndex]);
      } else {
        const hunk = nextHunk++;
        if (!implicitHunk) rows.push({ kind: 'meta', meta: line, hunk });
        else if (rows.at(-1)?.kind === 'meta' && /^\*\*\* (?:Add File:|Update File:|Move to:)/.test(rows.at(-1)!.meta || '')) rows.at(-1)!.hunk = hunk;
        for (const row of pairLines(body, hunk, range)) rows.push(row);
        if (range && body.some(item => item.kind !== 'meta')) hasLineNumbers = true;
      }
      index = cursor;
      continue;
    }
    if (line.startsWith('@@')) codexFile = false;
    raw(line);
    index++;
  }
  return { rows, hasLineNumbers };
}
