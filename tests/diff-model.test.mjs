import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiff, toUnifiedRows } from '../src/diff-model.ts';

const changes = parsed => parsed.rows.filter(row => row.kind === 'change');
const textRows = parsed => parsed.rows.filter(row => row.kind !== 'meta');
const rawLines = parsed => parsed.rows.map(row => row.meta);

test('unified replacement aligns sides and carries independent line numbers across hunks', () => {
  const parsed = parseDiff(`diff --git a/src/main.ts b/src/main.ts
index 1234..5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,4 +10,5 @@ function run() {
 keep
-old one
-old two
+new one
+new two
+new three
 tail
@@ -90 +91 @@
-before
+after
`);
  assert.equal(parsed.hasLineNumbers, true);
  assert.deepEqual(textRows(parsed).map(row => [row.before?.line, row.before?.text, row.after?.line, row.after?.text, row.hunk]), [
    [10, 'keep', 10, 'keep', 0], [11, 'old one', 11, 'new one', 0], [12, 'old two', 12, 'new two', 0],
    [undefined, undefined, 13, 'new three', 0], [13, 'tail', 14, 'tail', 0], [90, 'before', 91, 'after', 1],
  ]);
  assert.deepEqual(parsed.rows.filter(row => row.kind === 'meta' && row.hunk !== undefined).map(row => row.hunk), [0, 1]);
});

test('new files, deleted files and rename headers preserve Unicode/spaced paths', () => {
  const parsed = parseDiff(`diff --git "a/старое имя.txt" "b/новое имя.txt"
similarity index 90%
rename from старое имя.txt
rename to новое имя.txt
--- a/старое имя.txt
+++ b/новое имя.txt
@@ -1 +1 @@
-было
+стало
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+first
+second
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second`);
  assert.deepEqual(changes(parsed).map(row => [row.before?.line, row.before?.text, row.after?.line, row.after?.text]), [
    [1, 'было', 1, 'стало'], [undefined, undefined, 1, 'first'], [undefined, undefined, 2, 'second'],
    [1, 'first', undefined, undefined], [2, 'second', undefined, undefined],
  ]);
  assert.ok(rawLines(parsed).includes('rename from старое имя.txt'));
  assert.ok(rawLines(parsed).includes('+++ /dev/null'));
});

test('header-like content inside a hunk is data; actual next file headers stay metadata', () => {
  const parsed = parseDiff(`--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
--- old title
+++ new title
--- a/two.txt
+++ b/two.txt
@@ -7 +8 @@
-seven
+eight`);
  assert.deepEqual(changes(parsed).map(row => [row.before.text, row.after.text]), [['-- old title', '++ new title'], ['seven', 'eight']]);
  assert.ok(rawLines(parsed).includes('--- a/two.txt'));
  assert.ok(rawLines(parsed).includes('+++ b/two.txt'));
});

test('newline markers never advance counters or become source text', () => {
  const parsed = parseDiff('@@ -1 +1 @@\r\n-old\r\n\\ No newline at end of file\r\n+new\r\n\\ No newline at end of file\r\n');
  assert.equal(parsed.hasLineNumbers, true);
  assert.deepEqual(changes(parsed).map(row => [row.before?.line, row.after?.line]), [[1, undefined], [undefined, 1]]);
  assert.equal(rawLines(parsed).filter(line => line === '\\ No newline at end of file').length, 2);
});

test('Codex apply_patch fragments support moves, named anchors, additions and unnumbered updates', () => {
  const parsed = parseDiff(`*** Begin Patch
*** Update File: папка/старое имя.ts
*** Move to: папка/новое имя.ts
@@ function run()
 keep
-old
+new
@@
-second old
+second new
*** Add File: папка/ещё один.ts
+export const result = 1;
+
*** Update File: settings.json
-false
+true
*** End of File
*** Delete File: obsolete.txt
*** End Patch`);
  assert.equal(parsed.hasLineNumbers, false);
  assert.deepEqual(changes(parsed).map(row => [row.before?.text, row.after?.text]), [
    ['old', 'new'], ['second old', 'second new'], [undefined, 'export const result = 1;'], [undefined, ''], ['false', 'true'],
  ]);
  assert.ok(textRows(parsed).every(row => row.before?.line === undefined && row.after?.line === undefined));
  assert.deepEqual([...new Set(textRows(parsed).map(row => row.hunk))], [0, 1, 2, 3]);
  assert.ok(rawLines(parsed).includes('*** Delete File: obsolete.txt'));
});

test('standalone Codex anchor is supported without making up line numbers', () => {
  const parsed = parseDiff('@@ class App\n-old\n+new\n same');
  assert.equal(parsed.hasLineNumbers, false);
  assert.equal(changes(parsed)[0].before.text, 'old');
  assert.equal(changes(parsed)[0].after.text, 'new');
  assert.equal(textRows(parsed)[1].kind, 'context');
});

test('apply_patch hunk keeps header-shaped source lines until a Codex file boundary', () => {
  const parsed = parseDiff('*** Begin Patch\n*** Update File: titles.md\n@@\n--- old title\n+++ new title\n*** End Patch');
  assert.deepEqual(changes(parsed).map(row => [row.before?.text, row.after?.text]), [['-- old title', '++ new title']]);
  assert.equal(parsed.hasLineNumbers, false);
});

test('truncated, overlong and malformed ranges remain raw, without fabricated coordinates', () => {
  for (const patch of [
    '@@ -8,2 +9,2 @@\n-old\n+new',
    '@@ -8 +9 @@\n-old\n+new\n+extra',
    '@@ -x +1 @@\n-old\n+new',
    '@@ -0 +1 @@\n-old\n+new',
    '@@ -999999999999999999999 +1 @@\n-old\n+new',
    '--- a/путь с пробелом.txt\n+++ b/путь с пробелом.txt\n@@ -8,2 +9,2 @@\n-old',
    '*** Update File: file.txt\n@@ -x +1 @@\n-old\n+new',
  ]) {
    const parsed = parseDiff(patch);
    assert.equal(parsed.hasLineNumbers, false, patch);
    assert.deepEqual(rawLines(parsed), patch.split('\n'), patch);
    assert.ok(parsed.rows.every(row => row.hunk === undefined), patch);
  }
});

test('a damaged hunk does not contaminate a valid following file or hunk', () => {
  const parsed = parseDiff('@@ -1,2 +1,2 @@\n-old\n+new\n@@ -10 +10 @@\n-before\n+after\ndiff --git a/x b/x\n@@ -5 +6 @@\n-x\n+y');
  assert.equal(parsed.hasLineNumbers, true);
  assert.deepEqual(changes(parsed).map(row => [row.before.line, row.after.line, row.hunk]), [[10, 10, 0], [5, 6, 1]]);
  assert.deepEqual(rawLines(parsed).slice(0, 3), ['@@ -1,2 +1,2 @@', '-old', '+new']);
});

test('combined and binary formats stay raw until the next ordinary file patch', () => {
  const prefix = `diff --cc merge.txt
index aaa,bbb..ccc
--- a/merge.txt
+++ b/merge.txt
@@@ -1,2 -1,2 +1,2 @@@
 -first parent
  unchanged
++merged
@@ -99 +99 @@
-not a two-way hunk
+still combined
diff --git a/image.png b/image.png
GIT binary patch
literal 15
+binary encoding
-binary encoding
`;
  const parsed = parseDiff(prefix + 'diff --git a/readme b/readme\n@@ -1 +1 @@\n-old\n+new');
  assert.deepEqual(rawLines(parsed).slice(0, prefix.trimEnd().split('\n').length), prefix.trimEnd().split('\n'));
  assert.equal(changes(parsed).length, 1);
  assert.equal(changes(parsed)[0].before.text, 'old');
});

test('empty, binary summary and unknown text are preserved without synthetic source rows', () => {
  assert.deepEqual(parseDiff(''), { rows: [], hasLineNumbers: false });
  for (const patch of ['Binary files a/a.png and b/a.png differ', 'plain content\n+not a patch\n\nlast line']) {
    assert.deepEqual(rawLines(parseDiff(patch)), patch.split('\n'));
    assert.equal(parseDiff(patch).hasLineNumbers, false);
  }
});

test('orphan no-newline markers in Codex files remain raw and parsing always advances', () => {
  const patch = '*** Begin Patch\n*** Update File: empty.txt\n\\ No newline at end of file\n*** End Patch';
  assert.deepEqual(rawLines(parseDiff(patch)), patch.split('\n'));
  assert.equal(parseDiff(patch).hasLineNumbers, false);
});

test('adjacent edits retain sequence and repeated text is never matched across context', () => {
  const parsed = parseDiff('@@ -1,5 +1,5 @@\n-a\n+b\n-c\n+d\n boundary\n-duplicate\n-tail\n+tail\n+duplicate');
  assert.deepEqual(textRows(parsed).map(row => [row.before?.text, row.after?.text]), [
    ['a', 'b'], ['c', 'd'], ['boundary', 'boundary'], ['duplicate', 'tail'], ['tail', 'duplicate'],
  ]);
});

test('unified rows reconstruct original patch order for replacements, alternating edits and newline markers', () => {
  for (const patch of [
    '@@ -10,3 +10,4 @@\n keep\n-old one\n-old two\n+new one\n+new two\n+new three',
    '@@ -1,4 +1,4 @@\n-first\n+second\n-third\n+fourth\n-fifth\n-sixth\n+seventh\n+eighth',
    '@@ -1,2 +1,2 @@\n-old one\n-old two\n\\ No newline at end of file\n+new one\n+new two\n\\ No newline at end of file',
    '@@ -1,2 +1,2 @@\n-one\n-two\n+three\n+four\n@@ -9,2 +9,2 @@\n-five\n-six\n+seven\n+eight',
    '*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** Update File: old.txt\n@@\n-before\n+after\n*** End Patch',
    '@@ -1,4 +1,4 @@\n-truncated\n+raw',
  ]) {
    const parsed = parseDiff(patch);
    const before = structuredClone(parsed.rows);
    const unified = toUnifiedRows(parsed.rows);
    const restored = unified.map(row => row.kind === 'meta' ? row.meta : row.kind === 'context' ? ` ${row.before.text}` : row.before ? `-${row.before.text}` : `+${row.after.text}`).join('\n');
    assert.equal(restored, patch);
    assert.deepEqual(parsed.rows, before, 'Switching view must not mutate the split representation');
    assert.ok(unified.every(row => row.kind !== 'change' || !row.before || !row.after));
  }
});
