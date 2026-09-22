import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { BuildDetails, useBuildInfo } from './BuildInfo';
import type { AppUpdateStatus } from './types';
import './app-updates.css';

type UpdateAction = { kind: 'load' | 'check' | 'download' } | { kind: 'save'; patch: { enabled?: boolean; skippedVersion?: string | null } };
const causeText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** One subscription per workspace; polling and persistent preferences belong to the host. */
export function useAppUpdates() {
  const build = useBuildInfo();
  const [receivedStatus, setStatus] = useState<AppUpdateStatus | null>(null);
  const [pending, setPending] = useState<UpdateAction['kind'] | null>(null);
  const [failure, setFailure] = useState<{ message: string; action: UpdateAction } | null>(null);
  const [downloadOpened, setDownloadOpened] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const revision = useRef(0);
  const mounted = useRef(false);
  const running = useRef(false);
  const available = typeof window.codex?.getAppUpdateStatus === 'function' && typeof window.codex?.checkAppUpdates === 'function' && typeof window.codex?.setAppUpdatePreferences === 'function' && typeof window.codex?.openAppUpdateDownload === 'function';

  const perform = useCallback(async (action: UpdateAction) => {
    if (running.current) return;
    running.current = true;
    const started = revision.current;
    setPending(action.kind); setFailure(null); setDownloadOpened(false);
    try {
      let next: AppUpdateStatus | undefined;
      if (action.kind === 'load') next = await window.codex.getAppUpdateStatus();
      else if (action.kind === 'check') next = await window.codex.checkAppUpdates();
      else if (action.kind === 'save') next = await window.codex.setAppUpdatePreferences(action.patch);
      else await window.codex.openAppUpdateDownload();
      if (!mounted.current) return;
      if (next && revision.current === started) setStatus(next);
      if (action.kind === 'download') setDownloadOpened(true);
    } catch (cause) {
      if (mounted.current) setFailure({ action, message: `${action.kind === 'save' ? 'Не удалось сохранить настройку.' : action.kind === 'download' ? 'Не удалось открыть загрузку.' : 'Не удалось проверить обновления.'} ${causeText(cause)}` });
    } finally {
      running.current = false;
      if (mounted.current) setPending(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!available) return () => { mounted.current = false; };
    const unsubscribe = window.codex.onAppUpdateStatus?.(next => {
      revision.current++; setStatus(next); setDownloadOpened(false);
    });
    void perform({ kind: 'load' });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [available, perform]);

  const status = receivedStatus || (!available ? {
    currentVersion: build?.version || '', channel: build?.channel || 'development', supported: false, enabled: false, phase: 'disabled' as const,
  } : null);
  const offered = Boolean(status?.supported && status.latestVersion && status.downloadUrl && status.phase === 'available');
  return {
    status, pending, failure, downloadOpened, available,
    bannerVisible: offered && !dismissed.has(status!.latestVersion!) && status!.skippedVersion !== status!.latestVersion,
    offered,
    check: () => void perform({ kind: 'check' }),
    download: () => void perform({ kind: 'download' }),
    save: (patch: { enabled?: boolean; skippedVersion?: string | null }) => void perform({ kind: 'save', patch }),
    retry: () => { if (failure) void perform(failure.action); },
    dismiss: () => { if (status?.latestVersion) setDismissed(previous => new Set(previous).add(status.latestVersion!)); },
  };
}

type UpdateControl = ReturnType<typeof useAppUpdates>;

export function AppUpdateBanner({ control, onDetails }: { control: UpdateControl; onDetails(): void }) {
  const { status, pending, failure } = control;
  if (!control.bannerVisible || !status) return null;
  return <aside className="app-update-banner" aria-label="Доступно обновление приложения">
    <Download size={17} aria-hidden="true" />
    <div className="app-update-banner-copy" role="status"><strong>Доступен Codex Desk {status.latestVersion}</strong><span>{failure ? failure.message : control.downloadOpened ? 'Загрузка открыта в браузере. Запустите скачанный установщик.' : 'Новая версия готова к скачиванию.'}</span></div>
    <div className="app-update-banner-actions">
      <button type="button" className="primary-button" disabled={Boolean(pending)} onClick={control.download}><Download size={13} /> Скачать обновление</button>
      <button type="button" className="text-button" onClick={onDetails}>Подробнее</button>
      <button type="button" className="text-button" disabled={Boolean(pending)} onClick={() => control.save({ skippedVersion: status.latestVersion })}>Пропустить эту версию</button>
      <button type="button" className="text-button" data-tooltip="Скрыть предложение до следующего запуска приложения" onClick={control.dismiss}>Позже</button>
    </div>
  </aside>;
}

function lastChecked(value?: string) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Ещё не проверяли';
}

function statusText(status: AppUpdateStatus) {
  if (status.phase === 'checking') return 'Проверяем наличие новой версии…';
  if (status.phase === 'available') return `Доступна версия ${status.latestVersion || ''}.`;
  if (status.phase === 'up-to-date') return 'Установлена актуальная версия.';
  if (status.phase === 'error') return 'Проверка обновлений не завершилась. Повторите её позже.';
  if (!status.enabled || status.phase === 'disabled') return 'Автоматическая проверка выключена. Вы можете проверить обновления вручную.';
  return 'Автоматическая проверка включена.';
}

export function AppUpdateDialog({ control, onClose }: { control: UpdateControl; onClose(): void }) {
  const { status, pending, failure } = control;
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]') || []);
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const busy = Boolean(pending || status?.phase === 'checking');
  const local = status && status.channel !== 'stable';
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal app-update-dialog" role="dialog" aria-modal="true" aria-labelledby="app-updates-title" ref={dialog}>
      <div className="modal-header"><div><div className="eyebrow"><RefreshCw size={12} aria-hidden="true" /> CODEX DESK</div><h2 id="app-updates-title">Обновления приложения</h2></div><button type="button" className="icon-button" aria-label="Закрыть обновления приложения" data-tooltip="Закрыть" ref={closeButton} onClick={onClose}><X size={18} /></button></div>
      <div className="settings-content">
        <BuildDetails />
        {!status && !failure && <p className="app-update-status" role="status"><LoaderCircle className="spin" size={15} /> Загружаем сведения об обновлениях…</p>}
        {local ? <p className="app-update-status">{status.channel === 'nightly' ? 'Nightly' : 'Версия для разработки'} обновляется локально. Онлайн-обновления доступны в канале Release.</p> : status && !status.supported ? <p className="app-update-status">Онлайн-обновления недоступны в этой сборке.</p> : status && <>
          <label className="settings-row app-update-option"><span><strong>Проверять автоматически</strong><small>Периодически проверять новые версии на GitHub и предлагать обновление.</small></span><input type="checkbox" aria-label="Проверять обновления автоматически" checked={status.enabled} disabled={busy} onChange={event => control.save({ enabled: event.target.checked })} /></label>
          <p className="app-update-last-check">Последняя проверка: <span>{lastChecked(status.checkedAt)}</span></p>
          <p className="app-update-status" role="status">{status.phase === 'checking' && <LoaderCircle className="spin" size={15} />}{statusText(status)}</p>
          {status.phase === 'error' && status.error && !failure && <p className="app-update-error" role="alert">{status.error}</p>}
          {control.offered && <>
            {status.skippedVersion === status.latestVersion && <p className="app-update-note">Вы пропустили эту версию. Её по-прежнему можно скачать вручную.</p>}
            <div className="app-update-actions"><button type="button" className="primary-button" disabled={busy} onClick={control.download}><Download size={14} /> Скачать обновление</button><button type="button" className="text-button" disabled={busy} onClick={() => control.save({ skippedVersion: status.skippedVersion === status.latestVersion ? null : status.latestVersion })}>{status.skippedVersion === status.latestVersion ? 'Снова напоминать' : 'Пропустить эту версию'}</button></div>
            <p className="app-update-note">Загрузка откроется в браузере. Затем запустите скачанный установщик, чтобы обновить приложение.</p>
          </>}
          {control.offered && status.releaseNotes && <details className="app-update-notes"><summary>Что нового в версии {status.latestVersion}</summary><div>{status.releaseNotes}</div></details>}
          {control.downloadOpened && <p className="app-update-status" role="status">Загрузка открыта в браузере.</p>}
        </>}
        {failure && <div className="app-update-error" role="alert"><span>{failure.message}</span><button type="button" className="secondary-button" disabled={busy} onClick={control.retry}>{failure.action.kind === 'save' ? 'Повторить сохранение' : failure.action.kind === 'download' ? 'Повторить загрузку' : 'Повторить проверку'}</button></div>}
      </div>
      <div className="modal-footer">{control.available && (!status || status.supported) ? <button type="button" className="secondary-button" disabled={busy} onClick={control.check}>{busy && <LoaderCircle size={13} className="spin" />} {status?.phase === 'error' ? 'Повторить проверку' : 'Проверить сейчас'}</button> : <span />}<button type="button" className="primary-button" onClick={onClose}>Готово</button></div>
    </section>
  </div>;
}