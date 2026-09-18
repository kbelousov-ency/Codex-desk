import { Terminal } from 'lucide-react';
import type { CommandName, standardCommands } from './slash-commands';
import './commands.css';

export default function CommandMenu({ commands, selected, onSelect, onHighlight }: {
  commands: readonly typeof standardCommands[number][]; selected: number;
  onSelect(name: CommandName): void; onHighlight(index: number): void;
}) {
  return <div className="command-menu" role="listbox" aria-label="Команды Codex">
    <div className="command-menu-heading"><Terminal size={14} />Команды Codex Desk</div>
    {commands.map((command, index) => <button type="button" key={command.name} role="option" aria-selected={selected === index} data-command={command.name} className={`command-menu-option ${selected === index ? 'selected' : ''}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => onHighlight(index)} onClick={() => onSelect(command.name)}>
      <code>/{command.name}</code><span><strong>{command.label}</strong><small>{command.description}</small></span>
    </button>)}
  </div>;
}
