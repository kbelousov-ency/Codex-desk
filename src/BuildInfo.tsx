import { useContext, useEffect, useState } from 'react';
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
  const title = info ? description(info) : info === null ? 'Сведения о сборке недоступны' : 'Загружаем сведения о сборке…';
  if (openUpdates) return <button type="button" className={`version-badge build-badge ${info?.channel || 'unknown'}`} title={title} aria-label={`Обновления приложения · ${title}`} onClick={openUpdates}>{info ? labels[info.channel] : info === null ? '—' : '…'}</button>;
  return <span className={`version-badge build-badge ${info?.channel || 'unknown'}`} title={title} aria-label={title}>{info ? labels[info.channel] : info === null ? '—' : '…'}</span>;
}

export function BuildDetails() {
  const info = useBuildInfo();
  if (!info) return <p className="build-details-unavailable">{info === null ? 'Сведения о сборке недоступны.' : 'Загружаем сведения о сборке…'}</p>;
  const date = buildDate(info);
  return <div className="build-details">
    <strong>Codex Desk <span className={`build-channel-text ${info.channel}`}>{labels[info.channel]}</span></strong>
    <dl>
      <div><dt>Версия</dt><dd>{info.version || 'Не указана'}</dd></div>
      {info.buildId && <div><dt>Сборка</dt><dd title={info.buildId}>{info.buildId.slice(0, 12)}</dd></div>}
      {date && <div><dt>Дата сборки</dt><dd><time dateTime={info.builtAt}>{date}</time></dd></div>}
    </dl>
  </div>;
}
