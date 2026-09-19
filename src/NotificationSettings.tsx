import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, LoaderCircle, X } from 'lucide-react';
import type { NotificationPreferences } from './types';
import './notifications.css';

const eventOptions: { key: keyof NotificationPreferences; label: string }[] = [
  { key: 'completed', label: 'Завершение задач' },
  { key: 'question', label: 'Вопросы Codex' },
  { key: 'approval', label: 'Запросы разрешений' },
  { key: 'error', label: 'Ошибки и потеря соединения' },
];

export function NotificationSettings({ onClose }: { onClose(): void }) {
  const [settings, setSettings] = useState<NotificationPreferences | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [failedPatch, setFailedPatch] = useState<Partial<NotificationPreferences> | null>(null);
  const generation = useRef(0);
  const saving = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setPending(true); setError(''); setFailedPatch(null);
    try {
      const result = await window.codex.getNotificationSettings();
      if (generation.current !== current) return;
      setSettings(result.settings); setSupported(result.supported);
    } catch (cause) {
      if (generation.current === current) setError(`Не удалось загрузить настройки. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (generation.current === current) setPending(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') || []);
      const first = elements[0]; const last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const save = async (patch: Partial<NotificationPreferences>) => {
    if (saving.current) return;
    saving.current = true;
    const current = ++generation.current;
    setPending(true); setError(''); setFailedPatch(null);
    try {
      const result = await window.codex.setNotificationSettings(patch);
      if (generation.current !== current) return;
      setSettings(result.settings); setSupported(result.supported);
    } catch (cause) {
      if (generation.current === current) {
        setError(`Не удалось сохранить настройку. ${cause instanceof Error ? cause.message : String(cause)}`);
        setFailedPatch(patch);
      }
    } finally {
      saving.current = false;
      if (generation.current === current) setPending(false);
    }
  };

  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal notification-settings" role="dialog" aria-modal="true" aria-labelledby="notification-settings-title" ref={dialog}>
      <div className="modal-header">
        <div><div className="eyebrow"><Bell size={12} aria-hidden="true" /> УВЕДОМЛЕНИЯ</div><h2 id="notification-settings-title">Быть в курсе задач</h2></div>
        <button className="icon-button" aria-label="Закрыть настройки уведомлений" title="Закрыть" ref={closeButton} onClick={onClose}><X size={18} /></button>
      </div>
      <div className="settings-content">
        {!settings && pending && <p className="notification-settings-status" role="status"><LoaderCircle size={15} className="spin" /> Загружаем настройки…</p>}
        {settings && <>
          <label className="settings-row notification-option">
            <span><strong>Уведомления Windows</strong><small>Для фоновых диалогов и когда окно не активно. Нажмите уведомление, чтобы перейти к диалогу.</small></span>
            <input type="checkbox" aria-label="Уведомления Windows" checked={settings.enabled} disabled={pending} onChange={event => void save({ enabled: event.target.checked })} />
          </label>
          <label className="settings-row notification-option">
            <span><strong>Звук</strong><small>Системный звук при появлении уведомления.</small></span>
            <input type="checkbox" aria-label="Звук" checked={settings.sound} disabled={pending || !settings.enabled} onChange={event => void save({ sound: event.target.checked })} />
          </label>
          <fieldset disabled={pending || !settings.enabled} className="notification-events">
            <legend>Сообщать о событиях</legend>
            {eventOptions.map(option => <label className="notification-event" key={option.key}>
              <input type="checkbox" checked={settings[option.key]} onChange={event => void save({ [option.key]: event.target.checked })} />
              <span>{option.label}</span>
            </label>)}
          </fieldset>
          {!supported && <p className="notification-settings-status" role="status">Системные уведомления недоступны. Отметки во вкладках и список «Требуют внимания» продолжают работать.</p>}
          <p className="notification-settings-note">Отметки непрочитанного и ожидающие ответа диалоги видны в приложении при любых настройках уведомлений.</p>
        </>}
        {error && <div className="notification-settings-error" role="alert"><span>{error}</span><button className="secondary-button" disabled={pending} onClick={() => void (failedPatch ? save(failedPatch) : load())}>{failedPatch ? 'Повторить сохранение' : 'Повторить загрузку'}</button></div>}
      </div>
      <div className="modal-footer"><span role="status">{settings && pending ? 'Сохраняем…' : settings && !error ? 'Настройки сохраняются автоматически' : ''}</span><button className="primary-button" onClick={onClose}>Готово</button></div>
    </section>
  </div>;
}
