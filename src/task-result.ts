import type { Item, TurnWork } from './types';

export type ResultFile = { key: string; itemId: string; path: string; originalPath?: string; label: string; failed: boolean };
export type ResultCommand = { itemId: string; command: string; status: string; failed: boolean };
export type TaskResult = { turnId: string; answerId: string; files: ResultFile[]; commands: ResultCommand[] };

function fileLabel(item: Item, change: any) {
  if (item.status === 'failed') return 'Ошибка изменения';
  if (item.status === 'declined') return 'Отклонено';
  if (item.status !== 'completed') return 'Результат не указан';
  if (change.kind?.move_path || change.kind?.movePath) return 'Переименован';
  return change.kind?.type === 'add' ? 'Добавлен' : change.kind?.type === 'delete' ? 'Удалён' : 'Изменён';
}

function commandStatus(item: Item) {
  const exit = typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) ? `Код выхода: ${item.exitCode}` : '';
  const status = ({ completed: 'Завершена', failed: 'Ошибка', declined: 'Отклонена', interrupted: 'Прервана', canceled: 'Отменена', cancelled: 'Отменена', inProgress: 'Выполняется', running: 'Выполняется', pending: 'Ожидает' } as Record<string, string>)[item.status];
  return [status, exit].filter(Boolean).join(' · ') || 'Результат не указан';
}

/** No inferred turn assignment or success based on an answer's prose. */
export function taskResults(items: Item[], turns: Record<string, TurnWork>): Map<string, TaskResult> {
  const results = new Map<string, TaskResult>();
  for (const item of items) {
    if (!item.turnId || turns[item.turnId]?.status !== 'completed') continue;
    let result = results.get(item.turnId);
    if (!result) {
      result = { turnId: item.turnId, answerId: '', files: [], commands: [] };
      results.set(item.turnId, result);
    }
    if (item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string' && item.text.trim()) result.answerId = item.id;
    if (item.type === 'commandExecution' && typeof item.command === 'string' && item.command.trim()) {
      result.commands.push({ itemId: item.id, command: item.command, status: commandStatus(item), failed: ['failed', 'declined', 'interrupted', 'cancelled', 'canceled'].includes(item.status) || (typeof item.exitCode === 'number' && item.exitCode !== 0) });
    }
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      for (const [index, change] of item.changes.entries()) {
        if (!change || typeof change.path !== 'string' || !change.path.trim()) continue;
        const moved = change.kind?.move_path || change.kind?.movePath;
        const path = item.status === 'completed' && typeof moved === 'string' && moved ? moved : change.path;
        result.files.push({ key: `${item.id}-${index}`, itemId: item.id, path, ...(path !== change.path ? { originalPath: change.path } : {}), label: fileLabel(item, change), failed: ['failed', 'declined'].includes(item.status) });
      }
    }
    if (item.type === 'imageGeneration' && item.status === 'completed' && typeof item.savedPath === 'string' && item.savedPath.trim()) {
      result.files.push({ key: item.id, itemId: item.id, path: item.savedPath, label: 'Изображение', failed: false });
    }
  }
  return new Map([...results.values()].filter(result => result.answerId && (result.files.length || result.commands.length)).map(result => [result.answerId, result]));
}
