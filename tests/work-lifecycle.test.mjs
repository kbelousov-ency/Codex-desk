import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import * as turnWork from '../src/turn-work.ts';
import * as cacheHistory from '../src/cache-history.ts';

// Exercise the real hook's bridge handler without a browser or a model. Setters
// retain state, while renders are explicit so same-tick events cannot rely on one.
const source = await readFile(new URL('../src/useCodex.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let listener;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, fn };
      return slots[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) {
        slots[index]?.cleanup?.();
        const slot = slots[index] = { deps };
        effects.push(() => { slot.cleanup = fn(); });
      }
    },
  };
  const exports = {};
  const imports = { react: hooks, './AgentContext': { agentName: () => 'Codex' }, './turn-work': turnWork, './cache-history': cacheHistory };
  new Function('require', 'exports', 'crypto', compiled)(name => {
    assert.ok(imports[name], `unexpected runtime dependency: ${name}`);
    return imports[name];
  }, exports, { randomUUID });
  let nextTurn = 0;
  const f = { events: [], turnStart: null, resumeStart: null, resumeResult: null, compactStart: null, api: null };
  const bridge = {
    getSettings: async () => ({}),
    setSettings: async () => ({}),
    start: async () => ({ cwd: 'C:\\fixture', models: [], config: {}, provider: 'codex' }),
    onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
    request: async (method, params) => {
      if (method === 'thread/list') return { data: [] };
      if (method === 'thread/start') return { thread: { id: 'thread', cwd: 'C:\\fixture' } };
      if (method === 'thread/resume') { f.resumeStart?.(); return { thread: f.resumeResult || { id: params.threadId, turns: [] } }; }
      if (method === 'thread/compact/start') { f.compactStart?.(); return {}; }
      if (method === 'turn/start') {
        const id = `turn-${++nextTurn}`;
        if (f.turnStart) return f.turnStart(id);
        f.emit('turn/started', { turn: { id } });
        return { turn: { id, status: 'inProgress' } };
      }
      throw new Error(`Unexpected fixture request ${method}`);
    },
  };
  f.emit = (method, params) => listener({ type: 'notification', data: { method, params: { threadId: 'thread', ...params } } });
  f.status = state => listener({ type: 'status', data: { state } });
  f.render = () => {
    cursor = 0;
    f.api = exports.useCodex(bridge, { onWorkLifecycle: event => f.events.push(event) });
    for (const effect of effects.splice(0)) effect();
  };
  f.render();
  for (let index = 0; index < 8; index++) await tick();
  f.render();
  return f;
}
const message = (f, turnId, text, phase = 'final_answer', id = `answer-${turnId}`) => f.emit('item/completed', { turnId, item: { id, type: 'agentMessage', text, phase } });
const complete = (f, id, status = 'completed', extra = {}) => f.emit('turn/completed', { turn: { id, status, ...extra } });

test('same-tick working events report the exact final answer and ignore repeats and old turns', async () => {
  const f = await fixture();
  await f.api.send('first', []);
  f.emit('turn/started', { turn: { id: 'turn-1' } });
  assert.deepEqual(f.api.getActiveWorkTurn(), { threadId: 'thread', turnId: 'turn-1' });
  message(f, 'turn-1', 'old result');
  complete(f, 'turn-1');
  assert.equal(f.api.getActiveWorkTurn(), null);
  await f.api.send('second', []);
  message(f, 'turn-1', 'late old result');
  complete(f, 'turn-1');
  message(f, 'turn-2', 'current commentary', 'commentary', 'comment');
  message(f, 'turn-2', 'current final');
  complete(f, 'turn-2');
  complete(f, 'turn-2');
  assert.deepEqual(f.events.map(event => [event.kind, event.turnId, event.result]), [
    ['started', 'turn-1', undefined], ['completed', 'turn-1', 'old result'],
    ['started', 'turn-2', undefined], ['completed', 'turn-2', 'current final'],
  ]);
});

test('canonical completion items can promote the final answer without a render', async () => {
  const f = await fixture();
  f.turnStart = async id => {
    f.emit('turn/started', { turn: { id } });
    message(f, id, 'Promoted answer', 'commentary');
    complete(f, id, 'completed', { items: [{ id: `answer-${id}`, type: 'agentMessage', text: 'Promoted answer', phase: 'final_answer' }] });
    return { turn: { id } };
  };
  await f.api.send('fast', []);
  assert.equal(f.events.at(-1).result, 'Promoted answer');
  assert.equal(f.api.getActiveWorkTurn(), null);
});

test('ordinary send is tracked when started notification is omitted', async () => {
  const f = await fixture();
  f.turnStart = async id => ({ turn: { id } });
  await f.api.send('work', []);
  assert.deepEqual(f.api.getActiveWorkTurn(), { threadId: 'thread', turnId: 'turn-1' });
  message(f, 'turn-1', 'Unphased result', null);
  complete(f, 'turn-1', 'failed', { error: { message: 'Command failed' } });
  assert.deepEqual(f.events, [
    { kind: 'started', threadId: 'thread', turnId: 'turn-1' },
    { kind: 'completed', threadId: 'thread', turnId: 'turn-1', status: 'failed', result: 'Unphased result', error: 'Command failed' },
  ]);
});

test('accepted completion before the RPC acknowledgement announces its missing start first', async () => {
  const f = await fixture();
  f.turnStart = async id => {
    message(f, id, 'Immediate final');
    complete(f, id);
    return { turn: { id } };
  };
  await f.api.send('work', []);
  assert.deepEqual(f.events.map(event => [event.kind, event.turnId, event.result]), [
    ['started', 'turn-1', undefined], ['completed', 'turn-1', 'Immediate final'],
  ]);
});

test('autoping, compaction, history replay and disconnect do not complete working tasks', async () => {
  const f = await fixture();
  await f.api.send('seed', []);
  complete(f, 'turn-1');
  f.events.length = 0;
  await f.api.sendPing('cache ping');
  message(f, 'turn-2', 'ping response');
  complete(f, 'turn-2');
  assert.deepEqual(f.events, []);
  f.compactStart = () => {
    f.emit('turn/started', { turn: { id: 'compact' } });
    complete(f, 'compact');
  };
  await f.api.compact();
  assert.deepEqual(f.events, []);
  f.api.clearThread();
  f.resumeResult = { id: 'thread', turns: [{ id: 'historic', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'history' }] }] };
  f.resumeStart = () => {
    f.emit('turn/started', { turn: { id: 'historic' } });
    message(f, 'historic', 'replayed result');
    complete(f, 'historic');
  };
  await f.api.resume({ id: 'thread' });
  complete(f, 'historic');
  assert.deepEqual(f.events, []);
  await f.api.send('new', []);
  f.events.length = 0;
  f.emit('item/completed', { turnId: 'turn-3', item: { id: 'incomplete', type: 'agentMessage', text: 'work' } });
  f.emit('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-3', status: 'completed' } });
  assert.deepEqual(f.events, []);
  // A stopped transport is not an interrupted turn.
  f.status('disconnected');
  complete(f, 'turn-3');
  assert.deepEqual(f.events, []);
  f.api.clearThread();
  assert.equal(f.api.getActiveWorkTurn(), null);
});

test('interruption reports an empty result honestly and long results are visibly bounded', async () => {
  const f = await fixture();
  await f.api.send('stop me', []);
  message(f, 'turn-1', 'still working', 'commentary');
  complete(f, 'turn-1', 'interrupted');
  assert.equal(f.events.at(-1).status, 'interrupted');
  assert.equal(f.events.at(-1).result, '');
  await f.api.send('long report', []);
  message(f, 'turn-2', 'x'.repeat(110_000));
  complete(f, 'turn-2');
  assert.equal(f.events.at(-1).result.length, 100_000);
  assert.match(f.events.at(-1).result, /Итоговый отчёт сокращён/);
});
