import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Command, Search, X } from 'lucide-react';
import './command-palette.css';

export type PaletteCommand = {
  id: string;
  /** Group heading shown once per group, in the order groups first appear. */
  group: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon?: ComponentType<{ size?: number }>;
  disabled?: boolean;
  /** Extra words the filter matches, e.g. a folder path. */
  keywords?: string;
  run(): void;
};

const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е');
/** Every whitespace-separated query token must appear somewhere in label/hint/keywords. */
export function matchesPalette(command: Pick<PaletteCommand, 'label' | 'hint' | 'keywords' | 'group'>, query: string) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = normalize(`${command.group} ${command.label} ${command.hint || ''} ${command.keywords || ''}`);
  return tokens.every(token => haystack.includes(token));
}

/** Ctrl+K palette: tabs, dialogs and workspace actions in one searchable list. Nothing runs until Enter/click. */
export default function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    const matches = commands.filter(command => matchesPalette(command, query));
    return [...new Set(matches.map(command => command.group))].flatMap(group => matches.filter(command => command.group === group));
  }, [commands, query]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [index, visible.length]);
  useEffect(() => { setIndex(value => Math.min(value, Math.max(0, visible.length - 1))); }, [visible.length]);
  const run = (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };
  const groups: string[] = [];
  for (const command of visible) if (!groups.includes(command.group)) groups.push(command.group);
  let position = -1;
  return <div className="modal-backdrop command-palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Палитра команд" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])')];
        const position = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault(); controls[(position + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }
    }}>
      <div className="command-palette-search">
        <Search size={16} />
        <input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="Вкладка, диалог или действие…" aria-label="Найти команду" role="combobox" aria-expanded={true} aria-controls="command-palette-list" aria-activedescendant={visible[index] ? `palette-${visible[index].id}` : undefined} autoComplete="off" spellCheck={false}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (visible.length) setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length); }
            else if (event.key === 'Enter') { event.preventDefault(); run(visible[index]); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          }} />
        <kbd>Ctrl+K</kbd>
        <button type="button" className="icon-button small" aria-label="Закрыть палитру" onClick={onClose}><X size={15} /></button>
      </div>
      <div ref={list} id="command-palette-list" className="command-palette-list" role="listbox" aria-label="Команды">
        {!visible.length && <p className="command-palette-empty">Ничего не найдено.</p>}
        {groups.map(group => <div className="command-palette-group" key={group} role="group" aria-label={group}>
          <div className="command-palette-heading">{group}</div>
          {visible.filter(command => command.group === group).map(command => {
            position++;
            const current = position;
            const Icon = command.icon || Command;
            return <button type="button" tabIndex={-1} key={command.id} id={`palette-${command.id}`} role="option" aria-selected={current === index} aria-disabled={command.disabled || undefined} data-index={current} data-command-id={command.id} className={`command-palette-option ${current === index ? 'selected' : ''} ${command.disabled ? 'disabled' : ''}`}
              onPointerMove={() => setIndex(current)} onPointerDown={event => event.preventDefault()} onClick={() => run(command)}>
              <Icon size={14} /><span><strong>{command.label}</strong>{command.hint && <small>{command.hint}</small>}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>;
          })}
        </div>)}
      </div>
      <footer className="command-palette-footer"><span>↑ ↓ выбор · Enter выполнить · Esc закрыть</span><span>Ctrl+Tab — следующая вкладка · Ctrl+Shift+T — вернуть закрытую</span></footer>
    </section>
  </div>;
}
