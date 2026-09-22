import type { Item, TurnWork } from './types';

export type ExportFormat = 'markdown' | 'html';
export type ExportScope = 'conversation' | 'work';
export type ConversationExportFile = { filename: string; content: string; format: ExportFormat };
export type ExportBlock = { kind: 'text' | 'markdown' | 'code'; text: string; language?: string };
export type ExportEntry = { id: string; label: string; turnId?: string; blocks: ExportBlock[] };
export type ExportInfo = { title: string; provider: string; cwd: string; partial: boolean; busy: boolean; scope: ExportScope; turnWork: Record<string, TurnWork> };

const labels: Record<string, string> = { commandExecution: 'Команда', fileChange: 'Изменения файлов', webSearch: 'Поиск', mcpToolCall: 'MCP', dynamicToolCall: 'Инструмент', collabAgentToolCall: 'Подагент', subAgentActivity: 'Подагент', imageView: 'Просмотр изображения', imageGeneration: 'Создание изображения', functionCallOutput: 'Результат инструмента', enteredReviewMode: 'Начало проверки', exitedReviewMode: 'Завершение проверки', contextCompaction: 'Сжатие контекста', sleep: 'Ожидание' };
const string = (value: unknown) => typeof value === 'string' ? value : '';

/** Keep the same explicit public tool fields as the work log; never serialize the entire event. */
function publicText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, (key, part) => ['encrypted_content', 'encryptedContent', 'hookPrompt'].includes(key) || ['encrypted_content', 'hookPrompt'].includes(part?.type) ? undefined : part, 2) || '';
}

export function exportEntries(items: Item[], scope: ExportScope, provider: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const item of items) {
    const blocks: ExportBlock[] = [];
    const add = (kind: ExportBlock['kind'], text: unknown, language?: string) => { if (typeof text === 'string' && text.length) blocks.push({ kind, text, ...(language ? { language } : {}) }); };
    let label = '';
    if (item.type === 'hookPrompt') continue;
    if (item.type === 'userMessage') {
      label = 'Вы';
      const content = Array.isArray(item.content) ? item.content : [];
      add('text', content.filter(part => part.type === 'text').map(part => string(part.text)).join('\n'));
      const images = content.filter(part => ['image', 'localImage'].includes(part.type));
      for (let index = 0; index < images.length; index++) add('text', `[Изображение: ${string(images[index].path) || string(item.previews?.[index]?.name) || 'вложение'}]`);
    } else if (item.type === 'agentMessage') {
      if (scope === 'conversation' && item.phase === 'commentary') continue;
      label = item.phase === 'commentary' ? `${provider} · Комментарий` : provider;
      add('markdown', item.text);
    } else {
      if (scope === 'conversation') continue;
      if (item.type === 'reasoning') {
        label = `${provider} · Пояснения`;
        const parts = (value: unknown) => Array.isArray(value) ? value.filter(part => typeof part === 'string').join('\n\n').trim() : '';
        add('markdown', parts(item.summary) || parts(item.content));
      } else if (item.type === 'plan') { label = 'План'; add('markdown', item.text); }
      else {
        label = labels[item.type] || 'Действие';
        if (item.tool) label += ` · ${string(item.tool)}`;
        if (item.status) add('text', `Состояние: ${string(item.status)}`);
        add('code', item.command, 'shell');
        for (const [key, caption] of [['cwd', 'Папка'], ['query', 'Запрос'], ['path', 'Файл'], ['savedPath', 'Сохранено'], ['agentPath', 'Агент'], ['agentThreadId', 'Диалог агента'], ['model', 'Модель'], ['reasoningEffort', 'Усилие']]) if (item[key]) add('text', `${caption}: ${string(item[key])}`);
        if (Array.isArray(item.receiverThreadIds)) add('text', `Диалоги агентов: ${item.receiverThreadIds.filter((part: unknown) => typeof part === 'string').join(', ')}`);
        if (Array.isArray(item.changes)) for (const change of item.changes) { add('text', change.path); add('code', change.diff, 'diff'); }
        for (const key of ['prompt', 'review', 'revisedPrompt']) add('markdown', item[key]);
        for (const [key, caption] of [['arguments', 'Параметры'], ['aggregatedOutput', 'Вывод'], ['output', 'Вывод'], ['result', 'Результат'], ['results', 'Результаты'], ['contentItems', 'Содержимое'], ['agentsStates', 'Состояния агентов'], ['error', 'Ошибка'], ['failure', 'Ошибка']]) {
          const value = publicText(item[key]);
          if (value) { add('text', caption); add('code', value); }
        }
        if (item.exitCode != null) add('text', `Код выхода: ${item.exitCode}`);
        if (typeof item.durationMs === 'number') add('text', `Длительность: ${(item.durationMs / 1000).toFixed(1)} с`);
      }
    }
    if (blocks.length || label === 'Действие') entries.push({ id: item.id, label, turnId: item.turnId, blocks });
  }
  return entries;
}

export function exportFilename(title: string, format: ExportFormat) {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[.\s]+$/g, '').trim().slice(0, 100) || 'Беседа';
  const name = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `Беседа-${cleaned}` : cleaned;
  return `${name}.${format === 'html' ? 'html' : 'md'}`;
}

export function fencedText(text: string, language = '') {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
const heading = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#]/g, '\\$&');

export function exportNotes(info: ExportInfo) {
  return [
    `Агент: ${info.provider}`, `Рабочая папка: ${info.cwd}`,
    `Состав: ${info.scope === 'work' ? 'переписка и ход работы' : 'переписка'}`,
    ...(info.partial ? ['Экспортирован загруженный фрагмент. Более ранние сообщения не включены.'] : []),
    ...(info.busy ? ['Снимок во время работы: текущий ответ может быть неполным.'] : []),
    'Вложения обозначены именами или путями; файлы изображений не включены.',
  ];
}

export function entryTiming(entry: ExportEntry, info: ExportInfo) {
  const turn = entry.turnId ? info.turnWork[entry.turnId] : undefined;
  if (!turn) return '';
  const parts: string[] = [];
  if (typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt) && !Number.isNaN(new Date(turn.startedAt).getTime())) parts.push(new Date(turn.startedAt).toISOString());
  if (turn.status && turn.status !== 'unknown') parts.push(turn.status);
  if (typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs)) parts.push(`${(turn.durationMs / 1000).toFixed(1)} с`);
  return parts.join(' · ');
}

export function exportMarkdown(entries: ExportEntry[], info: ExportInfo) {
  const sections = [`# ${heading(info.title || 'Беседа')}`, exportNotes(info).map(note => `> ${heading(note)}`).join('\n>\n')];
  let lastTurn: string | undefined;
  for (const entry of entries) {
    sections.push(`## ${heading(entry.label)}`);
    if (entry.turnId !== lastTurn) { const timing = entryTiming(entry, info); if (timing) sections.push(`_${heading(timing)}_`); lastTurn = entry.turnId; }
    for (const block of entry.blocks) sections.push(block.kind === 'markdown' ? block.text : fencedText(block.text, block.language));
  }
  return sections.join('\n\n') + '\n';
}
