import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, LoaderCircle, RotateCcw, Rows3, X } from 'lucide-react';
import { useBridge } from './BridgeContext';
import { ReviewDiff } from './DiffReview';
import type { CodexBridge } from './types';
import './git-rollback.css';

export type RollbackTarget = { path: string; undoId?: string };
type Preview = Awaited<ReturnType<CodexBridge['previewGitRollback']>>;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function GitRollback({ target, mutationsAllowed, onClose, onComplete }: {
  target: RollbackTarget; mutationsAllowed: boolean; onClose(): void; onComplete(message: string): void;
}) {
  const bridge = useBridge();
  const undo = Boolean(target.undoId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const mounted = useRef(false);
  const allowed = useRef(mutationsAllowed); allowed.current = mutationsAllowed;
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pendingRef.current) close.current(); }
      if (event.key === 'Tab') {
        const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])];
        const first = nodes[0], last = nodes.at(-1);
        if (!nodes.length) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { mounted.current = false; document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setLoading(true); setError(''); setExpired(false);
    void (async () => {
      try {
        if (!bridge.previewGitRollback || !bridge.previewUndoGitRollback) throw new Error('Откат доступен после обновления приложения.');
        const result = target.undoId ? await bridge.previewUndoGitRollback({ undoId: target.undoId }) : await bridge.previewGitRollback({ path: target.path });
        if (cancelled) return;
        if (!result?.previewId || result.path !== target.path || result.operation !== (undo ? 'undo' : 'restore') || !Number.isFinite(new Date(result.expiresAt).getTime())) throw new Error('Не удалось проверить предпросмотр. Обновите его перед продолжением.');
        setPreview(result);
      } catch (cause) { if (!cancelled) setError(errorText(cause)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [bridge, target, revision, undo]);
  useEffect(() => {
    if (!preview) return;
    const remaining = new Date(preview.expiresAt).getTime() - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [preview]);
  const apply = async () => {
    if (!preview || loading || pendingRef.current || !allowed.current || expired) return;
    if (new Date(preview.expiresAt).getTime() <= Date.now()) { setExpired(true); return; }
    pendingRef.current = true; setPending(true); setError('');
    try {
      if (undo) await bridge.undoGitRollback({ previewId: preview.previewId });
      else await bridge.applyGitRollback({ previewId: preview.previewId });
      if (mounted.current) onComplete(undo ? `Изменения ${target.path} возвращены.` : `Файл ${target.path} восстановлен из индекса. Откат можно отменить ниже.`);
    } catch (cause) {
      if (mounted.current) { setError(errorText(cause)); setPreview(null); }
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  const closeDialog = () => { if (!pendingRef.current) onClose(); };
  return createPortal(<div className="diff-review-backdrop" onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}>
    <section ref={dialog} className="diff-review-modal git-rollback-modal" role="dialog" aria-modal="true" aria-label={undo ? 'Отмена отката файла' : 'Откат файла'} aria-busy={pending} tabIndex={-1}>
      <header className="diff-review-header"><RotateCcw size={19} /><div><small>{undo ? 'ОТМЕНА ОТКАТА' : 'ОТКАТ ФАЙЛА'}</small><h2>{target.path}</h2></div><button ref={closeButton} type="button" className="icon-button" aria-label="Закрыть предпросмотр отката" disabled={pending} onClick={closeDialog}><X size={19} /></button></header>
      <div className="git-rollback-explanation">{undo
        ? <p>В рабочий файл вернутся изменения, сохранённые перед этим откатом. Подготовленная к коммиту версия останется прежней.</p>
        : <><p>Рабочий файл будет заменён версией из индекса Git — той, которая подготовлена к коммиту. При отсутствии подготовленных изменений это последняя сохранённая в Git версия.</p><p>Будут отменены <strong>все неподготовленные изменения этого файла</strong>, включая ваши собственные. Перед заменой сохраняется резервная копия; откат можно отменить в «Недавних откатах».</p></>}
      </div>
      {loading && <p className="git-rollback-notice" role="status"><LoaderCircle size={15} className="spin" />Готовим предпросмотр…</p>}
      {error && <div className="diff-review-error" role="alert">{error}</div>}
      {expired && <p className="git-rollback-notice" role="status">Предпросмотр устарел. Обновите его, чтобы проверить файл ещё раз.</p>}
      {!mutationsAllowed && <p className="git-rollback-notice" role="status">Дождитесь завершения задач и закройте терминал перед изменением файлов.</p>}
      {preview && <>
        {preview.message && <div className="diff-review-message" role="status">{preview.message}</div>}
        {!preview.binary && preview.diff && <div className="diff-review-toolbar"><div className="diff-mode-buttons" role="group" aria-label="Вид сравнения"><button type="button" aria-pressed={mode === 'split'} disabled={pending} onClick={() => setMode('split')}><Columns2 size={14} />До / после</button><button type="button" aria-pressed={mode === 'unified'} disabled={pending} onClick={() => setMode('unified')}><Rows3 size={14} />Единый diff</button></div></div>}
      </>}
      <div className="diff-review-body">{preview && (preview.binary ? <p className="diff-number-note">Бинарный файл. Текстовое сравнение недоступно.</p> : preview.diff ? <ReviewDiff text={preview.diff} mode={mode} expanded beforeLabel="Сейчас · рабочий файл" afterLabel={undo ? 'После · сохранённые изменения' : 'После · версия из индекса'} /> : <p className="diff-number-note">Текстовых изменений нет.</p>)}</div>
      <footer className="git-rollback-footer"><p>Перед записью приложение повторно проверит файл и индекс. Если они изменились, потребуется новый предпросмотр.</p><div>
        <button type="button" className="git-rollback-secondary" disabled={pending} onClick={closeDialog}>Отмена</button>
        {(!preview || expired) && !loading ? <button type="button" className="git-rollback-secondary" disabled={pending} onClick={() => setRevision(value => value + 1)}>Обновить предпросмотр</button> : <button type="button" className={`git-rollback-confirm ${undo ? 'undo' : ''}`} disabled={!preview || loading || pending || expired || !mutationsAllowed} onClick={() => void apply()}>{pending && <LoaderCircle size={14} className="spin" />}{pending ? 'Применяем…' : undo ? 'Вернуть изменения' : 'Отменить изменения файла'}</button>}
      </div></footer>
    </section>
  </div>, document.body);
}
