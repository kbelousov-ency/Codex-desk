import { useEffect, useMemo, useRef, useState } from 'react';
import { RelayApi } from './api';
import { useRelay } from './useRelay';
import { TabMetadata } from './TabMetadata';
import { TabCommands } from './TabCommands';
import { NotificationSettingsPanel } from './NotificationSettings';
import type { InstallationSummary, TelegramContext, TabStatus } from './types';

const tabLabels: Record<TabStatus, string> = {
  running: 'Работает', idle: 'Ожидает', blocked: 'Нужен компьютер',
  unavailable: 'Недоступна', ambiguous: 'Проверьте на ПК', unknown: 'Статус неизвестен'
};

function lastSeen(value?: string | number | null): string {
  if (!value) return 'Нет данных об активности';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Нет данных об активности';
  return `Активность: ${new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(date)}`;
}

export function App({ telegram, apiOverride }: { telegram: TelegramContext; apiOverride?: RelayApi }) {
  const api = useMemo(() => apiOverride ?? new RelayApi({ initData: telegram.initData, fixture: telegram.isFixture }), [apiOverride, telegram.initData, telegram.isFixture]);
  const { snapshot, loading, error, live, refresh, removeInstallation } = useRelay(api, telegram.isFixture);
  const [confirmUnbind, setConfirmUnbind] = useState<InstallationSummary | null>(null);
  const [unbinding, setUnbinding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairingState, setPairingState] = useState<'idle' | 'working' | 'claimed' | 'error'>('idle');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const online = snapshot?.installations.filter((item) => item.status === 'online').length ?? 0;

  useEffect(() => {
    if (confirmUnbind && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!confirmUnbind && dialogRef.current?.open) dialogRef.current.close();
  }, [confirmUnbind]);

  async function unbind() {
    if (!confirmUnbind) return;
    setUnbinding(true);
    setActionError(null);
    try {
      await removeInstallation(confirmUnbind.installation_id);
      setConfirmUnbind(null);
    } catch { setActionError('Не удалось отвязать устройство. Попробуйте снова.'); }
    finally { setUnbinding(false); }
  }

  async function claimPairing() {
    if (!telegram.startParam) return;
    setPairingState('working');
    try { await api.claimPairing(telegram.startParam); setPairingState('claimed'); }
    catch { setPairingState('error'); }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">К</div>
        <div><p className="eyebrow">ПУЛЬТ С ТЕЛЕФОНА</p><h1>Кузьмич</h1></div>
        <span className="read-only">Управление</span>
      </header>

      {telegram.isFixture && <p className="fixture-banner" role="note">Демонстрационный режим · данные вымышлены</p>}
      {telegram.startParam && <section className="pairing-panel" aria-labelledby="pairing-title"><p className="eyebrow">ПРИВЯЗКА УСТРОЙСТВА</p><h2 id="pairing-title">Подключить этот телефон к Кузьмичу?</h2>{pairingState === 'claimed' ? <p className="pairing-success" role="status">Запрос принят. Подтверждение завершится на компьютере владельца.</p> : <><p>Код привязки действует недолго. После подтверждения на компьютере установка появится в списке.</p>{pairingState === 'error' && <p className="action-error" role="alert">Код недействителен или срок его действия истёк.</p>}<button className="button button-primary" type="button" disabled={pairingState === 'working'} onClick={() => { void claimPairing(); }}>{pairingState === 'working' ? 'Проверяем код…' : 'Подтвердить привязку'}</button></>}</section>}

      <section className={`connection-panel ${error ? 'is-offline' : online > 0 ? 'is-online' : 'is-offline'}`} aria-labelledby="connection-title">
        <span className="signal-dot" aria-hidden="true" />
        <div>
          <h2 id="connection-title">{loading ? 'Подключаемся к Кузьмичу…' : error ? 'Кузьмич недоступен' : online > 0 ? 'Кузьмич на связи' : 'Кузьмич не в сети'}</h2>
          <p>{loading ? 'Получаем список ваших установок.' : error ? 'Проверьте подключение и попробуйте ещё раз.' : online > 0 ? `${online} ${online === 1 ? 'установка онлайн' : 'установки онлайн'} · ${live ? 'живые обновления' : 'обновляем подключение'}` : 'Запустите Кузьмича на компьютере, чтобы увидеть актуальное состояние.'}</p>
        </div>
        {!loading && <button className="icon-button" type="button" aria-label="Обновить список" onClick={() => { void refresh(); }}>↻</button>}
      </section>

      {error && <div className="error-panel" role="alert"><strong>Не удалось получить данные</strong><p>{error.message}</p><button type="button" className="button button-secondary" onClick={() => { void refresh(); }}>Повторить</button></div>}

      <NotificationSettingsPanel api={api} />

      <section aria-labelledby="installations-title" className="installations">
        <div className="section-heading"><h2 id="installations-title">Мои установки</h2><span>{snapshot?.installations.length ?? '—'}</span></div>
        {loading && <div className="loading-state" role="status">Загрузка установок…</div>}
        {!loading && !error && snapshot?.installations.length === 0 && <div className="empty-state"><div className="empty-icon" aria-hidden="true">⌘</div><h3>Пока нет подключённых устройств</h3><p>В Кузьмиче на компьютере откройте доступ с телефона и отсканируйте код привязки.</p></div>}
        {snapshot?.installations.map((installation) => (
          <article className={`installation-card ${installation.status === 'online' ? '' : 'offline-card'}`} key={installation.installation_id}>
            <div className="installation-top"><div><h3>{installation.label || installation.name || 'Кузьмич'}</h3><p className="activity">{lastSeen(installation.last_seen_at)}</p></div><span className={`status-tag ${installation.status === 'online' && !error ? 'online' : 'offline'}`}>{error ? 'Нет связи' : installation.status === 'online' ? 'Онлайн' : 'Офлайн'}</span></div>
            {error && <p className="offline-note">Нет связи с сервером. Показано последнее известное состояние.</p>}
            {installation.status !== 'online' && <p className="offline-note">Компьютер недоступен. Показано последнее известное состояние.</p>}
            <h4 className="tabs-title">Разрешённые вкладки <span>{installation.tabs.length}</span></h4>
            {installation.tabs.length === 0 ? <p className="no-tabs">Разрешите доступ к нужным беседам в Кузьмиче на компьютере.</p> : <ul className="tab-list">{installation.tabs.map((tab) => <li key={tab.tab_id} className="tab-row"><div className={`tab-agent ${tab.agent.toLowerCase().includes('claude') ? 'claude' : ''}`} aria-hidden="true">{tab.agent.toLowerCase().includes('claude') ? 'C' : '⌘'}</div><div className="tab-main"><h5>{tab.name}</h5><p><span>{tab.agent.toLowerCase() === 'codex' ? 'Codex' : tab.agent.toLowerCase() === 'claude' ? 'Claude Code' : tab.agent}</span><span className="meta-separator">·</span><span>{tab.project || 'Проект не указан'}</span></p><span className={`tab-state ${tab.status}`}>{tabLabels[tab.status]}</span><TabMetadata queueLength={tab.queueLength} queuePaused={tab.queuePaused} updatedAt={tab.updatedAt} /><TabCommands api={api} installationId={installation.installation_id} tab={tab} installationOnline={installation.status === 'online' && !error} serverError={error} /></div></li>)}</ul>}
            <footer className="installation-footer"><span>Доступ управляется на ПК</span><button type="button" className="text-button" onClick={() => { setActionError(null); setConfirmUnbind(installation); }}>Отвязать устройство</button></footer>
          </article>
        ))}
      </section>
      <footer className="privacy-note"><span aria-hidden="true">◇</span><p>Состояние разрешённых вкладок и команды для выбранной вкладки. Сервер не хранит переписку: последний ответ передаётся только по отдельному запросу.</p></footer>

      <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="unbind-title" onCancel={(event) => { event.preventDefault(); if (!unbinding) setConfirmUnbind(null); }} onClose={() => { if (!unbinding) setConfirmUnbind(null); }}><p className="eyebrow">УСТРОЙСТВО</p><h2 id="unbind-title">Отвязать «{confirmUnbind?.label || confirmUnbind?.name || 'Кузьмич'}»?</h2><p>Установка исчезнет из этого списка. Для повторного подключения понадобится новая привязка на компьютере.</p>{actionError && <p role="alert" className="action-error">{actionError}</p>}<div className="dialog-actions"><button autoFocus className="button button-secondary" type="button" disabled={unbinding} onClick={() => setConfirmUnbind(null)}>Отмена</button><button className="button button-danger" type="button" disabled={unbinding} onClick={() => { void unbind(); }}>{unbinding ? 'Отвязываем…' : 'Отвязать'}</button></div></dialog>
    </main>
  );
}
