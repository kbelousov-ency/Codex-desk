import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { OpenAppUpdatesContext } from './AppUpdateContext';
import type { BuildInfo } from './types';
import './build-info.css';

// Build identity belongs to the window, not to an App Server or chat tab.
// A shared promise also avoids duplicate IPC from StrictMode and archive views.
let buildInfo: BuildInfo | null | undefined;
let buildInfoRequest: Promise<BuildInfo | null> | undefined;
function loadBuildInfo() {
  return buildInfoRequest ??= Promise.resolve().then(async () => {
    if (!window.codex?.getBuildInfo) return { channel: 'development', version: '' } as BuildInfo;
    const result = await window.codex.getBuildInfo();
    if (!result || !['stable', 'nightly', 'development'].includes(result.channel) || typeof result.version !== 'string') return null;
    return result;
  }).catch(() => null).then(result => { buildInfo = result; return result; });
}

export function useBuildInfo() {
  const [info, setInfo] = useState(buildInfo);
  useEffect(() => {
    let mounted = true;
    void loadBuildInfo().then(result => { if (mounted) setInfo(result); });
    return () => { mounted = false; };
  }, []);
  return info;
}

const labels = { stable: 'RELEASE', nightly: 'NIGHTLY', development: 'DEV' };
function buildDate(info: BuildInfo) {
  if (!info.builtAt) return '';
  const date = new Date(info.builtAt);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function description(info: BuildInfo) {
  return [
    `Codex Desk · ${labels[info.channel]}`,
    info.version ? `Версия ${info.version}` : '',
    info.buildId ? `Сборка ${info.buildId.slice(0, 12)}` : '',
    buildDate(info),
  ].filter(Boolean).join('\n');
}

export function BuildBadge() {
  const openUpdates = useContext(OpenAppUpdatesContext);
  const info = useBuildInfo();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const cancelClose = () => { if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const show = () => { cancelClose(); window.dispatchEvent(new CustomEvent('codex-desk:tooltip-open', { detail: id })); setOpen(true); };
  const close = () => { cancelClose(); setOpen(false); };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!trigger.current?.matches(':hover, :focus') && !tooltip.current?.matches(':hover')) setOpen(false);
    }, 140);
  };
  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !tooltip.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const otherTooltip = (event: Event) => { if ((event as CustomEvent).detail !== id) close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('codex-desk:tooltip-open', otherTooltip);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('codex-desk:tooltip-open', otherTooltip); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      if (!button?.width) { setOpen(false); return; }
      const edge = 10, gap = 9, width = Math.min(164, innerWidth - edge * 2);
      const height = tooltip.current?.offsetHeight || 90;
      setPosition({ width, left: Math.max(edge, Math.min(button.right - width, innerWidth - edge - width)), top: Math.max(edge, Math.min(button.bottom + gap, innerHeight - edge - height)), visibility: 'visible' });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, info]);
  const title = info ? description(info) : info === null ? 'Сведения о сборке недоступны' : 'Загружаем сведения о сборке…';
  const date = info && buildDate(info);
  return <>
    <button ref={trigger} type="button" className={`version-badge build-badge ${info?.channel || 'unknown'}`} aria-label={openUpdates ? `Обновления приложения · ${title}` : title} aria-describedby={open ? id : undefined}
      onPointerEnter={show} onPointerLeave={scheduleClose} onFocus={show} onBlur={close} onClick={() => { if (openUpdates) { close(); openUpdates(); } else show(); }}>
      {info ? labels[info.channel] : info === null ? '—' : '…'}
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" className={`build-tooltip ${info?.channel || 'unknown'}`} style={position} onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
      <div className="build-tooltip-heading"><strong>Codex Desk</strong>{info && <span>{labels[info.channel]}</span>}</div>
      {info ? <dl>
        <div><dt>Версия</dt><dd className="build-tooltip-version">{info.version || 'Не указана'}</dd></div>
        {info.buildId && <div><dt>Сборка</dt><dd className="build-tooltip-hash">{info.buildId.slice(0, 12)}</dd></div>}
        {date && <div><dt>Дата</dt><dd><time dateTime={info.builtAt}>{date}</time></dd></div>}
      </dl> : <p>{title}</p>}
    </div>, document.body)}
  </>;
}

export function BuildDetails() {
  const info = useBuildInfo();
  if (!info) return <p className="build-details-unavailable">{info === null ? 'Сведения о сборке недоступны.' : 'Загружаем сведения о сборке…'}</p>;
  const date = buildDate(info);
  return <div className="build-details">
    <strong>Codex Desk <span className={`build-channel-text ${info.channel}`}>{labels[info.channel]}</span></strong>
    <dl>
      <div><dt>Версия</dt><dd>{info.version || 'Не указана'}</dd></div>
      {info.buildId && <div><dt>Сборка</dt><dd data-tooltip={info.buildId}>{info.buildId.slice(0, 12)}</dd></div>}
      {date && <div><dt>Дата сборки</dt><dd><time dateTime={info.builtAt}>{date}</time></dd></div>}
    </dl>
  </div>;
}
