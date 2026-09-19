import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Hand, Shield, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Access, AgentProvider } from './types';
import { agentName } from './AgentContext';
import './access-select.css';

const codexModes: { value: Access; label: string; description: string; icon: LucideIcon }[] = [
  { value: 'workspace-write', label: 'Спрашивать разрешение', description: 'Запрашивать разрешение на изменения вне проекта и доступ к сети', icon: Hand },
  { value: 'auto', label: 'Одобрять за меня', description: 'Автоматически проверять запросы на дополнительный доступ', icon: ShieldCheck },
  { value: 'danger-full-access', label: 'Полный доступ', description: 'Доступ к файлам и сети без запросов подтверждения', icon: ShieldAlert },
];

export default function AccessSelect({ value, disabled, active = true, onChange, openSignal = 0, provider = 'codex' }: {
  value: Access; disabled: boolean; active?: boolean; onChange(value: Access): void; openSignal?: number; provider?: AgentProvider;
}) {
  const engineName = agentName(provider);
  const modes = provider === 'claude' ? [
    { value: 'workspace-write' as Access, label: 'Спрашивать разрешение', description: 'Обычные подтверждения инструментов Claude Code', icon: Hand },
    { value: 'auto' as Access, label: 'Разрешать правки', description: 'Автоматически разрешать редактирование файлов; остальные инструменты проверяет Claude Code', icon: ShieldCheck },
    codexModes[2],
  ] : codexModes;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selectedIndex = modes.findIndex(mode => mode.value === value);
  const selected = Math.max(0, selectedIndex);
  const currentMode = modes[selectedIndex];
  const label = currentMode?.label ?? (value === 'read-only' ? (provider === 'claude' ? 'Планирование' : 'Только чтение') : `Как в ${engineName}`);
  const ModeIcon = currentMode?.icon ?? Shield;
  const visible = open && !disabled && active;
  useEffect(() => { if (openSignal && active && !disabled) { trigger.current?.focus(); setHighlight(selected); setOpen(true); } }, [openSignal]);
  useEffect(() => { if (disabled || !active) setOpen(false); }, [disabled, active]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  useEffect(() => {
    if (visible) document.getElementById(`${id}-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [visible, highlight, id]);
  const choose = (index: number) => {
    if (disabled) return;
    setOpen(false); trigger.current?.focus(); onChange(modes[index].value);
  };
  return <div ref={root} className={`access-select access-picker ${value === 'danger-full-access' ? 'full-access' : ''}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="access-trigger" role="combobox" aria-label="Режим доступа" aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? id : undefined} aria-activedescendant={visible ? `${id}-${highlight}` : undefined} disabled={disabled} data-value={value} onClick={() => { setHighlight(selected); setOpen(!visible); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key === 'Tab') { setOpen(false); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!visible) { setHighlight(selected); setOpen(true); }
        else setHighlight(index => (index + (event.key === 'ArrowDown' ? 1 : modes.length - 1)) % modes.length);
      } else if (visible && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault(); setHighlight(event.key === 'Home' ? 0 : modes.length - 1);
      } else if (visible && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(highlight); }
    }}><ModeIcon size={13} aria-hidden="true" /><span>{label}</span><ChevronDown size={11} aria-hidden="true" className={visible ? 'access-chevron-open' : ''} /></button>
    {visible && <div className="access-menu">
      <div className="access-menu-header">Как подтверждать действия {engineName}?</div>
      {!currentMode && <p id={`${id}-legacy`} className="access-current-note"><strong>Сейчас: {label}</strong><span>Текущий режим сохраняется до выбора одного из вариантов.</span></p>}
      <div id={id} role="listbox" aria-label="Выберите режим доступа" aria-describedby={!currentMode ? `${id}-legacy` : undefined}>
        {modes.map((mode, index) => <div role="option" aria-selected={value === mode.value} id={`${id}-${index}`} data-value={mode.value} key={mode.value} className={`access-option ${highlight === index ? 'highlighted' : ''} ${mode.value === 'danger-full-access' ? 'danger-option' : ''}`} onPointerMove={() => setHighlight(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <mode.icon className="access-option-icon" size={18} aria-hidden="true" />
          <div className="access-option-copy"><strong>{mode.label}</strong><small>{mode.description}</small></div>
          <span className="access-option-check">{value === mode.value && <Check size={16} aria-hidden="true" />}</span>
        </div>)}
      </div>
    </div>}
  </div>;
}
