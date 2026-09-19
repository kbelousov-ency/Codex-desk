import type { AgentCapabilities, AgentProvider, SettingSource, SettingSources } from './types';
import { agentName } from './AgentContext';
import { accessLabel } from './AccessSelect';
import { cliVersionNote } from './cli-versions';

const SOURCE_LABELS: Record<SettingSource, string> = {
  tab: 'восстановлено из вкладки',
  saved: 'сохранённые настройки агента',
  cli: 'конфигурация CLI',
  default: 'значение по умолчанию',
  selected: 'выбрано в этой вкладке',
};
const CAPABILITY_LABELS: { key: keyof AgentCapabilities; label: string }[] = [
  { key: 'steer', label: 'уточнение во время работы' },
  { key: 'compact', label: 'сжатие контекста' },
  { key: 'terminal', label: 'продолжение в терминале' },
  { key: 'mcp', label: 'импорт MCP из приложения' },
  { key: 'archive', label: 'архив диалогов' },
];

/** Read-only summary of what this tab will actually send: values, where they came from, CLI and capabilities. */
export default function EffectiveSettings({ provider, model, effort, access, sources, executable, cliVersion, capabilities, cwd }: {
  provider: AgentProvider; model: string; effort: string; access: string; sources: SettingSources; executable: string; cliVersion: string; capabilities: AgentCapabilities; cwd: string;
}) {
  const note = cliVersionNote(provider, cliVersion);
  const row = (label: string, value: string, source?: SettingSource) => <div className="effective-row" key={label}><dt>{label}</dt><dd>{value || '—'}{source && <small>{SOURCE_LABELS[source]}</small>}</dd></div>;
  return <section className="settings-effective" aria-label="Действующие настройки">
    <strong>Действующие настройки</strong>
    <p className="muted">Что именно отправит эта вкладка и откуда взято каждое значение. Изменить модель, глубину и доступ можно под полем сообщения.</p>
    <dl>
      {row('Агент', agentName(provider))}
      {row('Модель', model, sources.model)}
      {row('Глубина размышлений', effort, sources.effort)}
      {row('Доступ', accessLabel(provider, access as never), sources.access)}
      {row('Рабочая папка', cwd)}
      <div className="effective-row"><dt>{agentName(provider)} CLI</dt><dd>{executable || 'автоматический поиск'}{cliVersion && <small>версия {cliVersion}</small>}{note && <small className="effective-note">{note}</small>}</dd></div>
      <div className="effective-row"><dt>Возможности</dt><dd><ul className="effective-capabilities">{CAPABILITY_LABELS.map(item => <li key={item.key} data-capability={item.key} data-available={capabilities[item.key] ? 'true' : 'false'}>{capabilities[item.key] ? '✓' : '—'} {item.label}</li>)}</ul></dd></div>
    </dl>
  </section>;
}
