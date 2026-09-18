import { useState } from 'react';
import { Brain, Check, ChevronRight, Code2, FileCode2, GitBranch, Globe, Layers, LoaderCircle, Terminal } from 'lucide-react';
import type { Item } from './types';
import Markdown from './Markdown';
import { folderName } from './useCodex';
import { useBridge } from './BridgeContext';
import { changeStatus, diffLines, diffLineStats, groupFileChanges, relativeChangePath } from './change-utils';
import './changes.css';

export function Diff({ text }: { text: string }) {
  return <pre className="diff-code" tabIndex={0} aria-label="Добавленные и удалённые строки">{diffLines(text).map(({ line, kind, label }, index) => <span key={index} className={`diff-line diff-${kind}`} title={label ? line : undefined}>{label || line || ' '}{'\n'}</span>)}</pre>;
}

export function reasoningText(item: Item) {
  const text = (parts: unknown) => Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n\n').trim() : '';
  return text(item.summary) || text(item.content);
}

export function activityLabel(item?: Item) {
  if (!item) return '';
  if (item.type === 'commandExecution') {
    const action = item.commandActions?.[0];
    if (action?.type === 'read') return 'Чтение: ' + (action.name || folderName(action.path || ''));
    if (action?.type === 'search') return 'Поиск: ' + (action.query || action.path || item.command);
    if (action?.type === 'listFiles') return 'Список файлов: ' + (action.path || item.cwd || '');
    return 'Команда: ' + (item.command || 'выполнение');
  }
  if (item.type === 'fileChange') return 'Изменение: ' + ((item.changes || []).map((change: any) => folderName(change.path)).join(', ') || 'файлов');
  if (item.type === 'webSearch') return 'Поиск в интернете' + (item.query ? ': ' + item.query : '');
  if (item.type === 'mcpToolCall') return item.server + ' · ' + item.tool;
  if (item.type === 'dynamicToolCall') return item.tool || 'Вызов инструмента';
  if (item.type === 'collabAgentToolCall') return 'Агенты: ' + item.tool;
  if (item.type === 'subAgentActivity') return 'Агент: ' + (item.agentPath || item.agentThreadId);
  if (item.type === 'contextCompaction') return 'Сжатие контекста';
  if (item.type === 'imageView') return 'Просмотр: ' + folderName(item.path || '');
  return '';
}

export function Reasoning({ item }: { item: Item }) {
  const content = reasoningText(item);
  if (!content) return null;
  return <details className="reasoning-card" open>
    <summary><Brain size={15} /><span>Пояснения Codex</span>{!item.complete && <LoaderCircle size={13} className="spin" />}<ChevronRight className="disclosure-arrow" size={14} /></summary>
    <div className="reasoning-body"><Markdown>{content}</Markdown></div>
  </details>;
}

export function ActivityPanel({ items, plan, busy }: { items: Item[]; plan: any[]; busy: boolean }) {
  const activity = items.filter(i => !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(i.type));
  return <div className="panel-content">
    {plan.length > 0 && <div className="plan-card"><div className="eyebrow">ПЛАН РАБОТЫ</div>{plan.map((step, i) => <div className={`plan-step ${step.status}`} key={i}>{step.status === 'completed' ? <Check size={14} /> : step.status === 'inProgress' ? <LoaderCircle className="spin" size={14} /> : <span className="step-dot" />}<span>{step.step}</span></div>)}</div>}
    {!activity.length && !plan.length ? <div className="panel-empty"><div className="empty-icon"><Terminal size={24} /></div><h3>Работа на виду</h3><p>Здесь появятся команды, поиск и действия Codex в вашем проекте.</p><div className="empty-hint"><span className={`status-dot ${busy ? 'working' : ''}`} />{busy ? 'Codex приступает к задаче' : 'Готов к первой задаче'}</div></div> : <div className="activity-list">{activity.map(item => <Activity key={item.id} item={item} />)}</div>}
    <div className="panel-footnote"><Terminal size={13} /><span>Команды, результаты и файлы поступают из текущего сеанса Codex.</span></div>
  </div>;
}

function Activity({ item }: { item: Item }) {
  const running = !item.complete && (!item.status || ['inProgress', 'running', 'pending'].includes(item.status));
  const failed = ['failed', 'declined'].includes(item.status) || (item.exitCode != null && item.exitCode !== 0);
  const type = item.type;
  const Icon = type === 'commandExecution' ? Terminal : type === 'fileChange' ? FileCode2 : type === 'webSearch' ? Globe : type.includes('Agent') ? GitBranch : Layers;
  const title = activityLabel(item) || item.tool || 'Действие';
  const content = item.aggregatedOutput || (item.result ? JSON.stringify(item.result, null, 2) : null);
  return <details className={`activity-item ${failed ? 'failed' : ''}`} open={running || undefined}>
    <summary><Icon size={15} /><span title={title}>{title}</span>{running ? <LoaderCircle size={13} className="spin" /> : <span className={`activity-status ${failed ? 'failed' : ''}`}>{failed ? 'Ошибка' : 'Готово'}</span>}<ChevronRight size={13} className="disclosure-arrow" /></summary>
    <div className="activity-body">
      {item.command && <code className="command-text">{item.command}</code>}
      {item.query && <p>{item.query}</p>}
      {item.changes?.map((change: any) => <div className="activity-file" key={change.path}><FileCode2 size={12} /><span title={change.path}>{folderName(change.path)}</span></div>)}
      {item.prompt && <p>{item.prompt}</p>}
      {content && <pre className="command-output" tabIndex={0}>{content}</pre>}
      {item.error && <div className="inline-error">{typeof item.error === 'string' ? item.error : item.error.message}</div>}
      {item.exitCode != null && <div className="command-meta">Код выхода: {item.exitCode}{item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)} с`}</div>}
    </div>
  </details>;
}

function LineCounts({ text }: { text: string }) {
  const { added, removed } = diffLineStats(text);
  return <span className="change-line-counts" title={`Строк в этой правке: добавлено ${added}, удалено ${removed}`}><b className="text-green">+{added}</b><b className="text-red">−{removed}</b></span>;
}

export function ChangesPanel({ items, diff, cwd = '' }: { items: Item[]; diff: string; cwd?: string }) {
  const bridge = useBridge();
  const [error, setError] = useState('');
  const files = groupFileChanges(items, cwd);
  const openFile = async (path: string, menu = false) => {
    setError('');
    try {
      if (menu) await bridge.showPathMenu(path);
      else await bridge.openPath(path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="panel-content changes-panel">
    {error && <div className="link-error" role="alert"><span>{error}</span><button aria-label="Скрыть ошибку открытия файла" onClick={() => setError('')}>×</button></div>}
    {!files.length && !diff ? <div className="panel-empty"><div className="empty-icon"><Code2 size={25} /></div><h3>Изменения появятся здесь</h3><p>Следите за файлами и смотрите, какие строки добавил или удалил Codex.</p><div className="diff-sample"><span /><span /><span /></div></div> : <>
      <div className="changes-summary"><span>{files.length ? `Файлов: ${files.length}` : 'Изменения текущего запроса'}</span>{files.length > 0 && <small>Раскройте файл, чтобы увидеть правки по порядку.</small>}</div>
      {files.map(file => {
        const last = file.edits[file.edits.length - 1];
        const repeated = file.edits.length > 1;
        const pathToOpen = last.kind?.move_path || last.kind?.movePath || file.path;
        return <details className="file-diff change-file" key={file.key}>
          <summary><FileCode2 size={15} /><span className="change-file-heading"><span className="change-path" title={file.path}>{file.label}</span><span className="change-file-meta"><span className={`change-status ${last.status || ''}`} title={repeated ? 'Статус последней правки этого файла' : undefined}>{changeStatus(last)}</span>{repeated ? <span>Правок: {file.edits.length}</span> : last.diff && <LineCounts text={last.diff} />}</span></span><ChevronRight size={14} className="disclosure-arrow" /></summary>
          <div className="change-file-toolbar"><button className="text-button" title={pathToOpen} onClick={() => void openFile(pathToOpen)} onContextMenu={event => { event.preventDefault(); void openFile(pathToOpen, true); }}>Открыть файл</button><button className="text-button" onClick={() => void openFile(pathToOpen, true)}>В проводнике</button></div>
          {file.edits.map((edit, index) => <section className="change-patch" key={edit.key}>
            {repeated && <div className="change-patch-label"><strong>Правка {index + 1}</strong><span className={`change-status ${edit.status || ''}`}>{changeStatus(edit)}</span>{edit.diff && <LineCounts text={edit.diff} />}</div>}
            {(edit.kind?.move_path || edit.kind?.movePath) && <div className="change-move-path">Новое имя: {relativeChangePath((edit.kind.move_path || edit.kind.movePath)!, cwd)}</div>}
            {edit.diff ? <Diff text={edit.diff} /> : <p className="muted file-full-path">Diff не предоставлен Codex.</p>}
          </section>)}
        </details>;
      })}
      {diff && <details className="file-diff change-turn-diff" open={!files.length || undefined}><summary><GitBranch size={14} /><span className="change-turn-heading">Сводный diff текущего запроса<LineCounts text={diff} /></span><ChevronRight size={14} className="disclosure-arrow" /></summary><Diff text={diff} /></details>}
    </>}
    <div className="panel-footnote"><GitBranch size={13} /><span>Правки из этого диалога. Счётчики +/− относятся к отдельным правкам; повторные изменения сохранены в истории файла.</span></div>
  </div>;
}
