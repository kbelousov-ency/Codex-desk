import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationEntries } from '../src/conversation-items.ts';

const user = (id, turnId = 'turn', extra = {}) => ({ id, type: 'userMessage', turnId, content: [{ type: 'text', text: id }], ...extra });
const work = (id, turnId = 'turn', extra = {}) => ({ id, type: 'reasoning', turnId, summary: [id], ...extra });
const answer = (id, turnId = 'turn', extra = {}) => ({ id, type: 'agentMessage', turnId, phase: 'final_answer', text: id, ...extra });
const layout = items => conversationEntries(items).map(entry => entry.type === 'message' ? entry.item.id : entry.items.map(item => item.id));

test('a reply to an async final question keeps subsequent work below the reply in the same turn', () => {
  const items = [user('request'), work('before'), answer('question', 'turn', { delivery: 'async' }), user('reply'), work('after'), answer('result')];
  assert.deepEqual(layout(items), ['request', ['before'], 'question', 'reply', ['after'], 'result']);
  const groups = conversationEntries(items).filter(entry => entry.type === 'work');
  assert.deepEqual(groups.map(({ turnId, hasAnswer, continued, answerItemId }) => ({ turnId, hasAnswer, continued, answerItemId })), [
    { turnId: 'turn', hasAnswer: true, continued: true, answerItemId: 'question' },
    { turnId: 'turn', hasAnswer: true, continued: false, answerItemId: 'result' },
  ]);
  assert.equal(new Set(groups.map(group => group.key)).size, 2);
});

test('ordinary steering and repeated clarifications create independent live segments', () => {
  const items = [user('request'), work('first'), user('steer'), work('second'), user('another-steer'), work('third')];
  assert.deepEqual(layout(items), ['request', ['first'], 'steer', ['second'], 'another-steer', ['third']]);
  const groups = conversationEntries(items).filter(entry => entry.type === 'work');
  assert.deepEqual(groups.map(group => [group.hasAnswer, group.continued]), [[false, true], [false, true], [false, false]]);
});

test('async and structured questions preserve the position of work before an answer arrives', () => {
  for (const extra of [{ phase: 'final_answer', delivery: 'async' }, { phase: 'commentary', questions: [{ title: 'Choose', options: ['one', 'two'] }] }]) {
    const items = [user('request'), work('first'), answer('question', 'turn', extra), work('while-waiting')];
    assert.deepEqual(layout(items), ['request', ['first'], 'question', ['while-waiting']]);
    const groups = conversationEntries(items).filter(entry => entry.type === 'work');
    assert.equal(groups[1].hasAnswer, false, 'The earlier question cannot settle later work');
  }
});

test('echo replacement keeps the segment key and older turns keep their own grouping', () => {
  const pending = [user('optimistic', 'turn', { clientId: 'submitted', optimistic: true }), work('first')];
  const before = conversationEntries(pending).find(entry => entry.type === 'work');
  const confirmed = [user('server', 'turn', { clientId: 'submitted' }), pending[1]];
  assert.equal(conversationEntries(confirmed).find(entry => entry.type === 'work').key, before.key);
  const legacyEcho = [user('server', 'turn', { localMessageId: 'submitted' }), pending[1]];
  assert.equal(conversationEntries(legacyEcho).find(entry => entry.type === 'work').key, before.key);
  assert.deepEqual(layout([...confirmed, answer('result'), user('next', 'turn-2'), work('new', 'turn-2'), work('late-old')]), [
    'server', ['first', 'late-old'], 'result', 'next', ['new'],
  ]);
});

test('legacy history, empty reasoning, hidden hooks and ordinary final answers retain their behavior', () => {
  const items = [user('old', null), work('reasoning', null), answer('unphased', null, { phase: null }), user('next', null),
    work('empty', null, { summary: ['  '], content: [] }), { id: 'hook', type: 'hookPrompt' }, work('fallback', null, { summary: [''], content: ['public'] })];
  assert.deepEqual(layout(items), ['old', ['reasoning'], 'unphased', 'next', ['fallback']]);
  const final = answer('final');
  assert.deepEqual(layout([user('request'), work('first'), final, work('late-tool')]), ['request', ['first', 'late-tool'], 'final']);
});
