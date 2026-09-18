import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Brain, Check, ChevronDown, ChevronRight, Code2, Cpu, Folder, FolderOpen, FolderPlus, GitBranch, ImagePlus, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Search, Settings2, Shield, Square, Terminal, X } from 'lucide-react';
import type { Access, Attachment, CodexBridge, Settings, Thread, UpdateTabSnapshot } from './types';
import { BridgeContext } from './BridgeContext';
import { BuildBadge } from './BuildInfo';
import { errorText, folderName, useCodex } from './useCodex';
import ChatSearch from './ChatSearch';
import Approval from './Approval';
import CacheControl from './CacheControl';
import TokenUsage from './TokenUsage';
import CommandMenu from './CommandMenu';
import { matchingCommands, parseSlashCommand, type CommandName } from './slash-commands';
import AccessSelect from './AccessSelect';
import ComposerSelect from './ComposerSelect';
import FileBrowser from './FileBrowser';
import { groupFileChanges } from './change-utils';
import type { ProjectTreeControls } from './ProjectTree';
import ProjectSidebar from './ProjectSidebar';
import { ActivityPanel, ChangesPanel, reasoningText, activityLabel } from './Panels';
import './terminal.css';
import McpSettings from './McpSettings';

const effortLabels: Record<string, string> = { none: 'Без размышлений', minimal: 'Минимум', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимум', ultra: 'Ультра' };

export type SessionSummary = { cwd: string; title: string; threadId?: string; initialized: boolean; terminalOpen: boolean; busy: boolean; loading: boolean; connection: string; pending: number; settings: Settings };
export type WorkspaceControls = ProjectTreeControls & {
  threadNames?: Record<string, string>;
  newChat(cwd: string): void;
  openThread(cwd: string, thread: Thread): void;
  report(id: string, summary: SessionSummary): void;
  registerUpdateCapture?(id: string, capture: () => UpdateTabSnapshot | null): () => void;
};
export default function App({ bridge = window.codex, sessionId = 'default', active = true, initialThread, initialDraft = '', initialAttachments = [], restoreSettings, workspace }: {
  bridge?: CodexBridge; sessionId?: string; active?: boolean; initialThread?: Thread; initialDraft?: string; initialAttachments?: Attachment[]; restoreSettings?: Settings; workspace?: WorkspaceControls;
}) {
  const codex = useCodex(bridge, { restoreSettings });
  const [text, setText] = useState(initialDraft);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [tab, setTab] = useState<'files' | 'activity' | 'changes'>('files');
  const [showSidebar, setShowSidebar] = useState(true);
  const [showPanel, setShowPanel] = useState(() => window.innerWidth > 1000);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1000px)');
    const resize = () => { if (narrow.matches) setShowPanel(false); };
    narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatSearch, setShowChatSearch] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const [sending, setSending] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandKeyboardSelected, setCommandKeyboardSelected] = useState(false);
  const [statusSignal, setStatusSignal] = useState(0);
  const [modelSignal, setModelSignal] = useState(0);
  const [accessSignal, setAccessSignal] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const resumeAttempted = useRef(false);
  const savedScrollTop = useRef(0);
  const [scrolledUp, setScrolledUp] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const locked = workspace?.actionBusy || codex.terminalOpen || codex.busy || codex.loading || codex.connection === 'connecting';
  const ready = codex.connection === 'ready';
  const commands = active && !commandDismissed ? matchingCommands(text, commandMenuOpen) : [];
  const canCompact = !workspace?.actionBusy && ready && codex.threadReady && Boolean(codex.thread) && !codex.terminalOpen && !codex.busy && !codex.loading && !codex.requests.length;
  useEffect(() => { setCommandDismissed(false); setCommandIndex(0); setCommandKeyboardSelected(false); }, [text]);
  useEffect(() => { if (!active) { setCommandMenuOpen(false); setCommandDismissed(true); setShowHistory(false); } }, [active]);
  useEffect(() => {
    if (!commands.length) return;
    const outside = (event: PointerEvent) => { if (!composerRef.current?.contains(event.target as Node)) { setCommandMenuOpen(false); setCommandDismissed(true); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [commands.length]);
  useEffect(() => {
    if (!showHistory) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShowHistory(false); inputRef.current?.focus(); } };
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close);
  }, [showHistory]);
  const selectedModel = codex.models.find(model => model.model === codex.model);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  const modelOptions = codex.models.map(model => ({ value: model.model, label: model.displayName || model.model }));
  if (!codex.model) modelOptions.unshift({ value: '', label: 'Из конфигурации' });
  else if (!modelOptions.some(option => option.value === codex.model)) modelOptions.unshift({ value: codex.model, label: codex.model });
  const effortOptions = [{ value: '', label: 'По умолчанию' }, ...efforts.map(item => ({ value: item.reasoningEffort, label: effortLabels[item.reasoningEffort] || item.reasoningEffort }))];
  if (codex.effort && !effortOptions.some(option => option.value === codex.effort)) effortOptions.splice(1, 0, { value: codex.effort, label: effortLabels[codex.effort] || codex.effort });
  const imagesSupported = !selectedModel?.inputModalities || selectedModel.inputModalities.includes('image');
  const chatItems = codex.items.filter(item => ['userMessage', 'agentMessage', 'plan'].includes(item.type) || (item.type === 'reasoning' && Boolean(reasoningText(item))));
  const activeAction = [...codex.items].reverse().find(item => !item.complete && (!item.status || ['inProgress', 'running', 'pending'].includes(item.status)) && activityLabel(item));
  const currentAction = activityLabel(activeAction);
  const changedFiles = groupFileChanges(codex.items, codex.cwd).length;
  const account = codex.account;
  const accountLabel = account?.email || (account?.type === 'apiKey' ? 'API key' : codex.config?.model_provider ? `Провайдер: ${codex.config.model_provider}` : 'Локальная конфигурация');
  const status = codex.terminalOpen ? 'Диалог в терминале' : codex.connection === 'connecting' ? 'Подключаем Codex' : codex.connection === 'error' ? 'Нет соединения' : codex.requests.length ? 'Ожидает вашего ответа' : codex.loading ? 'Открываем диалог' : codex.busy ? 'Работает над задачей' : codex.thread && !codex.threadReady ? 'Диалог не подключён' : 'Готов к работе';
  const historyThread = codex.history.find(thread => thread.id === codex.thread?.id);
  const firstPrompt = codex.items.find(item => item.type === 'userMessage')?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ');
  const dialogueTitle = workspace?.threadNames?.[codex.thread?.id || ''] || codex.thread?.name || historyThread?.name || codex.thread?.preview || historyThread?.preview || firstPrompt?.slice(0, 100) || 'Новый диалог';

  useEffect(() => {
    const el = chatRef.current;
    if (active && el && !scrolledUp && !showChatSearch) el.scrollTop = el.scrollHeight;
    // Follow new content, not a scroll-position change caused by collapsing work.
    // The "latest message" button already scrolls explicitly.
  }, [active, codex.items, codex.requests, codex.busy]);
  useEffect(() => { setScrolledUp(false); setShowChatSearch(false); }, [codex.thread?.id]);
  useEffect(() => {
    if (!active) return;
    const el = chatRef.current;
    if (el && !showChatSearch) el.scrollTop = scrolledUp ? savedScrollTop.current : el.scrollHeight;
    if (ready) void codex.refreshHistory();
  }, [active]);
  const openChatSearch = () => {
    if (window.innerWidth <= 1000) setShowPanel(false);
    setShowChatSearch(true);
    requestAnimationFrame(() => chatRef.current?.querySelector<HTMLInputElement>('[aria-label="Найти в чате"]')?.focus());
  };
  useEffect(() => {
    if (!active) return;
    const find = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.altKey && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault(); openChatSearch();
      }
    };
    document.addEventListener('keydown', find); return () => document.removeEventListener('keydown', find);
  }, [active]);
  useEffect(() => {
    if (initialThread && ready && !resumeAttempted.current) {
      resumeAttempted.current = true;
      void codex.resume(initialThread, Boolean(restoreSettings));
    }
  }, [initialThread, ready]);
  useEffect(() => {
    workspace?.report(sessionId, {
      cwd: codex.cwd, title: dialogueTitle,
      threadId: codex.thread?.id, terminalOpen: codex.terminalOpen, busy: codex.busy, loading: codex.loading,
      initialized: ready && (!initialThread || resumeAttempted.current),
      connection: codex.connection, pending: codex.requests.length,
      settings: { model: codex.model, effort: codex.effort, access: codex.access },
    });
  }, [workspace?.report, sessionId, codex.cwd, codex.thread?.id, dialogueTitle, initialThread, codex.terminalOpen, codex.busy, codex.loading, codex.connection, codex.requests.length, codex.model, codex.effort, codex.access]);
  const captureUpdateRef = useRef<() => UpdateTabSnapshot | null>(() => null);
  captureUpdateRef.current = () => {
    if (sending || readingImages || showSettings || confirmFull || codex.loading || codex.busy || codex.terminalOpen || codex.requests.length || codex.connection === 'connecting') return null;
    const selected = codex.thread || (!resumeAttempted.current ? initialThread : undefined);
    return {
      sessionId, draft: text, attachments,
      settings: { model: codex.model, effort: codex.effort, access: codex.access },
      ...(selected ? { thread: { id: selected.id, cwd: codex.cwd || selected.cwd, name: dialogueTitle, ...(selected.historyMode ? { historyMode: selected.historyMode } : {}) } } : {}),
    };
  };
  useLayoutEffect(() => workspace?.registerUpdateCapture?.(sessionId, () => captureUpdateRef.current()), [workspace?.registerUpdateCapture, sessionId]);
  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }
  }, [text, active]);

  const addImages = async (files: File[]) => {
    const accepted = files.filter(file => /^image\/(png|jpe?g|webp|gif)$/.test(file.type));
    if (!accepted.length) { codex.setError('Поддерживаются изображения PNG, JPEG, WebP и GIF.'); return; }
    if (accepted.some(file => file.size > 20 * 1024 * 1024)) { codex.setError('Размер одного изображения не должен превышать 20 МБ.'); return; }
    if (attachments.length + accepted.length > 10) { codex.setError('К одному сообщению можно прикрепить до 10 изображений.'); return; }
    setReadingImages(true);
    try {
      const images = await Promise.all(accepted.map(file => new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name || `image-${Date.now()}.png`, dataUrl: String(reader.result) });
        reader.onerror = () => reject(new Error(`Не удалось прочитать ${file.name}`));
        reader.readAsDataURL(file);
      })));
      setAttachments(previous => [...previous, ...images].slice(0, 10)); codex.setError('');
    } catch (e) { codex.setError(errorText(e)); } finally { setReadingImages(false); }
  };
  const send = async () => {
    if (sending || readingImages) return;
    const command = parseSlashCommand(text);
    if (command) {
      if (attachments.length) { codex.setError('Команды не отправляют вложения. Уберите изображения или отправьте обычное сообщение.'); return; }
      if (!command.known) { codex.setError(`Команда /${command.name} пока не поддерживается. Доступные команды: /help.`); return; }
      if (command.args) { codex.setError(`Команда /${command.name} используется без аргументов.`); return; }
      const draft = text;
      if (await executeCommand(command.name as CommandName)) setText(current => current === draft ? '' : current);
      return;
    }
    if (!ready || locked) return;
    if (attachments.length && !imagesSupported) { codex.setError('Выбранная модель не поддерживает изображения. Выберите другую модель.'); return; }
    setSending(true);
    const draft = text; const images = attachments;
    if (await codex.send(draft, images)) { setText(current => current === draft ? '' : current); setAttachments(current => current.filter(image => !images.includes(image))); setScrolledUp(false); }
    setSending(false); inputRef.current?.focus();
  };
  const newChat = () => {
    if (workspace) { workspace.newChat(codex.cwd); return; }
    if (locked) return;
    codex.clearThread(); setText(''); setAttachments([]); codex.setNotice(''); inputRef.current?.focus();
  };
  const continueStopped = async () => {
    if (locked || !ready || !codex.threadReady || sending || readingImages || codex.requests.length) return;
    setSending(true);
    try {
      if (await codex.continueTurn()) {
        setScrolledUp(false);
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      }
    } finally { setSending(false); }
  };
  const executeCommand = async (name: CommandName): Promise<boolean> => {
    setCommandMenuOpen(false); setCommandDismissed(true); codex.setError('');
    if (name === 'help') { setCommandMenuOpen(true); setCommandDismissed(false); inputRef.current?.focus(); return true; }
    if (name === 'status') { setStatusSignal(value => value + 1); return true; }
    if (name === 'new') {
      if (!codex.cwd || (!workspace && locked)) { codex.setError('Новый диалог пока недоступен. Дождитесь подключения.'); return false; }
      newChat(); return true;
    }
    if (name === 'resume') { setShowHistory(true); if (ready) void codex.refreshHistory(); return true; }
    if (locked || !ready || codex.requests.length) { codex.setError('Дождитесь завершения текущей операции и подтверждений.'); return false; }
    if (name === 'compact') {
      if (!codex.thread) { codex.setError('Сначала начните диалог, чтобы сжать его контекст.'); return false; }
      return codex.compact();
    }
    if (name === 'model') { setModelSignal(value => value + 1); return true; }
    if (name === 'permissions') { setAccessSignal(value => value + 1); return true; }
    return false;
  };
  const chooseCommand = async (name: CommandName) => {
    const typedCommand = /^\/[a-z]*$/i.test(text.trim());
    if (typedCommand && attachments.length) { codex.setError('Команды не отправляют вложения. Уберите изображения или отправьте обычное сообщение.'); return; }
    const draft = text;
    if (await executeCommand(name)) {
      if (typedCommand) setText(current => current === draft ? '' : current);
    }
  };
  const addProject = () => { if (workspace) workspace.addProject(); else void codex.selectDirectory(); };
  const selectAccess = (value: Access) => value === 'danger-full-access' && codex.access !== value ? setConfirmFull(true) : codex.selectAccess(value);
  const accessExplanation = '«Спрашивать разрешение» позволяет работать в проекте и запрашивает подтверждение дополнительного доступа. «Одобрять за меня» передаёт такие запросы автоматической проверке Codex; она может отказать. «Полный доступ» разрешает работу с файлами и сетью без подтверждений. Выбор применяется к следующему запросу в этой вкладке.';
  const chatSearchButton = <button type="button" className="icon-button" aria-label="Поиск в чате" title="Поиск в чате (Ctrl+F)" aria-expanded={showChatSearch} onClick={openChatSearch}><Search size={17} /></button>;
  const terminalButton = <button type="button" className={`terminal-button ${codex.terminalOpen ? 'terminal-open' : ''}`} aria-label="Открыть текущую сессию в терминале" title={codex.terminalOpen ? 'Диалог открыт в терминале. Закройте терминал, чтобы продолжить здесь.' : !codex.thread ? 'Сначала начните диалог' : locked || codex.requests.length ? 'Дождитесь завершения текущей операции' : 'Продолжить текущий диалог в терминале Codex'} disabled={!canCompact || sending || readingImages} onClick={() => void codex.openTerminal()}><Terminal size={13} /><span>Терминал</span></button>;

  return <BridgeContext.Provider value={bridge}><div className={`app-shell ${showSidebar ? '' : 'sidebar-hidden'} ${showPanel ? '' : 'panel-hidden'}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Terminal size={19} strokeWidth={2.4} /></div><span>codex<span className="brand-light"> desk</span></span><BuildBadge /></div>
      {workspace ? <ProjectSidebar controls={workspace} active={active} /> : <>
      <button className="new-chat" onClick={newChat} disabled={locked}><Plus size={17} /><span>Новый диалог</span><kbd>+</kbd></button>
      <button className="new-session" aria-label="Добавить рабочую папку" title="Выбрать рабочую папку" onClick={addProject}><FolderPlus size={17} /><span><strong>Новая сессия</strong><small>Добавить рабочую папку</small></span></button>
      <div className="sidebar-section-label">РАБОЧИЕ ПАПКИ</div>
      <div className="project-list">
        {[codex.cwd].map(project => <button key={project || 'empty'} className={`project-card ${project === codex.cwd ? 'active' : ''}`} disabled={locked} onClick={() => void codex.selectDirectory()} title={project || 'Выбрать папку'}><span className="project-icon"><Folder size={19} /></span><span className="project-info"><strong>{project ? folderName(project) : 'Выберите проект'}</strong><small>{project || 'Папка на вашем компьютере'}</small></span>{project === codex.cwd && <span className="project-active-dot" />}</button>)}
      </div>
      <div className="sidebar-section-label history-label"><span>ДИАЛОГИ</span><button className="icon-button small" title="Обновить историю" aria-label="Обновить историю" disabled={!ready || locked || codex.historyLoading} onClick={() => void codex.refreshHistory()}><RefreshCw size={13} className={codex.historyLoading ? 'spin' : ''} /></button></div>
      <div className="history-list">
        {codex.history.map(thread => <button key={thread.id} className={`history-item ${codex.thread?.id === thread.id ? 'active' : ''}`} disabled={locked} onClick={() => { setAttachments([]); setText(''); void codex.resume(thread); }} title={thread.name || thread.preview || 'Новый диалог'}><MessageSquare size={14} /><span>{thread.name || thread.preview || 'Новый диалог'}</span>{codex.thread?.id === thread.id && <span className="history-active-dot" />}</button>)}
        {!codex.history.length && <div className="history-empty"><MessageSquare size={19} /><p>{codex.historyLoading ? 'Загружаем историю…' : 'Здесь будет история\nдиалогов этого проекта'}</p></div>}
        {codex.historyCursor && <button className="text-button history-more" disabled={codex.historyLoading || locked} onClick={() => void codex.refreshHistory(codex.cwd, codex.historyCursor!)}>Загрузить ещё</button>}
      </div>
      </>}
      <div className="sidebar-bottom"><div className="local-engine"><span className={`status-dot ${ready ? 'online' : ''}`} /><span>Локальный Codex CLI</span><span className="connection-label">{ready ? 'ON' : 'OFF'}</span></div><button className="account-button" onClick={() => setShowSettings(true)}><div className="avatar"><Terminal size={15} /></div><span><strong>Ваш Codex</strong><small>{accountLabel}</small></span><Settings2 size={15} /></button></div>
    </aside>

    <main className="main-column">
      <header className="topbar"><button className="icon-button" title={showSidebar ? 'Скрыть проекты' : 'Показать проекты'} aria-label="Переключить панель проектов" onClick={() => setShowSidebar(!showSidebar)}>{showSidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button><div className="breadcrumbs"><span>{codex.cwd ? folderName(codex.cwd) : 'Рабочее пространство'}</span><ChevronRight size={13} /><strong>{dialogueTitle || 'Новый диалог'}</strong></div><div className="topbar-actions">{chatSearchButton}<span className={`connection-pill ${codex.busy ? 'is-working' : ''}`}><span className={`status-dot ${ready ? codex.busy ? 'working' : 'online' : ''}`} />{status}</span><button className="icon-button" title="Настройки" aria-label="Настройки" onClick={() => setShowSettings(true)}><MoreHorizontal size={19} /></button><button className="icon-button" title={showPanel ? 'Скрыть действия' : 'Показать действия'} aria-label="Переключить панель действий" onClick={() => setShowPanel(!showPanel)}>{showPanel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div></header>

      <div className="chat-scroll" ref={chatRef} onScroll={e => { const el = e.currentTarget; if (!active) return; savedScrollTop.current = el.scrollTop; setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 100); }}>
        {!showChatSearch && !chatItems.length && !codex.loading && !codex.busy && !codex.items.some(item => activityLabel(item)) ? <section className="welcome">
          <div className="welcome-symbol"><Terminal size={33} strokeWidth={1.7} /><span /></div>
          <div className="eyebrow welcome-eyebrow">ВАШ ПРОЕКТ. ВАШ CODEX.</div>
          <h1>Давайте что-нибудь<br /><span>сделаем.</span></h1>
          <p className="welcome-description">Возможности Codex CLI — в удобном пространстве.<br />Код, изображения и весь ход работы в одном окне.</p>
          <div className="welcome-cards"><button onClick={() => { setText('Изучи проект и кратко объясни его структуру. Пока ничего не меняй.'); inputRef.current?.focus(); }}><Code2 size={20} /><strong>Разобраться в проекте</strong><span>Структура, логика, точки входа</span><ArrowRight size={15} /></button><button onClick={() => filesRef.current?.click()} disabled={!imagesSupported}><ImagePlus size={20} /><strong>Показать идею</strong><span>Макет, скриншот или референс</span><ArrowRight size={15} /></button></div>
          <button className="welcome-folder" disabled={workspace?.opening || (!workspace && locked)} onClick={addProject}><FolderOpen size={14} /><span>{codex.cwd ? codex.cwd : 'Выбрать рабочую папку'}</span><ChevronDown size={12} /></button>
        </section> : <div className="conversation">
          {codex.itemCursor && !showChatSearch && <button className="text-button load-earlier" disabled={codex.loading} onClick={() => void codex.loadEarlier()}>Показать предыдущие сообщения</button>}
          <ChatSearch key={codex.thread?.id || 'new'} items={codex.items} turnWork={codex.turnWork} open={showChatSearch} active={active} onClose={() => { setShowChatSearch(false); inputRef.current?.focus({ preventScroll: true }); }} hasEarlier={Boolean(codex.itemCursor)} loading={codex.loading} onLoadEarlier={() => void codex.loadEarlier()} />
          {codex.busy && <div className="working-indicator"><span className="working-orb" /><span>{codex.requests.length ? 'Codex ждёт вашего ответа' : currentAction || 'Codex работает'}<span className="working-dots">...</span></span></div>}
        </div>}
        {codex.loading && <div className="loading-chat"><LoaderCircle className="spin" size={22} /><span>Открываем диалог…</span></div>}
        {codex.requests.length > 0 && <div className="requests-list">{codex.requests.map(request => <Approval key={request.id} request={request} items={codex.items} respond={codex.respond} />)}</div>}
      </div>

      <div className="composer-area">
        {scrolledUp && <button className="scroll-bottom" onClick={() => { setScrolledUp(false); if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }}><ArrowDown size={14} />К последнему сообщению</button>}
        {codex.error && <div className="alert error-alert" role="alert"><span>{codex.error}</span>{codex.connection === 'error' && <button onClick={() => void codex.connect()}><RefreshCw size={14} />Подключить</button>}<button className="icon-button small" title="Скрыть ошибку" aria-label="Скрыть ошибку" onClick={() => codex.setError('')}><X size={14} /></button></div>}
        {codex.notice && <div className="alert notice-alert"><span>{codex.notice}</span>{codex.canContinue && <button type="button" className="continue-button" aria-label="Продолжить выполнение" title="Отправить «Продолжай» в этот диалог" disabled={locked || !ready || !codex.threadReady || sending || readingImages || Boolean(codex.requests.length)} onClick={() => void continueStopped()}><ArrowRight size={14} />Продолжить</button>}<button className="icon-button small" title="Скрыть уведомление" aria-label="Скрыть уведомление" onClick={() => codex.setNotice('')}><X size={14} /></button></div>}
        {ready && codex.thread && !codex.threadReady && !codex.loading && <div className="alert notice-alert"><span>Для продолжения нужно подключить диалог.</span><button disabled={locked || sending} onClick={() => void codex.resume(codex.thread!, true)}><RefreshCw size={14} />Повторить подключение</button></div>}
        <div ref={composerRef} className={`composer ${dragOver ? 'drag-over' : ''}`} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }} onDrop={e => { e.preventDefault(); setDragOver(false); void addImages([...e.dataTransfer.files]); }}>
          {commands.length > 0 && <CommandMenu commands={commands} selected={Math.min(commandIndex, commands.length - 1)} onHighlight={setCommandIndex} onSelect={name => void chooseCommand(name)} />}
          {dragOver && <div className="drop-overlay"><ImagePlus size={24} />Добавить изображения к сообщению</div>}
          {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, i) => <div className="attachment" key={`${attachment.name}-${i}`}><img src={attachment.dataUrl} alt={attachment.name} /><button title="Удалить изображение" aria-label={`Удалить ${attachment.name}`} onClick={() => setAttachments(previous => previous.filter((_, index) => index !== i))}><X size={12} /></button><span>{attachment.name}</span></div>)}</div>}
          <textarea ref={inputRef} value={text} rows={2} placeholder="Что будем делать? Можно вставить изображение…" aria-label="Сообщение Codex" onChange={e => { setCommandMenuOpen(false); setText(e.target.value); }} onPaste={e => { const files = [...e.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { e.preventDefault(); void addImages(files); } }} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (commands.length && e.key === 'Escape') { e.preventDefault(); setCommandMenuOpen(false); setCommandDismissed(true); } else if (commands.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setCommandKeyboardSelected(true); setCommandIndex(index => (index + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length); } else if (commands.length && (matchingCommands(text).length > 0 || commandKeyboardSelected) && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); void chooseCommand(commands[Math.min(commandIndex, commands.length - 1)].name); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div className="composer-toolbar"><div className="composer-tools"><button className="icon-button attach-button" title="Прикрепить изображения (или Ctrl+V)" aria-label="Прикрепить изображения" disabled={readingImages || !imagesSupported} onClick={() => filesRef.current?.click()}>{readingImages ? <LoaderCircle size={18} className="spin" /> : <Plus size={20} />}</button><span className="toolbar-divider" />
            <button type="button" className="icon-button" aria-label="Команды Codex" title="Команды Codex (/)" onClick={() => { setCommandMenuOpen(value => !value); setCommandDismissed(false); setCommandKeyboardSelected(false); inputRef.current?.focus(); }}><Terminal size={16} /></button>
            <ComposerSelect kind="model" label="Модель" value={codex.model} options={modelOptions} icon={<Cpu size={14} />} disabled={locked || !ready} active={active} openSignal={modelSignal} onChange={codex.selectModel} />
            <ComposerSelect kind="effort" label="Глубина размышлений" value={codex.effort} options={effortOptions} icon={<Brain size={14} />} disabled={locked || !ready || !efforts.length} active={active} onChange={codex.selectEffort} />
          </div>{codex.busy ? <button className="stop-button" onClick={() => void codex.stop()} title="Остановить выполнение" aria-label="Остановить выполнение"><Square size={14} fill="currentColor" /></button> : <button className="send-button" title="Отправить (Enter)" aria-label="Отправить сообщение" disabled={!ready || locked || sending || readingImages || (!text.trim() && !attachments.length)} onClick={() => void send()}><ArrowUp size={20} /></button>}</div>
        </div>
        <div className="composer-footer"><AccessSelect value={codex.access} disabled={locked || !ready} active={active} openSignal={accessSignal} onChange={selectAccess} />{terminalButton}<span className="keyboard-hint"><kbd>Enter</kbd> отправить<span>·</span><kbd>Shift Enter</kbd> новая строка</span><CacheControl active={active} tokens={codex.tokens} session={{ activityAt: codex.cacheActivityAt, generation: codex.cacheGeneration, completed: codex.cacheTurnCompleted, threadId: codex.thread?.id, busy: codex.busy, loading: codex.loading, connection: codex.connection, pending: codex.requests.length, blocked: !codex.threadReady || Boolean(workspace?.actionBusy) || codex.terminalOpen || sending || readingImages || showSettings || confirmFull || showHistory || commands.length > 0, sendPing: codex.sendPing }} /><TokenUsage tokens={codex.tokens} openSignal={statusSignal} canCompact={canCompact} compacting={codex.compacting} onCompact={() => void codex.compact()} active={active} sessionKey={`${sessionId}:${codex.thread?.id || "new"}`} /></div>
      </div>
    </main>

    <aside className="details-panel"><div className="panel-tabs">
      <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Folder size={14} />Файлы</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><Terminal size={14} />Действия{codex.busy && <span className="tab-live-dot" />}</button>
      <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><GitBranch size={14} />Изменения{changedFiles > 0 && <span className="count-badge">{changedFiles}</span>}</button>
    </div><div className="panel-scroll">
      <div hidden={tab !== 'files'}><FileBrowser cwd={codex.cwd} active={active && showPanel && tab === 'files'} refreshKey={changedFiles} /></div>
      {tab === 'activity' && <ActivityPanel items={codex.items} plan={codex.plan} busy={codex.busy} />}
      {tab === 'changes' && <ChangesPanel items={codex.items} diff={codex.diff} cwd={codex.cwd} />}
    </div><div className="panel-bottom"><span className="status-dot online" /><span>{tab === 'files' ? 'Файлы текущей рабочей папки' : 'Изменения сохраняются в проекте'}</span></div></aside>
    <input ref={filesRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { void addImages([...(e.target.files || [])]); e.currentTarget.value = ''; }} />

    {showHistory && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setShowHistory(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="История диалогов"><div className="modal-header"><h2>История диалогов</h2><button type="button" className="icon-button" aria-label="Закрыть историю" onClick={() => setShowHistory(false)}><X size={18} /></button></div><div className="command-history">{codex.history.map(thread => <button key={thread.id} disabled={!workspace && locked} onClick={() => { setShowHistory(false); if (workspace) workspace.openThread(codex.cwd, thread); else void codex.resume(thread); }}>{thread.name || thread.preview || 'Новый диалог'}</button>)}{!codex.history.length && <p className="muted">{codex.historyLoading ? 'Загружаем историю…' : 'В этой папке пока нет диалогов.'}</p>}{codex.historyCursor && <button disabled={codex.historyLoading} onClick={() => void codex.refreshHistory(codex.cwd, codex.historyCursor!)}>Загрузить ещё</button>}</div></section></div>}
    {showSettings && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowSettings(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><span className="eyebrow">CODEX DESK</span><h2 id="settings-title">Ваше рабочее пространство</h2></div><button className="icon-button" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={() => setShowSettings(false)}><X size={19} /></button></div><div className="settings-content"><McpSettings bridge={bridge} active={active && showSettings} /><div className="settings-row"><span><strong>Рабочая папка</strong><small>{codex.cwd || 'Не выбрана'}</small></span><button className="secondary-button" disabled={workspace?.opening || (!workspace && locked)} onClick={addProject}><FolderOpen size={14} />Изменить</button></div><div className="settings-row"><span><strong>Codex CLI</strong><small>{codex.executable || 'Автоматический поиск'}</small></span><button className="secondary-button" disabled={locked} onClick={() => void codex.selectExecutable()}>Выбрать</button></div><div className="settings-row"><span><strong>Соединение</strong><small>{status}</small></span><button className="secondary-button" disabled={locked} onClick={() => void codex.connect()}><RefreshCw size={14} />Переподключить</button></div><div className="settings-explanation"><Terminal size={18} /><p>Оболочка использует установленный Codex CLI, его аккаунт, конфигурацию, навыки и инструкции проекта. Модель и глубину размышлений можно изменить под сообщением.</p></div><div className="settings-explanation"><Brain size={18} /><p>Пояснения появляются, только когда Codex прислал текст. Пустые блоки скрыты. Конкретные команды, читаемые файлы и результаты видны в панели «Действия».</p></div><div className="settings-explanation"><Shield size={18} /><p>{accessExplanation}</p></div>{codex.diagnostics.length > 0 && <details className="diagnostics"><summary>Диагностика подключения</summary><pre>{codex.diagnostics.join('\n')}</pre></details>}</div><div className="modal-footer"><span>Ваш код · Ваш терминал · Ваш выбор</span><button className="primary-button" onClick={() => setShowSettings(false)}>Готово<Check size={15} /></button></div></section></div>}

    {confirmFull && <div className="modal-backdrop"><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="full-access-title"><div className="permission-symbol"><Shield size={26} /></div><h2 id="full-access-title">Включить полный доступ?</h2><p>Codex сможет выполнять команды, обращаться к сети и изменять файлы за пределами проекта без запросов подтверждения.</p><p className="muted">Режим применяется со следующего сообщения в этой вкладке.</p><div className="confirm-actions"><button className="secondary-button" autoFocus onClick={() => setConfirmFull(false)}>Отмена</button><button className="danger-button" onClick={() => { codex.selectAccess('danger-full-access'); setConfirmFull(false); }}>Включить полный доступ</button></div></section></div>}
  </div></BridgeContext.Provider>;
}

