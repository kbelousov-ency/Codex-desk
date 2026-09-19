import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Layers, Search, Unlink, X } from 'lucide-react';
import './change-turn-picker.css';

export type ChangeTurn = { id: string; number: number; text: string };
type Option = { id: string; title: string; description: string; number?: number };

export default function ChangeTurnPicker({ value, turns, unknown, active, onChange }: {
  value: string; turns: ChangeTurn[]; unknown: boolean; active: boolean; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(value);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const visible = open && active;
  const options = useMemo<Option[]>(() => [
    { id: 'all', title: 'Вся беседа', description: 'Все загруженные запросы' },
    ...[...turns].reverse().map(turn => ({ id: turn.id, number: turn.number, title: `Запрос ${turn.number}`, description: turn.text || 'Без текста сообщения' })),
    ...(unknown ? [{ id: 'unknown', title: 'Без привязки к запросу', description: 'Правки из ранней истории' }] : []),
  ], [turns, unknown]);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => words.every(word => `${option.title} ${option.description}`.toLocaleLowerCase().includes(word)));
  }, [options, query]);
  const current = options.find(option => option.id === value) || options[0];
  const highlighted = filtered.findIndex(option => option.id === highlight);
  const activeIndex = highlighted >= 0 ? highlighted : 0;
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    setQuery(''); setHighlight(value); setPosition({ visibility: 'hidden' }); setOpen(true);
  };
  const choose = (option: Option) => { onChange(option.id); close(true); };
  const navigate = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') {
      // Continue through the panel in DOM order, rather than from the portal at body end.
      trigger.current?.focus({ preventScroll: true }); close();
      if (event.shiftKey) event.preventDefault();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length) setHighlight(filtered[(activeIndex + (event.key === 'ArrowDown' ? 1 : filtered.length - 1)) % filtered.length].id);
    } else if (event.key === 'Enter' && event.target === search.current) {
      event.preventDefault();
      if (filtered[activeIndex]) choose(filtered[activeIndex]);
    }
  };

  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  useLayoutEffect(() => {
    if (visible && position.visibility === 'visible') search.current?.focus({ preventScroll: true });
  }, [visible, position.visibility]);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      if (!button?.width || !button.height) { setOpen(false); return; }
      const scroller = trigger.current?.closest('.panel-scroll')?.getBoundingClientRect();
      if (scroller && (button.bottom <= scroller.top || button.top >= scroller.bottom)) { setOpen(false); return; }
      const edge = 12, gap = 8;
      const width = Math.min(390, window.innerWidth - edge * 2);
      const above = Math.max(0, button.top - edge - gap);
      const below = Math.max(0, window.innerHeight - button.bottom - edge - gap);
      const upwards = below < 300 && above > below;
      setPosition({
        position: 'fixed', width, maxHeight: Math.min(460, upwards ? above : below),
        left: Math.max(edge, Math.min(button.right - width, window.innerWidth - edge - width)),
        ...(upwards ? { bottom: window.innerHeight - button.top + gap } : { top: button.bottom + gap }),
        visibility: 'visible',
      });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', onScroll, true); };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible || position.visibility !== 'visible') return;
    const option = document.getElementById(`${id}-option-${activeIndex}`);
    if (!list.current || !option) return;
    const bounds = list.current.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.bottom > bounds.bottom) list.current.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) list.current.scrollTop -= bounds.top - row.top;
  }, [visible, activeIndex, filtered, position, id]);

  return <div className="change-turn-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !menu.current?.contains(event.relatedTarget as Node | null)) close();
  }}>
    <span className="change-turn-label">Показать изменения</span>
    <button ref={trigger} type="button" className="change-turn-trigger" aria-label="Изменения по запросу" aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? `${id}-menu` : undefined} data-value={value} title={`${current.title} · ${current.description}`} onClick={() => visible ? close() : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
    }}>
      <span className="change-turn-trigger-icon"><Layers size={16} /></span>
      <span className="change-turn-current"><strong>{current.title}</strong><small>{current.description}</small></span>
      <ChevronDown size={14} className={visible ? 'change-turn-chevron-open' : ''} />
    </button>
    {visible && createPortal(<div ref={menu} id={`${id}-menu`} className="change-turn-menu" role="dialog" aria-label="Выбор запроса" style={position} onKeyDown={navigate}>
      <header><strong>Выбор запроса</strong><span>{turns.length}</span><button type="button" className="icon-button small" aria-label="Закрыть выбор запроса" onClick={() => close(true)}><X size={15} /></button></header>
      <div className="change-turn-search"><Search size={15} /><input ref={search} role="combobox" aria-label="Найти запрос" aria-autocomplete="list" aria-expanded={true} aria-controls={`${id}-list`} aria-activedescendant={filtered[activeIndex] ? `${id}-option-${activeIndex}` : undefined} placeholder="Найти по тексту или номеру…" autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setHighlight(''); }} /></div>
      <div className="change-turn-list" ref={list} id={`${id}-list`} role="listbox" aria-label="Запросы">
        {filtered.map((option, index) => <div key={option.id} id={`${id}-option-${index}`} role="option" aria-selected={option.id === value} data-value={option.id} title={`${option.title} · ${option.description}`} className={`change-turn-option ${option.number ? '' : 'change-turn-scope'} ${index === activeIndex ? 'highlighted' : ''}`} onPointerMove={() => setHighlight(option.id)} onPointerDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <span className="change-turn-number" aria-hidden="true">{option.number || (option.id === 'all' ? <Layers size={16} /> : <Unlink size={15} />)}</span>
          <span className="change-turn-option-copy"><strong>{option.title}</strong><span>{option.description}</span></span>
          <span className="change-turn-check">{option.id === value && <Check size={15} />}</span>
        </div>)}
      </div>
      {!filtered.length && <div className="change-turn-empty" role="status"><Search size={22} /><strong>Запросы не найдены</strong><span>Попробуйте другое слово или номер.</span></div>}
      <footer><span>Сначала последние</span><span><kbd>↑</kbd><kbd>↓</kbd> выбор <kbd>↵</kbd></span></footer>
    </div>, document.body)}
  </div>;
}
