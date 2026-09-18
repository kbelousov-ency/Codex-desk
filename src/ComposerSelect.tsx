import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './composer-select.css';

export type ComposerOption = { value: string; label: string };

export default function ComposerSelect({ label, value, options, icon, disabled, active = true, kind, onChange, openSignal = 0 }: {
  label: string; value: string; options: ComposerOption[]; icon: ReactNode;
  disabled: boolean; active?: boolean; kind: 'model' | 'effort'; onChange(value: string): void; openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const visible = open && active && !disabled && options.length > 0;
  const current = options.find(option => option.value === value)?.label || value || 'По умолчанию';
  const show = () => {
    if (disabled || !active || !options.length) return;
    setHighlight(selected); setPosition({ visibility: 'hidden' }); setOpen(true);
    document.dispatchEvent(new CustomEvent('codex:composer-menu', { detail: id }));
  };
  const choose = (index: number) => {
    if (disabled || !active || !options[index]) return;
    setOpen(false); trigger.current?.focus(); onChange(options[index].value);
  };
  useEffect(() => { if (openSignal && active && !disabled) { trigger.current?.focus(); show(); } }, [openSignal]);
  useEffect(() => { if (disabled || !active) setOpen(false); }, [disabled, active]);
  useEffect(() => {
    const otherMenu = (event: Event) => { if ((event as CustomEvent).detail !== id) setOpen(false); };
    document.addEventListener('codex:composer-menu', otherMenu);
    return () => document.removeEventListener('codex:composer-menu', otherMenu);
  }, [id]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  useEffect(() => {
    setHighlight(index => Math.min(Math.max(0, index), options.length - 1));
  }, [options.length]);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      if (!button) return;
      const edge = 10, gap = 8;
      const width = Math.min(kind === 'model' ? 288 : 258, window.innerWidth - edge * 2);
      const above = Math.max(0, button.top - edge - gap);
      const below = Math.max(0, window.innerHeight - button.bottom - edge - gap);
      const upwards = above >= Math.min(336, options.length * 36 + 44) || above >= below;
      const maxHeight = Math.min(336, upwards ? above : below);
      const height = Math.min(menu.current?.scrollHeight || 336, maxHeight);
      setPosition({
        position: 'fixed', width, maxHeight,
        left: Math.max(edge, Math.min(button.left, window.innerWidth - edge - width)),
        top: upwards ? Math.max(edge, button.top - gap - height) : button.bottom + gap,
        visibility: 'visible',
      });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', onScroll, true); };
  }, [visible, options.length, kind]);
  useLayoutEffect(() => {
    if (!visible || position.visibility !== 'visible') return;
    const list = menu.current;
    const option = document.getElementById(`${id}-${highlight}`);
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect();
    const item = option.getBoundingClientRect();
    if (item.bottom > bounds.bottom - 6) list.scrollTop += item.bottom - bounds.bottom + 6;
    else if (item.top < bounds.top + 6) list.scrollTop -= bounds.top - item.top + 6;
  }, [visible, highlight, id, position]);

  return <div className={`composer-picker ${kind}-select`} ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !menu.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className={`composer-select-trigger select-chip ${kind}-select`} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? id : undefined} aria-activedescendant={visible ? `${id}-${highlight}` : undefined} data-value={value} title={current} disabled={disabled} onClick={() => visible ? setOpen(false) : show()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key === 'Tab') { setOpen(false); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!visible) show();
        else setHighlight(index => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
      } else if (visible && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault(); setHighlight(event.key === 'Home' ? 0 : options.length - 1);
      } else if (visible && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(highlight); }
    }}>{icon}<span>{current}</span><ChevronDown size={11} className={visible ? 'composer-chevron-open' : ''} /></button>
    {visible && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className={`composer-select-menu ${kind}-menu`} style={position}>
      <div className="composer-menu-heading" aria-hidden="true">{icon}<span>{label}</span></div>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} data-value={option.value} className={`composer-select-option ${highlight === index ? 'highlighted' : ''}`} onPointerMove={() => setHighlight(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={15} />}
      </div>)}
    </div>, document.body)}
  </div>;
}
