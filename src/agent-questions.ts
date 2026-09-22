import type { Item } from './types';

export type AgentQuestion = { title: string; options: string[] };

/** Only structured questions from the agent are interactive; Markdown lists stay text. */
export function agentQuestions(item: Item): AgentQuestion[] {
  if (item.type !== 'agentMessage' || !Array.isArray(item.questions)) return [];
  return item.questions.filter((question: any) => typeof question?.title === 'string' && question.title.trim()).map((question: any) => ({
    title: question.title,
    options: Array.isArray(question.options) ? question.options.filter((option: unknown): option is string => typeof option === 'string' && !!option.trim()) : [],
  }));
}

export function questionAnswer(questions: AgentQuestion[], answers: string[]): string {
  if (questions.length === 1) return answers[0]?.trim() || '';
  return questions.map((question, index) => `${question.title}\n${answers[index]?.trim() || ''}`).join('\n\n');
}

export function canAnswerQuestion(items: Item[], item: Item): boolean {
  if (!agentQuestions(item).length) return false;
  const index = items.findIndex(candidate => candidate.id === item.id);
  return index >= 0 && !items.slice(index + 1).some(candidate => candidate.type === 'userMessage' && !candidate.optimistic);
}
