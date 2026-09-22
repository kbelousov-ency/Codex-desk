import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitBranchPlus, GitMerge, LoaderCircle, RefreshCw, Trash2, X, ExternalLink } from 'lucide-react';
import type { WorktreeMergePreview, WorktreeSummary } from './types';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const folderName = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;

/** Dialog listing the repository's worktrees with open / merge-back / remove actions. Read-only until confirmed. */
export default function WorktreePanel({ cwd, openTabs, onClose, onOpen, onNewTask, onCloseTabs }: {
  cwd: string; openTabs: (folder: string) => number; onClose(): void; onOpen(folder: string): void; onNewTask(): void; onCloseTabs(folder: string): Promise<void>;
}) {
  const [summary, setSummary] = useState<WorktreeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<WorktreeMergePreview | null>(null);
  const [removing, setRemoving] = useState<{ path: string; branch: string | null; dirty: boolean | null; force: boolean; deleteBranch: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const load = async () => {
    setLoading(true); setError('');
    try { setSummary(await window.codex.listWorktrees!(cwd)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [cwd]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) { event.preventDefault(); if (preview || removing) { setPreview(null); setRemoving(null); } else closeRef.current(); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [pending, preview, removing]);
  const showMerge = async (folder: string) => {
    setPending(folder); setError(''); setNotice('');
    try { setPreview(await window.codex.previewWorktreeMerge!(folder)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(null); }
  };
  const merge = async () => {
    if (!preview || preview.blocked) return;
    setPending(preview.worktreePath); setError('');
    try {
      const result = await window.codex.mergeWorktree!(preview.worktreePath);
      setPreview(null);
      setNotice(`Ветка «${result.branch}» перенесена в «${result.target}»: ${result.commits} коммит(ов), HEAD ${result.before.slice(0, 7)} → ${result.after.slice(0, 7)}. Рабочую копию задачи можно удалить.`);
      await load();
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(null); }
  };
  const remove = async () => {
    if (!removing) return;
    setPending(removing.path); setError('');
    try {
      await onCloseTabs(removing.path);
      const result = await window.codex.removeWorktree!(removing.path, { force: removing.force, deleteBranch: removing.deleteBranch });
      setRemoving(null);
      setNotice(`Рабочая копия ${folderName(result.path)} удалена${result.branchDeleted ? `, ветка «${result.branch}» удалена` : result.branch ? `, ветка «${result.branch}» сохранена` : ''}.`);
      await load();
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(null); }
  };
  return createPortal(<div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <section ref={dialog} className="settings-modal worktree-panel" role="dialog" aria-modal="true" aria-label="Задачи проекта" aria-busy={Boolean(pending) || loading}>
      <div className="modal-header"><div><span className="eyebrow">GIT WORKTREE</span><h2 id="worktree-title">Задачи проекта {summary ? folderName(summary.root) : folderName(cwd)}</h2></div><button className="icon-button" data-tooltip="Закрыть" aria-label="Закрыть задачи проекта" disabled={Boolean(pending)} onClick={onClose}><X size={19} /></button></div>
      <div className="settings-content">
        <p className="muted">Каждая задача живёт в отдельной ветке и папке. Перенос выполняет обычный <code>git merge</code> в основной копии; при конфликтах слияние отменяется и ничего не меняется.</p>
        {error && <div className="alert error-alert" role="alert"><span>{error}</span><button className="icon-button small" aria-label="Скрыть ошибку" onClick={() => setError('')}><X size={14} /></button></div>}
        {notice && <div className="alert notice-alert" role="status"><span>{notice}</span><button className="icon-button small" aria-label="Скрыть уведомление" onClick={() => setNotice('')}><X size={14} /></button></div>}
        {loading && <p className="folder-history-status"><LoaderCircle size={12} className="spin" /> Читаем рабочие копии…</p>}
        {summary && <ul className="worktree-list" aria-label="Рабочие копии">{summary.worktrees.map(item => {
          const tabs = openTabs(item.path);
          return <li key={item.path} className={`worktree-row ${item.main ? 'main' : ''}`} data-worktree-path={item.path} data-worktree-branch={item.branch ?? ''}>
            <div className="worktree-info">
              <strong>{item.main ? <GitBranch size={13} /> : <GitBranchPlus size={13} />}{item.branch ?? (item.detached ? 'без ветки' : '—')}{item.main && <small className="worktree-tag">основная</small>}{item.current && <small className="worktree-tag current">эта папка</small>}</strong>
              <small data-tooltip={item.path}>{item.path}</small>
              <small className="worktree-state">{item.dirty ? 'есть незафиксированные изменения' : item.dirty === false ? 'чисто' : 'состояние неизвестно'}{!item.main && item.ahead !== null && ` · +${item.ahead} коммит(ов)`}{!item.main && item.behind ? ` · отстаёт на ${item.behind}` : ''}{tabs ? ` · вкладок открыто: ${tabs}` : ''}</small>
            </div>
            <div className="worktree-actions">
              <button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => onOpen(item.path)}><ExternalLink size={13} />Открыть</button>
              {!item.main && <button type="button" className="secondary-button" disabled={Boolean(pending) || !item.branch} onClick={() => void showMerge(item.path)}><GitMerge size={13} />Перенести в {summary.mainBranch ?? 'основную'}</button>}
              {!item.main && <button type="button" className="secondary-button worktree-remove" aria-label={`Удалить копию ${item.branch ?? folderName(item.path)}`} disabled={Boolean(pending)} onClick={() => setRemoving({ path: item.path, branch: item.branch, dirty: item.dirty, force: false, deleteBranch: false })}><Trash2 size={13} /></button>}
            </div>
          </li>;
        })}</ul>}
        {preview && <section className="worktree-preview" aria-label="Предпросмотр переноса">
          <h3>Перенос «{preview.branch}» → «{preview.target}»</h3>
          {preview.blocked ? <p className="inline-error">{preview.blocked}</p> : <p className="muted">{preview.commits.length} коммит(ов){preview.behind ? `, ветка отстаёт от «${preview.target}» на ${preview.behind}: будет коммит слияния` : ''}.{preview.worktreeDirty ? ' Незафиксированные изменения в копии задачи не переносятся.' : ''}</p>}
          {preview.commits.length > 0 && <ol className="worktree-commits">{preview.commits.slice(0, 20).map(commit => <li key={commit.hash}><code>{commit.hash}</code> {commit.subject}</li>)}{preview.commits.length > 20 && <li className="muted">… ещё {preview.commits.length - 20}</li>}</ol>}
          {preview.stat && <pre className="approval-code worktree-stat">{preview.stat}</pre>}
          <div className="confirm-actions"><button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => setPreview(null)}>Отмена</button><button type="button" className="primary-button" disabled={Boolean(pending) || Boolean(preview.blocked)} onClick={() => void merge()}>{pending ? <LoaderCircle size={14} className="spin" /> : <GitMerge size={14} />}Выполнить merge</button></div>
        </section>}
        {removing && <section className="worktree-preview" role="alertdialog" aria-label="Удалить рабочую копию">
          <h3>Удалить копию {removing.branch ? `«${removing.branch}»` : folderName(removing.path)}?</h3>
          <p className="muted">Папка <code>{removing.path}</code> будет удалена командой <code>git worktree remove</code>. Открытые вкладки этой папки закроются.{removing.dirty ? ' В копии есть незафиксированные изменения — они будут потеряны.' : ''}</p>
          {removing.dirty && <label className="question-option"><input type="checkbox" checked={removing.force} onChange={event => setRemoving({ ...removing, force: event.target.checked })} /><span><strong>Удалить вместе с незафиксированными изменениями</strong></span></label>}
          {removing.branch && <label className="question-option"><input type="checkbox" checked={removing.deleteBranch} onChange={event => setRemoving({ ...removing, deleteBranch: event.target.checked })} /><span><strong>Удалить и ветку «{removing.branch}»</strong><small>Только если она полностью слита; иначе ветка останется.</small></span></label>}
          <div className="confirm-actions"><button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => setRemoving(null)}>Отмена</button><button type="button" className="danger-button" disabled={Boolean(pending) || (Boolean(removing.dirty) && !removing.force)} onClick={() => void remove()}>{pending ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}Удалить копию</button></div>
        </section>}
      </div>
      <div className="modal-footer"><span>Слияние и удаление — обычные команды Git в этом репозитории</span><div className="confirm-actions"><button type="button" className="secondary-button" disabled={loading || Boolean(pending)} onClick={() => void load()}><RefreshCw size={14} />Обновить</button><button type="button" className="primary-button" disabled={Boolean(pending)} onClick={onNewTask}><GitBranchPlus size={14} />Новая задача…</button></div></div>
    </section>
  </div>, document.body);
}
