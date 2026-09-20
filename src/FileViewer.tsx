import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileCode2, FileText, Image, MessageSquarePlus, Search, X } from 'lucide-react';
import { useBridge } from './BridgeContext';
import Markdown from './Markdown';
import { highlightSource, sourceLineRange, sourceWindow } from './source-highlight';
import './file-viewer.css';

type FileResult = { path: string; name: string };
type Preview = { path: string; kind: 'text' | 'markdown' | 'image' | 'unsupported'; text?: string; dataUrl?: string; language?: string; truncated?: boolean; message?: string };
type SelectedText = { text: string; start?: number; end?: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function FileViewer({ cwd, active, onClose, onAsk, initialPath }: {
  cwd: string; active: boolean; onClose(): void; onAsk(text: string): void; initialPath?: string;
}) {
  const bridge = useBridge();
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPath, setPreviewPath] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [source, setSource] = useState(false);
  const [selection, setSelection] = useState<SelectedText | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [lineInput, setLineInput] = useState('');
  const [lineError, setLineError] = useState('');
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const lineNumberInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const markdown = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const searchRevision = useRef(0);
  const readRevision = useRef(0);
  const close = useRef(onClose); close.current = onClose;
  const context = useRef({ cwd, active, bridge }); context.current = { cwd, active, bridge };

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchInput.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyG' && lineNumberInput.current) { event.preventDefault(); event.stopPropagation(); lineNumberInput.current.focus(); lineNumberInput.current.select(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]') || [])].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [active]);

  const search = async (next?: string) => {
    const revision = ++searchRevision.current;
    const origin = context.current;
    const current = () => revision === searchRevision.current && context.current.cwd === origin.cwd && context.current.bridge === origin.bridge && context.current.active;
    setSearchBusy(true); setSearchError('');
    try {
      const result = await bridge.searchProjectFiles({ query, ...(next ? { cursor: next } : {}) });
      if (!current()) return;
      setFiles(previous => next ? [...previous, ...result.files.filter(file => !previous.some(other => other.path === file.path))] : result.files);
      setCursor(result.nextCursor); setTruncated(!!result.truncated);
    } catch (error) { if (current()) setSearchError(message(error)); }
    finally { if (current()) setSearchBusy(false); }
  };

  const openFile = async (path: string) => {
    const revision = ++readRevision.current;
    const origin = context.current;
    const current = () => revision === readRevision.current && context.current.cwd === origin.cwd && context.current.bridge === origin.bridge && context.current.active;
    setPreviewPath(path); setPreview(null); setSelection(null); setPreviewError(''); setPreviewBusy(true); setSource(false); setScrollTop(0); setScrollLeft(0); setLineInput(''); setLineError(''); setJumpLine(null);
    try { const result = await bridge.readProjectFile({ path }); if (current()) setPreview(result); }
    catch (error) { if (current()) setPreviewError(message(error)); }
    finally { if (current()) setPreviewBusy(false); }
  };

  useEffect(() => {
    searchRevision.current++;
    setFiles([]); setCursor(null); setIndex(0); setSearchError(''); setTruncated(false);
    if (!active) { setSearchBusy(false); return; }
    setSearchBusy(true);
    const timer = window.setTimeout(() => void search(), 120);
    return () => { clearTimeout(timer); searchRevision.current++; };
  }, [query, cwd, active, bridge]);
  useEffect(() => {
    readRevision.current++; setPreview(null); setPreviewPath(''); setSelection(null); setPreviewError(''); setPreviewBusy(false);
    if (active && initialPath) void openFile(initialPath);
    return () => { readRevision.current++; };
  }, [cwd, active, bridge, initialPath]);
  useEffect(() => { dialog.current?.querySelector(`#file-result-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index]);

  const ask = (selected = false) => {
    if (!preview) return;
    const absolute = `${cwd.replace(/[\\/]$/, '')}/${preview.path}`;
    if (!selected || !selection?.text) onAsk(absolute);
    else {
      const location = selection.start !== undefined ? ` — строки ${selection.start}${selection.end !== selection.start ? `–${selection.end}` : ''}` : '';
      const longestFence = Math.max(2, ...[...selection.text.matchAll(/`+/g)].map(match => match[0].length));
      const fence = '`'.repeat(longestFence + 1);
      onAsk(`${absolute}${location}\n${fence}\n${selection.text}\n${fence}`);
    }
    onClose();
  };
  const captureSourceSelection = () => {
    const element = textarea.current;
    if (!element || element.selectionStart === element.selectionEnd) { setSelection(null); return; }
    const { selectionStart: start, selectionEnd: end, value } = element;
    setSelection({ text: value.slice(start, end), start: value.slice(0, start).split('\n').length, end: value.slice(0, end - (value[end - 1] === '\n' ? 1 : 0)).split('\n').length });
  };
  const captureMarkdownSelection = () => {
    const selected = window.getSelection();
    if (!selected?.rangeCount || !markdown.current?.contains(selected.anchorNode) || !markdown.current?.contains(selected.focusNode)) { setSelection(null); return; }
    const text = selected.toString();
    setSelection(text ? { text } : null);
  };
  const external = async () => {
    const revision = readRevision.current;
    try { await bridge.openPath(previewPath); }
    catch (error) { if (revision === readRevision.current && context.current.active) setPreviewError(message(error)); }
  };

  const displaySource = preview && (preview.kind === 'text' || (preview.kind === 'markdown' && source));
  const highlighted = useMemo(() => highlightSource(preview?.text || '', preview?.path || ''), [preview?.text, preview?.path]);
  const lines = highlighted.offsets.length;
  const firstLine = Math.max(0, Math.floor(scrollTop / 20) - 2);
  const visibleSource = useMemo(() => sourceWindow(highlighted, firstLine, 100), [highlighted, firstLine]);
  useEffect(() => {
    if (!displaySource || jumpLine == null || !textarea.current) return;
    const range = sourceLineRange(highlighted, String(jumpLine));
    if (!range) return;
    const element = textarea.current;
    element.focus({ preventScroll: true }); element.setSelectionRange(range.start, range.end);
    element.scrollTop = Math.max(0, (range.line - 1) * 20 - element.clientHeight / 2 + 24); element.scrollLeft = 0;
    setScrollTop(element.scrollTop); setScrollLeft(0); captureSourceSelection(); setJumpLine(null);
  }, [displaySource, jumpLine, highlighted]);
  const goToLine = () => {
    const range = sourceLineRange(highlighted, lineInput);
    if (!range) { setLineError(`Введите номер от 1 до ${lines}.`); return; }
    setLineError(''); setSource(true); setJumpLine(range.line);
  };
  if (!active) return null;
  return createPortal(<div className="file-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="file-viewer" role="dialog" aria-modal="true" aria-labelledby="file-viewer-title" ref={dialog}>
      <header className="file-viewer-header"><div><FileCode2 size={20} /><h2 id="file-viewer-title">Файлы проекта</h2><span className="file-viewer-shortcut">Ctrl+P</span></div><button type="button" className="icon-btn" aria-label="Закрыть просмотр файлов" onClick={onClose}><X size={19} /></button></header>
      <div className="file-viewer-search"><Search size={17} /><input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти файл по имени или пути…" aria-label="Найти файл проекта" role="combobox" aria-expanded={true} aria-controls="file-viewer-results" aria-activedescendant={files[index] ? `file-result-${index}` : undefined} autoComplete="off" onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, Math.min(files.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))); }
        if (event.key === 'Enter' && files[index]) { event.preventDefault(); void openFile(files[index].path); }
      }} />{query && <button type="button" className="icon-btn" aria-label="Очистить поиск файлов" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={15} /></button>}</div>
      <div className="file-viewer-body">
        <aside className="file-viewer-list">
          <div className="file-viewer-project" title={cwd}>{cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd}</div>
          <div id="file-viewer-results" role="listbox" aria-label="Найденные файлы" aria-busy={searchBusy}>
            {files.map((file, offset) => <button key={file.path} id={`file-result-${offset}`} type="button" role="option" aria-selected={offset === index} className={`file-viewer-result ${previewPath === file.path ? 'opened' : ''}`} onClick={() => { setIndex(offset); void openFile(file.path); }} title={file.path}><FileText size={16} /><span><strong>{file.name}</strong><small>{file.path}</small></span></button>)}
          </div>
          {searchBusy && <p className="file-viewer-status" role="status">Поиск файлов…</p>}
          {searchError && <div className="file-viewer-status" role="alert">{searchError}<button type="button" onClick={() => void search()}>Повторить</button></div>}
          {!searchBusy && !searchError && !files.length && <p className="file-viewer-status">Файлы не найдены.</p>}
          {cursor && <button type="button" className="file-viewer-more" disabled={searchBusy} onClick={() => void search(cursor)}>Показать ещё</button>}
          {truncated && <p className="file-viewer-status">Показана часть большого проекта. Если нужного файла нет, откройте его через дерево файлов.</p>}
          <p className="file-viewer-exclusions">Без .git, node_modules и ссылок на папки.</p>
        </aside>
        <main className="file-viewer-preview">
          {previewPath && <div className="file-viewer-filebar"><span title={previewPath}>{previewPath}</span><button type="button" className="icon-btn" onClick={() => void external()} title="Открыть во внешней программе" aria-label="Открыть во внешней программе"><ExternalLink size={17} /></button></div>}
          {previewBusy && <div className="file-viewer-placeholder" role="status">Открытие файла…</div>}
          {previewError && <div className="file-viewer-status" role="alert">{previewError}<button type="button" onClick={() => void openFile(previewPath)}>Повторить</button></div>}
          {!previewPath && <div className="file-viewer-placeholder"><FileCode2 size={34} /><strong>Откройте файл для просмотра</strong><span>Выберите его слева или найдите по имени.</span><small>↑ ↓ — выбор · Enter — открыть</small></div>}
          {preview && <>
            {preview.kind === 'markdown' && <div className="file-viewer-modes"><button type="button" aria-pressed={!source} onClick={() => { setSource(false); setSelection(null); }}>Предпросмотр</button><button type="button" aria-pressed={source} onClick={() => { setSource(true); setSelection(null); setScrollTop(0); }}>Исходник</button></div>}
            {(preview.kind === 'text' || preview.kind === 'markdown') && <form className="file-viewer-line-jump" onSubmit={event => { event.preventDefault(); goToLine(); }}><label htmlFor="file-viewer-line">Строка</label><input id="file-viewer-line" ref={lineNumberInput} value={lineInput} onChange={event => { setLineInput(event.target.value); setLineError(''); }} inputMode="numeric" aria-label="Номер строки" aria-invalid={!!lineError} aria-describedby={lineError ? 'file-viewer-line-error' : undefined} placeholder={`1–${lines}`} /><button type="submit" title="Перейти к строке · Ctrl+G">Перейти</button><span>Ctrl+G</span>{lineError && <span id="file-viewer-line-error" role="alert">{lineError}</span>}</form>}
            {preview.message && <p className="file-viewer-notice">{preview.message}</p>}
            {displaySource && <div className="file-viewer-source"><div className="file-viewer-gutter" aria-hidden="true" style={{ width: `${Math.max(5, String(lines).length + 2)}ch` }}><pre style={{ transform: `translateY(${firstLine * 20 - scrollTop}px)` }}>{Array.from({ length: Math.min(100, Math.max(0, lines - firstLine)) }, (_, i) => firstLine + i + 1).join('\n')}</pre></div><div className="file-viewer-code"><pre className="file-viewer-highlight" aria-hidden="true" style={{ transform: `translate(${-scrollLeft}px, ${firstLine * 20 - scrollTop}px)` }}>{visibleSource.map((piece, index) => piece.kind ? <span key={index} className={`source-${piece.kind}`}>{piece.text}</span> : piece.text)}</pre><textarea ref={textarea} readOnly spellCheck={false} wrap="off" aria-label="Содержимое файла" value={highlighted.text} onSelect={captureSourceSelection} onMouseUp={captureSourceSelection} onKeyUp={captureSourceSelection} onScroll={event => { setScrollTop(event.currentTarget.scrollTop); setScrollLeft(event.currentTarget.scrollLeft); }} /></div></div>}
            {displaySource && highlighted.limited && <p className="file-viewer-notice">Подсветка ограничена для большого файла; весь загруженный текст доступен для чтения.</p>}
            {preview.kind === 'markdown' && !source && <div ref={markdown} className="file-viewer-markdown" tabIndex={0} onMouseUp={captureMarkdownSelection} onKeyUp={captureMarkdownSelection}><Markdown>{preview.text || ''}</Markdown></div>}
            {preview.kind === 'image' && <div className="file-viewer-image"><img src={preview.dataUrl} alt={preview.path} /></div>}
            {preview.kind === 'unsupported' && <div className="file-viewer-placeholder"><FileText size={32} /><span>Файл можно открыть во внешней программе или добавить его путь в сообщение.</span></div>}
            <footer className="file-viewer-footer"><span>{preview.kind === 'image' ? <><Image size={14} /> Изображение</> : preview.kind === 'unsupported' ? 'Только путь' : `${preview.language || 'Markdown'} · ${preview.truncated ? 'часть файла' : 'только чтение'}`}</span><button type="button" disabled={!selection?.text} onMouseDown={event => event.preventDefault()} onClick={() => ask(true)} title="Добавить путь и выделенный текст в сообщение"><MessageSquarePlus size={15} /> Спросить о выделении</button><button type="button" onClick={() => ask()}>Добавить путь</button></footer>
          </>}
        </main>
      </div>
    </section>
  </div>, document.body);
}
