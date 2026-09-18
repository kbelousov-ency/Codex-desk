import type { Item } from './types';

export type ConversationEntry = { type: 'message'; key: string; item: Item } | {
  type: 'work'; key: string; turnId: string; items: Item[]; hasAnswer: boolean;
};

export function availableReasoning(item: Item) {
  const text = (parts: unknown) => Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n\n').trim() : '';
  return text(item.summary) || text(item.content);
}

function isWork(item: Item) {
  if (item.type === 'userMessage' || item.type === 'hookPrompt') return false;
  if (item.type === 'agentMessage') return item.phase === 'commentary' && !!item.text?.trim();
  if (item.type === 'reasoning') return !!availableReasoning(item);
  if (item.type === 'plan') return !!item.text?.trim();
  return true;
}

/** Keep user messages and every final/unphased answer visible, without guessing phases. */
export function conversationEntries(items: Item[]): ConversationEntry[] {
  const groups = new Map<string, { entry: Extract<ConversationEntry, { type: 'work' }>; index: number; answerIndex?: number }>();
  let fallback = 'history';
  const assigned = items.map((item, index) => {
    if (item.type === 'userMessage') fallback = item.turnId || `message-${item.id}`;
    const turnId = item.turnId || fallback;
    let group = groups.get(turnId);
    if (!group) {
      group = { entry: { type: 'work', key: `work-${turnId}`, turnId, items: [], hasAnswer: false }, index: Infinity };
      groups.set(turnId, group);
    }
    if (item.type === 'agentMessage' && item.phase !== 'commentary') {
      group.answerIndex ??= index;
      if (item.phase === 'final_answer') group.entry.hasAnswer = true;
    }
    if (isWork(item)) {
      group.entry.items.push(item);
      group.index = Math.min(group.index, index);
    }
    return { item, index };
  });
  const logsAt = new Map<number, ConversationEntry[]>();
  for (const group of groups.values()) {
    if (!group.entry.items.length) continue;
    const index = Math.min(group.index, group.answerIndex ?? Infinity);
    const entries = logsAt.get(index) || [];
    entries.push(group.entry);
    logsAt.set(index, entries);
  }
  const entries: ConversationEntry[] = [];
  for (const { item, index } of assigned) {
    entries.push(...(logsAt.get(index) || []));
    if (item.type === 'userMessage' || (item.type === 'agentMessage' && item.phase !== 'commentary')) {
      entries.push({ type: 'message', key: `message-${item.id}`, item });
    }
  }
  return entries;
}

export function workDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} ч ${Math.floor(seconds % 3600 / 60)} мин ${seconds % 60} с`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
  return `${seconds} с`;
}
