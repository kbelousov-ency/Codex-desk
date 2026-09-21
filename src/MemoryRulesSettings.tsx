import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, CircleAlert, CircleCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import AgentLogo from './AgentLogo';
import type { AgentProvider } from './types';
import type { MemoryRulesPreview, MemoryRulesResult } from './memory-rules-types';
import './memory-rules-settings.css';

const allProviders: AgentProvider[] = ['codex', 'claude'];
const names: Record<AgentProvider, string> = { codex: 'Codex', claude: 'Claude' };
const message = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Не удалось прочитать или сохранить правила. Попробуйте ещё раз.';
type ProviderState = { preview?: MemoryRulesPreview; result?: MemoryRulesResult; loading?: boolean; error?: string };

export default function MemoryRulesSettings({ providers = allProviders, onBusyChange, disabled = false, showTitle = true }: {
  providers?: AgentProvider[];
  onBusyChange?(busy: boolean): void;
  disabled?: boolean;
  showTitle?: boolean;
}) {
  const bridge = window.codex.memoryRules;
  const [states, setStates] = useState<Partial<Record<AgentProvider, ProviderState>>>({});
  const [saving, setSaving] = useState<AgentProvider | null>(null);
  const generation = useRef(0);
  const writing = useRef(false);
  const reads = useRef(new Map<AgentProvider, number>());
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const providersKey = providers.join(',');

  const refresh = useCallback(async (provider: AgentProvider) => {
    if (!bridge || writing.current) return;
    const current = generation.current;
    const request = (reads.current.get(provider) || 0) + 1;
    reads.current.set(provider, request);
    setStates(previous => ({ ...previous, [provider]: { loading: true } }));
    try {
      const preview = await bridge.preview(provider);
      if (generation.current === current && reads.current.get(provider) === request) setStates(previous => ({ ...previous, [provider]: { preview } }));
    } catch (cause) {
      if (generation.current === current && reads.current.get(provider) === request) setStates(previous => ({ ...previous, [provider]: { error: message(cause) } }));
    }
  }, [bridge]);

  useEffect(() => {
    generation.current++;
    for (const provider of allProviders) if (providersKey.split(',').includes(provider)) void refresh(provider);
    return () => { generation.current++; };
  }, [providersKey, refresh]);

  const apply = async (provider: AgentProvider) => {
    const preview = states[provider]?.preview;
    if (!bridge || !preview || preview.conflict || disabled || writing.current) return;
    writing.current = true;
    setSaving(provider);
    busyCallback.current?.(true);
    const current = generation.current;
    setStates(previous => ({ ...previous, [provider]: { preview } }));
    try {
      const result = await bridge.apply({ provider, enabled: !preview.enabled, revision: preview.revision });
      if (generation.current === current) setStates(previous => ({ ...previous, [provider]: { preview: result, result } }));
    } catch (cause) {
      // The files may have changed since preview. Require a fresh read before retrying a write.
      if (generation.current === current) setStates(previous => ({ ...previous, [provider]: { error: message(cause) } }));
    } finally {
      writing.current = false;
      if (generation.current === current) setSaving(null);
      busyCallback.current?.(false);
    }
  };

  return <section className="memory-rules-settings" aria-label="Правила памяти">
    {showTitle && <h3><BookOpen size={17} />Правила памяти для всех проектов</h3>}
    <p className="memory-rules-description">Рекомендуем сохранять решения и причины, держать краткий индекс и проверять целостность заметок перед сжатием. Полное сжатие памяти не запускается автоматически.</p>
    <p className="memory-rules-description">Правила действуют в новых сессиях выбранного агента во всех проектах, включая терминал. После изменения откройте новый диалог; уже запущенный CLI перезапустите.</p>
    <p className="memory-rules-description">Включение добавит раздел к вашим глобальным инструкциям. Существующие инструкции сохранятся; перед изменением файлов создаются резервные копии. Отключение уберёт только раздел Codex Desk.</p>
    {!providers.length ? <p className="memory-rules-unavailable">Установите агента, чтобы подключить правила. Позже это можно сделать в настройках приложения.</p> : !bridge ? <p className="memory-rules-unavailable" role="status">Настройка правил доступна в установленном приложении Codex Desk.</p> : <div className="memory-rules-providers">{providers.map(provider => {
      const state = states[provider];
      const preview = state?.preview;
      const name = names[provider];
      return <section className="memory-rules-provider" key={provider} data-memory-provider={provider} aria-label={`Правила памяти ${name}`}>
        <div className="memory-rules-provider-title"><AgentLogo provider={provider} size={21} /><strong>{name}</strong><span className={preview?.enabled ? 'is-enabled' : ''}>{state?.loading ? 'Читаем инструкции…' : preview?.conflict ? 'Нужна проверка' : preview ? preview.enabled ? 'Подключены' : 'Не подключены' : 'Нет данных'}</span></div>
        {state?.loading && <div className="memory-rules-loading" role="status"><LoaderCircle size={15} className="spin" />Проверяем глобальные инструкции {name}</div>}
        {state?.error && <p className="memory-rules-error" role="alert"><CircleAlert size={15} />{state.error}</p>}
        {preview && <>
          <dl className="memory-rules-paths"><dt>Глобальные инструкции</dt><dd><code>{preview.instructionPath}</code></dd><dt>Полная процедура</dt><dd><code>{preview.procedurePath}</code></dd></dl>
          <details className="memory-rules-text"><summary>Текст правил для {name}</summary><pre>{preview.rulesText}</pre></details>
          <details className="memory-rules-text"><summary>Полная инструкция для {name}</summary><pre>{preview.procedureText}</pre></details>
          {preview.conflict && <p className="memory-rules-error" role="alert"><CircleAlert size={15} />{preview.conflict}</p>}
        </>}
        {state?.result && <div className="memory-rules-result" role="status"><CircleCheck size={16} /><div><strong>{state.result.enabled ? `Правила для ${name} включены` : `Правила для ${name} отключены`}</strong>{state.result.backupPaths.length > 0 && <><p>Резервные копии:</p><ul>{state.result.backupPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}</div></div>}
        <div className="memory-rules-actions">
          {preview && <button className="secondary-button" disabled={disabled || Boolean(saving) || Boolean(preview.conflict)} onClick={() => void apply(provider)}>{saving === provider && <LoaderCircle size={14} className="spin" />}{preview.enabled ? `Отключить для ${name}` : `Включить для ${name}`}</button>}
          <button className="secondary-button" disabled={Boolean(saving) || Boolean(state?.loading)} onClick={() => void refresh(provider)} aria-label={`Проверить правила ${name} снова`}><RefreshCw size={13} />{state?.error ? 'Попробовать снова' : 'Проверить снова'}</button>
        </div>
      </section>;
    })}</div>}
  </section>;
}
