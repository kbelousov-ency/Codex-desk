import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, File, Folder, FolderOpen, Link, LoaderCircle, RefreshCw } from 'lucide-react';
import { useBridge } from './BridgeContext';
import { folderName } from './useCodex';
import type { ProjectFile } from './types';
import './file-browser.css';

type Directory = { entries: ProjectFile[]; nextCursor: number | null; loaded: boolean; loading: boolean; error: string; failedCursor?: number };
const emptyDirectory = (): Directory => ({ entries: [], nextCursor: null, loaded: false, loading: false, error: '' });
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export default function FileBrowser({ cwd, active = true, refreshKey, onAskCodex }: { cwd: string; active?: boolean; refreshKey?: unknown; onAskCodex?: (path: string) => void }) {
  const bridge = useBridge();
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState('');
  const directoriesRef = useRef(directories);
  const expandedRef = useRef(expanded);
  const generation = useRef(0);
  const actionGeneration = useRef(0);
  const pending = useRef(new Set<string>());
  const lastRefresh = useRef(refreshKey);

  // A native menu can resolve after switching tabs, projects, or hiding the tree.
  useLayoutEffect(() => () => { actionGeneration.current += 1; }, [bridge, cwd, active]);

  const setDirectory = useCallback((relative: string, value: Directory) => {
    directoriesRef.current = { ...directoriesRef.current, [relative]: value };
    setDirectories(directoriesRef.current);
  }, []);

  const load = useCallback(async (relative: string, cursor = 0) => {
    if (pending.current.has(relative)) return;
    const version = generation.current;
    const old = directoriesRef.current[relative] || emptyDirectory();
    pending.current.add(relative);
    setDirectory(relative, { ...old, loading: true, error: '' });
    try {
      if (!bridge.listFiles) throw new Error('Перезапустите приложение, чтобы загрузить дерево файлов.');
      const page = await bridge.listFiles(relative, cursor);
      if (generation.current !== version) return;
      const entries = cursor ? [...old.entries, ...page.entries] : page.entries;
      // A folder can change between pages; avoid duplicate rows in that case.
      const unique = [...new Map(entries.map(entry => [entry.path, entry])).values()];
      setDirectory(relative, { entries: unique, nextCursor: page.nextCursor, loaded: true, loading: false, error: '' });
    } catch (error) {
      if (generation.current === version) setDirectory(relative, { ...old, loading: false, error: errorText(error), failedCursor: cursor });
    } finally {
      if (generation.current === version) pending.current.delete(relative);
    }
  }, [bridge, setDirectory]);

  const refresh = useCallback(() => {
    generation.current += 1;
    pending.current.clear();
    setActionError('');
    // Closed branches load again on their next expansion so a manual refresh or
    // a completed file change cannot leave a previously visited branch stale.
    directoriesRef.current = Object.fromEntries(Object.entries(directoriesRef.current).map(([relative, directory]) => [relative,
      relative && !expandedRef.current[relative] ? { ...directory, loaded: false, loading: false, error: '' } : directory,
    ]));
    setDirectories(directoriesRef.current);
    // Refresh only directories the user has expanded; no recursive project scan.
    for (const relative of ['', ...Object.keys(expandedRef.current).filter(key => expandedRef.current[key])]) void load(relative);
  }, [load]);

  useEffect(() => {
    generation.current += 1;
    pending.current.clear();
    directoriesRef.current = {};
    expandedRef.current = {};
    setDirectories({});
    setExpanded({});
    setActionError('');
    lastRefresh.current = refreshKey;
    return () => { generation.current += 1; pending.current.clear(); };
    // A different project or session must never reuse another project's tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, cwd]);

  useEffect(() => {
    if (!active || !cwd) return;
    const changed = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    if (changed && directoriesRef.current['']) refresh();
    else if (!directoriesRef.current['']) void load('');
  }, [active, bridge, cwd, load, refresh, refreshKey]);

  const toggle = (relative: string) => {
    const opened = !expandedRef.current[relative];
    expandedRef.current = { ...expandedRef.current, [relative]: opened };
    setExpanded(expandedRef.current);
    if (opened && !directoriesRef.current[relative]?.loaded) void load(relative);
  };

  const fileAction = async (relative: string, menu = false) => {
    const version = actionGeneration.current;
    setActionError('');
    try {
      const result = menu ? await bridge.showPathMenu(relative, { askCodex: Boolean(onAskCodex) }) : await bridge.openPath(relative);
      if (actionGeneration.current === version && result?.action === 'askCodex') onAskCodex?.(result.path);
    } catch (error) { if (actionGeneration.current === version) setActionError(errorText(error)); }
  };

  const renderDirectory = (relative: string, depth: number): ReactNode => {
    const directory = directories[relative];
    const label = relative ? relative.split('/').at(-1) : folderName(cwd);
    return <ul className="tree-file-list" aria-label={`Содержимое папки ${label}`}>
      {directory?.entries.map(entry => {
        const isDirectory = entry.type === 'directory';
        const opened = Boolean(expanded[entry.path]);
        const Icon = isDirectory ? (opened ? FolderOpen : Folder) : entry.type === 'link' ? Link : File;
        return <li key={entry.path}>
          <button className={`tree-file-row ${isDirectory ? 'tree-file-directory' : ''}`} data-path={entry.path}
            style={{ '--tree-depth': depth } as CSSProperties} title={entry.type === 'link' ? `${entry.path} — ссылка` : entry.path}
            aria-label={isDirectory ? `Раскрыть папку ${entry.name}` : `Открыть файл ${entry.name}`} aria-expanded={isDirectory ? opened : undefined}
            onClick={() => isDirectory ? toggle(entry.path) : void fileAction(entry.path)}
            onContextMenu={event => { event.preventDefault(); void fileAction(entry.path, true); }}
            onKeyDown={event => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void fileAction(entry.path, true); }
              else if (isDirectory && event.key === 'ArrowRight' && !opened) { event.preventDefault(); toggle(entry.path); }
              else if (isDirectory && event.key === 'ArrowLeft' && opened) { event.preventDefault(); toggle(entry.path); }
            }}>
            {isDirectory ? <ChevronRight size={12} className={`tree-file-chevron ${opened ? 'expanded' : ''}`} /> : <span className="tree-file-chevron-space" />}
            <Icon size={15} /><span className="tree-file-name">{entry.name}</span>{entry.type === 'link' && <span className="tree-file-kind">ссылка</span>}
          </button>
          {isDirectory && opened && renderDirectory(entry.path, depth + 1)}
        </li>;
      })}
      {directory?.error && <li className="tree-file-feedback tree-file-error" role="alert"><span>{directory.error}</span><button className="text-button" onClick={() => void load(relative, directory.failedCursor)}>Повторить</button></li>}
      {directory?.loading ? <li className="tree-file-feedback" role="status"><LoaderCircle size={13} className="spin" />Загружаем файлы…</li>
        : directory?.loaded && !directory.entries.length && !directory.error ? <li className="tree-file-feedback">Папка пуста</li> : null}
      {directory?.nextCursor != null && !directory.error && <li><button className="tree-file-more text-button" aria-label={`Показать ещё файлов в ${label}`} disabled={directory.loading} onClick={() => void load(relative, directory.nextCursor!)}>Показать ещё</button></li>}
    </ul>;
  };

  return <section className="file-browser" aria-label="Файлы рабочей папки">
    <header className="file-browser-header"><FolderOpen size={15} /><div title={cwd}><strong>{folderName(cwd) || 'Рабочая папка'}</strong><span>{cwd || 'Папка не выбрана'}</span></div><button className="icon-button small" aria-label="Обновить дерево файлов" title="Обновить дерево файлов" disabled={!cwd || directories['']?.loading} onClick={refresh}><RefreshCw size={14} className={directories['']?.loading ? 'spin' : ''} /></button></header>
    {actionError && <div className="tree-file-feedback tree-file-error" role="alert">{actionError}</div>}
    {cwd ? renderDirectory('', 0) : <p className="tree-file-feedback">Выберите рабочую папку, чтобы увидеть её файлы.</p>}
  </section>;
}
