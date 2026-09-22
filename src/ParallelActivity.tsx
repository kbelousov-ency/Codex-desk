import { useEffect, useId, useRef, useState } from 'react';
import { Files, GitCompareArrows, Layers, X } from 'lucide-react';
import { parallelActivity, type ParallelSession } from './parallel-activity';
import './parallel-activity.css';

export default function ParallelActivity({ sessions, activeId, onActivate }: { sessions: ParallelSession[]; activeId: string; onActivate(id: string): void }) {
  const [opened, setOpened] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const activity = parallelActivity(sessions, activeId);
  const visible = Boolean(activity && opened);
  useEffect(() => { setOpened(false); }, [activeId]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpened(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpened(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [visible]);
  if (!activity) return null;
  const count = activity.overlaps.length;
  return <div className="parallel-activity">
    <button ref={button} type="button" className={`parallel-toggle ${count ? 'has-overlap' : ''}`} aria-label="Диалоги в общей папке" aria-expanded={visible} aria-controls={id} data-tooltip={`${activity.sessions.length} диалога в одной рабочей папке${count ? ` · Совпавших файлов: ${count}` : ''}`} onClick={() => setOpened(value => !value)}>
      {count ? <GitCompareArrows size={15} /> : <Layers size={15} />}<span className="parallel-label">Одна папка</span><span className="parallel-count">{activity.sessions.length}</span>{count > 0 && <span className="parallel-overlap-count" aria-label={`Совпавших файлов: ${count}`}>{count}</span>}
    </button>
    {visible && <div ref={panel} id={id} className="parallel-menu" role="region" aria-label="Диалоги в общей рабочей папке">
      <div className="parallel-heading"><strong>Общая рабочая папка</strong><button type="button" className="icon-button small" aria-label="Закрыть список параллельных диалогов" onClick={() => { setOpened(false); button.current?.focus(); }}><X size={14} /></button></div>
      <p className="parallel-folder">{activity.cwd}</p>
      <p className="parallel-explanation">Файлы общие для этих диалогов.</p>
      <div className="parallel-sessions">{activity.sessions.map(session => {
        const overlaps = activity.overlaps.filter(file => file.sessionIds.includes(session.id));
        const current = session.id === activeId;
        const status = session.terminalOpen ? 'Открыт в терминале' : session.pending ? 'Ожидает ответа' : session.loading ? 'Загружается' : session.busy ? 'Выполняется' : 'Готов';
        return <button type="button" key={session.id} className={`parallel-session ${current ? 'current' : ''}`} aria-current={current ? 'true' : undefined} onClick={() => { setOpened(false); onActivate(session.id); requestAnimationFrame(() => document.getElementById(`tab-${session.id}`)?.focus()); }}>
          <span className="parallel-session-title">{session.title || 'Новый диалог'}{current && <small>Текущая</small>}</span>
          <span className="parallel-session-status">{session.provider === 'claude' ? 'Claude Code' : 'Codex'} · {status}</span>
          {overlaps.length > 0 && <span className="parallel-session-files"><Files size={12} />{overlaps.map(file => file.label).join(', ')}</span>}
        </button>;
      })}</div>
      <p className={`parallel-overlap-note ${count ? 'has-overlap' : ''}`}>{count ? `Одни и те же файлы изменены в выполняющихся запросах: ${count}.` : 'Совпадений в выполняющихся запросах пока не видно.'}</p>
      <p className="parallel-explanation">Учитываются сообщённые агентом успешные изменения. Правки через команды и терминал могут быть не видны.</p>
    </div>}
  </div>;
}
