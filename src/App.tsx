import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Brain, Check, ChevronDown, ChevronRight, Code2, CornerDownRight, Cpu, Folder, FolderOpen, FolderPlus, GitBranch, ImagePlus, ListPlus, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Search, Settings2, Shield, Square, Terminal, X } from 'lucide-react';
import type { Access, AgentProvider, Attachment, CodexBridge, Item, MessageQueueState, ScrollAnchor, SessionAttentionEvent, Settings, Thread, UpdateTabSnapshot } from './types';
import { BridgeContext } from './BridgeContext';
import { AgentContext, agentName } from './AgentContext';
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
import UpdateNotice from './UpdateNotice';
import MessageQueue from './MessageQueue';
import { useMessageQueue } from './useMessageQueue';
import { readScrollAnchor, restoreScrollAnchor } from './scroll-anchor';
import FileViewer from './FileViewer';
import { useMessageJump, type MessageJump } from './useMessageJump';
import { cliVersionNote } from './cli-versions';
import EffectiveSettings from './EffectiveSettings';
import UsageLimit from './UsageLimit';

const effortLabels: Record<string, string> = { none: 'Без размышлений', minimal: 'Минимум', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимум', ultra: 'Ультра' };

export type SessionSummary = { cwd: string; title: string; threadId?: string; initialized: boolean; terminalOpen: boolean; busy: boolean; loading: boolean; connection: string; pending: number; settings: Settings };
export type WorkspaceControls = ProjectTreeControls & {
  threadNames?: Record<string, string>;
  newChat(cwd: string, provider?: AgentProvider): void;
  openThread(cwd: string, thread: Thread): void;
  report(id: string, summary: SessionSummary): void;
  registerUpdateCapture?(id: string, capture: (persistent?: boolean) => UpdateTabSnapshot | null): () => void;
  onSessionStateChange?(id: string): void;
  flushSessionState?(): Promise<void>;
  onSessionAttention?(id: string, event: SessionAttentionEvent, title: string): void;
};
export default function App({ bridge = window.codex, sessionId = 'default', active = true, initialThread, initialDraft = '', initialAttachments = [], initialQueue, initialScrollTop, initialScrollAnchor, initialPreservedDraft, restoreSettings, workspace, jump }: {
  bridge?: CodexBridge; sessionId?: string; active?: boolean; initialThread?: Thread; initialDraft?: string; initialAttachments?: Attachment[]; initialQueue?: MessageQueueState; initialScrollTop?: number; initialScrollAnchor?: ScrollAnchor; initialPreservedDraft?: { text: string; attachments: Attachment[] }; restoreSettings?: Settings; workspace?: WorkspaceControls; jump?: MessageJump;
}) {
  const attentionRef = useRef<(event: SessionAttentionEvent) => void>(() => {});
  const codex = useCodex(bridge, { restoreSettings, onAttention: event => attentionRef.current(event) });
  const engineName = agentName(codex.provider);
  const [text, setText] = useState(initialDraft);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [editingMessage, setEditingMessage] = useState(Boolean(initialPreservedDraft));
  const [loadingEdit, setLoadingEdit] = useState(false);
  const savedDraft = useRef<{ text: string; attachments: Attachment[] } | null>(initialPreservedDraft || null);
  const editThread = useRef(initialThread?.id);
  const editGeneration = useRef(0);
  const editPending = useRef(false);
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
  const [showChangesReview, setShowChangesReview] = useState(false);
  const [fileViewer, setFileViewer] = useState<{ path?: string } | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const filePickerPending = useRef(false);
  const filePickerGeneration = useRef(0);
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
  const savedScrollTop = useRef(initialScrollTop ?? 0);
  const pendingScroll = useRef(initialScrollTop ?? (initialScrollAnchor ? 0 : undefined));
  const savedAnchor = useRef(initialScrollAnchor);
  const anchorCursors = useRef(new Set<string>());
  const [scrolledUp, setScrolledUp] = useState(initialScrollTop !== undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusDraftEnd = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  useMessageJump({ jump, active, loading: codex.loading, ready: Boolean(codex.thread), items: codex.items, hasEarlier: Boolean(codex.itemCursor), loadEarlier: () => void codex.loadEarlier(), container: chatRef,
    onMissing: () => codex.setNotice('Сообщение не найдено в доступной истории. Оно могло быть удалено или сжато.'), onJump: () => { pendingScroll.current = undefined; setScrolledUp(true); } });
  useEffect(() => {
    if (!active) { setFileViewer(null); return; }
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && !event.altKey && !document.querySelector('[aria-modal="true"]')) { event.preventDefault(); if (codex.cwd) setFileViewer({}); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [active, codex.cwd]);
  const locked = workspace?.actionBusy || codex.terminalOpen || codex.busy || codex.loading || codex.connection === 'connecting';
  const ready = codex.connection === 'ready';
  const queueOwner = useRef<{ threadId?: string; cwd?: string } | null>(initialQueue?.items.length ? { threadId: initialQueue.threadId || initialThread?.id, cwd: initialQueue.cwd || initialThread?.cwd } : null);
  const queueOwnerMismatch = Boolean(queueOwner.current && ((queueOwner.current.threadId && queueOwner.current.threadId !== codex.thread?.id) || (queueOwner.current.cwd && codex.cwd && queueOwner.current.cwd !== codex.cwd)));
  const queueBlocked = Boolean(queueOwnerMismatch || workspace?.actionBusy || codex.terminalOpen || codex.loading || !ready || codex.requests.length || sending || readingImages || selectingFiles || editingMessage || loadingEdit || showSettings || showChangesReview || Boolean(fileViewer) || confirmFull || (codex.thread && !codex.threadReady) || (initialThread && !resumeAttempted.current));
  const queue = useMessageQueue(initialQueue, {
    busy: codex.busy, blocked: queueBlocked, completion: codex.queueCompletion, pause: codex.queuePause,
    canSend: codex.canSendQueued, send: codex.send, flush: workspace?.flushSessionState,
  });
  useEffect(() => {
    if (!queue.state.items.length) { queueOwner.current = null; return; }
    if (queueOwnerMismatch && ready && !codex.loading && (!initialThread || resumeAttempted.current) && queue.state.reason !== 'Очередь относится к прежнему диалогу. Откройте его перед продолжением.') queue.pause('Очередь относится к прежнему диалогу. Откройте его перед продолжением.');
  }, [queueOwnerMismatch, queue.state.items.length, queue.state.reason, ready, codex.loading, initialThread]);
  const commands = active && !editingMessage && !loadingEdit && !commandDismissed ? matchingCommands(text, commandMenuOpen).filter(command => command.name !== 'compact' || codex.capabilities.compact) : [];
  const editContext = useRef({ text, attachments, active, sending, readingImages, loading: codex.loading, terminalOpen: codex.terminalOpen, actionBusy: workspace?.actionBusy });
  editContext.current = { text, attachments, active, sending, readingImages, loading: codex.loading, terminalOpen: codex.terminalOpen, actionBusy: workspace?.actionBusy };
  useLayoutEffect(() => {
    filePickerGeneration.current++;
    return () => { filePickerGeneration.current++; };
  }, [bridge, codex.cwd, codex.thread?.id, active, editingMessage]);
  useLayoutEffect(() => {
    editGeneration.current += 1;
    editPending.current = false;
    setLoadingEdit(false);
    return () => { editGeneration.current += 1; editPending.current = false; };
  }, [bridge, codex.cwd, codex.thread?.id, active]);
  useEffect(() => {
    if (!codex.thread) return;
    if (savedDraft.current && editThread.current !== codex.thread.id) {
      setText(savedDraft.current.text); setAttachments(savedDraft.current.attachments);
      savedDraft.current = null; setEditingMessage(false);
    }
    editThread.current = codex.thread.id;
  }, [bridge, codex.cwd, codex.thread?.id]);
  const canOperateThread = !selectingFiles && !workspace?.actionBusy && ready && codex.threadReady && Boolean(codex.thread) && !codex.terminalOpen && !codex.busy && !codex.loading && !codex.requests.length;
  const canCompact = codex.capabilities.compact && canOperateThread;
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
  const status = codex.terminalOpen ? 'Диалог в терминале' : codex.connection === 'connecting' ? `Подключаем ${engineName}` : codex.connection === 'error' ? 'Нет соединения' : codex.requests.length ? 'Ожидает вашего ответа' : codex.loading ? 'Открываем диалог' : codex.busy ? 'Работает над задачей' : codex.thread && !codex.threadReady ? 'Диалог не подключён' : 'Готов к работе';
  const historyThread = codex.history.find(thread => thread.id === codex.thread?.id);
  const firstPrompt = codex.items.find(item => item.type === 'userMessage')?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ');
  const dialogueTitle = workspace?.threadNames?.[codex.thread?.id || ''] || codex.thread?.name || historyThread?.name || codex.thread?.preview || historyThread?.preview || firstPrompt?.slice(0, 100) || 'Новый диалог';
  const saveBookmark = async (item: Item) => {
    if (!codex.thread || !window.codex.saveBookmark) throw new Error('Сначала откройте сохранённый диалог.');
    const excerpt = item.type === 'userMessage' ? (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : item.text || '';
    await window.codex.saveBookmark({ provider: codex.provider, cwd: codex.cwd, threadId: codex.thread.id, itemId: item.id, ...(item.turnId ? { turnId: item.turnId } : {}), threadName: dialogueTitle.replace(/\s+/g, ' ').slice(0, 500), excerpt: excerpt.slice(0, 4000) });
  };
  attentionRef.current = event => workspace?.onSessionAttention?.(sessionId, event, dialogueTitle);

  useEffect(() => {
    const el = chatRef.current;
    if (active && el && pendingScroll.current === undefined && !scrolledUp && !showChatSearch) el.scrollTop = el.scrollHeight;
    // Follow new content, not a scroll-position change caused by collapsing work.
    // The "latest message" button already scrolls explicitly.
  }, [active, codex.items, codex.requests, codex.busy]);
  useEffect(() => { if (pendingScroll.current === undefined) setScrolledUp(false); setShowChatSearch(false); }, [codex.thread?.id]);
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (!active || !el || pendingScroll.current === undefined || !ready || codex.loading || (initialThread && (!resumeAttempted.current || !codex.thread))) return;
    if (savedAnchor.current && !restoreScrollAnchor(el, savedAnchor.current) && codex.itemCursor && !codex.error && !anchorCursors.current.has(codex.itemCursor)) {
      anchorCursors.current.add(codex.itemCursor);
      void codex.loadEarlier();
      return;
    }
    if (!savedAnchor.current || !restoreScrollAnchor(el, savedAnchor.current)) el.scrollTop = pendingScroll.current;
    savedScrollTop.current = el.scrollTop;
    pendingScroll.current = undefined;
    setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 100);
  }, [active, ready, codex.loading, codex.items, codex.thread?.id, codex.itemCursor, codex.error, initialThread]);
  useEffect(() => {
    if (!active) return;
    const el = chatRef.current;
    if (el && !showChatSearch && pendingScroll.current === undefined) el.scrollTop = scrolledUp ? savedScrollTop.current : el.scrollHeight;
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
      settings: { ...(codex.provider === 'claude' ? { provider: codex.provider } : {}), model: codex.model, effort: codex.effort, access: codex.access },
    });
  }, [workspace?.report, sessionId, codex.cwd, codex.thread?.id, dialogueTitle, initialThread, codex.terminalOpen, codex.busy, codex.loading, codex.connection, codex.requests.length, codex.provider, codex.model, codex.effort, codex.access]);
  const captureUpdateRef = useRef<(persistent?: boolean) => UpdateTabSnapshot | null>(() => null);
  captureUpdateRef.current = persistent => {
    if (!persistent && (sending || queue.inFlight || readingImages || selectingFiles || editingMessage || loadingEdit || showSettings || showChangesReview || Boolean(fileViewer) || confirmFull || codex.loading || codex.busy || codex.terminalOpen || codex.requests.length || codex.connection === 'connecting')) return null;
    const selected = codex.thread || (!resumeAttempted.current ? initialThread : undefined);
    return {
      sessionId, draft: text, attachments, queue: { ...queue.snapshot(), ...queueOwner.current },
      scrollTop: pendingScroll.current ?? (active && chatRef.current ? chatRef.current.scrollTop : savedScrollTop.current),
      scrollAnchor: pendingScroll.current !== undefined || !active || !chatRef.current ? savedAnchor.current : readScrollAnchor(chatRef.current),
      ...(savedDraft.current ? { preservedDraft: savedDraft.current } : {}),
      settings: !codex.cwd && restoreSettings ? restoreSettings : { ...(codex.provider === 'claude' ? { provider: codex.provider } : {}), model: codex.model, effort: codex.effort, access: codex.access },
      ...(selected ? { thread: { id: selected.id, ...(codex.provider === 'claude' ? { provider: codex.provider } : {}), cwd: codex.cwd || selected.cwd, name: dialogueTitle, ...(selected.historyMode ? { historyMode: selected.historyMode } : {}) } } : {}),
    };
  };
  useLayoutEffect(() => workspace?.registerUpdateCapture?.(sessionId, persistent => captureUpdateRef.current(persistent)), [workspace?.registerUpdateCapture, sessionId]);
  useEffect(() => { workspace?.onSessionStateChange?.(sessionId); }, [workspace?.onSessionStateChange, sessionId, text, attachments, queue.state, editingMessage]);
  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }
  }, [text, attachments, active, editingMessage, loadingEdit]);

  useLayoutEffect(() => {
    if (!focusDraftEnd.current) return;
    focusDraftEnd.current = false;
    const input = inputRef.current;
    if (!active || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  }, [text, attachments, active, editingMessage, loadingEdit]);

  const askAboutPath = (path: string) => {
    if (editPending.current || sending) return;
    focusDraftEnd.current = true;
    setCommandMenuOpen(false);
    setText(current => `${current}${current && !current.endsWith('\n') ? '\n' : ''}${path}\n`);
    if (window.innerWidth <= 1000) setShowPanel(false);
  };

  const editMessage = useCallback(async (item: Item) => {
    const current = editContext.current;
    if (!current.active || current.sending || current.readingImages || filePickerPending.current || current.loading || current.terminalOpen || current.actionBusy || editPending.current) return;
    const version = ++editGeneration.current;
    editPending.current = true; setLoadingEdit(true);
    try {
      const content = item.content || [];
      if (content.some((part: any) => !['text', 'image', 'localImage'].includes(part.type))) throw new Error('Это сообщение содержит вложения, которые пока нельзя перенести в редактор. Текущий черновик сохранён.');
      const imageParts = content.filter((part: any) => ['image', 'localImage'].includes(part.type));
      const sources = imageParts.length ? imageParts : item.previews || [];
      if (sources.length > 10) throw new Error('В сообщении больше 10 изображений. Текущий черновик сохранён.');
      const images: Attachment[] = await Promise.all(sources.map(async (part: any, index: number) => {
        const preview = imageParts.length ? item.previews?.[index] : part;
        const sourcePath = part.path || preview?.path;
        const name = preview?.name || (sourcePath ? folderName(sourcePath) : `Изображение ${index + 1}`);
        let dataUrl = preview?.dataUrl || part.dataUrl || part.url;
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl || '') && sourcePath) dataUrl = await bridge.readAttachment(sourcePath);
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl || '')) throw new Error(`Не удалось восстановить изображение «${name}». Текущий черновик сохранён.`);
        return { name, dataUrl, ...(sourcePath ? { path: sourcePath } : {}) };
      }));
      if (editGeneration.current !== version) return;
      const latest = editContext.current;
      savedDraft.current ||= { text: latest.text, attachments: latest.attachments };
      focusDraftEnd.current = true;
      setText(content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'));
      setAttachments(images); setEditingMessage(true); setCommandMenuOpen(false); setShowChatSearch(false);
      if (window.innerWidth <= 1000) setShowPanel(false);
    } catch (error) {
      if (editGeneration.current === version) codex.setError(errorText(error));
    } finally {
      if (editGeneration.current === version) { editPending.current = false; setLoadingEdit(false); }
    }
  }, [bridge, codex.setError]);

  const cancelEdit = () => {
    if (sending || readingImages) return;
    editGeneration.current += 1; editPending.current = false; setLoadingEdit(false);
    const draft = savedDraft.current;
    savedDraft.current = null; setEditingMessage(false);
    if (draft) { focusDraftEnd.current = true; setText(draft.text); setAttachments(draft.attachments); }
  };

  const addImages = async (files: File[]) => {
    if (sending || editPending.current || filePickerPending.current) return;
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
  const chooseFiles = async () => {
    if (filePickerPending.current || readingImages || loadingEdit || sending || !active || workspace?.actionBusy) return;
    if (!bridge.chooseComposerFiles) { codex.setError('Выбор файлов доступен после обновления приложения. Изображение можно вставить через Ctrl+V.'); return; }
    const version = filePickerGeneration.current;
    filePickerPending.current = true; setSelectingFiles(true);
    try {
      const result = await bridge.chooseComposerFiles({ imageSlots: Math.max(0, 10 - attachments.length), imagesSupported });
      if (!result || version !== filePickerGeneration.current) return;
      const totalImages = [...editContext.current.attachments, ...result.images];
      const bytes = (dataUrl: string) => Math.floor((dataUrl.split(',')[1]?.length || 0) * 3 / 4);
      if (totalImages.length > 10 || totalImages.reduce((sum, image) => sum + bytes(image.dataUrl), 0) > 60 * 1024 * 1024) throw new Error('В сообщении должно быть не больше 10 изображений общим размером до 60 МБ. Удалите часть изображений и повторите выбор.');
      const paths = result.paths.join('\n');
      focusDraftEnd.current = true;
      setCommandMenuOpen(false); setCommandDismissed(true);
      if (paths) setText(current => `${current}${current && !current.endsWith('\n') ? '\n' : ''}${paths}\n`);
      if (result.images.length) setAttachments(current => [...current, ...result.images]);
      codex.setError('');
      if (result.message) codex.setNotice(result.message);
      if (window.innerWidth <= 1000) setShowPanel(false);
    } catch (e) { if (version === filePickerGeneration.current) codex.setError(errorText(e)); }
    finally { filePickerPending.current = false; setSelectingFiles(false); }
  };
  const clearSentDraft = (draft: string, images: Attachment[]) => {
    if (savedDraft.current) { const saved = savedDraft.current; savedDraft.current = null; setEditingMessage(false); setText(saved.text); setAttachments(saved.attachments); }
    else { setText(current => current === draft ? '' : current); setAttachments(current => current.filter(image => !images.includes(image))); }
  };
  const steerCurrent = async () => {
    if (workspace?.actionBusy || codex.terminalOpen || codex.loading || !ready || codex.requests.length || !codex.busy || codex.compacting || codex.steering || sending || readingImages || filePickerPending.current || editPending.current) return;
    if (!editingMessage && parseSlashCommand(text)) { codex.setError('Команды выполняются отдельно. Для уточнения напишите обычное сообщение.'); return; }
    const draft = text, images = attachments;
    setSending(true);
    try { if (await codex.steer(draft, images)) clearSentDraft(draft, images); }
    finally { setSending(false); inputRef.current?.focus(); }
  };
  const enqueueMessage = () => {
    if (sending || readingImages || filePickerPending.current || editPending.current || (!text.trim() && !attachments.length)) return;
    if (queue.state.items.length >= 50) { codex.setError('В очереди уже 50 сообщений. Удалите или отправьте часть из них.'); return; }
    if (!editingMessage && parseSlashCommand(text)) { codex.setError('Команды выполняются отдельно и не добавляются в очередь сообщений.'); return; }
    if (queueOwnerMismatch) { codex.setError('Сначала удалите очередь прежнего диалога или вернитесь в него.'); return; }
    queueOwner.current ||= { threadId: codex.thread?.id, cwd: codex.cwd };
    queue.enqueue(text, attachments);
    clearSentDraft(text, attachments);
    inputRef.current?.focus();
  };
  const send = async () => {
    if (sending || readingImages || filePickerPending.current || editPending.current) return;
    const command = editingMessage ? null : parseSlashCommand(text);
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
    if (await codex.send(draft, images)) {
      clearSentDraft(draft, images);
      setScrolledUp(false);
    }
    setSending(false); inputRef.current?.focus();
  };
  const newChat = () => {
    if (workspace) { workspace.newChat(codex.cwd, codex.provider); return; }
    if (locked) return;
    codex.clearThread(); setText(''); setAttachments([]); codex.setNotice(''); inputRef.current?.focus();
  };
  const selectProvider = (value: string) => {
    if (!workspace || value === codex.provider || (value !== 'codex' && value !== 'claude')) return;
    workspace.newChat(codex.cwd || workspace.activeCwd, value);
  };
  const continueStopped = async () => {
    if (locked || !ready || !codex.threadReady || sending || readingImages || filePickerPending.current || codex.requests.length) return;
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
      if (!codex.capabilities.compact) { codex.setError(`Сжатие контекста ${engineName} из приложения пока недоступно.`); return false; }
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
  const accessExplanation = codex.provider === 'claude'
    ? '«Спрашивать разрешение» использует обычные подтверждения Claude Code. «Разрешать правки» автоматически разрешает редактирование файлов; разрешения на другие инструменты проверяет Claude Code. «Полный доступ» отключает запросы подтверждения. Выбор применяется к следующему запросу в этой вкладке.'
    : '«Спрашивать разрешение» позволяет работать в проекте и запрашивает подтверждение дополнительного доступа. «Одобрять за меня» передаёт такие запросы автоматической проверке Codex; она может отказать. «Полный доступ» разрешает работу с файлами и сетью без подтверждений. Выбор применяется к следующему запросу в этой вкладке.';
  const chatSearchButton = <button type="button" className="icon-button" aria-label="Поиск в чате" title="Поиск в чате (Ctrl+F)" aria-expanded={showChatSearch} onClick={openChatSearch}><Search size={17} /></button>;
  const terminalButton = <button type="button" className={`terminal-button ${codex.terminalOpen ? 'terminal-open' : ''}`} aria-label="Открыть текущую сессию в терминале" title={!codex.capabilities.terminal ? `Продолжение ${engineName} в терминале пока недоступно` : codex.terminalOpen ? 'Диалог открыт в терминале. Закройте терминал, чтобы продолжить здесь.' : !codex.thread ? 'Сначала начните диалог' : locked || codex.requests.length ? 'Дождитесь завершения текущей операции' : `Продолжить текущий диалог в терминале ${engineName}`} disabled={!codex.capabilities.terminal || !canOperateThread || sending || readingImages} onClick={() => void codex.openTerminal()}><Terminal size={13} /><span>Терминал</span></button>;

  return <AgentContext.Provider value={codex.provider}><BridgeContext.Provider value={bridge}><div className={`app-shell ${showSidebar ? '' : 'sidebar-hidden'} ${showPanel ? '' : 'panel-hidden'}`}>
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
      <div className="sidebar-bottom"><div className="local-engine"><span className={`status-dot ${ready ? 'online' : ''}`} /><span>Локальный {engineName} CLI</span><span className="connection-label">{ready ? 'ON' : 'OFF'}</span></div><button className="account-button" onClick={() => setShowSettings(true)}><div className="avatar"><Terminal size={15} /></div><span><strong>Ваш {engineName}</strong><small>{accountLabel}</small></span><Settings2 size={15} /></button></div>
    </aside>

    <main className="main-column">
      <header className="topbar"><button className="icon-button" title={showSidebar ? 'Скрыть проекты' : 'Показать проекты'} aria-label="Переключить панель проектов" onClick={() => setShowSidebar(!showSidebar)}>{showSidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button><div className="breadcrumbs"><span>{codex.cwd ? folderName(codex.cwd) : 'Рабочее пространство'}</span><ChevronRight size={13} /><strong>{dialogueTitle || 'Новый диалог'}</strong></div><div className="topbar-actions">{chatSearchButton}<span className={`connection-pill ${codex.busy ? 'is-working' : ''}`}><span className={`status-dot ${ready ? codex.busy ? 'working' : 'online' : ''}`} />{status}</span><button className="icon-button" title="Настройки" aria-label="Настройки" onClick={() => setShowSettings(true)}><MoreHorizontal size={19} /></button><button className="icon-button" title={showPanel ? 'Скрыть действия' : 'Показать действия'} aria-label="Переключить панель действий" onClick={() => setShowPanel(!showPanel)}>{showPanel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div></header>

      <div className="chat-scroll" ref={chatRef} onScroll={e => { const el = e.currentTarget; if (!active || pendingScroll.current !== undefined) return; savedScrollTop.current = el.scrollTop; savedAnchor.current = readScrollAnchor(el); setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 100); workspace?.onSessionStateChange?.(sessionId); }}>
        {!showChatSearch && !chatItems.length && !codex.loading && !codex.busy && !codex.items.some(item => activityLabel(item)) ? <section className="welcome">
          <div className="welcome-symbol"><Terminal size={33} strokeWidth={1.7} /><span /></div>
          <div className="eyebrow welcome-eyebrow">ВАШ ПРОЕКТ. ВАШ {codex.provider === 'claude' ? 'CLAUDE' : 'CODEX'}.</div>
          <h1>Давайте что-нибудь<br /><span>сделаем.</span></h1>
          <p className="welcome-description">Возможности {engineName} CLI — в удобном пространстве.<br />Код, изображения и весь ход работы в одном окне.</p>
          <div className="welcome-cards"><button onClick={() => { setText('Изучи проект и кратко объясни его структуру. Пока ничего не меняй.'); inputRef.current?.focus(); }}><Code2 size={20} /><strong>Разобраться в проекте</strong><span>Структура, логика, точки входа</span><ArrowRight size={15} /></button><button onClick={() => filesRef.current?.click()} disabled={!imagesSupported}><ImagePlus size={20} /><strong>Показать идею</strong><span>Макет, скриншот или референс</span><ArrowRight size={15} /></button></div>
          <button className="welcome-folder" disabled={workspace?.opening || (!workspace && locked)} onClick={addProject}><FolderOpen size={14} /><span>{codex.cwd ? codex.cwd : 'Выбрать рабочую папку'}</span><ChevronDown size={12} /></button>
        </section> : <div className="conversation">
          {codex.itemCursor && !showChatSearch && <button className="text-button load-earlier" disabled={codex.loading} onClick={() => void codex.loadEarlier()}>Показать предыдущие сообщения</button>}
          <ChatSearch key={codex.thread?.id || 'new'} items={codex.items} turnWork={codex.turnWork} open={showChatSearch} active={active} onClose={() => { setShowChatSearch(false); inputRef.current?.focus({ preventScroll: true }); }} hasEarlier={Boolean(codex.itemCursor)} loading={codex.loading} onLoadEarlier={() => void codex.loadEarlier()} onEditMessage={editMessage} onBookmark={saveBookmark} editDisabled={sending || readingImages || loadingEdit || codex.loading || codex.terminalOpen || Boolean(workspace?.actionBusy)} />
          {codex.busy && <div className="working-indicator"><span className="working-orb" /><span>{codex.requests.length ? `${engineName} ждёт вашего ответа` : currentAction || `${engineName} работает`}<span className="working-dots">...</span></span></div>}
        </div>}
        {codex.loading && <div className="loading-chat"><LoaderCircle className="spin" size={22} /><span>Открываем диалог…</span></div>}
        {codex.requests.length > 0 && <div className="requests-list">{codex.requests.map(request => <Approval key={request.id} request={request} items={codex.items} respond={codex.respond} />)}</div>}
      </div>

      <div className="composer-area">
        <UpdateNotice />
        <MessageQueue queue={queue} blocked={queueBlocked} />
        {scrolledUp && <button className="scroll-bottom" onClick={() => { setScrolledUp(false); if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }}><ArrowDown size={14} />К последнему сообщению</button>}
        {codex.error && <div className="alert error-alert" role="alert"><span>{codex.error}</span>{codex.connection === 'error' && <button onClick={() => void codex.reconnect()}><RefreshCw size={14} />{codex.thread ? 'Переподключить диалог' : 'Подключить'}</button>}<button className="icon-button small" title="Скрыть ошибку" aria-label="Скрыть ошибку" onClick={() => codex.setError('')}><X size={14} /></button></div>}
        {codex.notice && <div className="alert notice-alert"><span>{codex.notice}</span>{codex.canContinue && <button type="button" className="continue-button" aria-label="Продолжить выполнение" title="Отправить «Продолжай» в этот диалог" disabled={locked || !ready || !codex.threadReady || sending || readingImages || Boolean(codex.requests.length)} onClick={() => void continueStopped()}><ArrowRight size={14} />Продолжить</button>}<button className="icon-button small" title="Скрыть уведомление" aria-label="Скрыть уведомление" onClick={() => codex.setNotice('')}><X size={14} /></button></div>}
        {ready && codex.thread && !codex.threadReady && !codex.loading && <div className="alert notice-alert"><span>Для продолжения нужно подключить диалог.</span><button disabled={locked || sending} onClick={() => void codex.resume(codex.thread!, true)}><RefreshCw size={14} />Повторить подключение</button></div>}
        {(editingMessage || loadingEdit) && <div className="composer-edit-banner" role="status"><span><strong>{loadingEdit ? 'Восстанавливаем сообщение…' : 'Редактирование сообщения'}</strong>{loadingEdit ? 'Загружаем исходные изображения.' : 'Исправленный текст отправится новым сообщением. Ваш черновик сохранён.'}</span><button type="button" className="text-button" aria-label="Отменить редактирование" disabled={sending || readingImages || selectingFiles} onClick={cancelEdit}>Отмена</button></div>}
        <div ref={composerRef} className={`composer ${dragOver ? 'drag-over' : ''}`} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }} onDrop={e => { e.preventDefault(); setDragOver(false); void addImages([...e.dataTransfer.files]); }}>
          {commands.length > 0 && <CommandMenu commands={commands} selected={Math.min(commandIndex, commands.length - 1)} onHighlight={setCommandIndex} onSelect={name => void chooseCommand(name)} />}
          {dragOver && <div className="drop-overlay"><ImagePlus size={24} />Добавить изображения к сообщению</div>}
          {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, i) => <div className="attachment" key={`${attachment.name}-${i}`}><img src={attachment.dataUrl} alt={attachment.name} /><button title="Удалить изображение" aria-label={`Удалить ${attachment.name}`} disabled={loadingEdit || sending} onClick={() => setAttachments(previous => previous.filter((_, index) => index !== i))}><X size={12} /></button><span>{attachment.name}</span></div>)}</div>}
          <textarea ref={inputRef} value={text} readOnly={loadingEdit || (editingMessage && sending)} rows={2} placeholder="Что будем делать? Можно вставить изображение…" aria-label={`Сообщение ${engineName}`} onChange={e => { setCommandMenuOpen(false); setText(e.target.value); }} onPaste={e => { const files = [...e.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { e.preventDefault(); void addImages(files); } }} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape' && (editingMessage || loadingEdit)) { e.preventDefault(); cancelEdit(); } else if (commands.length && e.key === 'Escape') { e.preventDefault(); setCommandMenuOpen(false); setCommandDismissed(true); } else if (commands.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setCommandKeyboardSelected(true); setCommandIndex(index => (index + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length); } else if (commands.length && (matchingCommands(text).length > 0 || commandKeyboardSelected) && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); void chooseCommand(commands[Math.min(commandIndex, commands.length - 1)].name); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div className="composer-toolbar"><div className="composer-tools"><button className="icon-button attach-button" title="Добавить файлы: изображения с превью, остальные — путями в сообщение" aria-label="Добавить файлы" disabled={readingImages || selectingFiles || loadingEdit || sending || Boolean(workspace?.actionBusy)} onClick={() => void chooseFiles()}>{readingImages || selectingFiles ? <LoaderCircle size={18} className="spin" /> : <Plus size={20} />}</button><span className="toolbar-divider" />
            <button type="button" className="icon-button" aria-label={`Команды ${engineName}`} title={`Команды ${engineName} (/)`} disabled={editingMessage || loadingEdit || sending} onClick={() => { setCommandMenuOpen(value => !value); setCommandDismissed(false); setCommandKeyboardSelected(false); inputRef.current?.focus(); }}><Terminal size={16} /></button>
            <ComposerSelect kind="provider" label="Агент" value={codex.provider} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} icon={<Terminal size={14} />} disabled={!workspace || Boolean(workspace.opening) || Boolean(workspace.actionBusy) || selectingFiles} active={active} onChange={selectProvider} />
            <ComposerSelect kind="model" label="Модель" value={codex.model} options={modelOptions} icon={<Cpu size={14} />} disabled={locked || selectingFiles || !ready} active={active} openSignal={modelSignal} onChange={codex.selectModel} />
            <ComposerSelect kind="effort" label="Глубина размышлений" value={codex.effort} options={effortOptions} icon={<Brain size={14} />} disabled={locked || selectingFiles || !ready || !efforts.length} active={active} onChange={codex.selectEffort} />
          </div><div className="composer-actions">
            {(codex.busy || queue.state.items.length > 0) && <>
              {codex.busy && <button type="button" className="composer-action composer-steer" aria-label="Уточнить текущую задачу" title={codex.capabilities.steer ? `Уточнить текущую задачу — передать сообщение ${engineName} во время выполнения` : `Уточнения во время выполнения для ${engineName} пока недоступны. Используйте очередь.`} disabled={!codex.capabilities.steer || (!text.trim() && !attachments.length) || Boolean(workspace?.actionBusy) || codex.terminalOpen || codex.loading || !ready || Boolean(codex.requests.length) || selectingFiles || sending || readingImages || loadingEdit || codex.compacting || codex.steering || (attachments.length > 0 && !imagesSupported)} onClick={() => void steerCurrent()}><CornerDownRight size={14} /><span>Уточнить</span></button>}
              <button type="button" className="composer-action composer-enqueue" aria-label="Отправить после завершения" title="В очередь — отправить сообщение после завершения текущей задачи" disabled={(!text.trim() && !attachments.length) || queueOwnerMismatch || selectingFiles || sending || readingImages || loadingEdit || (attachments.length > 0 && !imagesSupported)} onClick={enqueueMessage}><ListPlus size={15} /><span>В очередь</span></button>
              {codex.busy && <span className="composer-action-divider" aria-hidden="true" />}
            </>}
            {codex.busy ? <button className="stop-button" onClick={() => void codex.stop()} title="Остановить выполнение" aria-label="Остановить выполнение"><Square size={14} fill="currentColor" /></button> : <button className="send-button" title="Отправить (Enter)" aria-label="Отправить сообщение" disabled={!ready || locked || selectingFiles || sending || readingImages || loadingEdit || (!text.trim() && !attachments.length)} onClick={() => void send()}><ArrowUp size={20} /></button>}
          </div></div>
        </div>
        <div className="composer-footer"><AccessSelect provider={codex.provider} value={codex.access} disabled={locked || selectingFiles || !ready} active={active} openSignal={accessSignal} onChange={selectAccess} />{terminalButton}<span className="keyboard-hint"><kbd>Enter</kbd> отправить<span>·</span><kbd>Shift Enter</kbd> новая строка</span>{codex.capabilities.usage && <UsageLimit usage={codex.usage} loading={codex.usageLoading} active={active} disabled={!ready || locked || sending} onRefresh={() => void codex.refreshUsage()} onCommand={command => { if (ready && !locked && !sending) void codex.send(command, []); }} />}<CacheControl active={active} tokens={codex.tokens} session={{ activityAt: codex.cacheActivityAt, generation: codex.cacheGeneration, completed: codex.cacheTurnCompleted, threadId: codex.thread?.id, busy: codex.busy, loading: codex.loading, connection: codex.connection, pending: codex.requests.length, blocked: queue.state.items.length > 0 || Boolean(queue.inFlight) || !codex.threadReady || Boolean(workspace?.actionBusy) || codex.terminalOpen || sending || readingImages || selectingFiles || editingMessage || loadingEdit || showSettings || showChangesReview || Boolean(fileViewer) || confirmFull || showHistory || commands.length > 0, sendPing: codex.sendPing }} /><TokenUsage tokens={codex.tokens} openSignal={statusSignal} canCompact={canCompact} compactSupported={codex.capabilities.compact} compacting={codex.compacting} onCompact={() => void codex.compact()} active={active} sessionKey={`${sessionId}:${codex.thread?.id || "new"}`} /></div>
      </div>
    </main>

    <aside className="details-panel"><div className="panel-tabs">
      <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Folder size={14} />Файлы</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><Terminal size={14} />Действия{codex.busy && <span className="tab-live-dot" />}</button>
      <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><GitBranch size={14} />Изменения{changedFiles > 0 && <span className="count-badge">{changedFiles}</span>}</button>
    </div><div className="panel-scroll">
      <div hidden={tab !== 'files'}><FileBrowser cwd={codex.cwd} active={active && showPanel && tab === 'files'} refreshKey={changedFiles} onAskCodex={askAboutPath} onPreview={path => setFileViewer({ path })} /></div>
      {tab === 'activity' && <ActivityPanel items={codex.items} plan={codex.plan} busy={codex.busy} />}
      {tab === 'changes' && <ChangesPanel key={codex.thread?.id || 'new'} items={codex.items} diff={codex.diff} cwd={codex.cwd} diffTurnId={codex.diffTurnId} turnDiffs={codex.turnDiffs} active={active && !workspace?.actionBusy} hasEarlier={Boolean(codex.itemCursor)} loading={codex.loading} busy={codex.busy} mutationsAllowed={ready && codex.access !== 'read-only' && !locked && !codex.requests.length && !sending && !readingImages} onLoadEarlier={() => void codex.loadEarlier()} onReviewChange={setShowChangesReview} />}
    </div><div className="panel-bottom"><span className="status-dot online" /><span>{tab === 'files' ? 'Файлы текущей рабочей папки' : 'Изменения сохраняются в проекте'}</span></div></aside>
    <input ref={filesRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { void addImages([...(e.target.files || [])]); e.currentTarget.value = ''; }} />

    {showHistory && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setShowHistory(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="История диалогов"><div className="modal-header"><h2>История диалогов</h2><button type="button" className="icon-button" aria-label="Закрыть историю" onClick={() => setShowHistory(false)}><X size={18} /></button></div><div className="command-history">{codex.history.map(thread => <button key={thread.id} disabled={!workspace && locked} onClick={() => { setShowHistory(false); if (workspace) workspace.openThread(codex.cwd, thread); else void codex.resume(thread); }}>{thread.name || thread.preview || 'Новый диалог'}</button>)}{!codex.history.length && <p className="muted">{codex.historyLoading ? 'Загружаем историю…' : 'В этой папке пока нет диалогов.'}</p>}{codex.historyCursor && <button disabled={codex.historyLoading} onClick={() => void codex.refreshHistory(codex.cwd, codex.historyCursor!)}>Загрузить ещё</button>}</div></section></div>}
    {showSettings && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowSettings(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><span className="eyebrow">CODEX DESK</span><h2 id="settings-title">Ваше рабочее пространство</h2></div><button className="icon-button" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={() => setShowSettings(false)}><X size={19} /></button></div><div className="settings-content"><div className="settings-provider-summary"><strong>Агент: {engineName}</strong><p>Выберите агента под сообщением. Другой агент откроется в отдельной вкладке.</p></div><EffectiveSettings provider={codex.provider} model={codex.model} effort={codex.effort} access={codex.access} sources={codex.sources} executable={codex.executable} cliVersion={codex.cliVersion} capabilities={codex.capabilities} cwd={codex.cwd} />{codex.capabilities.mcp ? <McpSettings bridge={bridge} active={active && showSettings} /> : <p className="muted">Подключения Claude Code настраиваются через его CLI. Импорт MCP из этого окна пока доступен для Codex.</p>}<div className="settings-row"><span><strong>Рабочая папка</strong><small>{codex.cwd || 'Не выбрана'}</small></span><button className="secondary-button" disabled={workspace?.opening || (!workspace && locked)} onClick={addProject}><FolderOpen size={14} />Изменить</button></div><div className="settings-row"><span><strong>{engineName} CLI</strong><small>{codex.executable || 'Автоматический поиск'}{codex.cliVersion ? ` · версия ${codex.cliVersion}` : ''}</small>{cliVersionNote(codex.provider, codex.cliVersion) && <small className="muted">{cliVersionNote(codex.provider, codex.cliVersion)}</small>}</span><button className="secondary-button" disabled={locked} onClick={() => void codex.selectExecutable()}>Выбрать</button></div><div className="settings-row"><span><strong>Соединение</strong><small>{status}</small></span><button className="secondary-button" disabled={locked} onClick={() => void codex.connect()}><RefreshCw size={14} />Переподключить</button></div><div className="settings-explanation"><Terminal size={18} /><p>Оболочка использует установленный {engineName} CLI, его аккаунт, конфигурацию, навыки и инструкции проекта. Модель и глубину размышлений можно изменить под сообщением.</p></div><div className="settings-explanation"><Brain size={18} /><p>Пояснения появляются, только когда {engineName} прислал текст. Пустые блоки скрыты. Конкретные команды, читаемые файлы и результаты видны в панели «Действия».</p></div><div className="settings-explanation"><Shield size={18} /><p>{accessExplanation}</p></div>{codex.diagnostics.length > 0 && <details className="diagnostics"><summary>Диагностика подключения</summary><pre>{codex.diagnostics.join('\n')}</pre></details>}</div><div className="modal-footer"><span>Ваш код · Ваш терминал · Ваш выбор</span><button className="primary-button" onClick={() => setShowSettings(false)}>Готово<Check size={15} /></button></div></section></div>}

    {confirmFull && <div className="modal-backdrop"><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="full-access-title"><div className="permission-symbol"><Shield size={26} /></div><h2 id="full-access-title">Включить полный доступ?</h2><p>{engineName} сможет выполнять команды, обращаться к сети и изменять файлы за пределами проекта без запросов подтверждения.</p><p className="muted">Режим применяется со следующего сообщения в этой вкладке.</p><div className="confirm-actions"><button className="secondary-button" autoFocus onClick={() => setConfirmFull(false)}>Отмена</button><button className="danger-button" onClick={() => { codex.selectAccess('danger-full-access'); setConfirmFull(false); }}>Включить полный доступ</button></div></section></div>}
    {fileViewer && active && <FileViewer cwd={codex.cwd} active={active} initialPath={fileViewer.path} onClose={() => setFileViewer(null)} onAsk={question => { focusDraftEnd.current = true; setText(current => `${current}${current && !current.endsWith('\n') ? '\n' : ''}${question}\n`); setFileViewer(null); inputRef.current?.focus(); }} />}
  </div></BridgeContext.Provider></AgentContext.Provider>;
}
