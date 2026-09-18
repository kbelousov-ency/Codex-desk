import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, FolderOpen, LoaderCircle, X } from 'lucide-react';
import { reportRendererError } from './renderer-diagnostics';
import type { DiagnosticsStatus } from './types';
import { BuildDetails } from './BuildInfo';
import './diagnostics.css';

function DiagnosticsContent() {
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState<'export' | 'folder' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const refresh = async () => {
    try {
      if (!window.codex?.getDiagnosticsStatus) throw new Error('unavailable');
      setStatus(await window.codex.getDiagnosticsStatus()); setStatusError('');
    } catch { setStatusError('Не удалось получить состояние журнала. Попробуйте сохранить диагностику.'); }
  };
  useEffect(() => { void refresh(); }, []);
  const run = async (action: 'export' | 'folder') => {
    if (pending.current) return;
    pending.current = true; setBusy(action); setMessage(''); setError('');
    try {
      if (action === 'export') {
        if (!window.codex?.exportDiagnostics) throw new Error('unavailable');
        const result = await window.codex.exportDiagnostics();
        setMessage(result.canceled ? 'Сохранение отменено.' : result.path ? `Диагностика сохранена: ${result.path}` : 'Диагностика сохранена.');
      } else {
        if (!window.codex?.openDiagnosticsFolder) throw new Error('unavailable');
        await window.codex.openDiagnosticsFolder(); setMessage('Папка журнала открыта в проводнике.');
      }
    } catch {
      setError(action === 'export' ? 'Не удалось сохранить диагностику. Повторите попытку и выберите доступную папку.' : 'Не удалось открыть папку журнала. Можно попробовать сохранить диагностику в другой папке.');
      void refresh();
    } finally { pending.current = false; setBusy(null); }
  };
  return <div className="diagnostics-content">
    <BuildDetails />
    <p>Приложение автоматически сохраняет технические события и ошибки на этом компьютере. Старые записи заменяются новыми, размер журнала ограничен.</p>
    <p>Тексты переписки, содержимое файлов, пароли и токены авторизации в журнал не записываются. Данные никуда не отправляются автоматически.</p>
    <p>Если возникла ошибка, сохраните диагностику и передайте файл вместе с описанием проблемы и примерным временем её появления.</p>
    <div className={`diagnostics-state ${status && !status.enabled || statusError ? 'has-error' : ''}`} role="status">
      <span className={`status-dot ${status?.enabled ? 'online' : ''}`} />
      <span>{statusError || (status ? status.enabled ? 'Журнал включён' : 'Запись журнала недоступна' : 'Проверяем журнал…')}</span>
    </div>
    {status?.error && <p className="diagnostics-warning">{status.error}</p>}
    {status?.directory && <div className="diagnostics-directory"><span>Папка журнала</span><code>{status.directory}</code></div>}
    {message && <p className="diagnostics-result" role="status">{message}</p>}
    {error && <p className="diagnostics-warning" role="alert">{error}</p>}
    <div className="diagnostics-actions">
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('folder')}><FolderOpen size={14} />Открыть папку</button>
      <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run('export')}>{busy === 'export' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{busy === 'export' ? 'Сохраняем…' : 'Сохранить диагностику'}</button>
    </div>
  </div>;
}

function DiagnosticsModal({ close }: { close(): void }) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop diagnostics-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}><section className="settings-modal diagnostics-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" ref={dialog}>
    <div className="modal-header"><h2 id="diagnostics-title"><FileText size={17} />Диагностика</h2><button type="button" className="icon-button" aria-label="Закрыть диагностику" onClick={close}><X size={17} /></button></div>
    <DiagnosticsContent />
  </section></div>, document.body);
}

export function DiagnosticsButton({ active = true }: { active?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <>
    <button type="button" className="diagnostics-toggle" aria-label="Диагностика" aria-haspopup="dialog" onClick={() => setOpen(true)}><FileText size={14} /><span>Диагностика</span></button>
    {open && active && <DiagnosticsModal close={() => setOpen(false)} />}
  </>;
}

export class DiagnosticsErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { reportRendererError('react', error, info.componentStack || undefined); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="diagnostics-fallback"><section className="diagnostics-fallback-card"><FileText size={27} /><h1>Не удалось отобразить приложение</h1><p>В интерфейсе произошла ошибка. Сохраните диагностику перед перезапуском приложения.</p><DiagnosticsContent /></section></main>;
  }
}
