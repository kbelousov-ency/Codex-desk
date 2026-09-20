export type SourceToken = { start: number; end: number; kind: 'comment' | 'string' | 'keyword' | 'number' | 'tag' | 'property' };
export type HighlightedSource = { text: string; offsets: number[]; tokens: SourceToken[]; limited: boolean };
const keywords = 'abstract and as async await base bool boolean break byte case catch char class const continue def default defer del do double elif else enum except export extends false final finally float fn for from func function global goto if implements import in instanceof int interface internal is lambda let long match mod namespace new nil none not null object of or override package pass private protected pub public raise readonly ref return self short sizeof static string struct super switch this throw trait true try type typeof undefined union unsafe use using var virtual void volatile when where while with yield';
const wordSet = new Set(keywords.split(' '));
const codeExtensions = new Set('js jsx ts tsx mjs cjs mts cts py pyw css scss less json jsonc sh bash zsh ps1 psm1 yaml yml toml rs go c h cc cpp cxx hpp cs java kt kts swift php rb sql html htm svg xml vue svelte'.split(' '));

/** Small lexical highlighter: text is always rendered through React text nodes, never HTML. */
export function highlightSource(source: string, path: string): HighlightedSource {
  const text = source.replace(/\r\n?/g, '\n');
  const offsets = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') offsets.push(index + 1);
  const extension = path.split('.').at(-1)?.toLowerCase() || '';
  const tokens: SourceToken[] = [];
  if (!codeExtensions.has(extension)) return { text, offsets, tokens, limited: false };
  const hashComments = /^(py|pyw|sh|bash|zsh|ps1|psm1|yaml|yml|toml|rb)$/.test(extension);
  const markup = /^(html|htm|svg|xml|vue|svelte)$/.test(extension);
  const sql = extension === 'sql';
  const patterns = [
    ...(markup ? ['<!--[^]*?(?:-->|$)'] : []),
    '/\\*[^]*?(?:\\*/|$)',
    ...(hashComments ? ['#[^\\n]*'] : sql ? ['--[^\\n]*'] : ['//[^\\n]*']),
    '"""[^]*?(?:"""|$)', "'''[^]*?(?:'''|$)",
    '"(?:\\\\[^]|[^"\\\\])*?(?:"|$)', "'(?:\\\\[^]|[^'\\\\])*?(?:'|$)", '`(?:\\\\[^]|[^`\\\\])*?(?:`|$)',
    ...(markup ? ['</?[A-Za-z][\\w:.-]*', '/?>'] : []),
    '\\b(?:0[xX][\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b',
    '\\b[A-Za-z_$][\\w$]*\\b',
  ];
  // Bounded work for generated/minified files. The remaining text remains readable and selectable.
  const limit = Math.min(text.length, 300_000);
  const expression = new RegExp(patterns.join('|'), 'g');
  const input = text.slice(0, limit);
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input)) && tokens.length < 40_000) {
    const value = match[0];
    let kind: SourceToken['kind'] | undefined;
    if (value.startsWith('/*') || value.startsWith('//') || value.startsWith('<!--') || (hashComments && value.startsWith('#')) || (sql && value.startsWith('--'))) kind = 'comment';
    else if (/^["'`]/.test(value)) kind = extension === 'json' && /^\s*:/.test(input.slice(match.index + value.length, match.index + value.length + 40)) ? 'property' : 'string';
    else if (markup && /^[<>/]/.test(value)) kind = 'tag';
    else if (/^\d/.test(value)) kind = 'number';
    else if (wordSet.has(value.toLowerCase())) kind = 'keyword';
    if (kind) tokens.push({ start: match.index, end: match.index + value.length, kind });
  }
  return { text, offsets, tokens, limited: text.length > limit || tokens.length >= 40_000 };
}

/** Slice only visible rows, preserving tokens which started above the viewport. */
export function sourceWindow(source: HighlightedSource, first: number, count: number) {
  const start = source.offsets[first] ?? source.text.length;
  const end = source.offsets[first + count] ?? source.text.length;
  const pieces: { text: string; kind?: SourceToken['kind'] }[] = [];
  let low = 0, high = source.tokens.length;
  while (low < high) { const mid = (low + high) >>> 1; if (source.tokens[mid].end <= start) low = mid + 1; else high = mid; }
  let position = start;
  for (let index = low; index < source.tokens.length; index++) {
    const token = source.tokens[index];
    if (token.start >= end) break;
    if (token.start > position) pieces.push({ text: source.text.slice(position, token.start) });
    const next = Math.min(end, token.end);
    pieces.push({ text: source.text.slice(Math.max(position, token.start), next), kind: token.kind });
    position = next;
  }
  if (position < end) pieces.push({ text: source.text.slice(position, end) });
  return pieces;
}

export function sourceLineRange(source: HighlightedSource, value: string) {
  if (!/^\d+$/.test(value.trim())) return null;
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1 || line > source.offsets.length) return null;
  const start = source.offsets[line - 1];
  const end = line < source.offsets.length ? source.offsets[line] - 1 : source.text.length;
  return { line, start, end };
}
