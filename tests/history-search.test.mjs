import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { HistorySearch, historyMessageText } from '../electron/history-search.mjs';

const cwd = path.resolve('history-search-fixture');
const message = (id, text = 'Найти [решение].') => ({ id, type: 'agentMessage', text, turnId: `turn-${id}` });
const thread = (id, provider = 'codex', extra = {}) => ({ id, provider, cwd, name: `Диалог ${id}`, ...extra });

test('content search uses literal Cyrillic messages across providers and preserves precise navigation', async () => {
  const calls = [];
  const service = new HistorySearch({
    listThreads: async options => { calls.push(options); return { data: [thread(`${options.provider}-thread`, options.provider, { archived: options.provider === 'codex' })] }; },
    readThread: async ({ thread }) => ({ thread: { ...thread, turns: [{ id: 'turn-id', items: [
      { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Проверить [РЕШЕНИЕ].' }, { type: 'image', url: 'secret-image' }] },
      message('assistant'),
      { id: 'hidden', type: 'reasoning', text: '[решение].', summary: ['[решение].'], encrypted_content: '[решение].' },
      { id: 'tool', type: 'commandExecution', aggregatedOutput: '[решение].' },
      { id: 'system', type: 'systemMessage', text: '[решение].' },
    ] }] } }),
  });
  const result = await service.search({ query: '[решение].', cwd, provider: 'all' });
  assert.equal(result.nextCursor, null);
  assert.equal(result.scannedThreads, 2);
  assert.equal(result.matches.length, 4);
  assert.deepEqual(result.matches.map(match => match.provider), ['codex', 'codex', 'claude', 'claude']);
  assert.equal(result.matches[0].turnId, 'turn-id');
  assert.equal(result.matches[0].itemId, 'user');
  assert.equal(result.matches[0].role, 'user');
  assert.equal(result.matches[0].thread.archived, true);
  assert.equal(result.matches[0].snippet, 'Проверить [РЕШЕНИЕ].');
  assert.deepEqual(result.warnings, []);
  assert.ok(calls.every(call => call.cwd === cwd && call.limit === 10));
  assert.equal(historyMessageText({ type: 'userMessage', content: [{ type: 'image', text: 'hidden' }] }), '');
});

test('bounded search continues through thread pages and item pages with no lost or duplicate matches', async () => {
  const reads = [], lists = [], pages = {
    first: { items: Array.from({ length: 7 }, (_, n) => message(`a${n}`)), nextCursor: 'older' },
    older: { items: [message('a6'), message('b0'), message('b1')], nextCursor: null },
  };
  const service = new HistorySearch({ maxMatches: 3, maxThreadsPerPage: 1, maxReadPages: 2,
    listThreads: async ({ cursor }) => { lists.push(cursor); return cursor ? { data: [thread('second')] } : { data: [thread('first')], nextCursor: 'next-list' }; },
    readThread: async ({ thread, cursor }) => { reads.push([thread.id, cursor]); return thread.id === 'second' ? { items: [message('last')] } : pages[cursor ?? 'first']; },
  });
  const collected = [];
  let cursor, page;
  do {
    const before = reads.length;
    page = await service.search({ query: 'решение', cwd, provider: 'codex', ...(cursor ? { cursor } : {}) });
    assert.ok(reads.length - before <= 2);
    assert.ok(page.matches.length <= 3);
    collected.push(...page.matches.map(match => match.itemId)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(collected, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b0', 'b1', 'last']);
  assert.deepEqual(lists, [undefined, 'next-list']);
  assert.equal(page.scannedThreads, 2);
});

test('native empty pages are bounded and provider scans alternate fairly', async () => {
  const providers = [];
  const service = new HistorySearch({ maxReadPages: 2,
    listThreads: async options => { providers.push(options.provider); return { data: [], nextCursor: `next-${providers.length}` }; },
    readThread: async () => { throw new Error('No thread should be read'); },
  });
  const page = await service.search({ query: 'empty', cwd, provider: 'all' });
  assert.deepEqual(page.matches, []);
  assert.ok(page.nextCursor);
  assert.ok(providers.length <= 6);
  assert.deepEqual(providers.slice(0, 4), ['codex', 'claude', 'codex', 'claude']);
});

test('continuation scope, expiry and duplicate concurrent load-more are checked before reads', async () => {
  let now = 0, reads = 0;
  const service = new HistorySearch({ maxMatches: 1, cursorTtlMs: 20, now: () => now,
    listThreads: async () => ({ data: [thread('test')] }),
    readThread: async () => { reads += 1; return { items: [message('1'), message('2'), message('3')] }; },
  });
  const first = await service.search({ query: 'решение', cwd, provider: 'codex' });
  await assert.rejects(service.search({ query: 'other', cwd, provider: 'codex', cursor: first.nextCursor }), /изменился/);
  await assert.rejects(service.search({ query: 'решение', cwd: path.resolve('other-project'), provider: 'codex', cursor: first.nextCursor }), /изменился/);
  assert.equal(reads, 1);
  const results = await Promise.allSettled([1, 2].map(() => service.search({ query: 'РЕШЕНИЕ', cwd, provider: 'codex', cursor: first.nextCursor })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  now = 21;
  const token = results.find(result => result.status === 'fulfilled').value.nextCursor;
  await assert.rejects(service.search({ query: 'решение', cwd, provider: 'codex', cursor: token }), /устарел/);
  assert.equal(reads, 2);
});

test('source failures and repeated cursors are visible and cannot loop forever', async () => {
  const service = new HistorySearch({
    listThreads: async ({ provider }) => provider === 'claude' ? Promise.reject(new Error('private transcript path')) : { data: [thread('test')], nextCursor: 'repeat-list' },
    readThread: async () => ({ items: [message('1')], nextCursor: 'repeat-items' }),
  });
  const result = await service.search({ query: 'решение', cwd });
  assert.equal(result.nextCursor, null);
  assert.equal(result.matches.length, 1);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.every(warning => !warning.includes('private transcript path')));
});

test('foreign project/provider results and replaced thread responses cannot leak message bodies', async () => {
  let reads = 0;
  const service = new HistorySearch({
    listThreads: async () => ({ data: [thread('valid'), thread('foreign', 'codex', { cwd: path.resolve('foreign') }), thread('provider', 'claude')] }),
    readThread: async () => { reads += 1; return { thread: thread('different'), items: [message('wrong')] }; },
  });
  const result = await service.search({ query: 'решение', cwd, provider: 'codex' });
  assert.equal(reads, 1);
  assert.deepEqual(result.matches, []);
  assert.equal(result.warnings.length, 1);
});

test('search validates input and disposal stops in-flight traversal', async () => {
  let finish;
  const service = new HistorySearch({ listThreads: () => new Promise(resolve => { finish = resolve; }), readThread: async () => ({ items: [] }) });
  for (const query of ['', '  ', 'x'.repeat(501), 'a\nb', '\0', null]) await assert.rejects(service.search({ query, cwd }), /поиска/);
  await assert.rejects(service.search({ query: 'ok', cwd: 'relative' }), /папку/);
  await assert.rejects(service.search({ query: 'ok', cwd, provider: 'unknown' }), /агент/);
  const job = service.search({ query: 'ok', cwd });
  service.dispose(); finish({ data: [thread('never-read')] });
  await assert.rejects(job, /закрыто/);
  await assert.rejects(service.search({ query: 'ok', cwd }), /закрыто/);
});
