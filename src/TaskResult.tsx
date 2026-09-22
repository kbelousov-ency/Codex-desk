import { FileText, ListChecks, Terminal } from 'lucide-react';
import type { TaskResult as TaskResultData } from './task-result';
import './task-result.css';

export type ResultActions = {
  onOpenResultFile?(path: string): void;
  onReviewResult?(turnId: string): void;
  onJumpToItem?(itemId: string): void;
};

export default function TaskResult({ result, onOpenResultFile, onReviewResult, onJumpToItem }: { result: TaskResultData } & ResultActions) {
  return <section className="task-result" aria-label="Результат запроса" data-result-turn-id={result.turnId}>
    <div className="task-result-heading"><ListChecks size={14} /><strong>Результат запроса</strong><span>По событиям хода работы</span></div>
    {result.files.length > 0 && <details className="task-result-section" open={result.files.length <= 3}>
      <summary><FileText size={13} />Файлы <span>{result.files.length}</span></summary>
      <ul>{result.files.map(file => <li key={file.key} className={file.failed ? 'has-error' : ''}>
        <div className="task-result-file"><span className="task-result-status">{file.label}</span>{onOpenResultFile ? <button type="button" className="task-result-path" data-tooltip={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => onOpenResultFile(file.path)}>{file.path}</button> : <span className="task-result-path">{file.path}</span>}</div>
        {onJumpToItem && <button type="button" className="task-result-source" aria-label={`Событие изменения: ${file.path}`} onClick={() => onJumpToItem(file.itemId)}>Событие</button>}
      </li>)}</ul>
      {onReviewResult && <button type="button" className="task-result-review" onClick={() => onReviewResult(result.turnId)}>Посмотреть изменения запроса</button>}
    </details>}
    {result.commands.length > 0 && <details className="task-result-section" open={result.commands.length <= 2}>
      <summary><Terminal size={13} />Команды <span>{result.commands.length}</span></summary>
      <ul>{result.commands.map(command => <li key={command.itemId} className={command.failed ? 'has-error' : ''}>
        <div className="task-result-command"><code data-tooltip={command.command}>{command.command}</code><span className="task-result-status">{command.status}</span></div>
        {onJumpToItem && <button type="button" className="task-result-source" aria-label={`Событие команды: ${command.command}`} onClick={() => onJumpToItem(command.itemId)}>Событие</button>}
      </li>)}</ul>
    </details>}
  </section>;
}
