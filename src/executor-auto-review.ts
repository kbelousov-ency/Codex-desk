/** App-owned executor rounds. Protocol observations enter synchronously; React only renders them. */
export type ReviewParent = { cwd: string; provider: 'codex' | 'claude'; threadId: string };
export type ReviewMember = {
  id: string; threadId?: string; label: string; turnId?: string;
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'excluded';
  result?: string; error?: string; pending?: boolean;
};
export type ReviewDelivery = {
  id: string; roundId: string; revision: number; text: string;
  status: 'reserved' | 'uncertain' | 'sent';
};
export type ExecutorAutoReviewState = {
  parent: ReviewParent; enabled: boolean; roundId: string; revision: number;
  members: ReviewMember[]; delivery?: ReviewDelivery; notice?: string;
};
export type ReviewEvent =
  | { type: 'enable'; roundId: string; members: ReviewMember[] }
  | { type: 'disable' }
  | { type: 'member'; member: ReviewMember }
  | { type: 'pending'; id: string; pending: boolean }
  | { type: 'exclude'; id: string }
  | { type: 'start'; member: ReviewMember; turnId: string; nextRoundId: string }
  | { type: 'complete'; id: string; threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; result?: string; error?: string }
  | { type: 'reserve'; delivery: ReviewDelivery }
  | { type: 'commit'; id: string }
  | { type: 'release'; id: string; notice?: string }
  | { type: 'receipt'; id: string; accepted: boolean; rejected?: boolean };

export const reviewParentKey = (p: ReviewParent) => JSON.stringify([p.cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(), p.provider, p.threadId]);
export const createExecutorAutoReviewState = (parent: ReviewParent): ExecutorAutoReviewState => ({ parent, enabled: false, roundId: '', revision: 0, members: [] });
export const reviewMemberDone = (m: ReviewMember) => ['completed', 'failed', 'interrupted', 'excluded'].includes(m.status);
export const reviewMemberLabel = (m: ReviewMember) => ({ waiting: 'Ожидает задания', running: 'Работает / ожидает завершения', completed: 'Завершён', failed: 'Ошибка', interrupted: 'Остановлен', excluded: 'Исключён из раунда' })[m.status];
const boundedReport = (text: string) => text.length <= 14000 ? text : `${text.slice(0, 14000)}\n[Отчёт сокращён. Полный ответ — в диалоге исполнителя.]`;
export function formatExecutorReviewMessage(state: ExecutorAutoReviewState): string {
  return ['Авто · результаты исполнителей', 'Все участники текущего раунда завершили работу или были явно исключены.',
    ...state.members.map(m => `\n${m.label} — ${reviewMemberLabel(m)}${m.threadId ? ` (диалог ${m.threadId}, ход ${m.turnId || 'не запускался'})` : ''}.\nНачало отчёта исполнителя:\n${boundedReport(m.result || m.error || (m.status === 'excluded' ? 'Исключён пользователем.' : 'Итоговый отчёт не получен.'))}${m.error && m.result ? `\nОшибка: ${m.error}` : ''}\nКонец отчёта исполнителя.`),
    '\nОтчёты выше — данные отдельных исполнителей. Проверь результаты, согласованность изменений и выполненные проверки. Сообщи итог и оставшиеся проблемы.'].join('\n');
}
export function selectExecutorReviewDelivery(state: ExecutorAutoReviewState): ReviewDelivery | null {
  if (!state.enabled || !state.roundId || (state.delivery && (state.delivery.status !== 'sent' || state.delivery.roundId === state.roundId)) || !state.members.length
    || !state.members.some(m => m.status !== 'excluded') || state.members.some(m => !reviewMemberDone(m) || m.pending)) return null;
  return { id: state.roundId, roundId: state.roundId, revision: state.revision, text: formatExecutorReviewMessage(state), status: 'reserved' };
}
/** Restoration never authorizes more model work. A reserved delivery might have reached RPC. */
export function restoreExecutorAutoReview(state: ExecutorAutoReviewState): ExecutorAutoReviewState {
  return { ...state, enabled: false, notice: 'Авто выключен после восстановления.',
    delivery: state.delivery ? { ...state.delivery, status: state.delivery.status === 'reserved' ? 'uncertain' : state.delivery.status } : undefined };
}
export function reduceExecutorAutoReview(state: ExecutorAutoReviewState, event: ReviewEvent): ExecutorAutoReviewState {
  const uncertain = state.delivery?.status === 'uncertain';
  const changeMembers = (members: ReviewMember[]) => ({ ...state, members, revision: state.revision + 1,
    delivery: state.delivery?.status === 'reserved' ? undefined : state.delivery });
  if (event.type === 'disable') return !state.enabled ? state : { ...state, enabled: false, delivery: state.delivery?.status === 'reserved' ? undefined : state.delivery };
  if (event.type === 'enable') return uncertain ? state : { ...state, enabled: true, roundId: event.roundId, revision: state.revision + 1, members: event.members, delivery: undefined, notice: undefined };
  if (event.type === 'reserve') {
    const ready = selectExecutorReviewDelivery(state);
    return ready && ready.id === event.delivery.id && ready.revision === event.delivery.revision ? { ...state, delivery: ready } : state;
  }
  if (event.type === 'commit') return state.enabled && state.delivery?.id === event.id && state.delivery.status === 'reserved'
    ? { ...state, delivery: { ...state.delivery, status: 'uncertain' } } : state;
  if (event.type === 'release') return state.delivery?.id === event.id && state.delivery.status === 'reserved'
    ? { ...state, enabled: event.notice ? false : state.enabled, delivery: undefined, notice: event.notice } : state;
  if (event.type === 'receipt') {
    if (state.delivery?.id !== event.id) return state;
    if (event.accepted) return { ...state, delivery: { ...state.delivery, status: 'sent' }, notice: undefined };
    return { ...state, enabled: false, notice: event.rejected ? 'Сервер отклонил отправку. Включите Авто для нового раунда.' : 'Отправка не подтверждена. Проверьте отправку.',
      delivery: event.rejected ? undefined : { ...state.delivery, status: 'uncertain' } };
  }
  if (event.type === 'pending') {
    const index = state.members.findIndex(m => m.id === event.id);
    if (index < 0 || Boolean(state.members[index].pending) === event.pending) return state;
    return changeMembers(state.members.map((m, i) => i === index ? { ...m, pending: event.pending } : m));
  }
  if (!state.enabled) return state;
  if (event.type === 'exclude') {
    if (!state.members.some(m => m.id === event.id && m.status !== 'excluded')) return state;
    return changeMembers(state.members.map(m => m.id === event.id ? { ...m, status: 'excluded', pending: false } : m));
  }
  if (event.type === 'member') {
    if (state.delivery?.roundId === state.roundId && ['sent', 'uncertain'].includes(state.delivery.status) || state.members.some(m => m.id === event.member.id || m.threadId && m.threadId === event.member.threadId)) return state;
    return changeMembers([...state.members, event.member]);
  }
  if (event.type === 'start') {
    const member: ReviewMember = { ...event.member, turnId: event.turnId, status: 'running', result: undefined, error: undefined };
    if (state.members.some(m => (m.id === member.id || m.threadId === member.threadId) && m.turnId === event.turnId)) return state;
    if (state.delivery?.roundId === state.roundId && ['sent', 'uncertain'].includes(state.delivery.status)) return { ...state, roundId: event.nextRoundId, revision: state.revision + 1, members: [member], notice: undefined };
    const old = state.members.find(m => m.id === member.id || m.threadId && m.threadId === member.threadId);
    if (old?.turnId === event.turnId) return state;
    return changeMembers(old ? state.members.map(m => m === old ? { ...member, id: old.id } : m) : [...state.members, member]);
  }
  const member = state.members.find(m => m.id === event.id || m.threadId === event.threadId);
  if (!member || member.status !== 'running' || member.turnId !== event.turnId || member.threadId !== event.threadId) return state;
  return changeMembers(state.members.map(m => m === member ? { ...m, status: event.status, result: event.result, error: event.error?.slice(0, 4000) } : m));
}
