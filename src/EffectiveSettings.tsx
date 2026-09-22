import type { AgentCapabilities, AgentDetails, AgentProvider, SettingSource, SettingSources } from './types';
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
const MCP_STATUS: Record<string, string> = { connected: 'подключён', failed: 'ошибка', 'needs-auth': 'нужен вход', pending: 'подключается', disabled: 'выключен' };

export default function EffectiveSettings({ provider, model, effort, access, sources, executable, cliVersion, capabilities, cwd, details, detailsLoading = false }: {
  provider: AgentProvider; model: string; effort: string; access: string; sources: SettingSources; executable: string; cliVersion: string; capabilities: AgentCapabilities; cwd: string; details?: AgentDetails | null; detailsLoading?: boolean;
}) {
  const skills = details?.commands.filter(command => !command.builtin) ?? [];
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
      {provider === 'claude' && <div className="effective-row" data-effective="skills"><dt>Навыки и команды</dt><dd>{detailsLoading && !details ? 'читаем…' : !details ? '—' : skills.length ? <details className="effective-list"><summary>{skills.length} пользовательских, {details.commands.length - skills.length} встроенных{details.agents.length ? `, субагентов: ${details.agents.length}` : ''}</summary><ul>{skills.map(command => <li key={command.name}><code>/{command.name}</code>{command.description && <small>{command.description}</small>}</li>)}{details.agents.map(agent => <li key={`agent:${agent.name}`}><code>{agent.name}</code><small>субагент{agent.description ? `: ${agent.description}` : ''}</small></li>)}</ul></details> : `только встроенные (${details.commands.length})`}</dd></div>}
      {provider === 'claude' && <div className="effective-row" data-effective="mcp"><dt>MCP-серверы</dt><dd>{detailsLoading && !details ? 'читаем…' : !details ? '—' : details.mcpServers === null ? <small className="effective-note">{details.mcpError || 'состояние недоступно'}</small> : details.mcpServers.length ? <ul className="effective-mcp">{details.mcpServers.map(server => <li key={server.name} data-mcp-status={server.status}><code>{server.name}</code> <span>{MCP_STATUS[server.status] || server.status}</span>{server.error && <small>{server.error}</small>}</li>)}</ul> : 'не настроены'}</dd></div>}
      <div className="effective-row"><dt>Возможности</dt><dd><ul className="effective-capabilities">{CAPABILITY_LABELS.map(item => <li key={item.key} data-capability={item.key} data-available={capabilities[item.key] ? 'true' : 'false'}>{capabilities[item.key] ? '✓' : '—'} {item.label}</li>)}</ul></dd></div>
    </dl>
  </section>;
}
