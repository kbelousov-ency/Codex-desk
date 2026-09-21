import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, X } from 'lucide-react';
import type { AgentProvider, Item } from './types';
import { buildAgentHandoff, MAX_AGENT_HANDOFF_CHARACTERS } from './agent-handoff';
import './agent-handoff.css';

type AgentHandoffProps = {
  sourceProvider: AgentProvider;
  cwd: string;
  title: string;
  threadId: string;
  initialTask: string;
  blocked: boolean;
  loadHistory(): Promise<Item[]>;
  onCreate(targetProvider: AgentProvider, text: string): Promise<boolean>;
  onClose(): void;
};

const providerName = (provider: AgentProvider) => provider === 'claude' ? 'Claude Code' : 'Codex';
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function AgentHandoff({ sourceProvider, cwd, title, threadId, initialTask, blocked, loadHistory, onCreate, onClose }: AgentHandoffProps) {
  const targetProvider: AgentProvider = sourceProvider === 'claude' ? 'codex' : 'claude';
  const targetName = providerName(targetProvider);
  const ids = useId();
  const [task, setTask] = useState(initialTask || 'Продолжи выполнение задачи с учётом переданного контекста.');
  const [scope, setScope] = useState<'conversation' | 'work'>('work');
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [createError, setCreateError] = useState('');
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState('');
  const [edited, setEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const alive = useRef(false);
  const creatingRef = useRef(false);
  const latest = useRef({ loadHistory, onClose });
  latest.current = { loadHistory, onClose };

  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!creatingRef.current) latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])]
        .filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (!dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', listener, true);
    return () => {
      alive.current = false;
      document.removeEventListener('keydown', listener, true);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setLoadError('');
    setItems(null);
    void Promise.resolve().then(() => canceled ? null : latest.current.loadHistory()).then(history => {
      if (!canceled && history) setItems(history);
    }).catch(cause => {
      if (!canceled) setLoadError(errorMessage(cause));
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => { canceled = true; };
  }, [retry, threadId, sourceProvider]);

  const context = useMemo(() => items === null ? null : buildAgentHandoff({ items, sourceProvider, targetProvider, cwd, title, threadId, task, scope }), [items, sourceProvider, targetProvider, cwd, title, threadId, task, scope]);
  useEffect(() => {
    if (context && !edited) setPreview(context.text);
  }, [context, edited]);

  const tooLarge = preview.length > MAX_AGENT_HANDOFF_CHARACTERS;
  const contextError = context?.blockedCode && context.blockedCode !== 'size' ? context.blockedReason : '';
  const canCreate = !creating && !loading && !loadError && !blocked && !!context && !contextError && !tooLarge && !!preview.trim();
  const create = async () => {
    if (!canCreate || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError('');
    try {
      const created = await onCreate(targetProvider, preview);
      if (!alive.current) return;
      if (created) latest.current.onClose();
      else setCreateError('Черновик не создан. Повторите попытку.');
    } catch (cause) {
      if (alive.current) setCreateError(errorMessage(cause));
    } finally {
      creatingRef.current = false;
      if (alive.current) setCreating(false);
    }
  };

  return createPortal(<div className="handoff-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !creatingRef.current) onClose();
  }}><section ref={dialog} className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-description`} aria-busy={loading || creating} tabIndex={-1}>
    <header className="handoff-header">
      <h2 id={`${ids}-title`}><ArrowRightLeft size={19} aria-hidden="true" />Передать задачу другому агенту</h2>
      <button type="button" aria-label="Закрыть передачу задачи" disabled={creating} onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="handoff-body">
      <p className="handoff-route">{providerName(sourceProvider)} <span aria-hidden="true">→</span><span className="handoff-sr-only">передаёт задачу в</span> <strong>{targetName}</strong></p>
      <p id={`${ids}-description`} className="handoff-hint">Откроется новая вкладка с черновиком в той же папке. Проверьте текст и отправьте его обычной кнопкой в чате. Настройки принимающего агента сохраняются.</p>
      <dl className="handoff-details"><div><dt>Диалог</dt><dd>{title || 'Беседа'}</dd></div><div><dt>Папка</dt><dd>{cwd || 'Не указана'}</dd></div></dl>
      <label className="handoff-field" htmlFor={`${ids}-task`}>Задача для {targetName}</label>
      <textarea id={`${ids}-task`} className="handoff-task" rows={3} value={task} disabled={creating} onChange={event => setTask(event.target.value)} />
      <fieldset className="handoff-scope" disabled={creating}><legend>Контекст</legend>
        <label><input type="radio" name={`${ids}-scope`} checked={scope === 'conversation'} onChange={() => setScope('conversation')} />Переписка</label>
        <label><input type="radio" name={`${ids}-scope`} checked={scope === 'work'} onChange={() => setScope('work')} />Переписка и ход работы</label>
      </fieldset>
      <p className="handoff-hint">История читается целиком без обращения к модели. Изображения и другие вложения передаются именами и ссылками; нужные бинарные файлы приложите в новом диалоге повторно. Неотправленные вложения исходного черновика также нужно приложить заново.</p>
      {blocked && <p className="handoff-warning" role="status">Передача станет доступна, когда исходный агент подключится и завершит работу.</p>}
      {loading && <p className="handoff-hint" role="status">Загрузка полной истории…</p>}
      {loadError && <div className="handoff-load-error"><p className="handoff-error" role="alert">Не удалось загрузить полную историю: {loadError}</p><button type="button" disabled={creating} onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button></div>}
      {context && <>
        <div className="handoff-preview-heading"><label className="handoff-field" htmlFor={`${ids}-preview`}>Сообщение для нового диалога</label>{edited && <span className="handoff-edited">Изменено вручную</span>}</div>
        {edited && <div className="handoff-refresh"><p className="handoff-hint" id={`${ids}-refresh-help`}>Изменения задачи и состава контекста не заменяют ваши правки. «Обновить текст» заново соберёт сообщение и заменит ручные изменения. В черновик попадёт текст из поля ниже.</p><button type="button" disabled={creating} aria-describedby={`${ids}-refresh-help`} onClick={() => { setPreview(context.text); setEdited(false); }}>Обновить текст</button></div>}
        <textarea id={`${ids}-preview`} className="handoff-preview" rows={14} value={preview} disabled={creating} spellCheck={false} aria-describedby={`${ids}-count`} onChange={event => { setPreview(event.target.value); setEdited(true); setCreateError(''); }} />
        <p className="handoff-count" id={`${ids}-count`}>{preview.length.toLocaleString('ru-RU')} / {MAX_AGENT_HANDOFF_CHARACTERS.toLocaleString('ru-RU')} символов · Записей в исходном контексте: {context.entryCount} · Вложений: {context.attachmentCount}</p>
        {tooLarge && <p className="handoff-error" role="alert">Сообщение превышает {MAX_AGENT_HANDOFF_CHARACTERS.toLocaleString('ru-RU')} символов. Выберите «Переписка» или сократите текст вручную. Контекст не обрезается автоматически.</p>}
        {contextError && <p className="handoff-error" role="alert">{contextError}</p>}
      </>}
      {createError && <p className="handoff-error" role="alert">{createError}</p>}
    </div>
    <footer className="handoff-footer"><button type="button" disabled={creating} onClick={onClose}>Отмена</button><button type="button" className="handoff-create" disabled={!canCreate} onClick={() => void create()}>{creating ? 'Создание черновика…' : `Создать черновик в ${targetName}`}</button></footer>
  </section></div>, document.body);
}
