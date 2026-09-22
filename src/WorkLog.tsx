import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brain, ChevronRight, ChevronUp, FileCode2, GitBranch, Globe, Image, Layers, ListChecks, LoaderCircle, MessageSquare, Timer, Terminal } from 'lucide-react';
import type { Item, TurnWork } from './types';
import Markdown from './Markdown';
import { activityLabel, Diff } from './Panels';
import { availableReasoning, workDuration } from './conversation-items';
import { useBridge } from './BridgeContext';
import { useAgentName } from './AgentContext';

const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled', 'disconnected']);

export default function WorkLog({ turnId, items, turn, hasAnswer, continued, answerItemId, searchable = false }: { turnId: string; items: Item[]; turn?: TurnWork; hasAnswer: boolean; continued: boolean; answerItemId?: string; searchable?: boolean }) {
  const terminal = turn && turn.status !== 'unknown' ? terminalStatuses.has(turn.status) : items.every(item => item.complete);
  // A previous async question may have final_answer in the same running turn.
  // Only the answer belonging to this segment can settle its new activity.
  const settled = terminal || hasAnswer || continued;
  const [open, setOpen] = useState(!settled);
  const [now, setNow] = useState(Date.now);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const manualCollapse = useRef(false);
  const collapse = () => { manualCollapse.current = true; setOpen(false); };
  useLayoutEffect(() => {
    if (open || !manualCollapse.current) return;
    manualCollapse.current = false;
    const summary = summaryRef.current;
    const scroller = detailsRef.current?.closest<HTMLElement>('.chat-scroll');
    if (!summary || !scroller) return;
    summary.focus({ preventScroll: true });
    const header = summary.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (header.top < viewport.top || header.bottom > viewport.bottom) {
      scroller.scrollTop += header.top - viewport.top - 4;
    }
  }, [open]);
  useEffect(() => { setOpen(!settled); }, [settled]);
  useEffect(() => {
    if (settled || turn?.startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [settled, turn?.startedAt]);
  const answerStartedAt = hasAnswer && (!turn?.answerItemId || turn.answerItemId === answerItemId) ? turn?.answerStartedAt : undefined;
  const end = turn?.completedAt ?? answerStartedAt ?? (!settled ? now : undefined);
  // Timing belongs to the whole server turn, not to individual clarifications.
  // Show it once, on the last segment, without inventing per-segment durations.
  const duration = continued ? undefined : turn?.durationMs ?? (turn?.startedAt != null && end != null ? Math.max(0, end - turn.startedAt) : undefined);
  const suffix = turn?.status === 'failed' ? 'Ошибка' : turn?.status === 'disconnected' ? 'Связь прервана' : ['interrupted', 'cancelled', 'canceled'].includes(turn?.status || '') ? 'Остановлено' : '';
  const label = duration != null ? `${settled ? 'Работал' : 'Работает'} ${workDuration(duration)}` : 'Ход работы';
  return <details ref={detailsRef} className={`work-log ${settled ? 'settled' : 'running'}`} data-turn-id={turnId} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary ref={summaryRef} className="work-log-summary" onClick={event => {
      if (open) { event.preventDefault(); collapse(); }
    }}><span>{label}{suffix && ` · ${suffix}`}</span>{!settled && <LoaderCircle size={12} className="spin" />}<ChevronRight size={14} className="disclosure-arrow" />{open && <span className="work-log-collapse-hint">Свернуть</span>}</summary>
    <div className="work-log-body">{items.map(item => <WorkItem key={item.id} item={item} running={!terminal} searchable={searchable} />)}
      <button type="button" className="work-log-collapse" aria-label="Свернуть ход работы" onClick={collapse}><ChevronUp size={13} />Свернуть ход работы</button>
    </div>
  </details>;
}

function WorkItem({ item, running, searchable }: { item: Item; running: boolean; searchable: boolean }) {
  const engineName = useAgentName();
  if (item.type === 'reasoning') return <div className="work-log-row work-reasoning" data-item-id={item.id}><Brain size={14} aria-label={`Пояснения ${engineName}`} /><Markdown>{availableReasoning(item)}</Markdown></div>;
  if (item.type === 'agentMessage') return <div className="work-log-row work-commentary" data-item-id={item.id}><MessageSquare size={14} aria-label={`Комментарий ${engineName}`} /><Markdown>{item.text || ''}</Markdown></div>;
  if (item.type === 'plan') return <div className="work-log-row work-plan" data-item-id={item.id}><ListChecks size={14} aria-label="План" /><Markdown>{item.text || ''}</Markdown></div>;
  return <ToolRow item={item} allowRunning={running} searchable={searchable} />;
}

function itemLabel(item: Item) {
  const kind = item.kind === 'started' ? 'приступил к работе' : item.kind === 'completed' ? 'завершил работу' : item.kind === 'interrupted' ? 'остановлен' : item.kind === 'interacted' ? 'получил сообщение' : '';
  if (item.type === 'subAgentActivity') return `${activityLabel(item)}${kind ? ` · ${kind}` : ''}`;
  if (item.type === 'imageGeneration') return 'Создание изображения';
  if (item.type === 'sleep') return `Ожидание${typeof item.durationMs === 'number' ? ` · ${workDuration(item.durationMs)}` : ''}`;
  if (item.type === 'enteredReviewMode') return 'Начало проверки';
  if (item.type === 'exitedReviewMode') return 'Завершение проверки';
  if (item.type === 'functionCallOutput') return `Результат: ${item.name || 'инструмент'}`;
  return activityLabel(item) || item.tool || 'Действие';
}

// Only explicit, public tool fields are rendered; encrypted content and hook prompts stay untouched.
function publicText(value: any): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, (key, part) => key === 'encrypted_content' || part?.type === 'encrypted_content' ? undefined : part, 2) || '';
}

function ToolRow({ item, allowRunning, searchable }: { item: Item; allowRunning: boolean; searchable: boolean }) {
  const [open, setOpen] = useState(false);
  const running = allowRunning && !item.complete && (!item.status || ['inProgress', 'running', 'pending'].includes(item.status));
  const failed = ['failed', 'declined'].includes(item.status) || (item.exitCode != null && item.exitCode !== 0) || item.success === false;
  const Icon = item.type === 'commandExecution' ? Terminal : item.type === 'fileChange' ? FileCode2 : item.type === 'webSearch' ? Globe : item.type.includes('Agent') ? GitBranch : ['imageView', 'imageGeneration'].includes(item.type) ? Image : item.type === 'sleep' ? Timer : Layers;
  const label = itemLabel(item);
  return <details className={`work-log-row work-tool ${failed ? 'failed' : ''}`} data-item-id={item.id} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon size={14} /><span className="work-tool-label" data-tooltip={label}>{label}</span>{running ? <LoaderCircle size={12} className="spin" /> : failed && <span className="work-tool-status">Ошибка</span>}<ChevronRight size={12} className="disclosure-arrow" /></summary>
    {(open || searchable) && <div className="work-tool-body">
      {item.command && <pre className="work-output work-command" tabIndex={0}>{item.command}</pre>}
      {item.cwd && <div className="work-meta">Папка: {item.cwd}</div>}
      {item.query && <p>{item.query}</p>}
      {item.path && <WorkFile path={item.path} />}
      {item.savedPath && <WorkFile path={item.savedPath} />}
      {item.agentPath && <div className="work-meta">Агент: {item.agentPath}</div>}
      {item.agentThreadId && <div className="work-meta">Диалог агента: {item.agentThreadId}</div>}
      {item.receiverThreadIds?.length > 0 && <div className="work-meta">Диалоги агентов: {item.receiverThreadIds.join(', ')}</div>}
      {item.model && <div className="work-meta">Модель: {item.model}{item.reasoningEffort && ` · ${item.reasoningEffort}`}</div>}
      {item.changes?.map((change: any, index: number) => <div className="work-file-change" key={`${change.path}-${index}`}><WorkFile path={change.path} />{change.diff && <Diff text={change.diff} />}</div>)}
      {item.prompt && <Markdown>{item.prompt}</Markdown>}
      {item.review && <Markdown>{item.review}</Markdown>}
      {item.revisedPrompt && <Markdown>{item.revisedPrompt}</Markdown>}
      {item.arguments != null && <div className="work-detail"><span>Параметры</span><pre className="work-output" tabIndex={0}>{publicText(item.arguments)}</pre></div>}
      {item.aggregatedOutput && <pre className="work-output" tabIndex={0}>{item.aggregatedOutput}</pre>}
      {item.output != null && <pre className="work-output" tabIndex={0}>{publicText(item.output)}</pre>}
      {item.result != null && <pre className="work-output" tabIndex={0}>{publicText(item.result)}</pre>}
      {item.results != null && <pre className="work-output" tabIndex={0}>{publicText(item.results)}</pre>}
      {item.contentItems != null && <pre className="work-output" tabIndex={0}>{publicText(item.contentItems)}</pre>}
      {item.agentsStates != null && <pre className="work-output" tabIndex={0}>{publicText(item.agentsStates)}</pre>}
      {item.error && <div className="inline-error">{publicText(item.error)}</div>}
      {item.failure && <div className="inline-error">{publicText(item.failure)}</div>}
      {item.exitCode != null && <div className="work-meta">Код выхода: {item.exitCode}{item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)} с`}</div>}
    </div>}
  </details>;
}

function WorkFile({ path }: { path: string }) {
  const bridge = useBridge();
  const [error, setError] = useState('');
  const open = async (menu = false) => {
    setError('');
    try { if (menu) await bridge.showPathMenu(path); else await bridge.openPath(path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <><button className="work-file-link" data-tooltip={path} onClick={() => void open()} onContextMenu={event => { event.preventDefault(); void open(true); }}>{path}</button>{error && <div className="inline-error" role="alert">{error}</div>}</>;
}
