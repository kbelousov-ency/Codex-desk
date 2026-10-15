import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, Copy, Info, LoaderCircle, Server, Smartphone, Unlink, UserCheck } from 'lucide-react';
import QRCode from 'qrcode';
import type { RelayBridgeState, RelayConnectionSettingsProps } from './types';
import './relay-connection.css';

/**
 * «Подключение к серверу» — the local panel for the relay bridge.
 *
 * Nothing secret ever reaches this component: the host returns only state. The pairing code is
 * shown here and only here, and a credential is issued only after the owner has seen which
 * Telegram account is asking and pressed confirm.
 */

const connectionText: Record<RelayBridgeState['connection'], string> = {
  disabled: 'Подключение выключено',
  unconfigured: 'Сервер не настроен',
  connecting: 'Подключаемся к серверу…',
  online: 'Сервер на связи',
  pairing: 'Ждём подтверждения из Telegram',
  error: 'Соединение не установлено',
};

const formatExpiry = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

export function RelayConnectionSettings({ bridge, disabled = false }: RelayConnectionSettingsProps) {
  const [state, setState] = useState<RelayBridgeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'url' | 'label' | 'enable' | 'pair' | 'confirm' | 'unlink'>('');
  const [urlInput, setUrlInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [qr, setQr] = useState('');
  const generation = useRef(0);
  const touchedUrl = useRef(false);
  const touchedLabel = useRef(false);

  const load = useCallback(async () => {
    const current = generation.current;
    try {
      const next = await bridge.getState();
      if (generation.current === current) setState(next);
    } catch (cause) {
      if (generation.current === current) setFailure(cause instanceof Error ? cause.message : 'Не удалось прочитать настройку подключения к серверу.');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    generation.current++;
    touchedUrl.current = false; touchedLabel.current = false;
    setState(null); setLoading(true); setUrlInput(''); setLabelInput(''); setFailure(''); setNotice('');
    const unsubscribe = bridge.onState(next => { setState(next); setLoading(false); });
    void load();
    return () => { generation.current++; unsubscribe(); };
  }, [bridge, load]);

  // A half-typed address belongs to the owner; the host only overwrites what was never touched.
  useEffect(() => {
    if (state && !touchedUrl.current) setUrlInput(state.relayUrl);
    if (state && !touchedLabel.current) setLabelInput(state.label);
  }, [state]);

  // The QR is drawn locally from the link the host built; the code never goes anywhere to be
  // rendered. Losing the pairing clears the picture with it.
  const link = state?.pairing?.link ?? '';
  useEffect(() => {
    if (!link) { setQr(''); return; }
    let cancelled = false;
    void QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 180, color: { dark: '#0f140f', light: '#e8f0e4' } })
      .then(value => { if (!cancelled) setQr(value); })
      .catch(() => { if (!cancelled) setQr(''); });
    return () => { cancelled = true; };
  }, [link]);

  const act = async (kind: Exclude<typeof busy, ''>, action: () => Promise<unknown>, success = '') => {
    if (disabled || busy) return;
    const current = generation.current;
    setBusy(kind); setFailure(''); setNotice('');
    try {
      await action();
      if (generation.current === current && success) setNotice(success);
    } catch (cause) {
      if (generation.current === current) setFailure(cause instanceof Error ? cause.message : 'Не удалось изменить настройку.');
    } finally {
      if (generation.current === current) setBusy('');
    }
  };

  const saveUrl = () => act('url', async () => {
    setState(await bridge.setRelayUrl(urlInput));
    touchedUrl.current = false;
  }, 'Адрес сервера сохранён.');

  const saveLabel = () => act('label', async () => {
    setState(await bridge.setLabel(labelInput));
    touchedLabel.current = false;
  }, 'Имя этого компьютера сохранено.');

  const toggleEnabled = (enabled: boolean) => act('enable', async () => { setState(await bridge.setEnabled(enabled)); });
  // The name goes in with the pairing: it is the one moment the owner is thinking about which
  // computer this is, and it is sent to the server as part of `pair_start`.
  const startPairing = () => act('pair', async () => { setState(await bridge.startPairing(labelInput)); touchedLabel.current = false; });
  const cancelPairing = () => act('pair', async () => { setState(await bridge.cancelPairing()); });
  const confirmPairing = () => act('confirm', async () => { setState(await bridge.confirmPairing()); },
    'Подтверждено. Ждём, пока сервер выдаст ключ этой установке.');
  const unlink = () => act('unlink', async () => { setState(await bridge.unlink()); },
    'Установка отвязана. Сервер больше не получает ни названий бесед, ни их состояний.');

  const copy = (value: string) => { void navigator.clipboard?.writeText(value).catch(() => {}); };

  const locked = disabled || Boolean(busy);
  const encryption = state ? state.encryptionAvailable : true;
  const pairing = state?.pairing ?? null;

  return <section className="relay-connection" aria-label="Подключение к серверу">
    <h3><Server size={13} aria-hidden="true" />Подключение к серверу</h3>

    <div className="relay-connection-status" role="status">
      {loading || state?.connection === 'connecting' || state?.connection === 'pairing'
        ? <LoaderCircle size={14} className="spin" aria-hidden="true" />
        : state?.connection === 'online' ? <CircleCheck size={14} aria-hidden="true" /> : null}
      <span>
        <span>{loading ? 'Читаем настройку…' : state ? connectionText[state.connection] : 'Состояние неизвестно'}</span>
        {state?.owner && <small>Владелец: {state.owner.displayName} · ID {state.owner.telegramUserId}</small>}
        {state?.connection === 'online' && <small>Серверу видно разрешённых бесед: {state.publishedTabs}</small>}
      </span>
    </div>

    <p>Кузьмич сам подключается к серверу и держит связь: открытых портов на компьютере не появляется. На сервер уходят только название, агент, проект, состояние и длина очереди тех бесед, которым вы отдельно разрешили доступ. Переписка, пути и настройки не уходят никогда.</p>

    {!encryption && <p className="inline-error" role="alert">Шифрование Windows недоступно, поэтому ключ установки сохранить нельзя. Открытый ключ не сохраняется никогда.</p>}
    {(failure || state?.error) && <p className="inline-error" role="alert">{failure || state?.error}</p>}
    {notice && <p className="relay-connection-notice" role="status">{notice}</p>}

    <label className="settings-row relay-connection-toggle">
      <span>
        <strong>Держать связь с сервером</strong>
        <small>Выключение разрывает соединение и прекращает отправку состояний. Выданные беседам разрешения и привязка установки при этом сохраняются.</small>
      </span>
      <input type="checkbox" aria-label="Держать связь с сервером" checked={Boolean(state?.enabled)}
        disabled={locked || loading || !state} onChange={event => void toggleEnabled(event.target.checked)} />
    </label>

    <div className="relay-connection-block" aria-label="Адрес сервера">
      <h4><Server size={13} aria-hidden="true" />Адрес сервера</h4>
      <p>Укажите адрес вида <code>wss://имя-сервера</code>: путь приложение дописывает само, поэтому хвост <code>/bridge/v2</code> можно не писать — если он есть, он будет отброшен. Незашифрованный <code>ws://</code> принимается только для этого же компьютера — для проверки. Ключ установки в адресе не передаётся никогда, поэтому параметры в ссылке не допускаются.</p>
      <div className="relay-connection-form">
        <input type="text" className="text-input" autoComplete="off" spellCheck={false} placeholder="wss://relay.example.com"
          aria-label="Адрес relay-сервера" value={urlInput} disabled={locked}
          onChange={event => { touchedUrl.current = true; setUrlInput(event.target.value); }}
          onKeyDown={event => { if (event.key === 'Enter' && urlInput.trim()) void saveUrl(); }} />
        <button type="button" className="primary-button" disabled={locked || !urlInput.trim()} onClick={() => void saveUrl()}>
          {busy === 'url' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Server size={13} aria-hidden="true" />}
          Сохранить адрес
        </button>
      </div>
      {state?.linked && <p className="muted">Сменить сервер можно только после отвязки: существующий ключ установки другому серверу не предлагается.</p>}
    </div>

    {state?.linked && <div className="relay-connection-block" aria-label="Имя этого компьютера">
      <h4><Info size={13} aria-hidden="true" />Имя этого компьютера</h4>
      <p>Так установка называется в телефоне, если их несколько. Имя компьютера и имя пользователя Windows сами по себе никуда не уходят — уходит только то, что вы напишете здесь.</p>
      <div className="relay-connection-form">
        <input type="text" className="text-input" autoComplete="off" maxLength={64} placeholder="Кузьмич"
          aria-label="Имя этой установки" value={labelInput} disabled={locked}
          onChange={event => { touchedLabel.current = true; setLabelInput(event.target.value); }}
          onKeyDown={event => { if (event.key === 'Enter' && labelInput.trim()) void saveLabel(); }} />
        <button type="button" className="secondary-button" disabled={locked || !labelInput.trim()} onClick={() => void saveLabel()}>Сохранить имя</button>
      </div>
    </div>}

    <div className="relay-connection-block" aria-label="Привязка к Telegram">
      <h4><Smartphone size={13} aria-hidden="true" />Привязка к Telegram</h4>
      {state?.linked
        ? <>
            <p>Установка связана. Привязка даёт телефону личность, но не даёт доступа ни к одной беседе: каждую нужно разрешить отдельно здесь, на компьютере.</p>
            <div className="relay-connection-actions">
              <button type="button" className="danger-button" disabled={locked} onClick={() => void unlink()}><Unlink size={13} aria-hidden="true" />Отвязать установку</button>
            </div>
            <p className="muted">Отвязка действует сразу и не ждёт ответа сервера: без ключа установка всё равно не подключится.</p>
          </>
        : <>
            <p>Назовите этот компьютер, нажмите «Создать код» — и наведите на QR камеру телефона. Подтвердите привязку здесь, когда увидите, кто её запросил. Код показывается только на компьютере и живёт 10 минут.</p>

            {!pairing && <div className="relay-connection-form">
              <input type="text" className="text-input" autoComplete="off" maxLength={64} placeholder="Кузьмич"
                aria-label="Имя этой установки" value={labelInput} disabled={locked}
                onChange={event => { touchedLabel.current = true; setLabelInput(event.target.value); }} />
            </div>}
            {!pairing && <p className="muted">Так установка будет называться в телефоне, если их несколько. Имя компьютера и имя пользователя Windows сами по себе никуда не уходят.</p>}

            {pairing && <div className="relay-connection-code" role="status" aria-live="polite">
              {qr && <img className="relay-connection-qr" src={qr} width={180} height={180}
                alt={`QR-код для привязки установки «${pairing.label}»`} />}
              <code aria-label="Код привязки">{pairing.code}</code>
              <small>Установка «{pairing.label}». Действует до {formatExpiry(pairing.expiresAt)}.{pairing.link ? '' : ' Ждём, пока сервер назовёт имя бота.'}</small>
              {pairing.link && <div className="relay-connection-actions">
                <button type="button" className="secondary-button" onClick={() => copy(pairing.link as string)}><Copy size={13} aria-hidden="true" />Скопировать ссылку</button>
                <a className="secondary-button" href={pairing.link} rel="noreferrer">Открыть в Telegram</a>
              </div>}
            </div>}

            {pairing?.claimant && <div className="relay-connection-claim" role="alert">
              <strong>Привязку запросил: {pairing.claimant.displayName}</strong>
              <small>{pairing.claimant.username ? `@${pairing.claimant.username} · ` : ''}ID {pairing.claimant.telegramUserId}</small>
              <small>Подтверждайте, только если это вы. До подтверждения сервер не выдаёт ключ этой установке.</small>
              <div className="relay-connection-actions">
                <button type="button" className="primary-button" disabled={locked} onClick={() => void confirmPairing()}>
                  {busy === 'confirm' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <UserCheck size={13} aria-hidden="true" />}
                  Это я, подтвердить
                </button>
                <button type="button" className="secondary-button" disabled={locked} onClick={() => void cancelPairing()}>Это не я, отменить</button>
              </div>
            </div>}

            <div className="relay-connection-actions">
              <button type="button" className="primary-button" disabled={locked || !encryption || !state?.enabled || !state?.relayUrl} onClick={() => void startPairing()}>
                {busy === 'pair' && !pairing ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Smartphone size={13} aria-hidden="true" />}
                {pairing ? 'Создать новый код' : 'Создать код'}
              </button>
              {pairing && !pairing.claimant && <button type="button" className="secondary-button" disabled={locked} onClick={() => void cancelPairing()}>Отменить код</button>}
            </div>
            {state && (!state.enabled || !state.relayUrl) && <p className="muted">Код можно создать после сохранения адреса и включения связи.</p>}
          </>}
    </div>

    <div className="settings-explanation">
      <Info size={14} aria-hidden="true" />
      <p>Выбор сервера — это выбор того, кому доверено знать названия разрешённых бесед и их состояния и передавать в них текст. Прочитать переписку, открыть беседу, сменить модель или ответить за вас на запрос разрешения сервер не может: это остаётся на компьютере.</p>
    </div>
  </section>;
}

export default RelayConnectionSettings;
