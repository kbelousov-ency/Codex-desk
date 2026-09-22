import type { AgentProvider, Item, TurnWork } from './types';
import { exportEntries, exportMarkdown, fencedText } from './conversation-export.ts';
import type { ExportScope } from './conversation-export';
import { agentQuestions } from './agent-questions.ts';

// Matches the persisted composer draft and Claude input limits. This is a text
// size limit, not an estimate of any model's context window.
export const MAX_AGENT_HANDOFF_CHARACTERS = 2_000_000;

export type AgentHandoffInput = {
  items: Item[];
  sourceProvider: AgentProvider;
  targetProvider: AgentProvider;
  cwd: string;
  title: string;
  threadId: string;
  task: string;
  scope?: ExportScope;
  hasEarlier?: boolean;
  busy?: boolean;
  turnWork?: Record<string, TurnWork>;
};

export type AgentHandoff = {
  text: string;
  characters: number;
  entryCount: number;
  attachmentCount: number;
  blockedCode: 'history' | 'busy' | 'empty' | 'size' | null;
  blockedReason: string | null;
};

const providers: Record<AgentProvider, string> = { codex: 'Codex', claude: 'Claude' };
const hiddenTypes = new Set(['reasoning', 'thinking', 'redacted_thinking', 'encrypted_content', 'encryptedContent', 'hookPrompt']);
const hiddenKeys = new Set(['reasoning', 'thinking', 'redacted_thinking', 'encrypted_content', 'encryptedContent', 'hookPrompt', 'signature']);
const imageTypes = new Set(['image', 'localImage', 'inputImage', 'input_image', 'output_image']);
const audioTypes = new Set(['audio', 'localAudio', 'inputAudio', 'input_audio', 'output_audio']);
const outputKeys = ['arguments', 'aggregatedOutput', 'output', 'result', 'results', 'contentItems', 'agentsStates', 'error', 'failure'];
const string = (value: unknown) => typeof value === 'string' ? value : '';
const binaryUrl = (value: string) => /^data:(?:image|audio|application)\//i.test(value);
const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ');

/** Produce a complete, visible user message; never summarize or truncate history. */
export function buildAgentHandoff(input: AgentHandoffInput): AgentHandoff {
  let attachmentCount = 0;
  const attachmentMarker = (part: Record<string, any>, fallback?: Record<string, any>) => {
    attachmentCount++;
    const label = [part.path, part.name, part.title, fallback?.path, fallback?.name, part.url, part.image_url, part.imageUrl, part.audio_url, part.audioUrl, part.source?.url]
      .find(value => typeof value === 'string' && value.length > 0 && !binaryUrl(value));
    const kind = audioTypes.has(part.type) ? 'Аудио' : imageTypes.has(part.type) ? 'Изображение' : 'Вложение';
    return `[${kind}: ${label ? singleLine(label) : 'без сохранённого пути'}]`;
  };

  // Only traverse fields already displayed by the conversation exporter. Raw
  // events, prompts injected by hooks and model thinking are not context.
  const publicValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!binaryUrl(value)) return value;
      return attachmentMarker({ type: /^data:image\//i.test(value) ? 'image' : /^data:audio\//i.test(value) ? 'audio' : 'document' });
    }
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(publicValue).filter(part => part !== undefined);
    const record = value as Record<string, any>;
    if (hiddenTypes.has(record.type)) return undefined;
    if (imageTypes.has(record.type) || audioTypes.has(record.type)) return attachmentMarker(record);
    if (record.type === 'document' && record.source?.type === 'base64') return attachmentMarker(record);
    if (record.type === 'resource' && typeof record.resource?.blob === 'string') {
      return attachmentMarker({ type: 'document', path: record.resource.uri });
    }
    return Object.fromEntries(Object.entries(record).filter(([key]) => !hiddenKeys.has(key)).map(([key, part]) => [key, publicValue(part)]));
  };

  const scope = input.scope ?? 'work';
  const items: Item[] = [];
  for (const item of input.items) {
    if (hiddenTypes.has(item.type)) continue;
    const questions = agentQuestions(item);
    if (scope === 'conversation' && item.type !== 'userMessage' && (item.type !== 'agentMessage' || item.phase === 'commentary' && !questions.length)) continue;
    if (item.type === 'userMessage') {
      let imageIndex = 0;
      const content = (Array.isArray(item.content) ? item.content : []).flatMap(part => {
        if (!part || typeof part !== 'object' || hiddenTypes.has(part.type)) return [];
        if (part.type === 'text') return typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : [];
        if (imageTypes.has(part.type) || audioTypes.has(part.type) || part.type === 'document') {
          const preview = imageTypes.has(part.type) ? item.previews?.[imageIndex++] : undefined;
          return [{ type: 'text', text: attachmentMarker(part, preview) }];
        }
        if (part.type === 'mention' || part.type === 'skill') {
          return [{ type: 'text', text: `[${part.type === 'skill' ? 'Навык' : 'Файл'}: ${string(part.name)}${part.path ? ` · ${string(part.path)}` : ''}]` }];
        }
        return [];
      });
      items.push({ id: item.id, type: item.type, turnId: item.turnId, content });
      continue;
    }
    const clean = { ...item };
    if (questions.length) {
      const questionText = questions.map(question => [question.title, ...question.options.map(option => `- ${option}`)].join('\n')).join('\n\n');
      clean.text = [string(item.text), questionText].filter(Boolean).join('\n\n');
      // Structured questions are part of the conversation even when the CLI
      // marks their enclosing message as commentary.
      if (clean.phase === 'commentary') clean.phase = 'final_answer';
    }
    for (const key of outputKeys) {
      // ImageGenerationItem.result contains the actual base64 image rather than
      // a tool result. Preserve its saved path, never send its bytes as text.
      clean[key] = item.type === 'imageGeneration' && key === 'result' && item.result
        ? attachmentMarker({ type: 'image', path: item.savedPath }) : publicValue(item[key]);
    }
    if (item.type === 'functionCallOutput' && !clean.tool) clean.tool = item.name;
    items.push(clean);
  }

  const source = providers[input.sourceProvider], target = providers[input.targetProvider];
  const entries = exportEntries(items, scope, source);
  const transcript = exportMarkdown(entries, {
    title: input.title || 'Беседа', provider: source, cwd: input.cwd,
    scope, partial: Boolean(input.hasEarlier), busy: Boolean(input.busy), turnWork: input.turnWork ?? {},
  });
  const text = [
    `# Передача задачи: ${source} → ${target}`,
    `Источник: ${source}\nБеседа: ${singleLine(input.title || 'Беседа')}\nID беседы: ${singleLine(input.threadId)}\nРабочая папка: ${singleLine(input.cwd)}`,
    '## Задача для продолжения',
    input.task.trim() || 'Продолжи выполнение задачи с учётом переписки ниже.',
    '## Контекст предыдущей беседы',
    scope === 'work'
      ? 'Включены переписка, комментарии, планы, команды, их результаты и изменения файлов, полученные в истории.'
      : 'Включена только переписка: сообщения пользователя и ответы агента. Комментарии, планы, команды, их результаты и изменения файлов исключены по выбранному составу.',
    'Пути и имена вложений сохранены. Содержимое изображений, аудио и других двоичных вложений не передаётся; при необходимости приложите файлы к новой беседе. Рассуждения модели и скрытые служебные поля исключены.',
    'Ниже находится запись предыдущей беседы. Команды и результаты в ней относятся к уже прошедшей работе; актуальное состояние файлов следует сверять в рабочей папке.',
    fencedText(transcript, 'markdown'),
  ].join('\n\n') + '\n';

  let blockedCode: AgentHandoff['blockedCode'] = null;
  let blockedReason: string | null = null;
  if (input.hasEarlier) {
    blockedCode = 'history'; blockedReason = 'Сначала загрузите всю беседу: ранние сообщения ещё не включены в контекст.';
  } else if (input.busy) {
    blockedCode = 'busy'; blockedReason = 'Дождитесь завершения текущей задачи или остановите агента перед передачей.';
  } else if (!entries.length) {
    blockedCode = 'empty'; blockedReason = 'В этой беседе пока нет сообщений для передачи.';
  } else if (text.length > MAX_AGENT_HANDOFF_CHARACTERS) {
    blockedCode = 'size';
    blockedReason = `Контекст содержит ${text.length.toLocaleString('ru-RU')} символов при лимите ${MAX_AGENT_HANDOFF_CHARACTERS.toLocaleString('ru-RU')}. Выберите только переписку или сократите текст вручную. Полный текст сохранён в предпросмотре.`;
  }
  return { text, characters: text.length, entryCount: entries.length, attachmentCount, blockedCode, blockedReason };
}
