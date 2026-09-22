import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSubagents } from '../src/subagents.ts';

test('Codex tool completion does not complete agent; wait results and followups keep lifecycle', () => {
  const items = [{ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['a'], prompt: 'Проверить API', complete: true, status: 'completed', agentsStates: { a: { status: 'running', message: null } } }];
  assert.equal(collectSubagents(items)[0].status, 'running');
  items.push({ id: 'wait', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { a: { status: 'completed', message: 'Проверено' } } });
  assert.deepEqual(collectSubagents(items).map(t => [t.prompt, t.status, t.result, t.resultItemId]), [['Проверить API', 'completed', 'Проверено', 'wait']]);
  items.push({ id: 'next', type: 'collabAgentToolCall', tool: 'followupTask', receiverThreadIds: ['a'], prompt: 'Проверить UI', agentsStates: { a: { status: 'running' } } });
  assert.deepEqual(collectSubagents(items).map(t => [t.prompt, t.status, t.result, t.resultItemId]), [['Проверить UI', 'running', '', undefined]]);
});

test('agent error is not masked by generic completed activity, other agents remain isolated', () => {
  const tasks = collectSubagents([
    { id: 'x', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { a: { status: 'errored', message: 'Нет доступа' }, b: { status: 'running' } } },
    { id: 'y', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'a', agentPath: '/root/a' },
  ]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].error, 'Нет доступа');
  assert.equal(tasks[0].status, 'errored');
  assert.equal(tasks[0].name, '/root/a');
  assert.equal(tasks[1].status, 'running');
});

test('Claude foreground result and background notifications correlate without duplicates', () => {
  const tool = { id: 'call', type: 'mcpToolCall', server: 'Claude', tool: 'Agent', arguments: { description: 'Проверка', prompt: 'Проверить файлы', run_in_background: true }, complete: true, status: 'completed', result: { content: [{ type: 'text', text: 'Запущен' }] } };
  assert.equal(collectSubagents([tool])[0].status, 'unknown');
  const tasks = collectSubagents([tool, { id: 'task:bg', type: 'subAgentTask', taskId: 'bg', toolUseId: 'call', status: 'completed', result: 'Готово', description: 'Проверка' }]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].result, 'Готово');
  assert.equal(tasks[0].resultItemId, 'task:bg');
  assert.equal(tasks[0].prompt, 'Проверить файлы');
  assert.equal(collectSubagents([{ ...tool, arguments: {}, error: { message: 'Ошибка инструмента' }, status: 'failed' }])[0].status, 'failed');
});

test('unrelated MCP tools never masquerade as subagents', () => {
  assert.deepEqual(collectSubagents([{ id: 'a', type: 'mcpToolCall', server: 'Other', tool: 'Task' }, { id: 'b', type: 'userMessage' }]), []);
});

test('Claude history string tool results retain result jump and error text', () => {
  const tasks = collectSubagents([{ id: 'history-agent', type: 'mcpToolCall', server: 'Claude', tool: 'Agent', complete: true, status: 'failed', aggregatedOutput: 'Не удалось прочитать файл' }]);
  assert.equal(tasks[0].resultItemId, 'history-agent');
  assert.equal(tasks[0].error, 'Не удалось прочитать файл');
});

test('new started activity clears previous lifecycle result and errors before a second completion', () => {
  const items = [
    { id: 'old', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { a: { status: 'errored', message: 'Ошибка прежнего задания' } } },
    { id: 'start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'a' },
  ];
  const running = collectSubagents(items)[0];
  assert.deepEqual([running.status, running.error, running.result, running.resultItemId, running.itemId], ['running', '', '', undefined, 'start']);
  items.push({ id: 'end', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'a' });
  assert.equal(collectSubagents(items)[0].status, 'completed');
});

test('explicit completed state clears an old error when intermediate running state was not loaded', () => {
  const tasks = collectSubagents([
    { id: 'old', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { a: { status: 'errored', message: 'Ошибка' } } },
    { id: 'new', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { a: { status: 'completed', message: 'Исправлено' } } },
  ]);
  assert.deepEqual([tasks[0].status, tasks[0].error, tasks[0].result, tasks[0].resultItemId], ['completed', '', 'Исправлено', 'new']);
});

test('Claude public result never includes encrypted content or hook prompts', () => {
  const [task] = collectSubagents([{ id: 'call', type: 'mcpToolCall', server: 'Claude', tool: 'Agent', complete: true,
    result: { content: [{ type: 'text', text: 'Публичный результат' }, { type: 'encrypted_content', text: 'PRIVATE' }, { type: 'hookPrompt', text: 'PRIVATE' }] } }]);
  assert.equal(task.result, 'Публичный результат');
});
