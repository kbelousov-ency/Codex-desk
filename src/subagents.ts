import type { Item } from './types';

export type SubagentTask = { id: string; name: string; prompt: string; status: string; result: string; error: string; itemId: string; resultItemId?: string; threadId?: string; model?: string; outputFile?: string };
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function resultText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(resultText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (['encrypted_content', 'hookPrompt'].includes(value.type)) return '';
  return text(value.text) || text(value.message) || resultText(value.content);
}
export const subagentStatus = (status: string) => ({ pendingInit: 'Запускается', running: 'Работает', completed: 'Завершён', interrupted: 'Остановлен', stopped: 'Остановлен', errored: 'Ошибка', failed: 'Ошибка', shutdown: 'Закрыт', notFound: 'Не найден', unknown: 'Нет состояния' }[status] || status);

/** Fold only public CLI events, preserving separate tool and task lifecycles. */
export function collectSubagents(items: Item[]): SubagentTask[] {
  const tasks = new Map<string, SubagentTask>();
  const get = (id: string, item: Item) => {
    let task = tasks.get(id);
    if (!task) { task = { id, name: id, prompt: '', status: 'unknown', result: '', error: '', itemId: item.id }; tasks.set(id, task); }
    return task;
  };
  const claudeTools = new Set(items.filter(item => ['mcpToolCall', 'dynamicToolCall'].includes(item.type) && ['Agent', 'Task'].includes(item.tool) && (!item.server || item.server === 'Claude')).map(item => item.id));
  const backgroundTools = new Set(items.filter(item => item.type === 'subAgentTask').map(item => item.toolUseId).filter(Boolean));
  for (const item of items) {
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates || {};
      const ids = [...new Set<string>([...(item.receiverThreadIds || []), ...Object.keys(states)])];
      if (!ids.length && item.tool === 'spawnAgent') ids.push(`spawn:${item.id}`);
      for (const id of ids) {
        const task = get(id, item), state = states[id];
        if (!id.startsWith('spawn:')) task.threadId = id;
        if (item.prompt && (!task.prompt || ['spawnAgent', 'followupTask'].includes(item.tool))) task.prompt = item.prompt;
        if (item.model) task.model = item.model;
        if (state?.status) {
          task.status = state.status;
          if (state.status === 'completed') task.error = '';
          if (state.status === 'running' || state.status === 'pendingInit') { task.result = ''; task.error = ''; task.resultItemId = undefined; }
          if (state.message) {
            if (['errored', 'notFound'].includes(state.status)) task.error = state.message;
            else task.result = state.message;
            task.resultItemId = item.id;
          }
        } else if (id.startsWith('spawn:')) {
          task.name = 'Запуск подагента';
          task.status = item.status === 'failed' ? 'failed' : item.complete ? 'unknown' : 'pendingInit';
        }
        if (item.error) { task.error = resultText(item.error); task.resultItemId = item.id; }
      }
    } else if (item.type === 'subAgentActivity' && item.agentThreadId) {
      const task = get(item.agentThreadId, item);
      task.threadId = item.agentThreadId;
      if (item.agentPath) task.name = item.agentPath;
      if (item.kind === 'started') { task.status = 'running'; task.result = ''; task.error = ''; task.resultItemId = undefined; task.itemId = item.id; }
      else if (item.kind === 'interrupted') task.status = 'interrupted';
      else if (item.kind === 'completed' && !['errored', 'failed', 'notFound'].includes(task.status)) task.status = 'completed';
    } else if (claudeTools.has(item.id)) {
      const task = get(`claude:${item.id}`, item), args = item.arguments || {};
      task.name = text(args.description) || text(args.subagent_type) || 'Подагент Claude';
      task.prompt = text(args.prompt);
      task.model = text(args.model) || undefined;
      if (!backgroundTools.has(item.id)) {
        task.status = item.status === 'failed' || item.error ? 'failed' : !item.complete ? 'running' : args.run_in_background ? 'unknown' : 'completed';
        task.result = resultText(item.result) || text(item.aggregatedOutput);
        task.error = resultText(item.error) || (item.status === 'failed' ? task.result : '');
        if (task.result || task.error) task.resultItemId = item.id;
      }
    } else if (item.type === 'subAgentTask') {
      const task = get(item.toolUseId && claudeTools.has(item.toolUseId) ? `claude:${item.toolUseId}` : `claude-task:${item.taskId || item.id}`, item);
      if (item.description) task.name = item.description;
      task.status = item.status || 'unknown';
      task.outputFile = text(item.outputFile) || undefined;
      task.result = resultText(item.result);
      task.error = resultText(item.error) || (item.status === 'failed' ? task.result : '');
      if (task.result || task.error) task.resultItemId = item.id;
      else if (['running', 'pendingInit'].includes(task.status)) { task.resultItemId = undefined; task.itemId = item.id; }
    }
  }
  return [...tasks.values()];
}
