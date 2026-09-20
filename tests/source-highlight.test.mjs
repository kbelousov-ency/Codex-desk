import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightSource, sourceLineRange, sourceWindow } from '../src/source-highlight.ts';

test('source highlighting preserves exact normalized source and multiline state for visible rows', () => {
  const value = 'const answer = 42;\r\n/* multiline\r\ncomment */\r\nconst text = "<script>";\r\n';
  const source = highlightSource(value, 'src/app.ts');
  assert.equal(sourceWindow(source, 0, 100).map(piece => piece.text).join(''), value.replaceAll('\r\n', '\n'));
  assert.ok(source.tokens.some(token => token.kind === 'keyword'));
  assert.ok(source.tokens.some(token => token.kind === 'number'));
  const visible = sourceWindow(source, 2, 1);
  assert.equal(visible[0].kind, 'comment');
  assert.equal(visible.map(piece => piece.text).join(''), 'comment */\n');
});

test('line navigation validates available rows and selects exact source excluding newlines', () => {
  const source = highlightSource('one\r\ntwo\r\n', 'file.txt');
  assert.deepEqual(sourceLineRange(source, ' 2 '), { line: 2, start: 4, end: 7 });
  assert.deepEqual(sourceLineRange(source, '3'), { line: 3, start: 8, end: 8 });
  for (const value of ['0', '-1', '2.2', 'NaN', '1e2', '4', '']) assert.equal(sourceLineRange(source, value), null);
  assert.deepEqual(source.tokens, []);
});

test('highlighting remains bounded for generated files, preserves tail, supports JSON and Python comments', () => {
  const text = 'const n = 1;\n'.repeat(30_000);
  const source = highlightSource(text, 'large.js');
  assert.equal(source.limited, true);
  assert.equal(sourceWindow(source, 29_990, 10).map(piece => piece.text).join(''), 'const n = 1;\n'.repeat(10));
  assert.ok(highlightSource('{"key":42}', 'a.json').tokens.some(token => token.kind === 'property'));
  assert.equal(highlightSource('# comment\nTrue', 'a.py').tokens[0].kind, 'comment');
});
