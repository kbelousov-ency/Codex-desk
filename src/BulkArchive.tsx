import { Archive, CheckSquare, LoaderCircle, Square, X } from 'lucide-react';
import { bulkArchiveReport, bulkBlockReason, bulkScopeKey, conversationCount, keepSelectable, sameBulkScope, selectableIds } from './bulk-archive';
import type { BulkBlocked, BulkOutcome, BulkRow, BulkScope, BulkTarget } from './bulk-archive';
import './bulk-archive.css';

export type BulkRunState = {
  phase: 'confirm' | 'running' | 'done';
  scope: BulkScope;
  scopeLabel: string;
  targets: BulkTarget[];
  blocked: BulkBlocked[];
  outcomes: BulkOutcome[];
  current?: string;
  stopped?: boolean;
};

export type BulkArchiveControls = {
  bulkScope?: BulkScope | null;
  bulkSelected?: string[];
  bulkBusy?: boolean;
  startBulk?(scope: BulkScope): void;
  cancelBulk?(): void;
  toggleBulk?(scope: BulkScope, threadId: string): void;
  setBulkSelection?(scope: BulkScope, ids: string[]): void;
  requestBulkArchive?(scope: BulkScope, rows: BulkRow[]): void;
};

/** True while this exact scope is the one being multi-selected. */
export const bulkActive = (controls: BulkArchiveControls, scope: BulkScope) => sameBulkScope(controls.bulkScope, scope);

/** Enter/leave multi-select and act on it. Rendered above the conversations of one stated scope. */
export function BulkArchiveBar({ controls, scope, label, rows, morePages = false, locked }: {
  controls: BulkArchiveControls; scope: BulkScope; label: string; rows: BulkRow[]; morePages?: boolean;
  locked?(threadId: string): boolean;
}) {
  if (!controls.requestBulkArchive) return null;
  const active = bulkActive(controls, scope);
  const allowed = selectableIds(rows, locked);
  if (!active) return null;
  const selected = keepSelectable(controls.bulkSelected || [], rows, locked);
  const all = selected.length === allowed.length && allowed.length > 0;
  return <div className="bulk-archive-bar active" role="group" aria-label={`Выбор нескольких диалогов: ${label}`} data-bulk-scope={bulkScopeKey(scope)}>
    <div className="bulk-archive-status">
      <strong>Выбрано: {selected.length}</strong>
      <span className="bulk-archive-scope">Область: {label}</span>
    </div>
    <div className="bulk-archive-actions">
      <button type="button" className="text-button" disabled={controls.bulkBusy || !allowed.length}
        onClick={() => controls.setBulkSelection?.(scope, all ? [] : allowed)}>
        {all ? <Square size={12} /> : <CheckSquare size={12} />}
        {all ? 'Снять выделение' : `Выбрать все (${allowed.length})`}
      </button>
      <button type="button" className="text-button" disabled={controls.bulkBusy} onClick={() => controls.cancelBulk?.()}><X size={12} />Отмена</button>
      <button type="button" className="bulk-archive-apply" disabled={controls.bulkBusy || !selected.length}
        data-tooltip={selected.length ? `Архивировать выбранные диалоги: ${label}` : 'Выберите хотя бы один диалог'}
        onClick={() => controls.requestBulkArchive?.(scope, rows)}><Archive size={12} />В архив</button>
    </div>
    {morePages && <p className="bulk-archive-note">«Выбрать все» берёт только загруженные диалоги. Нажмите «Загрузить ещё», чтобы включить остальные страницы.</p>}
  </div>;
}

/** The checkbox that replaces the ⋮ menu while the row's scope is being multi-selected. */
export function BulkThreadCheckbox({ controls, scope, row, title, locked }: {
  controls: BulkArchiveControls; scope: BulkScope; row: BulkRow; title: string; locked?(threadId: string): boolean;
}) {
  const reason = bulkBlockReason(row.thread, row.cwd, locked);
  const checked = !reason && (controls.bulkSelected || []).includes(row.thread.id);
  return <input type="checkbox" className="bulk-thread-checkbox" aria-label={`Выбрать диалог ${title}`}
    data-tooltip={reason ? `Нельзя архивировать: ${reason}` : undefined}
    checked={checked} disabled={Boolean(reason) || controls.bulkBusy}
    onChange={() => controls.toggleBulk?.(scope, row.thread.id)} />;
}

const compactEntries = (entries: { id: string; title: string; reason?: string; error?: string }[]) => entries.slice(0, 2);

/** One confirmation with count and scope, then visible progress and a report that keeps the successes. */
export default function BulkArchiveDialog({ run, busy, onConfirm, onStop, onClose }: {
  run: BulkRunState; busy: boolean; onConfirm(): void; onStop(): void; onClose(): void;
}) {
  const total = run.targets.length;
  const done = run.outcomes.length;
  const report = run.phase === 'done' ? bulkArchiveReport({ outcomes: run.outcomes, blocked: run.blocked, total, stopped: run.stopped }) : null;
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="confirm-modal bulk-archive-modal" role={run.phase === 'confirm' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="bulk-archive-title">
      {run.phase === 'confirm' && <>
        <h2 id="bulk-archive-title">Архивировать {conversationCount(total)}?</h2>
        <p className="bulk-archive-modal-scope">Область: {run.scopeLabel}.</p>
        {Boolean(run.blocked.length) && <div className="bulk-archive-skipped">
          <p>Не будут затронуты {conversationCount(run.blocked.length)}.</p>
          {compactEntries(run.blocked).map(entry => <div key={entry.id}>{entry.title} — {entry.reason}</div>)}
          {run.blocked.length > 2 && <div className="muted">и ещё {run.blocked.length - 2}.</div>}
        </div>}
        <p className="muted">Диалоги не удаляются: история переедет в архив, откуда её можно восстановить. Черновики, открытые вкладки, настройки и история сохранятся.</p>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" autoFocus disabled={busy} onClick={onClose}>Отмена</button>
          <button type="button" className="primary-button" disabled={busy || !total} onClick={onConfirm}><Archive size={14} />Архивировать ({total})</button>
        </div>
      </>}
      {run.phase === 'running' && <>
        <h2 id="bulk-archive-title">Архивируем диалоги…</h2>
        <p className="bulk-archive-progress" role="status" aria-live="polite">Обработано {done} из {total}{run.current ? `. Сейчас: «${run.current}»` : ''}</p>
        <div className="bulk-archive-meter" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <p className="muted">Каждый диалог архивируется отдельным штатным вызовом. Уже выполненные остаются в архиве, даже если следующий не удастся.</p>
        <div className="confirm-actions"><button type="button" className="secondary-button" onClick={onStop}><LoaderCircle size={14} className="spin" />Остановить</button></div>
      </>}
      {run.phase === 'done' && report && <>
        <h2 id="bulk-archive-title">Результат архивации</h2>
        <p className="bulk-archive-progress" role="status">{report.message}</p>
        <p className="bulk-archive-modal-scope">Область: {run.scopeLabel}.</p>
        {Boolean(report.failed.length) && <div className="bulk-archive-failed">
          <p>Остались на месте:</p>
          {compactEntries(report.failed).map(entry => <div key={entry.id}>{entry.title} — {entry.error}</div>)}
          {report.failed.length > 2 && <div className="muted">и ещё {report.failed.length - 2}.</div>}
        </div>}
        {Boolean(run.blocked.length) && <div className="bulk-archive-skipped">
          <p>Пропущены до начала:</p>
          {compactEntries(run.blocked).map(entry => <div key={entry.id}>{entry.title} — {entry.reason}</div>)}
          {run.blocked.length > 2 && <div className="muted">и ещё {run.blocked.length - 2}.</div>}
        </div>}
        <div className="confirm-actions"><button type="button" className="primary-button" autoFocus onClick={onClose}>Закрыть</button></div>
      </>}
    </section>
  </div>;
}
