import { useAgentName } from './AgentContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Columns2, FileCode2, Rows3, X } from 'lucide-react';
import { parseDiff, toUnifiedRows } from './diff-model';
import type { DiffSide } from './diff-model';
import type { FileEdit } from './change-utils';
import { changeStatus } from './change-utils';
import './diff-review.css';

export function ReviewDiff({ text, mode = 'unified', expanded = false, beforeLabel = 'До', afterLabel = 'После' }: { text: string; mode?: 'unified' | 'split'; expanded?: boolean; beforeLabel?: string; afterLabel?: string }) {
  const parsed = useMemo(() => parseDiff(text), [text]);
  const rows = useMemo(() => mode === 'split' ? parsed.rows : toUnifiedRows(parsed.rows), [parsed, mode]);
  const side = (value: DiffSide | undefined) => <><span className="diff-line-number" aria-hidden="true">{value?.line ?? ''}</span><code className="review-code-text">{value?.text || (value ? ' ' : '')}</code></>;
  let previousHunk: number | undefined;
  return <div className={`review-diff ${mode} ${expanded ? 'expanded' : ''}`}>
    {!parsed.hasLineNumbers && <p className="diff-number-note">Номера строк в этой правке не предоставлены или не могут быть определены.</p>}
    {mode === 'split' && <div className="diff-column-headings"><span>{beforeLabel}</span><span>{afterLabel}</span></div>}
    <div className="review-diff-lines" tabIndex={0} aria-label={mode === 'split' ? 'Сравнение до и после' : 'Diff с номерами строк'}>
      {rows.map((row, index) => {
        const start = row.hunk !== undefined && row.hunk !== previousHunk;
        previousHunk = row.hunk;
        const anchor = start ? { 'data-diff-hunk': row.hunk, tabIndex: -1 } : {};
        if (row.kind === 'meta') return <div key={index} className={`review-meta ${start ? 'diff-hunk' : ''}`} {...anchor}>{row.meta || ' '}</div>;
        if (mode === 'split') return <div className="diff-split-row" key={index} {...anchor}>
          <div className={`diff-side ${row.before?.kind || 'empty'}`}>{side(row.before)}</div>
          <div className={`diff-side ${row.after?.kind || 'empty'}`}>{side(row.after)}</div>
        </div>;
        const lines = row.kind === 'context' ? [{ before: row.before, after: row.after, value: row.before || row.after }]
          : [...(row.before ? [{ before: row.before, after: undefined, value: row.before }] : []), ...(row.after ? [{ before: undefined, after: row.after, value: row.after }] : [])];
        return <div key={index} {...anchor}>{lines.map((line, offset) => <div key={offset} className={`diff-unified-row ${line.value?.kind || 'context'}`}>
          <span className="diff-line-number" aria-label={line.before?.line !== undefined ? `До: строка ${line.before.line}` : undefined}>{line.before?.line ?? ''}</span>
          <span className="diff-line-number" aria-label={line.after?.line !== undefined ? `После: строка ${line.after.line}` : undefined}>{line.after?.line ?? ''}</span>
          <span className="diff-sign" aria-hidden="true">{line.value?.kind === 'add' ? '+' : line.value?.kind === 'remove' ? '−' : ' '}</span><code className="review-code-text">{line.value?.text || ' '}</code>
        </div>)}</div>;
      })}
    </div>
  </div>;
}

export type ReviewSelection = { title: string; path?: string; edits: FileEdit[]; source?: 'git'; description?: string; message?: string; beforeLabel?: string; afterLabel?: string };

export function DiffReview({ selection, onClose, onOpen }: { selection: ReviewSelection; onClose(): void; onOpen(path: string): Promise<void> }) {
  const engineName = useAgentName();
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  const [fragment, setFragment] = useState(-1);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const total = useMemo(() => selection.edits.reduce((count, edit) => count + new Set(parseDiff(edit.diff).rows.flatMap(row => row.hunk !== undefined ? [row.hunk] : [])).size, 0), [selection.edits]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])];
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const move = (direction: number) => {
    const nodes = [...(container.current?.querySelectorAll<HTMLElement>('[data-diff-hunk]') || [])];
    if (!nodes.length || !container.current) return;
    const next = fragment < 0 ? direction > 0 ? 0 : nodes.length - 1 : (fragment + direction + nodes.length) % nodes.length;
    const node = nodes[next];
    container.current.scrollTop += node.getBoundingClientRect().top - container.current.getBoundingClientRect().top - 8;
    setFragment(next);
    node.focus({ preventScroll: true });
  };
  return createPortal(<div className="diff-review-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="diff-review-modal" role="dialog" aria-modal="true" aria-label="Просмотр изменений">
      <header className="diff-review-header"><FileCode2 size={19} /><div><small>ПРОСМОТР ИЗМЕНЕНИЙ</small><h2>{selection.title}</h2></div><button ref={closeRef} type="button" className="icon-button" aria-label="Закрыть просмотр изменений" onClick={onClose}><X size={19} /></button></header>
      <div className="diff-review-toolbar">
        <div className="diff-mode-buttons" role="group" aria-label="Вид сравнения"><button type="button" aria-pressed={mode === 'split'} onClick={() => { setMode('split'); setFragment(-1); }}><Columns2 size={14} />До / после</button><button type="button" aria-pressed={mode === 'unified'} onClick={() => { setMode('unified'); setFragment(-1); }}><Rows3 size={14} />Единый diff</button></div>
        <div className="diff-fragment-nav"><span aria-live="polite">{total ? `${fragment < 0 ? '—' : fragment + 1} / ${total}` : 'Нет фрагментов'}</span><button type="button" className="icon-button" aria-label="Предыдущий фрагмент" disabled={!total} onClick={() => move(-1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label="Следующий фрагмент" disabled={!total} onClick={() => move(1)}><ArrowDown size={15} /></button></div>
        {selection.path && <button type="button" className="text-button" onClick={() => { setError(''); void onOpen(selection.path!).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>Открыть файл</button>}
      </div>
      {error && <div className="diff-review-error" role="alert">{error}</div>}
      {selection.message && <div className="diff-review-message" role="status">{selection.message}</div>}
      <div ref={container} className="diff-review-body">{selection.edits.map((edit, index) => <section key={edit.key} className="diff-review-patch">
        <div className="diff-review-patch-title"><strong>{selection.source === 'git' ? selection.description || 'Git' : `Правка ${index + 1}`}</strong><span>{changeStatus(edit)}</span></div>
        {edit.diff ? <ReviewDiff text={edit.diff} mode={mode} expanded beforeLabel={selection.beforeLabel} afterLabel={selection.afterLabel} /> : <p className="diff-number-note">{selection.source === 'git' ? selection.message || 'Текстовых изменений нет.' : `Diff не предоставлен ${engineName}.`}</p>}
      </section>)}</div>
      <footer className="diff-review-footer">{selection.source === 'git' ? 'Снимок Git на момент открытия. Изменение файлов после чтения отразится при следующем открытии сравнения.' : 'Полученные правки из диалога. Показаны изменённые фрагменты; файл на диске мог измениться позже.'}</footer>
    </section>
  </div>, document.body);
}
