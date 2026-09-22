import { useAgentName } from './AgentContext';
import { useEffect, useMemo, useState } from 'react';
import { Brain, Check, ChevronRight, Code2, FileCode2, GitBranch, Globe, Layers, LoaderCircle, Maximize2, Terminal } from 'lucide-react';
import type { Item } from './types';
import Markdown from './Markdown';
import { folderName } from './useCodex';
import { useBridge } from './BridgeContext';
import { changeStatus, diffLines, diffLineStats, groupFileChanges, relativeChangePath } from './change-utils';
import './changes.css';
import { DiffReview, ReviewDiff, snapshotReviewSelection } from './DiffReview';
import type { ReviewSelection } from './DiffReview';
import GitPanel from './GitPanel';
import ChangeTurnPicker from './ChangeTurnPicker';

export function Diff({ text }: { text: string }) {
  return <pre className="diff-code" tabIndex={0} aria-label="Добавленные и удалённые строки">{diffLines(text).map(({ line, kind, label }, index) => <span key={index} className={`diff-line diff-${kind}`} data-tooltip={label ? line : undefined}>{label || line || ' '}{'\n'}</span>)}</pre>;
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
  if (item.type === 'subAgentTask') return 'Подагент: ' + (item.description || item.taskId);
  if (item.type === 'contextCompaction') return 'Сжатие контекста';
  if (item.type === 'imageView') return 'Просмотр: ' + folderName(item.path || '');
  return '';
}

export function Reasoning({ item }: { item: Item }) {
  const engineName = useAgentName();
  const content = reasoningText(item);
  if (!content) return null;
  return <details className="reasoning-card" open>
    <summary><Brain size={15} /><span>Пояснения {engineName}</span>{!item.complete && <LoaderCircle size={13} className="spin" />}<ChevronRight className="disclosure-arrow" size={14} /></summary>
    <div className="reasoning-body"><Markdown>{content}</Markdown></div>
  </details>;
}

export function ActivityPanel({ items, plan, busy }: { items: Item[]; plan: any[]; busy: boolean }) {
  const engineName = useAgentName();
  const activity = items.filter(i => !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(i.type));
  return <div className="panel-content">
    {plan.length > 0 && <div className="plan-card"><div className="eyebrow">ПЛАН РАБОТЫ</div>{plan.map((step, i) => <div className={`plan-step ${step.status}`} key={i}>{step.status === 'completed' ? <Check size={14} /> : step.status === 'inProgress' ? <LoaderCircle className="spin" size={14} /> : <span className="step-dot" />}<span>{step.step}</span></div>)}</div>}
    {!activity.length && !plan.length ? <div className="panel-empty"><div className="empty-icon"><Terminal size={24} /></div><h3>Работа на виду</h3><p>Здесь появятся команды, поиск и действия {engineName} в вашем проекте.</p><div className="empty-hint"><span className={`status-dot ${busy ? 'working' : ''}`} />{busy ? `${engineName} приступает к задаче` : 'Готов к первой задаче'}</div></div> : <div className="activity-list">{activity.map(item => <Activity key={item.id} item={item} />)}</div>}
    <div className="panel-footnote"><Terminal size={13} /><span>Команды, результаты и файлы поступают из текущего сеанса {engineName}.</span></div>
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
    <summary><Icon size={15} /><span data-tooltip={title}>{title}</span>{running ? <LoaderCircle size={13} className="spin" /> : <span className={`activity-status ${failed ? 'failed' : ''}`}>{failed ? 'Ошибка' : 'Готово'}</span>}<ChevronRight size={13} className="disclosure-arrow" /></summary>
    <div className="activity-body">
      {item.command && <code className="command-text">{item.command}</code>}
      {item.query && <p>{item.query}</p>}
      {item.changes?.map((change: any) => <div className="activity-file" key={change.path}><FileCode2 size={12} /><span data-tooltip={change.path}>{folderName(change.path)}</span></div>)}
      {item.prompt && <p>{item.prompt}</p>}
      {content && <pre className="command-output" tabIndex={0}>{content}</pre>}
      {item.error && <div className="inline-error">{typeof item.error === 'string' ? item.error : item.error.message}</div>}
      {item.exitCode != null && <div className="command-meta">Код выхода: {item.exitCode}{item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)} с`}</div>}
    </div>
  </details>;
}

function LineCounts({ text }: { text: string }) {
  const { added, removed } = diffLineStats(text);
  return <span className="change-line-counts" data-tooltip={`Строк в этой правке: добавлено ${added}, удалено ${removed}`}><b className="text-green">+{added}</b><b className="text-red">−{removed}</b></span>;
}

export function ChangesPanel({ items, diff, cwd = '', diffTurnId, turnDiffs = {}, active = true, hasEarlier = false, loading = false, onLoadEarlier, onReviewChange, onPinReview, onQuote, externalTurnSelection, busy = false, mutationsAllowed = true }: {
  items: Item[]; diff: string; cwd?: string; diffTurnId?: string; turnDiffs?: Record<string, string>; active?: boolean; hasEarlier?: boolean; loading?: boolean; onLoadEarlier?(): void; onReviewChange?(open: boolean): void; onPinReview?(selection: ReviewSelection): void; onQuote?(text: string): void; externalTurnSelection?: { turnId: string; key: number }; busy?: boolean; mutationsAllowed?: boolean;
}) {
  const engineName = useAgentName();
  const bridge = useBridge();
  const [error, setError] = useState('');
  const [turn, setTurn] = useState('all');
  const [query, setQuery] = useState('');
  const [review, setReview] = useState<ReviewSelection | null>(null);
  const [source, setSource] = useState<'conversation' | 'git'>('conversation');
  const turns = useMemo(() => {
    const ordered = new Map<string, string>();
    for (const item of items) {
      if (!item.turnId) continue;
      if (!ordered.has(item.turnId)) ordered.set(item.turnId, '');
      if (item.type === 'userMessage' && !ordered.get(item.turnId)) {
        const text = (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ').trim();
        ordered.set(item.turnId, text.replace(/\s+/g, ' '));
      }
    }
    for (const id of Object.keys(turnDiffs)) if (!ordered.has(id)) ordered.set(id, '');
    if (diffTurnId && !ordered.has(diffTurnId)) ordered.set(diffTurnId, '');
    return [...ordered].map(([id, text], index) => ({ id, number: index + 1, text }));
  }, [items, turnDiffs, diffTurnId]);
  const unknown = items.some(item => item.type === 'fileChange' && !item.turnId);
  const selectedItems = turn === 'all' ? items : items.filter(item => turn === 'unknown' ? !item.turnId : item.turnId === turn);
  const allFiles = groupFileChanges(items, cwd);
  const selectedFiles = groupFileChanges(selectedItems, cwd);
  const files = selectedFiles.filter(file => !query.trim() || file.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedDiff = turn === 'all' ? diff : turn === diffTurnId ? diff : turnDiffs[turn] || '';
  const showDiff = Boolean(selectedDiff && !query.trim());
  useEffect(() => { if (!active) setReview(null); }, [active]);
  useEffect(() => { if (source === 'conversation') onReviewChange?.(Boolean(review && active)); return () => { if (source === 'conversation') onReviewChange?.(false); }; }, [review, active, source, onReviewChange]);
  useEffect(() => { setReview(null); setTurn('all'); setQuery(''); }, [cwd, bridge]);
  useEffect(() => {
    if (!externalTurnSelection) return;
    setSource('conversation'); setTurn(externalTurnSelection.turnId); setQuery(''); setReview(null);
  }, [externalTurnSelection]);
  useEffect(() => { if (turn !== 'all' && turn !== 'unknown' && !turns.some(value => value.id === turn)) setTurn('all'); }, [turn, turns]);
  const openFile = async (path: string, menu = false) => {
    setError('');
    try {
      if (menu) await bridge.showPathMenu(path);
      else await bridge.openPath(path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="panel-content changes-panel">
    <div className="changes-source-tabs" role="group" aria-label="Источник изменений"><button type="button" aria-pressed={source === 'conversation'} onClick={() => { setSource('conversation'); setReview(null); }}>Из диалога</button><button type="button" aria-pressed={source === 'git'} onClick={() => { setSource('git'); setReview(null); }}><GitBranch size={13} />Git</button></div>
    {source === 'git' ? <GitPanel cwd={cwd} active={active} refreshKey={`${busy}:${items.filter(item => item.type === 'fileChange').map(item => `${item.id}:${item.status}:${item.complete}`).join('|')}`} onReviewChange={onReviewChange} onPinReview={onPinReview} onQuote={onQuote} mutationsAllowed={mutationsAllowed} /> : <>
    {error && <div className="link-error" role="alert"><span>{error}</span><button aria-label="Скрыть ошибку открытия файла" onClick={() => setError('')}>×</button></div>}
    {(allFiles.length > 0 || diff || Object.keys(turnDiffs).length > 0) && <div className="changes-filters">
      <ChangeTurnPicker value={turn} turns={turns} unknown={unknown} active={active} onChange={value => { setTurn(value); setReview(null); }} />
      <input aria-label="Найти изменённый файл" placeholder="Найти файл…" value={query} onChange={event => setQuery(event.target.value)} />
    </div>}
    {hasEarlier && <button type="button" className="text-button" disabled={loading} onClick={onLoadEarlier}>{loading ? 'Загружаем…' : 'Загрузить более ранние правки'}</button>}
    {!allFiles.length && !diff && !Object.keys(turnDiffs).length ? <div className="panel-empty"><div className="empty-icon"><Code2 size={25} /></div><h3>Изменения появятся здесь</h3><p>Следите за файлами и смотрите, какие строки добавил или удалил {engineName}.</p><div className="diff-sample"><span /><span /><span /></div></div> : <>
      {!files.length && !showDiff && <p className="changes-filter-empty">{query ? 'Файлы не найдены.' : 'Для этого запроса нет полученных правок.'}</p>}
      <div className="changes-summary"><span>{files.length ? `Файлов: ${files.length}` : 'Изменения текущего запроса'}</span>{files.length > 0 && <small>Раскройте файл, чтобы увидеть правки по порядку.</small>}</div>
      {files.map(file => {
        const last = file.edits[file.edits.length - 1];
        const repeated = file.edits.length > 1;
        const pathToOpen = last.kind?.move_path || last.kind?.movePath || file.path;
        return <details className="file-diff change-file" key={file.key}>
          <summary><FileCode2 size={15} /><span className="change-file-heading"><span className="change-path" data-tooltip={file.path}>{file.label}</span><span className="change-file-meta"><span className={`change-status ${last.status || ''}`} data-tooltip={repeated ? 'Статус последней правки этого файла' : undefined}>{changeStatus(last)}</span>{repeated ? <span>Правок: {file.edits.length}</span> : last.diff && <LineCounts text={last.diff} />}</span></span><ChevronRight size={14} className="disclosure-arrow" /></summary>
          <div className="change-file-toolbar"><button className="text-button" data-tooltip={pathToOpen} onClick={() => void openFile(pathToOpen)} onContextMenu={event => { event.preventDefault(); void openFile(pathToOpen, true); }}>Открыть файл</button><button className="text-button" onClick={() => void openFile(pathToOpen, true)}>В проводнике</button><button type="button" className="text-button expand-diff" aria-label={`Развернуть сравнение ${file.label}`} onClick={() => setReview({ title: file.label, path: pathToOpen, edits: file.edits })}><Maximize2 size={12} />Развернуть</button></div>
          {file.edits.map((edit, index) => <section className="change-patch" key={edit.key}>
            {repeated && <div className="change-patch-label"><strong>Правка {index + 1}</strong><span className={`change-status ${edit.status || ''}`}>{changeStatus(edit)}</span>{edit.diff && <LineCounts text={edit.diff} />}</div>}
            {(edit.kind?.move_path || edit.kind?.movePath) && <div className="change-move-path">Новое имя: {relativeChangePath((edit.kind.move_path || edit.kind.movePath)!, cwd)}</div>}
            {edit.diff ? <ReviewDiff text={edit.diff} /> : <p className="muted file-full-path">Diff не предоставлен {engineName}.</p>}
          </section>)}
        </details>;
      })}
      {showDiff && <details className="file-diff change-turn-diff" open={!files.length || undefined}><summary><GitBranch size={14} /><span className="change-turn-heading">{turn === 'all' ? 'Сводный diff текущего запроса' : 'Сводный diff выбранного запроса'}<LineCounts text={selectedDiff} /></span><ChevronRight size={14} className="disclosure-arrow" /></summary><button type="button" className="text-button" aria-label="Развернуть сводное сравнение" onClick={() => setReview({ title: 'Сводный diff запроса', edits: [{ key: 'summary', path: '', diff: selectedDiff }] })}><Maximize2 size={12} />Развернуть</button><ReviewDiff text={selectedDiff} /></details>}
    </>}
    <div className="panel-footnote"><GitBranch size={13} /><span>Правки из этого диалога. Счётчики +/− относятся к отдельным правкам; повторные изменения сохранены в истории файла.</span></div>
    {review && active && <DiffReview selection={review} onClose={() => setReview(null)} onOpen={path => bridge.openPath(path)} onQuote={onQuote} onToggleDock={onPinReview ? () => { onPinReview(snapshotReviewSelection(review)); setReview(null); } : undefined} />}
    </>}
  </div>;
}
