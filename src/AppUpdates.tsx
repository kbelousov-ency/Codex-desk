import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { BuildDetails, useBuildInfo, useProductName } from './BuildInfo';
import type { AppUpdateStatus } from './types';
import './app-updates.css';

type UpdateAction = { kind: 'load' | 'check' | 'download' | 'install' } | { kind: 'save'; patch: { enabled?: boolean; skippedVersion?: string | null } };
const causeText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const megabytes = (value: number) => `${Math.round(value / 1024 / 1024)} МБ`;

function progressText(status: AppUpdateStatus) {
  const progress = status.progress;
  if (!progress || progress.total <= 0) return 'Скачиваем установщик…';
  const percent = Math.min(100, Math.round(progress.received / progress.total * 100));
  return `Скачиваем установщик: ${megabytes(progress.received)} из ${megabytes(progress.total)} (${percent} %)`;
}

function failureText(status: AppUpdateStatus) {
  if (status.outcome?.state !== 'failed') return '';
  // Про ручной путь говорим только когда файл действительно на месте.
  const manual = status.outcome.installerPath
    ? ' Скачанный установщик можно запустить вручную.'
    : ' Скачанный установщик не найден — скачайте обновление заново.';
  if (status.outcome.reason === 'timeout') return `Обновление не применилось: приложение не успело закрыться.${manual}`;
  if (status.outcome.reason === 'ok') return `Установщик сообщил об успехе, но версия не изменилась.${manual}`;
  return `Обновление не применилось.${manual}`;
}

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
      else if (action.kind === 'install') next = await window.codex.installAppUpdate();
      else await window.codex.openAppUpdateDownload();
      if (!mounted.current) return;
      if (next && revision.current === started) setStatus(next);
      if (action.kind === 'download') setDownloadOpened(true);
    } catch (cause) {
      if (mounted.current) setFailure({ action, message: `${action.kind === 'save' ? 'Не удалось сохранить настройку.' : action.kind === 'download' ? 'Не удалось скачать установщик.' : action.kind === 'install' ? 'Не удалось обновить приложение.' : 'Не удалось проверить обновления.'} ${causeText(cause)}` });
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
  const offered = Boolean(status?.supported && status.latestVersion && status.downloadUrl && (status.phase === 'available' || status.phase === 'downloading'));
  const canApply = Boolean(status?.canApply) && typeof window.codex?.installAppUpdate === 'function';
  return {
    status, pending, failure, downloadOpened, available, canApply,
    bannerVisible: offered && !dismissed.has(status!.latestVersion!) && status!.skippedVersion !== status!.latestVersion,
    offered,
    check: () => void perform({ kind: 'check' }),
    download: () => void perform({ kind: 'download' }),
    install: () => void perform({ kind: 'install' }),
    acknowledgeOutcome: () => { void window.codex?.acknowledgeAppUpdateOutcome?.(); },
    revealFile: () => { void window.codex?.revealAppUpdateFile?.(); },
    save: (patch: { enabled?: boolean; skippedVersion?: string | null }) => void perform({ kind: 'save', patch }),
    retry: () => { if (failure) void perform(failure.action); },
    dismiss: () => { if (status?.latestVersion) setDismissed(previous => new Set(previous).add(status.latestVersion!)); },
  };
}

type UpdateControl = ReturnType<typeof useAppUpdates>;

export function AppUpdateBanner({ control, onDetails }: { control: UpdateControl; onDetails(): void }) {
  const productName = useProductName();
  const { status, pending, failure } = control;
  if (!control.bannerVisible || !status) return null;
  const downloading = status.phase === 'downloading';
  return <aside className="app-update-banner" aria-label="Доступно обновление приложения">
    <Download size={17} aria-hidden="true" />
    <div className="app-update-banner-copy" role="status">
      <strong>Доступен {productName} {status.latestVersion}</strong>
      <span>{downloading ? progressText(status) : failure ? failure.message : control.downloadOpened ? 'Установщик скачан и проверен. Закройте приложение и запустите его.' : control.canApply ? 'Можно обновиться не выходя из приложения.' : 'Новая версия готова к скачиванию.'}</span>
      {downloading && <progress className="app-update-progress" value={status.progress?.received ?? 0} max={status.progress?.total || 1} aria-label="Ход скачивания обновления" />}
    </div>
    <div className="app-update-banner-actions">
      {control.canApply
        ? <button type="button" className="primary-button" disabled={Boolean(pending) || downloading} onClick={control.install}><Download size={13} /> Обновить</button>
        : <button type="button" className="primary-button" disabled={Boolean(pending)} onClick={control.download}><Download size={13} /> Скачать обновление</button>}
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
  if (status.phase === 'available' || status.phase === 'downloading') return `Доступна версия ${status.latestVersion || ''}.`;
  if (status.phase === 'up-to-date') return 'Установлена актуальная версия.';
  if (status.phase === 'error') return 'Проверка обновлений не завершилась. Повторите её позже.';
  if (!status.enabled || status.phase === 'disabled') return 'Автоматическая проверка выключена. Вы можете проверить обновления вручную.';
  return 'Автоматическая проверка включена.';
}

export function AppUpdateDialog({ control, onClose }: { control: UpdateControl; onClose(): void }) {
  const productName = useProductName();
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
  const busy = Boolean(pending || status?.phase === 'checking' || status?.phase === 'downloading');
  const local = status && status.channel !== 'stable';
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal app-update-dialog" role="dialog" aria-modal="true" aria-labelledby="app-updates-title" ref={dialog}>
      <div className="modal-header"><div><div className="eyebrow"><RefreshCw size={12} aria-hidden="true" /> {productName.toUpperCase()}</div><h2 id="app-updates-title">Обновления приложения</h2></div><button type="button" className="icon-button" aria-label="Закрыть обновления приложения" data-tooltip="Закрыть" ref={closeButton} onClick={onClose}><X size={18} /></button></div>
      <div className="settings-content">
        <BuildDetails />
        {status?.outcome && <p className={status.outcome.state === 'applied' ? 'app-update-status' : 'app-update-error'} role="status">
          <span>{status.outcome.state === 'applied' ? `Приложение обновлено до версии ${status.outcome.version}.` : failureText(status)}</span>
          {status.outcome.state === 'failed' && status.outcome.installerPath
            && <button type="button" className="secondary-button" onClick={control.revealFile}>Показать файл в папке</button>}
          <button type="button" className="text-button" onClick={control.acknowledgeOutcome}>Понятно</button>
        </p>}
        {!status && !failure && <p className="app-update-status" role="status"><LoaderCircle className="spin" size={15} /> Загружаем сведения об обновлениях…</p>}
        {local ? <p className="app-update-status">{status.channel === 'nightly' ? 'Nightly' : 'Версия для разработки'} обновляется локально. Онлайн-обновления доступны в канале Release.</p> : status && !status.supported ? <p className="app-update-status">Онлайн-обновления недоступны в этой сборке.</p> : status && <>
          <label className="settings-row app-update-option"><span><strong>Проверять автоматически</strong><small>Периодически проверять новые версии в каталоге Portal и предлагать обновление.</small></span><input type="checkbox" aria-label="Проверять обновления автоматически" checked={status.enabled} disabled={busy} onChange={event => control.save({ enabled: event.target.checked })} /></label>
          <p className="app-update-last-check">Последняя проверка: <span>{lastChecked(status.checkedAt)}</span></p>
          <p className="app-update-status" role="status">{status.phase === 'checking' && <LoaderCircle className="spin" size={15} />}{statusText(status)}</p>
          {status.phase === 'error' && status.error && !failure && <p className="app-update-error" role="alert">{status.error}</p>}
          {control.offered && <>
            {status.skippedVersion === status.latestVersion && <p className="app-update-note">Вы пропустили эту версию. Её по-прежнему можно скачать вручную.</p>}
            <div className="app-update-actions">
              {control.canApply && <button type="button" className="primary-button" disabled={busy} onClick={control.install}><Download size={14} /> Обновить</button>}
              <button type="button" className={control.canApply ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={control.download}><Download size={14} /> {control.canApply ? 'Скачать установщик' : 'Скачать обновление'}</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => control.save({ skippedVersion: status.skippedVersion === status.latestVersion ? null : status.latestVersion })}>{status.skippedVersion === status.latestVersion ? 'Снова напоминать' : 'Пропустить эту версию'}</button>
            </div>
            {status.phase === 'downloading' && <p className="app-update-status" role="status">{progressText(status)}<progress className="app-update-progress" value={status.progress?.received ?? 0} max={status.progress?.total || 1} aria-label="Ход скачивания обновления" /></p>}
            <p className="app-update-note">{control.canApply
              ? 'Установщик скачается из Portal и будет проверен. Затем приложение предложит закрыться, дождётся завершения работы агентов, обновится и откроется снова с теми же вкладками.'
              : 'Установщик скачается из Portal и будет проверен. Затем закройте приложение и запустите его, чтобы обновиться.'}</p>
          </>}
          {control.offered && status.releaseNotes && <details className="app-update-notes"><summary>Что нового в версии {status.latestVersion}</summary><div>{status.releaseNotes}</div></details>}
          {control.downloadOpened && <p className="app-update-status" role="status">Установщик скачан и проверен. Он показан в папке загрузок.</p>}
        </>}
        {failure && <div className="app-update-error" role="alert"><span>{failure.message}</span><button type="button" className="secondary-button" disabled={busy} onClick={control.retry}>{failure.action.kind === 'save' ? 'Повторить сохранение' : failure.action.kind === 'download' ? 'Повторить загрузку' : 'Повторить проверку'}</button></div>}
      </div>
      <div className="modal-footer">{control.available && (!status || status.supported) ? <button type="button" className="secondary-button" disabled={busy} onClick={control.check}>{busy && <LoaderCircle size={13} className="spin" />} {status?.phase === 'error' ? 'Повторить проверку' : 'Проверить сейчас'}</button> : <span />}<button type="button" className="primary-button" onClick={onClose}>Готово</button></div>
    </section>
  </div>;
}
