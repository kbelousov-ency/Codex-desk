import { useMemo } from 'react';
import { ArrowUpRight, GitBranch, LoaderCircle } from 'lucide-react';
import type { Item } from './types';
import { collectSubagents, subagentStatus } from './subagents';
import Markdown from './Markdown';
import './subagents.css';

export default function SubagentPanel({ items, hasEarlier, loading, onLoadEarlier, onJump }: { items: Item[]; hasEarlier: boolean; loading: boolean; onLoadEarlier(): void; onJump(itemId: string): void }) {
  const tasks = useMemo(() => collectSubagents(items), [items]);
  return <div className="panel-content subagents-panel">
    {hasEarlier && <button className="text-button" disabled={loading} onClick={onLoadEarlier}>{loading ? 'Загружаем…' : 'Загрузить более ранние задачи'}</button>}
    {!tasks.length ? <div className="panel-empty"><div className="empty-icon"><GitBranch size={24} /></div><h3>Задачи подагентов</h3><p>Здесь появятся поручения, состояния и результаты подагентов этого диалога.</p></div> : tasks.map(task => <section key={task.id} className={`subagent-card ${['failed', 'errored', 'notFound'].includes(task.status) ? 'failed' : ''}`}>
      <div className="subagent-heading"><strong title={task.name}>{task.name}</strong><span className="subagent-state">{['running', 'pendingInit'].includes(task.status) && <LoaderCircle size={12} className="spin" />}{subagentStatus(task.status)}</span></div>
      {task.model && <small className="muted">{task.model}</small>}
      {task.prompt && <details className="subagent-prompt" open><summary>Задача</summary><Markdown>{task.prompt}</Markdown></details>}
      {task.error && <p className="inline-error" role="alert">{task.error}</p>}
      {task.result && task.result !== task.error && <details className="subagent-result"><summary>Результат</summary><Markdown>{task.result}</Markdown></details>}
      <button type="button" className="text-button" onClick={() => onJump(task.resultItemId || task.itemId)}><ArrowUpRight size={13} />{task.resultItemId ? 'К результату в чате' : 'К событию в чате'}</button>
    </section>)}
    <div className="panel-footnote">Последние состояния из доступной истории и событий CLI. Завершение вызова инструмента не всегда означает завершение фоновой задачи.</div>
  </div>;
}
