import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutorAutoReviewState, formatExecutorReviewMessage, reduceExecutorAutoReview as reduce,
  restoreExecutorAutoReview, reviewParentKey, selectExecutorReviewDelivery as select,
} from '../src/executor-auto-review.ts';

const parent = { cwd: 'E:/fixture', provider: 'codex', threadId: 'parent' };
const member = (id, fields = {}) => ({ id, label: `Агент ${id.toUpperCase()}`, status: 'waiting', ...fields });
const enable = (members = [member('a')]) => reduce(createExecutorAutoReviewState(parent), { type: 'enable', roundId: 'round-1', members });
const start = (state, id, turnId = `${id}-turn`, nextRoundId = 'round-2') => reduce(state, { type: 'start', member: member(id, { threadId: `${id}-thread` }), turnId, nextRoundId });
const complete = (state, id, fields = {}) => reduce(state, { type: 'complete', id, threadId: `${id}-thread`, turnId: `${id}-turn`, status: 'completed', result: `Результат ${id}`, ...fields });
const ready = () => complete(start(enable(), 'a'), 'a');
const reserve = state => reduce(state, { type: 'reserve', delivery: select(state) });
const commit = state => reduce(state, { type: 'commit', id: state.delivery.id });
const acknowledge = state => reduce(state, { type: 'receipt', id: state.delivery.id, accepted: true });

test('auto review defaults off and never sends for an empty roster', () => {
  const state = createExecutorAutoReviewState(parent);
  assert.equal(state.enabled, false);
  assert.equal(select(state), null);
  assert.equal(start(state, 'a'), state, 'Disabled mode does not collect new work');
  assert.equal(select(enable([])), null);
  assert.deepEqual(state.members, []);
});

test('two draft executors wait for both assignments and preserve exact final reports in either completion order', () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    let state = enable([member('a'), member('b')]);
    state = start(state, order[0]);
    state = complete(state, order[0]);
    assert.equal(select(state), null, 'An unstarted draft is still an unfinished participant');
    state = start(state, order[1]);
    state = complete(state, order[1]);
    const delivery = select(state);
    assert.ok(delivery);
    assert.match(delivery.text, /Результат a/);
    assert.match(delivery.text, /Результат b/);
    assert.match(delivery.text, /a-thread, ход a-turn/);
    assert.match(delivery.text, /b-thread, ход b-turn/);
    assert.equal(delivery.id, 'round-1');
  }
});

test('enabling during a live assignment accepts its matching completion without a second start', () => {
  const state = enable([member('a', { threadId: 'a-thread', turnId: 'a-turn', status: 'running' })]);
  assert.equal(select(state), null);
  assert.ok(select(complete(state, 'a')));
});

test('stale and duplicate completions cannot complete a newer assignment or mutate its saved report', () => {
  let state = start(enable(), 'a');
  state = start(state, 'a', 'a-next');
  assert.equal(complete(state, 'a'), state, 'Old turn completion is ignored');
  assert.equal(complete(state, 'a', { threadId: 'unrelated-thread', turnId: 'a-next' }), state);
  const finished = complete(state, 'a', { turnId: 'a-next', result: 'Новый результат' });
  assert.equal(complete(finished, 'a', { turnId: 'a-next', result: 'Повтор' }), finished);
  assert.equal(finished.members[0].result, 'Новый результат');
});

test('duplicate start is idempotent before completion and after delivery, without creating another round', () => {
  let state = start(enable(), 'a');
  assert.equal(start(state, 'a'), state);
  state = complete(state, 'a');
  assert.equal(start(state, 'a'), state);
  state = acknowledge(commit(reserve(state)));
  assert.equal(start(state, 'a', 'a-turn', 'spurious-round'), state);
  assert.equal(state.roundId, 'round-1');
  assert.equal(select(state), null);
});

test('a new assignment invalidates a reserved summary before send and rejects its stale claim', () => {
  const reserved = reserve(ready());
  const oldDelivery = reserved.delivery;
  const running = start(reserved, 'a', 'a-next');
  assert.equal(running.delivery, undefined);
  assert.equal(running.members[0].result, undefined);
  assert.equal(select(running), null);
  assert.equal(reduce(running, { type: 'commit', id: oldDelivery.id }), running);
  const finished = complete(running, 'a', { turnId: 'a-next', result: 'Актуальный результат' });
  assert.equal(reduce(finished, { type: 'reserve', delivery: oldDelivery }), finished);
  assert.match(select(finished).text, /Актуальный результат/);
  assert.doesNotMatch(select(finished).text, /Результат a/);
});

test('outstanding questions block completion and invalidate a reservation until resolved', () => {
  let state = reduce(reserve(ready()), { type: 'pending', id: 'a', pending: true });
  assert.equal(state.delivery, undefined);
  assert.equal(select(state), null);
  assert.equal(reduce(state, { type: 'pending', id: 'unknown', pending: false }), state);
  state = reduce(state, { type: 'pending', id: 'a', pending: false });
  assert.ok(select(state));
  assert.equal(reduce(state, { type: 'pending', id: 'a', pending: false }), state);
});

test('failed and interrupted outcomes are explicit and missing final text is reported honestly', () => {
  let state = start(start(enable([member('a'), member('b'), member('c')]), 'a'), 'b');
  state = start(state, 'c');
  state = complete(state, 'a', { status: 'failed', result: undefined, error: 'Проверка не прошла' });
  state = complete(state, 'b', { status: 'interrupted', result: undefined });
  state = complete(state, 'c', { result: undefined });
  const text = select(state).text;
  assert.match(text, /Агент A — Ошибка/);
  assert.match(text, /Проверка не прошла/);
  assert.match(text, /Агент B — Остановлен/);
  assert.match(text, /Итоговый отчёт не получен/);
  assert.doesNotMatch(text, /Агент A — Завершён/);
});

test('explicit exclusion is visible, clears that member pending flag and never sends for an all-excluded roster', () => {
  let state = complete(start(enable([member('a'), member('b', { pending: true })]), 'a'), 'a');
  state = reduce(state, { type: 'exclude', id: 'b' });
  assert.equal(state.members[1].pending, false);
  assert.match(select(state).text, /Агент B — Исключён из раунда/);
  assert.equal(reduce(state, { type: 'exclude', id: 'b' }), state);
  state = reduce(state, { type: 'exclude', id: 'a' });
  assert.equal(select(state), null);
});

test('disabling cancels only a reservation and preserves uncertain and sent identities', () => {
  const waiting = reduce(reserve(ready()), { type: 'disable' });
  assert.equal(waiting.enabled, false);
  assert.equal(waiting.delivery, undefined);
  assert.equal(select(waiting), null);
  for (const state of [commit(reserve(ready())), acknowledge(commit(reserve(ready())))]) {
    const disabled = reduce(state, { type: 'disable' });
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.delivery, state.delivery);
  }
  const uncertain = reduce(commit(reserve(ready())), { type: 'disable' });
  assert.equal(reduce(uncertain, { type: 'enable', roundId: 'unsafe-retry', members: [] }), uncertain);
});

test('select, reservation and commit are stable and idempotent across duplicate calls', () => {
  const state = ready(), selected = select(state);
  assert.deepEqual(select(state), selected);
  assert.equal(reduce(state, { type: 'reserve', delivery: { ...selected, id: 'other' } }), state);
  assert.equal(reduce(state, { type: 'reserve', delivery: { ...selected, revision: selected.revision - 1 } }), state);
  const reserved = reserve(state);
  assert.equal(reduce(reserved, { type: 'reserve', delivery: selected }), reserved);
  assert.equal(select(reserved), null);
  assert.equal(reduce(reserved, { type: 'commit', id: 'other' }), reserved);
  const committed = commit(reserved);
  assert.equal(commit(committed), committed);
  assert.equal(select(committed), null);
  assert.equal(reduce(committed, { type: 'receipt', id: 'other', accepted: true }), committed);
  const sent = acknowledge(committed);
  assert.deepEqual(acknowledge(sent), sent);
  assert.equal(select(sent), null);
});

test('temporary release keeps auto enabled and the same completed round eligible; persistence errors stop it', () => {
  const reserved = reserve(ready());
  const released = reduce(reserved, { type: 'release', id: reserved.delivery.id });
  assert.equal(released.enabled, true);
  assert.deepEqual(select(released), reserved.delivery);
  const stopped = reduce(reserved, { type: 'release', id: reserved.delivery.id, notice: 'Не удалось сохранить' });
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.delivery, undefined);
  assert.equal(stopped.notice, 'Не удалось сохранить');
  const uncertain = commit(reserved);
  assert.equal(reduce(uncertain, { type: 'release', id: uncertain.delivery.id }), uncertain);
});

test('pure restoration disables auto and freezes a saved reservation as uncertain without changing its source', () => {
  const reserved = reserve(ready());
  const serialized = JSON.stringify(reserved);
  const restored = restoreExecutorAutoReview(JSON.parse(serialized));
  assert.equal(restored.enabled, false);
  assert.equal(restored.delivery.status, 'uncertain');
  assert.equal(restored.delivery.id, reserved.delivery.id);
  assert.equal(restored.delivery.text, reserved.delivery.text);
  assert.equal(select(restored), null);
  assert.equal(JSON.stringify(reserved), serialized);
  assert.equal(restoreExecutorAutoReview(acknowledge(commit(reserved))).delivery.status, 'sent');
});

test('a child can finish the next round while the previous delivery is uncertain, then one ACK unlocks it', () => {
  let state = complete(complete(start(start(enable([member('a'), member('b')]), 'a'), 'b'), 'a'), 'b');
  state = commit(reserve(state));
  const frozen = structuredClone(state.delivery);
  state = start(state, 'a', 'a-next', 'round-2');
  assert.equal(state.roundId, 'round-2');
  assert.deepEqual(state.members.map(m => m.id), ['a'], 'Old participants without a new assignment do not block the next round');
  assert.deepEqual(state.delivery, frozen);
  state = complete(state, 'a', { turnId: 'a-next', result: 'Следующий результат' });
  assert.equal(select(state), null, 'Uncertain old RPC must be reconciled first');
  state = acknowledge(state);
  const next = select(state);
  assert.equal(next.id, 'round-2');
  assert.match(next.text, /Следующий результат/);
  assert.doesNotMatch(next.text, /Результат b/);
  state = reserve(state);
  assert.equal(reduce(state, { type: 'receipt', id: frozen.id, accepted: true }), state, 'Late ACK cannot overwrite the next reservation');
});

test('new participants enter the current unreserved round, duplicates do not, and completed reports remain after peers change', () => {
  const original = ready();
  let state = reduce(original, { type: 'member', member: member('b') });
  assert.equal(select(state), null);
  assert.equal(state.members[0].result, 'Результат a');
  assert.equal(reduce(state, { type: 'member', member: member('b') }), state);
  assert.equal(reduce(state, { type: 'member', member: member('new-session-a', { threadId: 'a-thread' }) }), state);
  state = complete(start(state, 'b'), 'b');
  assert.ok(select(state));
  assert.equal(original.members.length, 1, 'Reducer does not mutate old snapshots');
});

test('unknown delivery outcome never retries automatically; a confirmed rejection clears only its delivery', () => {
  const uncertain = commit(reserve(ready()));
  const unknown = reduce(uncertain, { type: 'receipt', id: uncertain.delivery.id, accepted: false });
  assert.equal(unknown.enabled, false);
  assert.equal(unknown.delivery.status, 'uncertain');
  assert.equal(select(unknown), null);
  const rejected = reduce(unknown, { type: 'receipt', id: uncertain.delivery.id, accepted: false, rejected: true });
  assert.equal(rejected.enabled, false);
  assert.equal(rejected.delivery, undefined);
  assert.equal(rejected.members[0].result, 'Результат a');
});

test('parent keys isolate provider, project and thread while normalizing Windows folder spelling', () => {
  assert.equal(reviewParentKey(parent), reviewParentKey({ ...parent, cwd: 'e:\\FIXTURE\\' }));
  for (const alternative of [{ provider: 'claude' }, { cwd: 'E:/other' }, { threadId: 'another-parent' }]) {
    assert.notEqual(reviewParentKey(parent), reviewParentKey({ ...parent, ...alternative }));
  }
});

test('formatted reports clearly disclose shortening and stay within the durable message size budget', () => {
  const state = enable(Array.from({ length: 100 }, (_, i) => member(`m${i}`, {
    threadId: `thread-${i}`, turnId: `turn-${i}`, label: 'А'.repeat(256), status: 'failed', result: 'Р'.repeat(100_000), error: 'О'.repeat(4000),
  })));
  const text = formatExecutorReviewMessage(state);
  assert.match(text, /Отчёт сокращён/);
  assert.ok(text.length <= 2_000_000, `Formatted summary has ${text.length} characters; persistence limit is 2000000`);
  assert.match(text, /Проверь результаты/);
  assert.equal(select(state).text, text);
});
