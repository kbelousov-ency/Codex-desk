import { useState } from 'react';
import { ArrowRight, Check, ShieldCheck, X } from 'lucide-react';
import type { Item, Request } from './types';
import { errorText } from './useCodex';
import { useAgentName } from './AgentContext';

export default function Approval({ request, items, respond }: { request: Request; items: Item[]; respond: (request: Request, result: any) => Promise<void> }) {
  const engineName = useAgentName();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const p = request.params;
  const questions = request.method === 'item/tool/requestUserInput';
  const permissions = request.method === 'item/permissions/requestApproval';
  const elicitation = request.method === 'mcpServer/elicitation/request';
  const legacy = ['applyPatchApproval', 'execCommandApproval'].includes(request.method);
  const approval = legacy || permissions || ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
  const command = request.method.includes('commandExecution') || request.method === 'execCommandApproval';
  const item = items.find(i => i.id === p.itemId);
  const submit = async (result: any) => {
    setPending(true); setError('');
    try { await respond(request, result); } catch (e) { setError(errorText(e)); } finally { setPending(false); }
  };
  const decide = (allowed: boolean) => {
    if (permissions) {
      const granted = Object.fromEntries(Object.entries(p.permissions || {}).filter(([, value]) => value !== null));
      return submit({ permissions: allowed ? granted : {}, scope: 'turn' });
    }
    if (legacy) return submit({ decision: allowed ? 'approved' : 'denied' });
    return submit({ decision: allowed ? 'accept' : 'decline' });
  };

  return <section className="approval-card">
    <div className="approval-heading"><ShieldCheck size={18} /><strong>{questions ? `${engineName} уточняет` : elicitation ? 'Запрос от подключения' : 'Нужно ваше решение'}</strong><span>{p.isBlocking === false ? 'Можно ответить позже' : 'Ожидает ответа'}</span></div>
    {questions ? <form onSubmit={e => {
      e.preventDefault();
      void submit({ answers: Object.fromEntries((p.questions || []).map((q: any) => [q.id, { answers: answers[q.id]?.trim() ? [answers[q.id].trim()] : [] }])) });
    }}>
      {(p.questions || []).map((q: any) => <fieldset key={q.id} disabled={pending}>
        <legend>{q.question}</legend>
        {q.options?.map((option: any) => <label className={`question-option ${answers[q.id] === option.label ? 'selected' : ''}`} key={option.label}>
          <input type="radio" name={q.id} value={option.label} checked={answers[q.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [q.id]: option.label }))} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        {(!q.options?.length || q.isOther) && <input className="text-input" type={q.isSecret ? 'password' : 'text'} placeholder={q.options?.length ? 'Или свой ответ…' : 'Ваш ответ…'} value={q.options?.some((o: any) => o.label === answers[q.id]) ? '' : answers[q.id] || ''} onChange={e => setAnswers(previous => ({ ...previous, [q.id]: e.target.value }))} autoComplete="off" />}
      </fieldset>)}
      <div className="approval-actions"><button className="text-button" type="button" disabled={pending} onClick={() => void submit({ answers: {} })}>Пропустить</button><button className="primary-button" disabled={pending} type="submit">Ответить <ArrowRight size={15} /></button></div>
    </form> : elicitation ? <>
      <p>{p.message}</p>
      {p.url && <p className="muted break-word">{p.url}</p>}
      <p className="muted">Это подключение запрашивает дополнительные данные. Формы подключений пока не поддерживаются.</p>
      <button className="secondary-button" disabled={pending} onClick={() => void submit({ action: 'decline', content: null, _meta: null })}>Отклонить запрос</button>
    </> : !approval ? <>
      <p>Этот запрос пока не поддерживается оболочкой: <code>{request.method}</code>.</p>
      {request.method === 'item/tool/call' ? <button className="secondary-button" disabled={pending} onClick={() => void submit({ success: false, contentItems: [{ type: 'inputText', text: 'This client does not implement the requested dynamic tool.' }] })}>Сообщить {engineName}</button> : <p className="muted">Остановите выполнение кнопкой под сообщением. Если запрос связан с аккаунтом, войдите через {engineName} CLI и переподключитесь.</p>}
    </> : <>
      <p>{p.reason || (command ? 'Разрешить выполнение этой команды?' : permissions ? 'Разрешить дополнительный доступ для текущего запроса?' : 'Разрешить изменения файлов?')}</p>
      {(p.command || item?.command) && <pre className="approval-code">{Array.isArray(p.command) ? p.command.join(' ') : p.command || item?.command}</pre>}
      {(p.cwd || p.grantRoot) && <div className="small-path">{p.grantRoot || p.cwd}</div>}
      {item?.changes?.map((change: any) => <div className="small-path" key={change.path}>{change.path}</div>)}
      {permissions && <pre className="approval-code">{JSON.stringify(p.permissions, null, 2)}</pre>}
      <div className="approval-actions"><button className="secondary-button" disabled={pending} onClick={() => void decide(false)}><X size={15} /> Отклонить</button><button className="primary-button" disabled={pending} onClick={() => void decide(true)}><Check size={15} /> Разрешить один раз</button></div>
    </>}
    {error && <p className="inline-error">{error}</p>}
  </section>;
}
