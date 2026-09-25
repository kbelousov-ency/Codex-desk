import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { ReleaseNotesState } from './types';
import './release-notes.css';

type ReleaseNotesControl = {
  state: ReleaseNotesState | null;
  loading: boolean;
  error: string;
  acknowledge(): Promise<void>;
};

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Loads the host-owned release notes once per workspace. The bridge is optional for old/dev fixtures. */
export function useReleaseNotes(): ReleaseNotesControl {
  const [state, setState] = useState<ReleaseNotesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const get = window.codex?.getReleaseNotes;
    if (typeof get !== 'function') {
      setLoading(false);
      return () => { mounted.current = false; };
    }
    void get().then(next => {
      if (!mounted.current) return;
      setState(next);
      setError('');
    }).catch(cause => {
      if (mounted.current) setError(`Не удалось загрузить изменения релиза. ${errorText(cause)}`);
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);

  const acknowledge = useCallback(async () => {
    const save = window.codex?.acknowledgeReleaseNotes;
    if (typeof save === 'function') await save();
    setState(previous => previous ? { ...previous, shouldShow: false } : previous);
  }, []);

  return { state, loading, error, acknowledge };
}

type ReleaseNotesDialogProps = {
  control: ReleaseNotesControl;
  onClose(): void;
};

/** Modal release summary. It is intentionally independent of the online update dialog. */
export function ReleaseNotesDialog({ control, onClose }: ReleaseNotesDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState('');
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') || []);
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const acknowledge = async () => {
    setAcknowledging(true); setAcknowledgeError('');
    try { await control.acknowledge(); onClose(); }
    catch (cause) { setAcknowledgeError(`Не удалось сохранить отметку о просмотре. ${errorText(cause)}`); }
    finally { setAcknowledging(false); }
  };
  const state = control.state;
  const currentVersion = state?.currentVersion || '';
  const range = state?.previousVersion && state.previousVersion !== currentVersion ? `${state.previousVersion} → ${currentVersion}` : currentVersion ? `Версия ${currentVersion}` : 'Изменения Codex Desk';
  const releases = state?.releases || [];
  const busy = acknowledging;

  return <div className="modal-backdrop release-notes-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="settings-modal release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-title" ref={dialog}>
      <div className="modal-header"><div><div className="eyebrow"><Sparkles size={12} aria-hidden="true" /> CODEX DESK</div><h2 id="release-notes-title">Что нового?</h2><p className="release-notes-range">{range}</p></div><button type="button" className="icon-button" aria-label="Закрыть страницу «Что нового?»" data-tooltip="Закрыть" ref={closeButton} disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <div className="settings-content release-notes-content">
        {control.loading && <p className="release-notes-status" role="status"><LoaderCircle className="spin" size={15} /> Загружаем изменения релиза…</p>}
        {!control.loading && control.error && <p className="release-notes-error" role="alert">{control.error}</p>}
        {!control.loading && !control.error && <>
          {state?.shouldShow && !state.previousVersion && <p className="release-notes-note">Предыдущая версия неизвестна. Показываем изменения установленного релиза.</p>}
          {releases.map(release => <section className="release-notes-version" key={release.version}>
            <h3>Версия {release.version}</h3>
            {release.items.length ? <ul>{release.items.map((item, index) => <li key={`${release.version}-${index}`}>{item}</li>)}</ul> : <p className="release-notes-empty">Для этой версии нет отдельных заметок.</p>}
          </section>)}
          {!releases.length && <div className="release-notes-fallback"><Check size={17} aria-hidden="true" /><p>Codex Desk{currentVersion ? ` ${currentVersion}` : ''} установлен. Подробные заметки для этой версии пока не добавлены.</p></div>}
        </>}
        {acknowledgeError && <p className="release-notes-error" role="alert">{acknowledgeError}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Позже</button><button type="button" className="primary-button" disabled={busy || control.loading} onClick={() => void acknowledge()}>{acknowledging && <LoaderCircle size={13} className="spin" />}Понятно</button></div>
    </section>
  </div>;
}

export type { ReleaseNotesControl };
