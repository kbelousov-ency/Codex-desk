import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, ExternalLink, KeyRound, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import type { ClaudeAuthStatus, ClaudeTokenInfo, CodexBridge } from './types';
import './claude-auth-settings.css';

const formatSavedAt = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function ClaudeAuthSettings({ bridge, disabled, loginInProgress }: { bridge: CodexBridge; disabled: boolean; loginInProgress: boolean }) {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState<ClaudeTokenInfo | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState<'' | 'load' | 'save' | 'clear' | 'setup'>('load');
  const [tokenError, setTokenError] = useState('');
  const [tokenNotice, setTokenNotice] = useState('');
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const authEvent = useRef(0);
  const launchPending = useRef(false);

  const refresh = useCallback(async (clearError = true) => {
    const current = generation.current;
    const request = ++statusRequest.current;
    setChecking(true);
    if (clearError) setError('');
    try {
      const result = await bridge.getClaudeAuthStatus();
      if (generation.current !== current || statusRequest.current !== request) return;
      setStatus(result); setWaiting(result.loginInProgress);
    } catch (cause) {
      if (generation.current !== current || statusRequest.current !== request) return;
      setStatus(null);
      setError(cause instanceof Error ? cause.message : 'Не удалось проверить вход в Claude Code.');
    } finally {
      if (generation.current === current && statusRequest.current === request) setChecking(false);
    }
  }, [bridge]);

  const loadToken = useCallback(async () => {
    const current = generation.current;
    setTokenBusy('load');
    try {
      const info = await bridge.getClaudeToken();
      if (generation.current !== current) return;
      setToken(info); setTokenError(info.error || '');
    } catch (cause) {
      if (generation.current !== current) return;
      setToken(null); setTokenError(cause instanceof Error ? cause.message : 'Не удалось прочитать настройку токена.');
    } finally { if (generation.current === current) setTokenBusy(''); }
  }, [bridge]);

  useEffect(() => {
    generation.current++;
    setStatus(null); setWaiting(false); setLaunching(false); launchPending.current = false;
    setToken(null); setTokenInput(''); setTokenError(''); setTokenNotice('');
    const unsubscribe = bridge.onEvent(event => {
      if (event.type !== 'auth') return;
      authEvent.current++;
      statusRequest.current++;
      setChecking(false);
      if (event.data.state === 'opened') { setWaiting(true); setError(''); }
      else {
        setWaiting(false); setStatus(null); setError(event.data.error || '');
        // Closing the CLI window alone does not prove that web authentication succeeded.
        void refresh(false);
      }
    });
    void refresh();
    void loadToken();
    return () => { generation.current++; statusRequest.current++; unsubscribe(); };
  }, [bridge, refresh, loadToken]);

  const inProgress = loginInProgress || launching || waiting;
  const login = async () => {
    if (disabled || checking || inProgress || launchPending.current) return;
    const current = generation.current;
    const event = authEvent.current;
    launchPending.current = true;
    setLaunching(true); setError('');
    try {
      await bridge.loginClaude();
      if (generation.current === current && authEvent.current === event) setWaiting(true);
    } catch (cause) {
      if (generation.current !== current) return;
      setWaiting(false);
      setError(cause instanceof Error ? cause.message : 'Не удалось запустить вход в Claude Code.');
    } finally {
      if (generation.current === current) { launchPending.current = false; setLaunching(false); }
    }
  };

  const applyToken = async (action: 'save' | 'clear') => {
    if (disabled || inProgress || tokenBusy) return;
    const current = generation.current;
    setTokenBusy(action); setTokenError(''); setTokenNotice('');
    try {
      const info = action === 'save' ? await bridge.setClaudeToken(tokenInput) : await bridge.clearClaudeToken();
      if (generation.current !== current) return;
      setToken(info); setTokenInput('');
      const restarted = info.restarted ? ` Переподключено вкладок Claude: ${info.restarted}.` : '';
      const busy = info.busy ? ` Занятых вкладок, которые применят изменение при следующем подключении: ${info.busy}.` : '';
      setTokenNotice((action === 'save' ? 'Токен сохранён и зашифрован. Новые процессы Claude Code используют его вместо общего файла входа.' : 'Токен удалён. Процессы Claude Code снова используют общий вход из браузера.') + restarted + busy);
    } catch (cause) {
      if (generation.current !== current) return;
      setTokenError(cause instanceof Error ? cause.message : 'Не удалось изменить токен.');
    } finally { if (generation.current === current) setTokenBusy(''); }
  };

  const setupToken = async () => {
    if (disabled || inProgress || tokenBusy) return;
    const current = generation.current;
    setTokenBusy('setup'); setTokenError(''); setTokenNotice('');
    try {
      await bridge.setupClaudeToken();
      if (generation.current !== current) return;
      setTokenNotice('Открыт терминал Claude Code. Завершите вход в браузере, скопируйте строку sk-ant-oat… из терминала и вставьте её в поле ниже.');
    } catch (cause) {
      if (generation.current !== current) return;
      setTokenError(cause instanceof Error ? cause.message : 'Не удалось открыть терминал Claude Code.');
    } finally { if (generation.current === current) setTokenBusy(''); }
  };

  const tokenLocked = disabled || inProgress || Boolean(tokenBusy);
  return <section className="claude-auth-settings" aria-label="Авторизация Claude Code">
    <h3>Авторизация Claude Code</h3>
    <div className="claude-auth-status" role="status">
      {inProgress || checking ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : status?.loggedIn ? <CircleCheck size={14} aria-hidden="true" /> : null}
      <span><span>{inProgress ? 'Вход выполняется в Claude CLI…' : checking ? 'Проверяем вход…' : status ? status.loggedIn ? 'Вход выполнен' : 'Вход не выполнен' : 'Статус входа неизвестен'}</span>
        {!inProgress && !checking && status?.loggedIn && status.email && <small>{status.email}</small>}
      </span>
    </div>
    <p>Откроется окно штатного Claude CLI и браузер. Вход общий с терминалом. После завершения подключения Claude в приложении обновятся.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="claude-auth-actions">
      <button type="button" className="primary-button" disabled={disabled || checking || inProgress} onClick={() => void login()}><ExternalLink size={13} aria-hidden="true" />Войти через браузер</button>
      <button type="button" className="secondary-button" disabled={checking || launching} onClick={() => void refresh()}><RefreshCw size={13} className={checking ? 'spin' : ''} aria-hidden="true" />Проверить вход</button>
    </div>
    {disabled && !inProgress && <p className="muted">Вход будет доступен после завершения текущей операции.</p>}

    <div className="claude-token" aria-label="Постоянный токен Claude Code">
      <h4><KeyRound size={13} aria-hidden="true" />Постоянный токен для этого приложения</h4>
      <div className="claude-auth-status" role="status">
        {tokenBusy === 'load' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : token?.configured ? <CircleCheck size={14} aria-hidden="true" /> : null}
        <span><span>{tokenBusy === 'load' ? 'Читаем настройку…' : token?.configured ? 'Токен сохранён' : 'Токен не настроен'}</span>
          {token?.configured && token.savedAt && <small>Сохранён {formatSavedAt(token.savedAt)}. Токены claude setup-token действуют около года.</small>}
        </span>
      </div>
      <p>Обычный вход через браузер хранит одноразовый refresh-токен в общем файле, за который конкурируют Claude Desktop, расширения IDE и параллельные вкладки. Проигравший процесс получает отказ сервера и стирает вход. Постоянный токен из команды <code>claude setup-token</code> передаётся только процессам Claude Code этого приложения через переменную <code>CLAUDE_CODE_OAUTH_TOKEN</code>, хранится зашифрованным средствами Windows и не попадает в настройки и снимки рабочего места.</p>
      {token && !token.encryptionAvailable && <p className="inline-error" role="alert">Шифрование Windows недоступно, токен сохранить нельзя.</p>}
      {tokenError && <p className="inline-error" role="alert">{tokenError}</p>}
      {tokenNotice && <p className="claude-token-notice" role="status">{tokenNotice}</p>}
      <div className="claude-token-form">
        <input type="password" className="text-input" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat01-…" aria-label="Токен Claude Code" value={tokenInput} disabled={tokenLocked || token?.encryptionAvailable === false} onChange={event => setTokenInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && tokenInput.trim()) void applyToken('save'); }} />
        <button type="button" className="primary-button" disabled={tokenLocked || !tokenInput.trim() || token?.encryptionAvailable === false} onClick={() => void applyToken('save')}>{tokenBusy === 'save' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}{token?.configured ? 'Заменить' : 'Сохранить'}</button>
      </div>
      <div className="claude-auth-actions">
        <button type="button" className="secondary-button" disabled={tokenLocked} onClick={() => void setupToken()}><ExternalLink size={13} aria-hidden="true" />Получить токен: claude setup-token</button>
        {token?.configured && <button type="button" className="secondary-button" disabled={tokenLocked} onClick={() => void applyToken('clear')}><Trash2 size={13} aria-hidden="true" />Удалить токен</button>}
      </div>
    </div>
  </section>;
}
