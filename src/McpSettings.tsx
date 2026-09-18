import { useEffect, useRef, useState } from 'react';
import { Check, CircleCheck, LoaderCircle, Plus, Plug, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { CodexBridge } from './types';
import './mcp-settings.css';

type Config = Awaited<ReturnType<CodexBridge['getMcpConfig']>>;
type Preview = Awaited<ReturnType<CodexBridge['previewMcpImport']>>;
type CheckResult = Awaited<ReturnType<CodexBridge['checkMcp']>>;
type ServerSummary = Config['servers'][number];
type Action = 'load' | 'preview' | 'save' | 'apply' | 'check' | null;

function ServerRow({ server, exists = false }: { server: ServerSummary; exists?: boolean }) {
  return <li className="mcp-server-row">
    <Server size={14} aria-hidden="true" />
    <div className="mcp-server-info">
      <div className="mcp-server-title"><strong>{server.name}</strong><span>{server.transport === 'http' ? 'HTTP' : 'Команда'}</span>{!server.enabled && <span>Выключен</span>}{exists && <span className="mcp-conflict-tag">Уже существует</span>}</div>
      <code>{server.address}</code>
      {!!server.headerNames.length && <small>Заголовки: {server.headerNames.join(', ')} · значения скрыты</small>}
      {!!server.envNames.length && <small>Переменные: {server.envNames.join(', ')} · значения скрыты</small>}
    </div>
  </li>;
}

const statusLabels: Record<string, string> = {
  ready: 'Подключён', connected: 'Подключён', available: 'Доступен', enabled: 'Включён',
  disabled: 'Выключен', unavailable: 'Недоступен', disconnected: 'Не подключён',
  error: 'Ошибка подключения', failed: 'Ошибка подключения', unknown: 'Нет данных',
  notStarted: 'Ещё не подключён', starting: 'Подключается', authenticationRequired: 'Нужна авторизация', cancelled: 'Подключение отменено',
  authRequired: 'Нужна авторизация', auth_required: 'Нужна авторизация',
};
const authLabels: Record<string, string> = {
  unsupported: 'Авторизация OAuth не используется', notLoggedIn: 'Нужен вход',
  bearerToken: 'Токен настроен', oAuth: 'Вход через OAuth', oauth: 'Вход через OAuth',
  not_logged_in: 'Нужен вход', bearer_token: 'Токен настроен', unknown: 'Нет данных об авторизации',
};

export default function McpSettings({ bridge, active, onApplied }: { bridge: CodexBridge; active: boolean; onApplied?(): void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [editor, setEditor] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [replace, setReplace] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    pending.current = active;
    setText(''); setPreview(null); setReplace(false); setEditor(false);
    setConfig(null); setChecked(null); setError(''); setNotice(''); setBackupPath(null);
    setAction(active ? 'load' : null);
    if (active) {
      void bridge.getMcpConfig().then(result => {
        if (generation.current === current) setConfig(result);
      }).catch(cause => {
        if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать конфигурацию MCP.');
      }).finally(() => {
        if (generation.current === current) { pending.current = false; setAction(null); }
      });
    }
    return () => { generation.current++; pending.current = false; };
  }, [bridge, active]);

  const run = async (kind: Exclude<Action, null>, operation: (current: number) => Promise<void>) => {
    if (!active || pending.current) return;
    pending.current = true;
    const current = generation.current;
    setAction(kind); setError('');
    try { await operation(current); }
    catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие с MCP.');
    } finally {
      if (generation.current === current) { pending.current = false; setAction(null); }
    }
  };

  const resetEditor = () => {
    setText(''); setPreview(null); setReplace(false); setEditor(false); setError('');
  };
  const startEditor = () => {
    resetEditor(); setEditor(true); setNotice(''); setBackupPath(null);
  };
  const inspect = () => {
    if (!text.trim() || pending.current) return;
    const input = text;
    setText(''); setPreview(null); setReplace(false);
    void run('preview', async current => {
      const result = await bridge.previewMcpImport(input);
      if (generation.current === current) setPreview(result);
    });
  };
  const save = () => {
    if (!preview || (preview.conflicts.length > 0 && !replace)) return;
    void run('save', async current => {
      const result = await bridge.saveMcpImport({ previewId: preview.previewId, replaceExisting: replace });
      if (generation.current !== current) return;
      resetEditor(); setChecked(null); setBackupPath(result.backupPath);
      setNotice(result.message || `Сохранено серверов: ${result.servers.length}.`);
      const refreshed = await bridge.getMcpConfig();
      if (generation.current === current) setConfig(refreshed);
    });
  };
  const apply = () => void run('apply', async current => {
    const result = await bridge.reloadMcp();
    if (generation.current !== current) return;
    setNotice(result.message); setChecked(null);
    if (result.status === 'applied') onApplied?.();
  });
  const check = () => void run('check', async current => {
    const result = await bridge.checkMcp();
    if (generation.current === current) setChecked(result);
  });

  if (!active) return null;
  return <section className="mcp-settings" aria-label="MCP-серверы">
    <div className="mcp-heading"><div><Plug size={16} aria-hidden="true" /><h3>MCP-серверы</h3></div>{!editor && <button type="button" className="secondary-button" disabled={!!action} onClick={startEditor}><Plus size={13} />Добавить из текста</button>}</div>
    <p className="mcp-caption">Серверы пользовательской конфигурации Codex доступны и в приложении, и в терминале. Настройки проекта могут их переопределять.</p>
    {config && <div className="mcp-config-path"><span>Файл конфигурации</span><code>{config.configPath}</code></div>}
    {action === 'load' && <p className="mcp-inline-status" role="status"><LoaderCircle size={13} className="spin" />Читаем конфигурацию…</p>}
    {config && <>{config.servers.length ? <ul className="mcp-server-list" aria-label="Настроенные MCP-серверы">{config.servers.map(server => <ServerRow key={server.name} server={server} />)}</ul> : <p className="mcp-empty">MCP-серверы пока не добавлены.</p>}</>}
    {editor && <div className="mcp-import">
      {preview ? <>
        <div className="mcp-preview-heading"><ShieldCheck size={14} /><strong>Будут сохранены</strong><span>Секретные значения скрыты</span></div>
        <ul className="mcp-server-list" aria-label="Предпросмотр импорта MCP">{preview.servers.map(server => <ServerRow key={server.name} server={server} exists={server.exists} />)}</ul>
        {preview.conflicts.length > 0 && <label className="mcp-replace"><input type="checkbox" aria-label="Обновить существующие серверы" checked={replace} disabled={!!action} onChange={event => setReplace(event.currentTarget.checked)} /><span>Обновить существующие серверы<small>{preview.conflicts.join(', ')}. Их настройки будут заменены целиком.</small></span></label>}
        <div className="mcp-import-actions"><button type="button" className="primary-button" disabled={!!action || (preview.conflicts.length > 0 && !replace)} onClick={save}>{action === 'save' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{action === 'save' ? 'Сохраняем…' : 'Сохранить MCP'}</button><button type="button" className="secondary-button" disabled={!!action} onClick={() => { setPreview(null); setReplace(false); setText(''); setError(''); }}>Изменить текст</button><button type="button" className="text-button" disabled={!!action} onClick={resetEditor}>Отмена</button></div>
      </> : <>
        <label className="mcp-paste-label">Вставьте JSON с <code>mcpServers</code> или TOML <code>[mcp_servers.…]</code><textarea aria-label="Конфигурация MCP" autoFocus spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" rows={6} maxLength={262144} value={text} disabled={!!action} onChange={event => { setText(event.currentTarget.value); setPreview(null); setReplace(false); setError(''); }} placeholder={'{\n  "mcpServers": {\n    "example": { "type": "http", "url": "http://server:8500/mcp" }\n  }\n}'} /></label>
        <p className="mcp-caption">Текст обрабатывается локально. После проверки поле очищается; значения токенов и заголовков не показываются в предпросмотре.</p>
        <div className="mcp-import-actions"><button type="button" className="primary-button" disabled={!!action || !text.trim()} onClick={inspect}>{action === 'preview' ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={13} />}{action === 'preview' ? 'Проверяем…' : 'Проверить текст'}</button><button type="button" className="text-button" disabled={!!action} onClick={resetEditor}>Отмена</button></div>
      </>}
    </div>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
    {notice && <div className="mcp-notice" role="status"><CircleCheck size={14} /><span>{notice}</span></div>}
    {backupPath && <div className="mcp-backup"><span>Резервная копия предыдущей конфигурации</span><code>{backupPath}</code></div>}
    <div className="mcp-connection-actions"><button type="button" className="secondary-button" disabled={!!action || !config} onClick={apply}><RefreshCw size={13} className={action === 'apply' ? 'spin' : ''} />{action === 'apply' ? 'Применяем…' : 'Применить в этой сессии'}</button><button type="button" className="secondary-button" disabled={!!action || !config} onClick={check}>{action === 'check' ? <LoaderCircle size={13} className="spin" /> : <Plug size={13} />}{action === 'check' ? 'Проверяем…' : 'Проверить подключение'}</button></div>
    <p className="mcp-caption">Новые сессии прочитают сохранённые настройки автоматически. Для текущей сессии примените их после завершения задачи.</p>
    {checked && <div className="mcp-check-result" role="status">{checked.message && <p>{checked.message}</p>}{checked.servers.length ? <ul aria-label="Подключения MCP текущей сессии">{checked.servers.map(server => <li key={server.name}><strong>{server.name}</strong><span>{statusLabels[server.status] || 'Нет данных'} · инструментов: {server.toolCount}</span><small>{authLabels[server.authStatus] || 'Нет данных об авторизации'}</small></li>)}</ul> : <p>В текущей сессии нет подключённых MCP-серверов.</p>}</div>}
  </section>;
}
