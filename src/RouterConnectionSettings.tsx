import { useEffect, useRef, useState } from 'react';
import { CircleCheck, ExternalLink, FileUp, LoaderCircle, Plug } from 'lucide-react';
import type { CodexBridge, RouterConnectionInfo, RouterConnectionPreview } from './types';

export default function RouterConnectionSettings({ bridge, disabled, onConnected, onBusyChange }: {
  bridge: CodexBridge; disabled: boolean; onConnected(): Promise<unknown>; onBusyChange(busy: boolean): void;
}) {
  const [info, setInfo] = useState<RouterConnectionInfo | null>(null);
  const [preview, setPreview] = useState<RouterConnectionPreview | null>(null);
  const [busy, setBusy] = useState<'' | 'portal' | 'file' | 'save'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    void bridge.getRouterConnection?.().then(value => { if (generation.current === current) setInfo(value); }, () => { if (generation.current === current) setError('Не удалось прочитать подключение роутера.'); });
    return () => { generation.current++; void bridge.cancelRouterConnection?.(); };
  }, [bridge]);
  useEffect(() => { onBusyChange(Boolean(busy)); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const prepare = async (kind: 'portal' | 'file') => {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(kind); setError(''); setNotice(''); setPreview(null);
    const current = ++generation.current;
    try {
      const result = kind === 'portal' ? await bridge.connectRouterPortal?.() : await bridge.previewRouterInstaller?.();
      if (current === generation.current) setPreview(result || null);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Не удалось подключить роутер.'); }
    finally { pending.current = false; if (current === generation.current) setBusy(''); }
  };
  const cancel = async () => {
    if (busy === 'save') return;
    generation.current++; setPreview(null); setError('');
    try { await bridge.cancelRouterConnection?.(); }
    catch { setError('Не удалось отменить подключение.'); }
    finally { pending.current = false; setBusy(''); }
  };
  const apply = async () => {
    if (!preview || disabled || pending.current || !bridge.applyRouterConnection) return;
    pending.current = true; setBusy('save'); setError('');
    try {
      const result = await bridge.applyRouterConnection({ previewId: preview.previewId });
      setInfo(result); setPreview(null);
      setNotice('Подключение сохранено. Переключаем текущий диалог на роутер…');
      await onConnected();
      setNotice('Подключение сохранено. Источник и модель для следующего сообщения показаны под полем ввода.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить подключение.'); }
    finally { pending.current = false; setBusy(''); }
  };
  if (!bridge.getRouterConnection) return null;
  return <section className="claude-auth-settings" aria-label="Роутер Claude">
    <h3><Plug size={14} aria-hidden="true" /> Роутер Claude</h3>
    <div className="claude-auth-status" role="status">{info?.configured && <CircleCheck size={14} aria-hidden="true" />}<span>{info?.configured ? 'Подключение сохранено' : 'Роутер не подключён'}{info?.baseUrl && <small>{info.baseUrl}</small>}</span></div>
    <p>Войдите на портал и нажмите «Подключить Claude». Desk получит настройки и сохранит ключ в зашифрованном виде. Личный аккаунт останется доступен в выборе источника.</p>
    {info?.error && <p className="inline-error" role="alert">{info.error}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="claude-auth-actions">
      <button type="button" className="primary-button" disabled={disabled || Boolean(busy) || info?.encryptionAvailable === false} onClick={() => void prepare('portal')}><ExternalLink size={13} aria-hidden="true" />Подключить через портал</button>
      <button type="button" className="secondary-button" disabled={disabled || Boolean(busy) || info?.encryptionAvailable === false} onClick={() => void prepare('file')}><FileUp size={13} aria-hidden="true" />Выбрать установщик с портала</button>
      {bridge.openRouterPortal && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void bridge.openRouterPortal?.().catch(() => setError('Не удалось открыть браузер.'))}>Открыть в обычном браузере</button>}
    </div>
    {busy && <p role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" /> {busy === 'portal' ? 'Завершите вход и подключение Claude в окне портала.' : busy === 'save' ? 'Сохраняем подключение…' : 'Получаем настройки из подключения…'}</p>}
    {preview && <div className="claude-token">
      <h4>Подключение готово к сохранению</h4>
      <p>{preview.providerName || 'Роутер'} · {preview.baseUrl}</p>
      <p>Настройки действуют в Desk. Для текущего диалога будет выбран источник «Роутер».</p>
      <button className="primary-button" type="button" disabled={disabled || Boolean(busy)} onClick={() => void apply()}>Сохранить и использовать</button>
    </div>}
    {(busy === 'portal' || busy === 'file' || preview) && <button className="secondary-button" type="button" disabled={busy === 'save'} onClick={() => void cancel()}>Отменить подключение</button>}
    {info?.encryptionAvailable === false && <p className="inline-error" role="alert">Шифрование Windows недоступно. Подключение сохранить нельзя.</p>}
  </section>;
}
