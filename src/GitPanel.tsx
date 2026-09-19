import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileCode2, GitBranch, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { useBridge } from './BridgeContext';
import { DiffReview } from './DiffReview';
import type { ReviewSelection } from './DiffReview';
import type { GitArea, GitEntry, GitStatus } from './types';
import './git-panel.css';

const names = { M: 'Изменён', A: 'Добавлен', D: 'Удалён', R: 'Переименован', C: 'Скопирован', T: 'Тип изменён', U: 'Конфликт', '?': 'Новый файл' };
const sections: { label: string; area: GitArea; accepts(entry: GitEntry): boolean }[] = [
  { label: 'Конфликты', area: 'unstaged', accepts: entry => entry.conflicted },
  { label: 'Подготовлено к коммиту', area: 'staged', accepts: entry => entry.staged && !entry.conflicted },
  { label: 'Не подготовлено', area: 'unstaged', accepts: entry => entry.unstaged && !entry.conflicted && !entry.untracked },
  { label: 'Новые файлы', area: 'untracked', accepts: entry => entry.untracked },
];

export default function GitPanel({ cwd, active, refreshKey, onReviewChange }: { cwd: string; active: boolean; refreshKey?: unknown; onReviewChange?(open: boolean): void }) {
  const bridge = useBridge();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewSelection | null>(null);
  const [stale, setStale] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');
  const generation = useRef(0);
  const request = useRef(0);
  const diffRequest = useRef(0);
  const activeRef = useRef(active); activeRef.current = active;
  const current = useRef({ bridge, cwd }); current.current = { bridge, cwd };
  const load = useCallback(async () => {
    if (!activeRef.current || !cwd) return;
    const version = generation.current, serial = ++request.current;
    ++diffRequest.current; setOpening(null); setLoading(true); setError(''); setStale(true);
    try {
      if (!bridge.getGitStatus) throw new Error('Просмотр Git доступен после обновления приложения.');
      const next = await bridge.getGitStatus();
      if (generation.current !== version || serial !== request.current || !activeRef.current) return;
      setStatus(next); setStale(false); setCheckedAt(new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }));
    } catch (cause) {
      if (generation.current === version && serial === request.current && activeRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (generation.current === version && serial === request.current) setLoading(false); }
  }, [bridge, cwd]);
  useEffect(() => {
    generation.current++; setStatus(null); setReview(null); setQuery(''); setError(''); setCheckedAt('');
    return () => { generation.current++; };
  }, [bridge, cwd]);
  useEffect(() => {
    if (active) void load();
    else { request.current++; diffRequest.current++; setLoading(false); setOpening(null); setReview(null); }
  }, [active, load, refreshKey]);
  useEffect(() => { onReviewChange?.(Boolean(active && review)); return () => onReviewChange?.(false); }, [review, active, onReviewChange]);
  const compare = async (entry: GitEntry, area: GitArea, label: string) => {
    if (!activeRef.current || stale || loading || opening) return;
    const version = generation.current, serial = ++diffRequest.current;
    const context = { bridge, cwd };
    setOpening(`${area}:${entry.path}`); setError('');
    try {
      const result = await bridge.getGitDiff({ path: entry.path, area });
      if (version !== generation.current || serial !== diffRequest.current || !activeRef.current || current.current.bridge !== context.bridge || current.current.cwd !== context.cwd) return;
      const code = area === 'staged' ? entry.indexStatus : entry.untracked ? '?' : entry.worktreeStatus;
      const message = result.message || [result.binary && 'Бинарный файл. Текстовое сравнение недоступно.', result.truncated && 'Сравнение ограничено по размеру.'].filter(Boolean).join(' ');
      setReview({
        source: 'git', title: entry.path, description: label, message,
        ...(code !== 'D' && !entry.submodule ? { path: entry.path } : {}),
        beforeLabel: area === 'staged' ? 'До · HEAD' : area === 'untracked' ? 'До · файл отсутствует в Git' : 'До · индекс',
        afterLabel: area === 'staged' ? 'После · индекс' : 'После · рабочий файл',
        edits: [{ key: `${area}:${entry.path}`, path: entry.path, diff: result.diff, kind: { type: code === 'D' ? 'delete' : code === 'A' || entry.untracked ? 'add' : 'update', ...(entry.originalPath ? { move_path: entry.path } : {}) } }],
      });
    } catch (cause) {
      if (version === generation.current && serial === diffRequest.current && activeRef.current) { setError(cause instanceof Error ? cause.message : String(cause)); setStale(true); }
    } finally { if (version === generation.current && serial === diffRequest.current) setOpening(null); }
  };
  const filtered = status?.entries.filter(entry => !query.trim() || `${entry.path} ${entry.originalPath || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || [];
  return <div className="git-panel">
    <div className="git-heading"><GitBranch size={15} /><div><strong>{status?.available ? status.detached ? 'Без ветки' : status.branch || 'Ветка не определена' : 'Git проекта'}</strong><small>{status?.available && (status.unborn ? 'Первый коммит ещё не создан' : status.detached ? status.head?.slice(0, 10) : status.root)}</small></div><button type="button" className="icon-button" aria-label="Обновить Git" title="Обновить Git" disabled={loading || !cwd} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div>
    {loading && <p className="git-status-note" role="status"><LoaderCircle className="spin" size={13} />Читаем состояние Git…</p>}
    {error && <div className="git-error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={loading} onClick={() => void load()}>Повторить</button></div>}
    {status && stale && <p className="git-status-note">Показан предыдущий список. Обновите Git перед сравнением.</p>}
    {!loading && status && !status.available && <div className="git-empty"><GitBranch size={25} /><p>{status.reason === 'git-unavailable' ? 'Git не найден. Установите Git и откройте приложение снова.' : status.reason === 'bare' ? 'У этого репозитория нет рабочей папки.' : 'В этой папке нет репозитория Git.'}</p></div>}
    {status?.available && <>
      <label className="git-search"><Search size={13} /><input aria-label="Найти файл Git" placeholder="Найти файл…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {status.truncated && <p className="git-status-note">Список ограничен по размеру; показаны не все файлы.</p>}
      {status.message && <p className="git-status-note">{status.message}</p>}
      {!filtered.length && <p className="git-empty">{query ? 'Файлы не найдены.' : 'В выбранной папке нет изменений.'}</p>}
      {sections.map(section => {
        const entries = filtered.filter(section.accepts);
        if (!entries.length) return null;
        return <section className="git-group" key={section.label} aria-label={section.label}><h3>{section.label}<span>{entries.length}</span></h3>{entries.map(entry => {
          const code = section.area === 'staged' ? entry.indexStatus : entry.untracked ? '?' : entry.worktreeStatus;
          return <button key={entry.path} type="button" className={`git-file ${entry.conflicted ? 'conflict' : ''}`} aria-label={`Сравнить ${entry.path} — ${section.label}`} disabled={loading || stale || Boolean(opening)} onClick={() => void compare(entry, section.area, section.label)}>
            {opening === `${section.area}:${entry.path}` ? <LoaderCircle className="spin" size={14} /> : entry.conflicted ? <AlertTriangle size={14} /> : <FileCode2 size={14} />}
            <span><strong>{entry.path}</strong><small>{entry.originalPath ? `${entry.originalPath} → ` : ''}{entry.conflicted ? 'Конфликт' : entry.submodule ? 'Подмодуль' : names[code as keyof typeof names] || 'Изменён'}</small></span><b aria-hidden="true">{entry.conflicted ? '!' : code === '.' ? 'M' : code}</b>
          </button>;
        })}</section>;
      })}
      <p className="git-status-note">{checkedAt && `Обновлено в ${checkedAt}. `}Состояние файлов выбранной папки; операции Git здесь только читают данные.</p>
    </>}
    {review && active && <DiffReview selection={review} onClose={() => setReview(null)} onOpen={path => bridge.openPath(path)} />}
  </div>;
}
