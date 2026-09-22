import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, X } from 'lucide-react';
import type { Item, TurnWork } from './types';
import { entryTiming, exportEntries, exportFilename, exportMarkdown, exportNotes } from './conversation-export';
import type { ConversationExportFile, ExportFormat, ExportInfo, ExportScope } from './conversation-export';
import './conversation-export.css';

async function htmlDocument(items: Item[], info: ExportInfo) {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const entries = exportEntries(items, info.scope, info.provider);
  const markup = renderToStaticMarkup(<html lang="ru"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta httpEquiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'" /><title>{info.title || 'Беседа'}</title><style>{`body{max-width:960px;margin:40px auto;padding:0 24px;color:#20252b;background:#fff;font:16px/1.6 system-ui,sans-serif}h1,h2{line-height:1.3}h2{font-size:19px}section{border-top:1px solid #d5d9de;margin:28px 0;padding-top:14px}pre{background:#f3f5f7;padding:14px;border-radius:6px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:6px 10px;border:1px solid #ccd1d8}a{color:#235b99}blockquote{border-left:3px solid #c3cbd4;padding-left:16px;margin-left:0;color:#4c5968}.metadata,.timing{color:#5b6572;font-size:13px}.plain{white-space:pre-wrap;overflow-wrap:anywhere}img{display:none}@media print{body{margin:0;max-width:none}pre{overflow:visible}section{break-inside:avoid}}`}</style></head><body><h1>{info.title || 'Беседа'}</h1><div className="metadata">{exportNotes(info).map((note, index) => <p key={index}>{note}</p>)}</div>{entries.map((entry, index) => <section key={`${entry.id}-${index}`}><h2>{entry.label}</h2>{entry.turnId !== entries[index - 1]?.turnId && entryTiming(entry, info) && <p className="timing">{entryTiming(entry, info)}</p>}{entry.blocks.map((block, offset) => block.kind === 'code' ? <pre key={offset}><code>{block.text}</code></pre> : block.kind === 'text' ? <p className="plain" key={offset}>{block.text}</p> : <ReactMarkdown key={offset} remarkPlugins={[remarkGfm]} urlTransform={url => /^https?:\/\//i.test(url) ? url : ''} components={{ img: ({ alt }) => <span>[Изображение{alt ? `: ${alt}` : ''}]</span>, a: ({ href, children }) => href ? <a href={href} rel="noreferrer noopener">{children}</a> : <span>{children}</span> }}>{block.text}</ReactMarkdown>)}</section>)}</body></html>);
  return `<!doctype html>\n${markup}\n`;
}

export default function ExportConversation({ items, turnWork, title, provider, cwd, hasEarlier, loading = false, busy = false, onLoadEarlier, onClose, onSave }: {
  items: Item[]; turnWork: Record<string, TurnWork>; title: string; provider: string; cwd: string;
  hasEarlier: boolean; loading?: boolean; busy?: boolean; onLoadEarlier?(): Promise<void>; onClose(): void;
  onSave(file: ConversationExportFile): Promise<{ canceled: boolean; path?: string }>;
}) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [scope, setScope] = useState<ExportScope>('conversation');
  const [saving, setSaving] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
  const [error, setError] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const request = useRef(false);
  const loadingAllRef = useRef(false);
  const close = useRef(onClose); close.current = onClose;
  const latest = useRef({ items, hasEarlier, loading, onLoadEarlier }); latest.current = { items, hasEarlier, loading, onLoadEarlier };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || [])];
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', listener, true);
    return () => { alive.current = false; loadingAllRef.current = false; document.removeEventListener('keydown', listener, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!loadingAll || !loadingAllRef.current || loading || request.current || !onLoadEarlier) return;
    if (!hasEarlier) { loadingAllRef.current = false; setLoadingAll(false); return; }
    const previousItems = items;
    request.current = true;
    void onLoadEarlier().then(() => new Promise(resolve => window.setTimeout(resolve, 0))).then(() => {
      if (!alive.current) return;
      if (latest.current.hasEarlier && latest.current.items.length === previousItems.length && latest.current.items.every((item, index) => item.id === previousItems[index]?.id)) { loadingAllRef.current = false; setLoadingAll(false); setError('Загрузка истории не продвинулась. Повторите загрузку или экспортируйте доступный фрагмент.'); }
    }).catch(cause => { if (alive.current) { loadingAllRef.current = false; setLoadingAll(false); setError(cause instanceof Error ? cause.message : String(cause)); } }).finally(() => {
      request.current = false;
      if (alive.current) setPageRevision(value => value + 1);
    });
  }, [loadingAll, loading, hasEarlier, items, onLoadEarlier, pageRevision]);
  const save = async () => {
    if (saving || loading || loadingAll) return;
    setSaving(true); setError(''); setSavedPath('');
    try {
      const info: ExportInfo = { title, provider, cwd, scope, turnWork, partial: hasEarlier, busy };
      const content = format === 'html' ? await htmlDocument(items, info) : exportMarkdown(exportEntries(items, scope, provider), info);
      const result = await onSave({ filename: exportFilename(title, format), content, format });
      if (alive.current && !result.canceled) setSavedPath(result.path || 'Файл сохранён.');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setSaving(false); }
  };
  return createPortal(<div className="export-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}><section ref={dialog} className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><header><h2 id="export-title"><Download size={19} />Экспорт беседы</h2><button type="button" aria-label="Закрыть экспорт" onClick={onClose}><X size={18} /></button></header><p className="export-name">{title || 'Беседа'}</p><label className="export-option">Формат<select value={format} disabled={saving} onChange={event => setFormat(event.target.value as ExportFormat)}><option value="markdown">Markdown (.md)</option><option value="html">HTML (.html)</option></select></label><fieldset disabled={saving}><legend>Содержимое</legend><label><input type="radio" name="export-scope" checked={scope === 'conversation'} onChange={() => setScope('conversation')} />Переписка</label><label><input type="radio" name="export-scope" checked={scope === 'work'} onChange={() => setScope('work')} />Переписка и ход работы</label></fieldset><p className="export-hint">Вложения будут обозначены именами или путями. HTML открывается без подключения к интернету.</p>{hasEarlier && <div className="export-history"><p>Загружен фрагмент беседы. Ранние сообщения пока не включены.</p>{onLoadEarlier && <button type="button" disabled={saving || loading && !loadingAll} onClick={() => { setError(''); loadingAllRef.current = !loadingAllRef.current; setLoadingAll(loadingAllRef.current); }}>{loadingAll ? 'Остановить загрузку' : 'Загрузить всю беседу'}</button>}</div>}{loadingAll && <p className="export-hint" role="status">Загрузка сообщений… {items.length}</p>}{busy && <p className="export-hint">Агент ещё работает. Будет сохранён текущий снимок беседы.</p>}{error && <p className="export-error" role="alert">{error}</p>}{savedPath && <p className="export-saved" role="status">Сохранено: {savedPath}</p>}<footer><button type="button" onClick={onClose}>Закрыть</button><button type="button" className="export-save" disabled={saving || loading || loadingAll || !items.length} onClick={() => void save()}>{saving ? 'Сохранение…' : hasEarlier ? 'Сохранить фрагмент…' : 'Сохранить…'}</button></footer></section></div>, document.body);
}
