import { useEffect, useRef, useState } from 'react';
import { RelayApi, RelayApiError } from './api';
import type { CommandResponse, CommandSummary, SendCommandInput, TabSummary } from './types';

export interface TabCommandsProps {
  api: RelayApi; installationId: string; tab: TabSummary;
  installationOnline: boolean; serverError?: Error | null;
}
type Work = 'send' | 'state' | 'stop' | 'answer' | 'status';
type Operation = { controller: AbortController; key: string; generation: number };
type StopConfirmation = { turnId: string; title: string };
type Answer = { text: string; truncated: boolean };
const terminal = (command: CommandSummary) => command.status === 'executed' || command.status === 'rejected';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function detailMessage(code?: string): string {
  switch (code) {
    case 'stale_turn': case 'stale_target': return 'Ход уже изменился на компьютере. Запросите состояние и подтвердите остановку заново.';
    case 'blocked': case 'busy': case 'queue_full': return 'Вкладка занята или требует действия на компьютере. Команда отклонена.';
    case 'unknown_tab': case 'access_denied': return 'Доступ к этой вкладке больше не разрешён на компьютере.';
    case 'not_connected': return 'Компьютер сейчас не подключён. Команда не отправлена.';
    case 'commands_unsupported': return 'Обновите Кузьмича на компьютере для работы с командами.';
    case 'rate_limited': case 'too_many_reads': return 'Слишком много запросов. Попробуйте немного позже.';
    case 'command_conflict': case 'request_conflict': return 'Этот запрос уже связан с другой командой. Проверьте её статус.';
    case 'command_not_found': return 'Команда пока не найдена. Можно повторить проверку её статуса.';
    case 'invalid_command': return 'Проверьте текст команды: служебные команды с / здесь не поддерживаются.';
    case 'expired': return 'Срок команды истёк до выполнения.';
    case 'persistence_failed': return 'Не удалось сохранить команду на компьютере. Требуется проверка на ПК.';
    case 'command_payload_key_required': return 'Сервер пока не настроен для приёма команд. Обратитесь к администратору сервера.';
    case 'unavailable': case 'not_found': return 'Беседа сейчас недоступна. Проверьте её на компьютере.';
    default: return 'Команда отклонена. Проверьте состояние на компьютере.';
  }
}
function commandLabel(command: CommandSummary): string {
  if (command.status === null) return 'Ожидаем подтверждения компьютера';
  if (command.status === 'queued') return 'Принято компьютером, ожидает выполнения';
  if (command.status === 'accepted') return 'Компьютер принял команду';
  if (command.status === 'uncertain') return 'Требуется проверка на компьютере';
  if (command.status === 'executed') return command.outcome === 'interrupted' ? 'Остановлено' : command.outcome === 'failed' ? 'Выполнение завершилось ошибкой' : 'Выполнено';
  return detailMessage(command.detail?.code);
}
function errorMessage(error: unknown): string {
  if (error instanceof RelayApiError) {
    if (['session_expired', 'invalid_init_data', 'expired_init_data', 'telegram_init_data_missing'].includes(error.code)) return 'Откройте приложение заново из Telegram.';
    return detailMessage(error.code);
  }
  return 'Нет подтверждения доставки. Проверьте статус этой команды; телефон повторно её не отправляет.';
}
function newer(current: CommandSummary | null, incoming: CommandSummary): CommandSummary | null {
  if (!current || current.commandId !== incoming.commandId) return current;
  if (terminal(current)) return current;
  if (current.status !== null && incoming.status === null) return current;
  return incoming;
}

export function TabCommands({ api, installationId, tab, installationOnline, serverError }: TabCommandsProps) {
  const [text, setText] = useState('');
  const [command, setCommand] = useState<CommandSummary | null>(null);
  const [automaticStatus, setAutomaticStatus] = useState(true);
  const [working, setWorking] = useState<Work | ''>('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [stop, setStop] = useState<StopConfirmation | null>(null);
  const [answer, setAnswer] = useState<Answer | null | undefined>(undefined);
  const mounted = useRef(false), generation = useRef(0), polling = useRef(false), statusGeneration = useRef(0);
  const busy = useRef<Operation | null>(null);
  const trackedId = useRef<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const key = `${installationId}:${tab.tab_id}`;
  const disabled = !installationOnline || Boolean(serverError);
  const latest = useRef({ key, disabled });
  latest.current = { key, disabled };

  function cancelRequests() {
    generation.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear(); busy.current = null;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelRequests(); };
  }, []);
  useEffect(() => {
    cancelRequests(); trackedId.current = null; setWorking(''); setCommand(null); setStop(null); setAnswer(undefined); setText(''); setActionError(null);
  }, [key]);
  useEffect(() => {
    if (disabled || tab.status === 'unavailable' || tab.status === 'ambiguous' || tab.status === 'unknown') {
      cancelRequests(); setWorking(''); setStop(null); setAnswer(undefined);
    } else if (tab.status === 'idle') setStop(null);
  }, [disabled, tab.status]);

  const valid = (op: Operation, requireOnline = true) => mounted.current && !op.controller.signal.aborted &&
    op.key === latest.current.key && op.generation === generation.current && (!requireOnline || !latest.current.disabled);
  function begin(kind: Work): Operation | undefined {
    if (busy.current || (kind !== 'status' && latest.current.disabled)) return;
    const op = { controller: new AbortController(), key: latest.current.key, generation: generation.current };
    controllers.current.add(op.controller); busy.current = op; setWorking(kind); setActionError(null);
    return op;
  }
  function end(op: Operation) {
    controllers.current.delete(op.controller);
    if (busy.current === op) { busy.current = null; if (mounted.current) setWorking(''); }
  }
  function apply(incoming: CommandSummary) { setCommand(current => newer(current, incoming)); }
  function clearPrivateOnAuthError(error: unknown) {
    if (error instanceof RelayApiError && (error.status === 401 || error.status === 403 || error.code === 'unknown_tab')) {
      setAnswer(undefined); setStop(null);
    }
  }
  useEffect(() => api.subscribeCommands((id, incoming) => {
    if (!mounted.current || id !== installationId || incoming.tabId !== tab.tab_id || incoming.commandId !== trackedId.current) return;
    statusGeneration.current++; apply(incoming);
  }), [api, installationId, tab.tab_id]);

  // GET is status-only. A null receipt must also wait for the first bridge ACK.
  useEffect(() => {
    if (!command || !automaticStatus || disabled || terminal(command) || command.status === 'uncertain') return;
    const controller = new AbortController(); controllers.current.add(controller);
    const op = { controller, key, generation: generation.current };
    const timer = window.setInterval(() => {
      if (polling.current || !valid(op)) return;
      polling.current = true;
      const observed = statusGeneration.current;
      void api.getCommand(installationId, command.commandId, controller.signal).then(next => {
        if (valid(op) && observed === statusGeneration.current) apply(next);
      }).catch(error => { if (valid(op)) clearPrivateOnAuthError(error); })
        .finally(() => { polling.current = false; });
    }, 4000);
    return () => { window.clearInterval(timer); controller.abort(); controllers.current.delete(controller); };
  }, [api, command?.commandId, command?.status, automaticStatus, disabled, installationId, key]);

  function pending(request: SendCommandInput) {
    const now = new Date().toISOString();
    trackedId.current = request.commandId;
    setAutomaticStatus(true);
    setCommand({ commandId: request.commandId, tabId: request.tabId, action: request.action, status: null, outcome: null,
      dispatchState: 'delivery_unknown', detail: null, createdAt: now, updatedAt: now });
  }
  const input = (action: SendCommandInput['action'], extra: Partial<SendCommandInput> = {}): SendCommandInput => ({
    commandId: crypto.randomUUID(), tabId: tab.tab_id, action, ...extra
  });
  const successfulRead = (response: CommandResponse, request: SendCommandInput) => response.command.commandId === request.commandId &&
    response.command.tabId === request.tabId && response.command.status === 'executed' && response.command.outcome === 'succeeded';

  async function perform(kind: Exclude<Work, 'status'>, request: SendCommandInput, consume?: (response: CommandResponse) => void) {
    const op = begin(kind); if (!op) return;
    pending(request); setAnswer(undefined);
    if (kind === 'send') setText('');
    const observed = statusGeneration.current;
    try {
      const response = await api.sendCommand(installationId, request, op.controller.signal);
      if (!valid(op)) return;
      if (observed === statusGeneration.current) apply(response.command);
      consume?.(response);
    } catch (error) {
      if (valid(op)) {
        if (error instanceof RelayApiError && error.status && error.status < 500) setAutomaticStatus(false);
        clearPrivateOnAuthError(error); setActionError(errorMessage(error));
      }
    } finally { end(op); }
  }
  function submitSend() {
    if (busy.current || disabled || !text.trim() || text.length > 32000 || text.trimStart().startsWith('/') || tab.status !== 'idle') return;
    void perform('send', input('send', { text }));
  }
  function fetchStateForStop() {
    if (busy.current || disabled) return;
    setStop(null);
    const request = input('get_state');
    void perform('state', request, response => {
      const state = record(response.payload) && record(response.payload.state) ? response.payload.state : null;
      if (!successfulRead(response, request) || !state || state.tabId !== tab.tab_id || !record(state.actions) ||
        state.actions.stop !== true || typeof state.activeTurnId !== 'string' || !state.activeTurnId || state.status === 'unavailable') {
        setActionError('Не получен свежий активный ход для остановки. Запросите состояние ещё раз.'); return;
      }
      setStop({ turnId: state.activeTurnId, title: typeof state.title === 'string' ? state.title : tab.name });
    });
  }
  function submitStop() {
    if (!stop || busy.current || disabled) return;
    const request = input('stop', { expectedTurnId: stop.turnId });
    setStop(null);
    void perform('stop', request);
  }
  function fetchLastAnswer() {
    if (busy.current || disabled) return;
    const request = input('get_last_answer');
    void perform('answer', request, response => {
      if (!successfulRead(response, request) || !record(response.payload) || !Object.prototype.hasOwnProperty.call(response.payload, 'answer')) {
        setActionError('Ответ не получен в этом запросе. Запросите последний ответ ещё раз.'); return;
      }
      const value = response.payload.answer;
      if (value === null) setAnswer(null);
      else if (record(value) && typeof value.text === 'string' && typeof value.truncated === 'boolean') setAnswer({ text: value.text, truncated: value.truncated });
      else setActionError('Компьютер вернул неподдерживаемый формат ответа.');
    });
  }
  async function refreshCommand() {
    if (!command || polling.current) return;
    const op = begin('status'); if (!op) return;
    polling.current = true;
    const observed = statusGeneration.current;
    try {
      const next = await api.getCommand(installationId, command.commandId, op.controller.signal);
      if (valid(op, false) && observed === statusGeneration.current) apply(next);
    } catch (error) { if (valid(op, false)) { clearPrivateOnAuthError(error); setActionError(errorMessage(error)); } }
    finally { polling.current = false; end(op); }
  }

  const commandBusy = Boolean(working);
  const tabBusy = tab.status === 'running' || tab.status === 'blocked';
  const controlId = `${installationId}-${tab.tab_id}`;
  return <div className="tab-commands">
    <label className="command-label" htmlFor={`command-${controlId}`}>Отправить текст</label>
    <textarea id={`command-${controlId}`} className="command-input" value={text} maxLength={32000}
      onChange={event => setText(event.target.value)} disabled={disabled || commandBusy}
      placeholder={disabled ? 'Компьютер не подключён' : 'Сообщение для этой вкладки'} rows={3} />
    {text.trimStart().startsWith('/') && <p className="command-hint command-error">Slash-команды здесь не отправляются.</p>}
    {text.length > 30000 && <p className="command-hint">Осталось {32000 - text.length} символов.</p>}
    <div className="command-actions">
      <button type="button" className="button button-primary" disabled={disabled || commandBusy || tab.status !== 'idle' || !text.trim() || text.trimStart().startsWith('/')}
        aria-describedby={tabBusy ? `busy-${controlId}` : undefined}
        onClick={submitSend}>{working === 'send' ? 'Отправляем…' : 'Отправить'}</button>
      <button type="button" className="button button-danger" disabled={disabled || commandBusy}
        onClick={fetchStateForStop}>{working === 'state' ? 'Проверяем ход…' : 'Остановить'}</button>
      <button type="button" className="button button-secondary" disabled={disabled || commandBusy}
        onClick={fetchLastAnswer}>{working === 'answer' ? 'Запрашиваем…' : 'Последний ответ'}</button>
    </div>
    {tabBusy && <p id={`busy-${controlId}`} className="command-hint">Беседа занята. Отправка станет доступна, когда задача закончится.</p>}
    {tab.status !== 'idle' && !tabBusy && <p className="command-hint">Отправка станет доступна, когда вкладка будет готова. Остановка требует свежего подтверждения хода.</p>}
    {!installationOnline && <p className="command-hint command-error">Компьютер офлайн — команды не ставятся в очередь.</p>}
    {actionError && <p className="command-hint command-error" role="alert">{actionError}</p>}
    {stop && <div className="stop-confirm" role="dialog" aria-labelledby={`stop-${controlId}`}>
      <strong id={`stop-${controlId}`}>Остановить показанный ход?</strong>
      <span>{stop.title} · Ход: <code>{stop.turnId}</code></span>
      <div className="command-actions">
        <button type="button" className="button button-danger" disabled={commandBusy || disabled} onClick={submitStop}>Подтвердить остановку</button>
        <button type="button" className="button button-secondary" onClick={() => setStop(null)}>Отмена</button>
      </div>
    </div>}
    {command && <div className={`command-status status-${command.status ?? 'pending'}`} role="status">
      <span>{commandLabel(command)}</span><small>ID: {command.commandId}</small>
      {!terminal(command) && command.replayUnavailable && <p className="command-hint command-error">
        Не удалось восстановить доставку этой команды. Проверьте её состояние на компьютере.
      </p>}
      {!terminal(command) && <button type="button" className="text-button" disabled={commandBusy}
        onClick={() => { void refreshCommand(); }}>{working === 'status' ? 'Обновляем…' : 'Проверить этот ID'}</button>}
    </div>}
    {answer !== undefined && <div className="last-answer" role="status"><strong>Последний ответ</strong>
      <p>{answer === null ? 'Ответа пока нет.' : answer.text || 'Пустой ответ.'}</p>
      {answer?.truncated && <small>Ответ сокращён.</small>}
    </div>}
  </div>;
}
