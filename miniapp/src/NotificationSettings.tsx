import { useEffect, useState } from 'react';
import type { RelayApi } from './api';
import type { NotificationSettings } from './types';

const labels: Array<[keyof NotificationSettings, string]> = [
  ['turnCompleted', 'Задача завершена'],
  ['actionRequired', 'Требуется действие на компьютере'],
  ['commandFailed', 'Команда не выполнена'],
  ['presence', 'Кузьмич отключился или снова на связи']
];

export function NotificationSettingsPanel({ api }: { api: RelayApi }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; void api.getNotificationSettings().then(value => { if (alive) setSettings(value); }).catch(() => { if (alive) setError('Настройки уведомлений пока недоступны.'); }); return () => { alive = false; }; }, [api]);
  async function change(key: keyof NotificationSettings, value: boolean) {
    if (!settings) return;
    const next = { ...settings, [key]: value };
    setSettings(next); setError(null);
    try { setSettings(await api.updateNotificationSettings(next)); }
    catch { setSettings(settings); setError('Не удалось сохранить настройку.'); }
  }
  return <section className="settings-panel" aria-labelledby="notification-settings-title">
    <div className="section-heading"><div><h2 id="notification-settings-title">Уведомления</h2><p className="settings-caption">Сообщения приходят в Telegram от бота.</p></div></div>
    {!settings && !error && <p className="loading-state">Загружаем настройки…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {settings && <div className="settings-list">{labels.map(([key, label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={settings[key]} onChange={event => { void change(key, event.target.checked); }} /></label>)}</div>}
  </section>;
}
