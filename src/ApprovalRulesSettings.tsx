import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ListChecks, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import type { ApprovalRule, ApprovalRuleKind, CodexBridge } from './types';
import './approval-rules.css';

const kindTitle: Record<ApprovalRuleKind, string> = {
  commands: 'Команды',
  paths: 'Папки для записи',
  hosts: 'Узлы сети',
};
const kindHint: Record<ApprovalRuleKind, string> = {
  commands: 'Команда и то, над чем она работает. Остальные аргументы свободны.',
  paths: 'Файлы прямо в этой папке. Суффикс /** охватывает и вложенные.',
  hosts: 'Обращение к этому узлу. Команда при этом тоже должна быть разрешена.',
};
const order: ApprovalRuleKind[] = ['commands', 'paths', 'hosts'];

/**
 * The standing approvals in force for this tab's project: what the user already agreed to, and the only
 * place to take it back. Revocation matters more than the list — a permission you cannot withdraw from the
 * interface is a permission the interface should never have granted.
 */
export default function ApprovalRulesSettings({ bridge, active }: { bridge: CodexBridge; active: boolean }) {
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await bridge.listApprovalRules();
      setRules(result.rules);
      setCwd(result.cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRules([]);
    }
  }, [bridge]);

  useEffect(() => { if (active) void load(); }, [active, load]);

  // Positions are 1-based in the order the host lists them, which is the order the host drops them by.
  const drop = async (position: number) => {
    setBusy(true); setError('');
    try {
      const result = await bridge.dropApprovalRule(position);
      setRules(result.rules);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void load();
    } finally { setBusy(false); }
  };

  return <section className="approval-rules-settings">
    <h3><ListChecks size={16} aria-hidden="true" />Правила подтверждения</h3>
    <p className="approval-rules-description">
      В режиме «По моим правилам» оболочка сама одобряет перечисленное здесь, а также команды только на
      чтение и git внутри проекта. Правило снимает вопрос, но не расширяет песочницу: всё, что здесь есть,
      вы могли подтвердить и кнопкой. Остальное по-прежнему спрашивается.
    </p>
    {cwd && <p className="approval-rules-project">Проект: <code>{cwd}</code></p>}
    {rules === null ? <p className="approval-rules-loading"><LoaderCircle size={14} className="spin" aria-hidden="true" />Читаем правила…</p>
      : rules.length === 0 ? <p className="approval-rules-empty">
        Сохранённых правил нет. Нажмите «Разрешить и запомнить» на карточке подтверждения — там показано
        точное правило, которое будет сохранено.
      </p>
        : <div className="approval-rules-groups">
          {order.filter(kind => rules.some(rule => rule.kind === kind)).map(kind => <div className="approval-rules-group" key={kind}>
            <div className="approval-rules-group-title"><strong>{kindTitle[kind]}</strong><span>{kindHint[kind]}</span></div>
            <ul>
              {rules.map((rule, index) => ({ rule, position: index + 1 })).filter(row => row.rule.kind === kind)
                .map(({ rule, position }) => <li key={`${rule.kind}-${rule.value}`}>
                  <code>{rule.value}</code>
                  <button className="icon-button" disabled={busy} aria-label={`Убрать правило ${rule.value}`}
                    data-tooltip="Убрать правило" onClick={() => void drop(position)}><Trash2 size={14} /></button>
                </li>)}
            </ul>
          </div>)}
        </div>}
    {error && <p className="approval-rules-error"><AlertTriangle size={14} aria-hidden="true" />{error}</p>}
    <div className="approval-rules-actions">
      <button className="secondary-button" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />Обновить</button>
    </div>
  </section>;
}
