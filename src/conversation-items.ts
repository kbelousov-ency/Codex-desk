import type { Item } from './types';
import { agentQuestions } from './agent-questions.ts';

export type ConversationEntry = { type: 'message'; key: string; item: Item } | {
  type: 'work'; key: string; turnId: string; items: Item[]; hasAnswer: boolean; continued: boolean; answerItemId?: string;
};

export function availableReasoning(item: Item) {
  const text = (parts: unknown) => Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n\n').trim() : '';
  return text(item.summary) || text(item.content);
}

function isWork(item: Item) {
  if (item.type === 'userMessage' || item.type === 'hookPrompt') return false;
  if (item.type === 'agentMessage') return item.phase === 'commentary' && !agentQuestions(item).length && !!item.text?.trim();
  if (item.type === 'reasoning') return !!availableReasoning(item);
  if (item.type === 'plan') return !!item.text?.trim();
  return true;
}

/** Keep user messages and every final/unphased answer visible, without guessing phases. */
export function conversationEntries(items: Item[]): ConversationEntry[] {
  type Group = { entry: Extract<ConversationEntry, { type: 'work' }>; index: number; answerIndex?: number };
  const groups: Group[] = [];
  const current = new Map<string, Group>();
  const boundaries = new Map<string, string>();
  const previous = new Map<string, Group>();
  let fallback = 'history';
  const assigned = items.map((item, index) => {
    if (item.type === 'userMessage') fallback = item.turnId || `message-${item.id}`;
    const turnId = item.turnId || fallback;
    // Steering keeps the server turn ID. Its user message starts a new visible
    // work segment, rather than sending subsequent events above the answer.
    if (item.type === 'userMessage') {
      boundaries.set(turnId, `user-${item.clientId || item.clientUserMessageId || item.localMessageId || item.id}`);
      current.delete(turnId);
    }
    let group = current.get(turnId);
    if (!group) {
      group = { entry: { type: 'work', key: `work-${turnId}-${boundaries.get(turnId) || 'start'}`, turnId, items: [], hasAnswer: false, continued: false }, index: Infinity };
      groups.push(group);
      current.set(turnId, group);
    }
    if (item.type === 'agentMessage' && (item.phase !== 'commentary' || agentQuestions(item).length)) {
      group.answerIndex ??= index;
      if (item.phase === 'final_answer') {
        group.entry.hasAnswer = true;
        group.entry.answerItemId = item.id;
      }
    }
    if (isWork(item)) {
      const earlier = previous.get(turnId);
      if (earlier && earlier !== group) earlier.entry.continued = true;
      previous.set(turnId, group);
      group.entry.items.push(item);
      group.index = Math.min(group.index, index);
    }
    // An asynchronous question can be followed by work even before its reply.
    // Keep that continuation below the question as well.
    if (item.type === 'agentMessage' && (agentQuestions(item).length || item.delivery === 'async')) {
      boundaries.set(turnId, `question-${item.id}`);
      current.delete(turnId);
    }
    return { item, index };
  });
  const logsAt = new Map<number, ConversationEntry[]>();
  for (const group of groups) {
    if (!group.entry.items.length) continue;
    const index = Math.min(group.index, group.answerIndex ?? Infinity);
    const entries = logsAt.get(index) || [];
    entries.push(group.entry);
    logsAt.set(index, entries);
  }
  const entries: ConversationEntry[] = [];
  for (const { item, index } of assigned) {
    entries.push(...(logsAt.get(index) || []));
    if (item.type === 'userMessage' || (item.type === 'agentMessage' && (item.phase !== 'commentary' || agentQuestions(item).length))) {
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
