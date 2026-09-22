import assert from 'node:assert/strict';
import test from 'node:test';
import { taskResults } from '../src/task-result.ts';

const answer = (turnId = 'turn', id = 'answer') => ({ id, turnId, type: 'agentMessage', phase: 'final_answer', text: 'Всё готово, проверки прошли.' });
const command = (properties = {}) => ({ id: 'command', turnId: 'turn', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, ...properties });
const completed = { turn: { id: 'turn', status: 'completed' } };

test('results require a recorded completed turn and a visible answer', () => {
  for (const status of [undefined, 'unknown', 'inProgress', 'interrupted', 'failed', 'disconnected']) {
    assert.equal(taskResults([command({ complete: true }), answer()], status ? { turn: { id: 'turn', status } } : {}).size, 0);
  }
  assert.equal(taskResults([command()], completed).size, 0);
  assert.equal(taskResults([command(), { ...answer(), phase: 'commentary' }], completed).size, 0);
  assert.equal(taskResults([command(), { ...answer(), text: '  ' }], completed).size, 0);
  assert.equal(taskResults([answer()], completed).size, 0, 'No empty result for a text-only conversation');
  assert.equal(taskResults([command(), answer()], completed).size, 1);
});

test('one result follows the last visible answer; turn-less and foreign events stay excluded', () => {
  const items = [answer('turn', 'early'), command(), command({ id: 'unassigned', turnId: undefined }), command({ id: 'other', turnId: 'other' }), { ...answer(), phase: undefined }];
  const results = taskResults(items, completed);
  assert.deepEqual([...results.keys()], ['answer']);
  assert.deepEqual(results.get('answer').commands.map(item => item.itemId), ['command']);
  assert.equal(taskResults([{ ...command(), turnId: undefined }, answer()], completed).size, 0);
});

test('commands retain observed exit codes, failures and unknown outcomes without interpreting prose', () => {
  const commands = taskResults([
    command(), command({ id: 'failed', exitCode: 2 }), command({ id: 'declined', status: 'declined', exitCode: undefined }),
    command({ id: 'unknown', status: undefined, exitCode: undefined, complete: true }), answer(),
  ], completed).get('answer').commands;
  assert.equal(commands[0].status, 'Завершена · Код выхода: 0');
  assert.equal(commands[0].failed, false);
  assert.equal(commands[1].failed, true);
  assert.equal(commands[1].status, 'Завершена · Код выхода: 2');
  assert.equal(commands[2].status, 'Отклонена');
  assert.equal(commands[3].status, 'Результат не указан');
  assert.ok(commands.every(item => !item.status.includes('проверки')));
});

test('file events preserve repeated changes, rename destination and failed operations', () => {
  const file = (id, status, kind) => ({ id, turnId: 'turn', type: 'fileChange', status, changes: [{ path: 'docs/Результат.md', kind }] });
  const files = taskResults([
    file('create', 'completed', { type: 'add' }), file('edit', 'completed', { type: 'update' }),
    file('move', 'completed', { type: 'update', move_path: 'docs/Итог.md' }),
    file('failed-move', 'failed', { type: 'update', movePath: 'docs/Нет.md' }),
    file('unknown', undefined, { type: 'add' }), answer(),
  ], completed).get('answer').files;
  assert.equal(files.length, 5);
  assert.deepEqual(files.map(item => item.label), ['Добавлен', 'Изменён', 'Переименован', 'Ошибка изменения', 'Результат не указан']);
  assert.equal(files[2].path, 'docs/Итог.md');
  assert.equal(files[2].originalPath, 'docs/Результат.md');
  assert.equal(files[3].path, 'docs/Результат.md');
  assert.equal(files[3].failed, true);
  assert.deepEqual(files.map(item => item.itemId), ['create', 'edit', 'move', 'failed-move', 'unknown']);
});

test('saved image artifacts use only an explicit completed event and public savedPath', () => {
  const files = taskResults([
    { id: 'image', turnId: 'turn', type: 'imageGeneration', status: 'completed', savedPath: 'output/result.png' },
    { id: 'failed', turnId: 'turn', type: 'imageGeneration', status: 'failed', savedPath: 'output/missing.png' },
    { id: 'in-text', turnId: 'turn', type: 'agentMessage', text: 'Создал output/claimed.png' },
    answer(),
  ], completed).get('answer').files;
  assert.deepEqual(files, [{ key: 'image', itemId: 'image', path: 'output/result.png', label: 'Изображение', failed: false }]);
});
