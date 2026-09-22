import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import './settings-dialog.css';

type SettingsTab = { id: string; label: string; icon: ReactNode; content: ReactNode };

export default function SettingsDialog({ tabs, active, busy, onClose }: {
  tabs: SettingsTab[]; active: boolean; busy: boolean; onClose(): void;
}) {
  const [selected, setSelected] = useState(tabs[0].id);
  const dialog = useRef<HTMLElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      if (previous?.isConnected && (element?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
    };
  }, [active]);

  // Disabling the focused save button can move focus to body before key events reach the dialog.
  useLayoutEffect(() => {
    if (!active || !busy) return;
    const focused = document.activeElement;
    if (focused === document.body || (focused instanceof HTMLElement && dialog.current?.contains(focused) && focused.matches(':disabled'))) {
      dialog.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.focus();
    }
  }, [active, busy]);

  const close = () => { if (!busy) onClose(); };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close();
    }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex="0"]') || [])
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    const first = elements[0], last = elements.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))) {
      event.preventDefault(); first.focus();
    }
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setSelected(tabs[next].id);
    tabButtons.current.get(tabs[next].id)?.focus();
  };

  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="settings-modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
      <div className="modal-header">
        <div><span className="eyebrow">CODEX DESK</span><h2 id={`${id}-title`}>Ваше рабочее пространство</h2></div>
        <button type="button" className="icon-button" data-tooltip="Закрыть настройки" aria-label="Закрыть настройки" disabled={busy} onClick={close}><X size={19} /></button>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Разделы настроек">
        {tabs.map((tab, index) => <button key={tab.id} ref={element => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id); }} type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`} aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1} disabled={busy} onClick={() => setSelected(tab.id)} onKeyDown={event => onTabKeyDown(event, index)}>
          {tab.icon}<span>{tab.label}</span>
        </button>)}
      </div>
      {/* Keep panels mounted: changing tabs must not reset MCP drafts, previews or pending writes. */}
      {tabs.map(tab => <div key={tab.id} className="settings-content settings-tab-panel" role="tabpanel" id={`${id}-panel-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`} hidden={selected !== tab.id} tabIndex={0}>{tab.content}</div>)}
      <div className="modal-footer"><span role="status">{busy ? 'Сохраняем правила памяти…' : 'Ваш код · Ваш терминал · Ваш выбор'}</span><button type="button" className="primary-button" disabled={busy} onClick={close}>Готово<Check size={15} /></button></div>
    </section>
  </div>;
}
