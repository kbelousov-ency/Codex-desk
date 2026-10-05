import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, CircleAlert, Copy, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import AgentLogo from './AgentLogo';
import type { AgentProvider, AgentSkill, AgentSkillSource, AgentSkillsSnapshot } from './types';
import './skills-settings.css';

const PROVIDERS: AgentProvider[] = ['codex', 'claude'];
const NAMES: Record<AgentProvider, string> = { codex: 'Codex', claude: 'Claude Code' };
const SOURCES: { key: AgentSkillSource; label: string; hint: string }[] = [
  { key: 'project', label: 'Проектные', hint: 'Лежат в рабочей папке и действуют только в ней.' },
  { key: 'user', label: 'Пользовательские', hint: 'Каталог агента в вашем профиле.' },
  { key: 'shared', label: 'Общие для агентов', hint: 'Каталог ~/.agents/skills, который читают оба агента.' },
  { key: 'synced', label: 'Синхронизированные', hint: 'Получены из вашей учётной записи.' },
  { key: 'plugin', label: 'Из плагинов', hint: 'Входят в установленные плагины и marketplace.' },
];
const message = (cause: unknown) => cause instanceof Error
  ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  : 'Не удалось прочитать список навыков. Попробуйте ещё раз.';
type ProviderState = { snapshot?: AgentSkillsSnapshot; loading?: boolean; error?: string };

/** Read-only list of the SKILL.md files installed for each agent. Nothing here enables, writes or sends a skill. */
export default function SkillsSettings({ provider, cwd, active = true }: { provider: AgentProvider; cwd: string; active?: boolean }) {
  const bridge = window.codex.skills;
  const [selected, setSelected] = useState<AgentProvider>(provider);
  const [states, setStates] = useState<Partial<Record<AgentProvider, ProviderState>>>({});
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const requests = useRef(new Map<AgentProvider, symbol>());
  const loaded = useRef(new Set<AgentProvider>());
  const tabButtons = useRef(new Map<AgentProvider, HTMLButtonElement>());

  const refresh = useCallback(async (agent: AgentProvider) => {
    if (!bridge) return;
    const request = Symbol();
    requests.current.set(agent, request);
    setStates(previous => ({ ...previous, [agent]: { ...previous[agent], loading: true, error: undefined } }));
    try {
      const snapshot = await bridge.list({ provider: agent, cwd });
      if (requests.current.get(agent) === request) setStates(previous => ({ ...previous, [agent]: { snapshot } }));
    } catch (cause) {
      if (requests.current.get(agent) === request) setStates(previous => ({ ...previous, [agent]: { error: message(cause) } }));
    }
  }, [bridge, cwd]);

  // The working folder decides which project skills exist, so a changed cwd invalidates every read.
  useEffect(() => { loaded.current.clear(); requests.current.clear(); setStates({}); }, [cwd]);
  useEffect(() => {
    if (!active || !bridge || loaded.current.has(selected)) return;
    loaded.current.add(selected);
    void refresh(selected);
  }, [active, bridge, selected, refresh]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? PROVIDERS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + PROVIDERS.length) % PROVIDERS.length;
    setSelected(PROVIDERS[next]);
    tabButtons.current.get(PROVIDERS[next])?.focus();
  };

  const copyPath = (skill: AgentSkill) => {
    void navigator.clipboard.writeText(skill.path).then(() => {
      setCopied(skill.id);
      setTimeout(() => setCopied(current => current === skill.id ? null : current), 1500);
    }).catch(() => setCopied(null));
  };

  const state = states[selected];
  const snapshot = state?.snapshot;
  const needle = query.trim().toLowerCase();
  const visible = (snapshot?.skills || []).filter(skill => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle));

  return <section className="skills-settings" aria-label="Установленные навыки">
    <h3><Sparkles size={17} />Установленные навыки</h3>
    <p className="skills-description">Список читается из файлов <code>SKILL.md</code> на этом компьютере. Приложение ничего не включает и не изменяет: какие навыки применить, решает сам агент по своим настройкам.</p>
    <div className="skills-agent-tabs" role="tablist" aria-label="Агент навыков">
      {PROVIDERS.map((agent, index) => <button key={agent} ref={element => { if (element) tabButtons.current.set(agent, element); else tabButtons.current.delete(agent); }}
        type="button" role="tab" id={`skills-tab-${agent}`} aria-controls={`skills-panel-${agent}`} aria-selected={selected === agent} tabIndex={selected === agent ? 0 : -1}
        data-skills-agent={agent} onClick={() => setSelected(agent)} onKeyDown={event => onTabKeyDown(event, index)}>
        <AgentLogo provider={agent} size={17} /><span>{NAMES[agent]}</span>
        {states[agent]?.snapshot && <span className="skills-count">{states[agent]!.snapshot!.skills.length}</span>}
      </button>)}
    </div>
    <div className="skills-panel" role="tabpanel" id={`skills-panel-${selected}`} aria-labelledby={`skills-tab-${selected}`}>
      {!bridge ? <p className="skills-unavailable" role="status">Список навыков доступен в установленном приложении Codex Desk.</p> : <>
        <div className="skills-toolbar">
          <input type="search" value={query} placeholder="Поиск по названию и описанию" aria-label="Поиск по навыкам" onChange={event => setQuery(event.target.value)} />
          <button type="button" className="secondary-button" disabled={state?.loading} onClick={() => void refresh(selected)}><RefreshCw size={13} />{state?.loading ? 'Читаем…' : 'Обновить'}</button>
        </div>
        {state?.loading && !snapshot && <p className="skills-loading" role="status"><LoaderCircle size={15} className="spin" />Читаем каталоги навыков {NAMES[selected]}</p>}
        {state?.error && <p className="skills-error" role="alert"><CircleAlert size={15} />{state.error}</p>}
        {snapshot && <>
          <p className="skills-summary" role="status">{snapshot.skills.length ? `Найдено навыков: ${snapshot.skills.length}${needle ? `, показано ${visible.length}` : ''}` : 'Навыки не найдены. Проверенные каталоги показаны ниже.'}{snapshot.truncated && ' · показаны первые 500'}</p>
          {SOURCES.map(group => {
            const items = visible.filter(skill => skill.source === group.key);
            if (!items.length) return null;
            return <section className="skills-group" key={group.key} data-skills-source={group.key}>
              <h4>{group.label}<span>{items.length}</span></h4>
              <p className="skills-group-hint">{group.hint}</p>
              <ul>{items.map(skill => <li key={skill.id}>
                <div className="skills-item-title"><code>{skill.name}</code>{skill.plugin && <span className="skills-plugin">плагин: {skill.plugin}</span>}
                  <button type="button" className="icon-button" aria-label={`Скопировать путь к навыку ${skill.name}`} data-tooltip="Скопировать путь" onClick={() => copyPath(skill)}>{copied === skill.id ? <Check size={13} /> : <Copy size={13} />}</button>
                </div>
                {skill.description && <p>{skill.description}</p>}
                <small title={[skill.path, ...(skill.duplicates || [])].join('\n')}>{skill.path}{skill.duplicates && ` · копий ещё: ${skill.duplicates.length}`}</small>
              </li>)}</ul>
            </section>;
          })}
          <details className="skills-roots"><summary>Где искали ({snapshot.roots.filter(root => root.exists).length} из {snapshot.roots.length} каталогов найдено)</summary>
            <ul>{snapshot.roots.map(root => <li key={root.path} data-skills-root={root.exists ? 'found' : 'missing'}><code>{root.path}</code><span>{root.exists ? `навыков: ${root.count}` : 'каталога нет'}</span></li>)}</ul>
          </details>
          {snapshot.errors.length > 0 && <div className="skills-issues" role="status"><strong>Не удалось прочитать:</strong><ul>{snapshot.errors.map(issue => <li key={issue.path}><code>{issue.path}</code><small>{issue.message}</small></li>)}</ul></div>}
        </>}
      </>}
    </div>
  </section>;
}
