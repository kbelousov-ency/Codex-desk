import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Archive, ArchiveRestore, Bell, BellRing, Bot, BookMarked, Clock3, Command, FolderPlus, FolderTree, GitBranch, GitFork, History, LoaderCircle, MessageSquare, Pin, PinOff, Plus, RefreshCw, RotateCcw, Sparkles, Terminal, X } from 'lucide-react';
import CommandPalette, { type PaletteCommand } from './CommandPalette';
import AgentLogo from './AgentLogo';
import WorktreePanel from './WorktreePanel';
import App, { type SessionSummary, type WorkspaceControls } from './App';
import { projectKey, type ProjectHistory } from './ProjectTree';
import ProjectSidebar from './ProjectSidebar';
import ArchiveView from './ArchiveView';
import BulkArchiveDialog, { type BulkRunState } from './BulkArchive';
import { bulkScopeLabel, bulkThreadTitle, planBulkArchive, sameBulkScope, toggleSelection } from './bulk-archive';
import type { BulkOutcome, BulkRow, BulkScope } from './bulk-archive';
import { BuildBadge, ProductBrand, useProductNameGenitive } from './BuildInfo';
import ProductLogo from './ProductLogo';
import { AppUpdateBanner, AppUpdateDialog, useAppUpdates } from './AppUpdates';
import { ReleaseNotesDialog, useReleaseNotes } from './ReleaseNotes';
import { OpenAppUpdatesContext } from './AppUpdateContext';
import { errorText, folderName } from './useCodex';
import type { AgentProvider, Attachment, CodexBridge, ExecutorAction, ExecutorThread, HistoryTarget, MessageQueueState, PendingMessage, PreservedDraft, ScrollAnchor, SessionAttentionEvent, SessionInfo, Settings, Thread, ThreadAction, ThreadChildLink, UpdateSnapshot, UpdateStatus, UpdateTabSnapshot } from './types';
import { executorLabelLetter, nextExecutorLabel } from './executor-agents';
import './nightly-update.css';
import './workspace-state.css';
import UpdateNotice, { UpdateNoticeContext } from './UpdateNotice';
import { NotificationSettings } from './NotificationSettings';
import './notifications.css';
import HistoryLibrary from './HistoryLibrary';
import SetupGate from './SetupGate';
import { sameSessionSummary } from './session-summary';
import ParallelActivity from './ParallelActivity';

type Tab = SessionInfo & { bridge?: CodexBridge; initialThread?: Thread; archivedThread?: Thread; draft?: string; attachments?: Attachment[]; preservedDraft?: PreservedDraft; restoreSettings?: Settings; queue?: MessageQueueState; scrollTop?: number; scrollAnchor?: ScrollAnchor; jump?: { itemId: string; turnId?: string; key: number; excerpt?: string }; pinned?: boolean; pendingMessage?: PendingMessage; childOf?: string; childLabel?: string; fork?: { lastTurnId?: string } };
/** What a closed tab needs to come back: the folder, agent and (if any) the dialog it showed. Processes are not kept. */
type ClosedTab = { cwd: string; provider?: AgentProvider; title: string; snapshot: UpdateTabSnapshot };
const MAX_CLOSED_TABS = 10;
/** Pinned tabs stay in front; a move never crosses the pinned boundary. */
export function reorderTabs<T extends { id: string; pinned?: boolean }>(tabs: T[], fromId: string, toId: string, after = false): T[] {
  const from = tabs.find(tab => tab.id === fromId), to = tabs.find(tab => tab.id === toId);
  if (!from || !to || from === to || Boolean(from.pinned) !== Boolean(to.pinned)) return tabs;
  const without = tabs.filter(tab => tab.id !== fromId);
  const index = without.findIndex(tab => tab.id === toId) + (after ? 1 : 0);
  return [...without.slice(0, index), from, ...without.slice(index)];
}
export function setTabPinned<T extends { id: string; pinned?: boolean }>(tabs: T[], id: string, pinned: boolean): T[] {
  const tab = tabs.find(item => item.id === id);
  if (!tab || Boolean(tab.pinned) === pinned) return tabs;
  const rest = tabs.filter(item => item.id !== id);
  const updated = { ...tab, pinned } as T;
  if (!pinned) delete (updated as { pinned?: boolean }).pinned;
  const boundary = rest.filter(item => item.pinned).length;
  return [...rest.slice(0, boundary), updated, ...rest.slice(boundary)];
}
const sameFolder = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const shortExecutorName = (name: string) => executorLabelLetter(name) || Array.from(name.trim()).slice(0, 3).join('');

export default function Workspace() {
  // Keep the existing single-session fixtures useful for renderer regressions.
  if (!window.codex?.getWorkspace) return <App />;
  return <SetupGate><TabbedWorkspace /></SetupGate>;
}

function TabbedWorkspace() {
  // Оба текста ниже — в родительном падеже: «изменения/новая версия Кузьмича».
  const productName = useProductNameGenitive();
  const appUpdates = useAppUpdates();
  const releaseNotes = useReleaseNotes();
  const [showAppUpdates, setShowAppUpdates] = useState(false);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [activeId, setActiveId] = useState('');
  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [histories, setHistories] = useState<Record<string, ProjectHistory>>({});
  // Dependent (child) conversations are kept apart from the folder history so the history
  // page, its cursor and the multi-select scope keep their current meaning.
  const [childHistories, setChildHistories] = useState<Record<string, ProjectHistory>>({});
  const [childLinks, setChildLinks] = useState<Record<string, ThreadChildLink[]>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [starting, setStarting] = useState(true);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  // Deliberately not persisted: a restart must never silently close a restored tab.
  const [deferredClose, setDeferredClose] = useState<Record<string, number>>({});
  const deferredCloseRef = useRef(deferredClose);
  const cancelDeferredClose = useCallback((id: string) => {
    if (!(id in deferredCloseRef.current)) return;
    const next = { ...deferredCloseRef.current }; delete next[id];
    deferredCloseRef.current = next; setDeferredClose(next);
  }, []);
  /** One deferred closure for a parent tab and its executors: the group closes together, so a
   * finished parent can never leave a still working executor without its row. `awaited` lists
   * the members that were working when the wait was armed. Memory only, like `deferredClose`. */
  const [cascadeClose, setCascadeClose] = useState<{ parentId: string; ids: string[]; awaited: string[] } | null>(null);
  const cascadeCloseRef = useRef(cascadeClose);
  const cancelCascadeClose = useCallback(() => {
    const cascade = cascadeCloseRef.current;
    if (!cascade) return;
    cascadeCloseRef.current = null; setCascadeClose(null);
    for (const id of [cascade.parentId, ...cascade.ids]) cancelDeferredClose(id);
  }, [cancelDeferredClose]);
  /** Cancels a pending closure: a member of the group cancels the whole cascade, because waiting
   * for the rest would close the tab the user has just been asked about. */
  const cancelCloseWait = useCallback((id: string) => {
    const cascade = cascadeCloseRef.current;
    if (cascade && (cascade.parentId === id || cascade.ids.includes(id))) { cancelCascadeClose(); return; }
    cancelDeferredClose(id);
  }, [cancelCascadeClose, cancelDeferredClose]);
  const [confirmCloseProject, setConfirmCloseProject] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [attention, setAttention] = useState<Record<string, SessionAttentionEvent>>({});
  const [showAttention, setShowAttention] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const focusedWindow = useRef(document.hasFocus());
  const notifiedSession = useRef<string | undefined>(undefined);
  const attentionMenu = useRef<HTMLDivElement>(null);
  const attentionButton = useRef<HTMLButtonElement>(null);
  const [savingBeforeClose, setSavingBeforeClose] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveThreads, setArchiveThreads] = useState<Thread[]>([]);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [threadNames, setThreadNames] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [actionDialog, setActionDialog] = useState<{ action: 'rename' | 'delete'; cwd: string; thread: Thread } | null>(null);
  const [bulkScope, setBulkScope] = useState<BulkScope | null>(null);
  const [bulkSelected, setBulkSelected] = useState<string[]>([]);
  const [bulkRun, setBulkRun] = useState<BulkRunState | null>(null);
  const bulkRunRef = useRef<BulkRunState | null>(null);
  bulkRunRef.current = bulkRun;
  const bulkStop = useRef(false);
  const [newName, setNewName] = useState('');
  const [worktreeDialog, setWorktreeDialog] = useState<{ cwd: string } | null>(null);
  const [worktreeName, setWorktreeName] = useState('');
  const [worktreeNotice, setWorktreeNotice] = useState('');
  const [tasksPanel, setTasksPanel] = useState<{ cwd: string } | null>(null);
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const closedTabsRef = useRef(closedTabs);
  closedTabsRef.current = closedTabs;
  const closingTab = useRef(false);
  /** Set while a parent tab and its executors are being closed as one group. */
  const closingGroup = useRef(false);
  const shortcutActions = useRef({ cycle: (_step: 1 | -1) => {}, restore: () => {} });
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [decidingUpdate, setDecidingUpdate] = useState(false);
  const [preparingUpdate, setPreparingUpdate] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const updateCaptures = useRef(new Map<string, (persistent?: boolean) => UpdateTabSnapshot | null>());
  const workspaceLoaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRevision = useRef(0);
  const savedRevision = useRef(-1);
  const saveChain = useRef(Promise.resolve());
  const lastSaved = useRef('');
  const savingWorkspace = useRef(false);
  const workspaceClosing = useRef(false);
  const updateRequest = useRef<string | null>(null);
  const releaseNotesAutoOpened = useRef(false);
  const restorePending = useRef(false);
  const actionPending = useRef(false);
  const archiveRequest = useRef(0);
  const pendingOpen = useRef(false);
  const loaded = useRef<Promise<void> | null>(null);
  const tabsRef = useRef(tabs);
  const projectsRef = useRef(projects);
  const summariesRef = useRef(summaries);
  const historiesRef = useRef(histories);
  const historyRequests = useRef(new Set<string>());
  const historyRevision = useRef(0);
  const historyRefreshPending = useRef(new Set<string>());
  const childHistoriesRef = useRef(childHistories);
  const childLinksRef = useRef(childLinks);
  const childRequests = useRef(new Set<string>());
  const childRefreshPending = useRef(new Set<string>());
  const childLinkRequests = useRef(new Set<string>());
  /** Executor conversations whose default name has already been written as the dialog title. */
  const executorRenamed = useRef(new Set<string>());
  const previousSummaries = useRef<Record<string, SessionSummary>>({});
  tabsRef.current = tabs;
  projectsRef.current = projects;
  summariesRef.current = summaries;
  historiesRef.current = histories;
  childHistoriesRef.current = childHistories;
  childLinksRef.current = childLinks;
  const updateState = useRef({ activeId, starting, opening, closing, confirmClose, confirmCloseProject, actionDialog, bulkRun, showNotificationSettings, showAppUpdates, showReleaseNotes, showLibrary, showPalette });
  updateState.current = { activeId, starting, opening, closing, confirmClose, confirmCloseProject, actionDialog, bulkRun, showNotificationSettings, showAppUpdates, showReleaseNotes, showLibrary, showPalette };
  useEffect(() => {
    if (starting || releaseNotesAutoOpened.current || !releaseNotes.state?.shouldShow) return;
    releaseNotesAutoOpened.current = true;
    setShowReleaseNotes(true);
  }, [releaseNotes.state, starting]);
  const registerUpdateCapture = useCallback((id: string, capture: (persistent?: boolean) => UpdateTabSnapshot | null) => {
    updateCaptures.current.set(id, capture);
    return () => { if (updateCaptures.current.get(id) === capture) updateCaptures.current.delete(id); };
  }, []);

  const clearAttention = useCallback((id: string) => {
    setAttention(previous => {
      if (!previous[id]) return previous;
      const next = { ...previous }; delete next[id]; return next;
    });
  }, []);
  const onSessionAttention = useCallback((id: string, event: SessionAttentionEvent, title: string) => {
    // Cancel immediately, even if request and completion arrive in the same React batch.
    if (event.kind === 'question' || event.kind === 'approval') cancelCloseWait(id);
    if (workspaceClosing.current || updateRequest.current || !tabsRef.current.some(tab => tab.id === id && !tab.archivedThread)) return;
    if (!focusedWindow.current || updateState.current.activeId !== id) setAttention(previous => ({ ...previous, [id]: event }));
    // Host checks actual native focus independently and suppresses visible-tab toasts.
    void window.codex.notifySession?.({ ...event, sessionId: id, title: title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160) }).catch(() => {});
  }, [cancelCloseWait]);
  useEffect(() => {
    let subscribed = true;
    let observedFocus = false;
    const focus = (value: boolean) => {
      observedFocus = true;
      focusedWindow.current = value;
      if (value) clearAttention(updateState.current.activeId);
    };
    const removeFocus = window.codex.onWindowFocus?.(focus);
    void window.codex.getWindowFocus?.().then(value => { if (subscribed && !observedFocus) focus(value); }).catch(() => {});
    const onFocus = () => focus(true), onBlur = () => focus(false);
    if (!removeFocus) { window.addEventListener('focus', onFocus); window.addEventListener('blur', onBlur); }
    const removeClick = window.codex.onNotificationActivated?.(({ sessionId }) => {
      if (!tabsRef.current.some(tab => tab.id === sessionId) || workspaceClosing.current || updateRequest.current) return;
      // Native activation arrives before its focus event; keep that event from
      // marking the formerly active, unread tab as viewed.
      updateState.current = { ...updateState.current, activeId: sessionId };
      setActiveId(sessionId); clearAttention(sessionId); setShowAttention(false);
      requestAnimationFrame(() => document.getElementById(`tab-${sessionId}`)?.focus());
    });
    return () => { subscribed = false; removeFocus?.(); removeClick?.(); window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur); };
  }, [clearAttention]);
  useEffect(() => {
    const selected = tabs.find(tab => tab.id === activeId && !tab.archivedThread);
    // The host only needs the visible dialogue; repeating the same value on every
    // render floods IPC and keeps the renderer busy instead of drawing the answer.
    if (notifiedSession.current !== selected?.id) {
      notifiedSession.current = selected?.id;
      void window.codex.setNotificationContext?.({ activeSessionId: selected?.id }).catch(() => {});
    }
    if (focusedWindow.current) clearAttention(activeId);
    const ids = new Set(tabs.map(tab => tab.id));
    setAttention(previous => Object.keys(previous).every(id => ids.has(id)) ? previous : Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
  }, [tabs, activeId, clearAttention]);
  useEffect(() => {
    if (!showAttention) return;
    const outside = (event: PointerEvent) => { if (!attentionMenu.current?.contains(event.target as Node) && !attentionButton.current?.contains(event.target as Node)) setShowAttention(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShowAttention(false); attentionButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    requestAnimationFrame(() => attentionMenu.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [showAttention]);

  const captureWorkspace = useCallback((): UpdateSnapshot | null => {
    const state = updateState.current;
    if (!workspaceLoaded.current || state.starting || state.opening || state.closing || actionPending.current || pendingOpen.current || updateRequest.current) return null;
    const captured: UpdateTabSnapshot[] = [];
    for (const tab of tabsRef.current) {
      const snapshot = updateCaptures.current.get(tab.id)?.(true);
      if (!snapshot) return null;
      captured.push(tab.pinned ? { ...snapshot, pinned: true } : snapshot);
    }
    return { version: 1, activeIndex: Math.max(0, tabsRef.current.findIndex(tab => tab.id === state.activeId)), tabs: captured };
  }, []);

  const flushSessionState = useCallback(async () => {
    // Optional for older test bridges; production always exposes persistence.
    if (!window.codex.saveWorkspaceState) return;
    if (workspaceClosing.current) throw new Error('Приложение закрывается. Очередь сохранится на паузе.');
    const snapshot = captureWorkspace();
    if (!snapshot) throw new Error('Рабочее место ещё открывается или изменяется. Повторите после завершения операции.');
    const revision = saveRevision.current;
    const encoded = JSON.stringify(snapshot);
    const work = saveChain.current.catch(() => {}).then(async () => {
      if (encoded !== lastSaved.current) await window.codex.saveWorkspaceState(snapshot);
      lastSaved.current = encoded;
      savedRevision.current = revision;
      setSaveError('');
    });
    saveChain.current = work;
    await work.catch(error => { setSaveError('Не удалось сохранить вкладки и черновики. ' + errorText(error)); throw error; });
  }, [captureWorkspace]);

  const autoSave = useCallback(() => {
    if (workspaceClosing.current || savingWorkspace.current || savedRevision.current === saveRevision.current || !captureWorkspace()) return;
    savingWorkspace.current = true;
    void flushSessionState().catch(() => {}).finally(() => { savingWorkspace.current = false; });
  }, [captureWorkspace, flushSessionState]);

  const onSessionStateChange = useCallback((_sessionId?: string) => {
    saveRevision.current++;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(autoSave, 400);
  }, [autoSave]);

  useEffect(() => { onSessionStateChange(); }, [tabs, activeId, starting, opening, closing, summaries, onSessionStateChange]);
  useEffect(() => {
    if (!window.codex.saveWorkspaceState) return;
    // Maximum delay during continuous typing; retries also cover transient IPC failures.
    const interval = setInterval(autoSave, 2000);
    const remove = window.codex.onWorkspaceSave?.(({ requestId }) => {
      workspaceClosing.current = true;
      flushSync(() => setSavingBeforeClose(true));
      const snapshot = captureWorkspace();
      void window.codex.completeWorkspaceSave({ requestId, ...(snapshot ? { snapshot } : {}) }).catch(error => {
        setSaveError('Не удалось сохранить окно перед закрытием. ' + errorText(error));
      });
    });
    return () => { clearInterval(interval); if (saveTimer.current) clearTimeout(saveTimer.current); remove?.(); };
  }, [autoSave, captureWorkspace]);

  useEffect(() => {
    if (!preparingUpdate && !savingBeforeClose) return;
    const nodes = [...(shellRef.current?.children || [])].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.classList.contains('nightly-update-overlay'));
    const previous = nodes.map(node => node.inert);
    nodes.forEach(node => { node.inert = true; });
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current?.querySelector<HTMLElement>('.nightly-update-overlay')?.focus();
    return () => { nodes.forEach((node, index) => { node.inert = previous[index]; }); focused?.focus({ preventScroll: true }); };
  }, [preparingUpdate, savingBeforeClose]);

  useEffect(() => {
    if (!window.codex.onUpdatePrepare || !window.codex.onUpdateStatus) return;
    let receivedStatus = false;
    let subscribed = true;
    const removeStatus = window.codex.onUpdateStatus(status => {
      receivedStatus = true;
      setUpdateStatus(status);
      if (status.state !== 'preparing') { updateRequest.current = null; setPreparingUpdate(false); }
    });
    void window.codex.getUpdateStatus?.().then(status => { if (subscribed && !receivedStatus && status) setUpdateStatus(status); }).catch(() => {});
    const removePrepare = window.codex.onUpdatePrepare(({ requestId }) => {
      if (updateRequest.current) return;
      updateRequest.current = requestId;
      const prepare = async () => {
        const current = updateState.current;
        if (current.starting || current.opening || current.closing || current.confirmClose || current.confirmCloseProject || current.actionDialog || current.bulkRun || current.showNotificationSettings || current.showAppUpdates || current.showReleaseNotes || current.showLibrary || current.showPalette || actionPending.current || pendingOpen.current) {
          await window.codex.completeUpdatePrepare({ requestId, defer: true });
          updateRequest.current = null;
          return;
        }
        const snapshotTabs: UpdateTabSnapshot[] = [];
        for (const tab of tabsRef.current) {
          const snapshot = updateCaptures.current.get(tab.id)?.();
          if (!snapshot) {
            await window.codex.completeUpdatePrepare({ requestId, defer: true });
            updateRequest.current = null;
            return;
          }
          snapshotTabs.push(tab.pinned ? { ...snapshot, pinned: true } : snapshot);
        }
        flushSync(() => { setPreparingUpdate(true); setUpdateStatus({ state: 'preparing' }); });
        await window.codex.completeUpdatePrepare({ requestId, snapshot: { version: 1, activeIndex: Math.max(0, tabsRef.current.findIndex(tab => tab.id === current.activeId)), tabs: snapshotTabs } });
      };
      void prepare().catch(() => {
        updateRequest.current = null;
        setPreparingUpdate(false);
        setUpdateStatus({ state: 'error', message: 'Не удалось сохранить вкладки для обновления. Приложение продолжает работать.' });
      });
    });
    return () => { subscribed = false; removeStatus(); removePrepare(); };
  }, []);

  const decideUpdate = async (decision: 'close' | 'later') => {
    if (decidingUpdate) return;
    setDecidingUpdate(true);
    try { setUpdateStatus(await window.codex.decideUpdate(decision)); }
    catch (error) { setUpdateStatus({ state: 'error', message: errorText(error) }); }
    finally { setDecidingUpdate(false); }
  };
  const forceUpdate = async () => {
    if (decidingUpdate) return;
    setDecidingUpdate(true);
    try { setUpdateStatus(await window.codex.forceUpdate()); }
    catch (error) { setUpdateStatus({ state: 'error', message: errorText(error) }); }
    finally { setDecidingUpdate(false); }
  };

  useEffect(() => {
    document.getElementById(`tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  // Workspace shortcuts. Ctrl+K opens the palette even over a dialog-free view; the rest stay quiet while a modal is open.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl || event.altKey || event.defaultPrevented || workspaceClosing.current || updateRequest.current) return;
      const modal = Boolean(document.querySelector('[aria-modal="true"]'));
      if ((event.code === 'KeyK' || event.key.toLowerCase() === 'k') && !event.shiftKey) {
        if (modal && !updateState.current.showPalette) return;
        event.preventDefault(); setTabMenu(null); setShowPalette(value => !value); return;
      }
      if (modal) return;
      if (event.key === 'Tab') { event.preventDefault(); shortcutActions.current.cycle(event.shiftKey ? -1 : 1); return; }
      if (event.shiftKey && (event.code === 'KeyT' || event.key.toLowerCase() === 't')) { event.preventDefault(); shortcutActions.current.restore(); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!tabMenu) return;
    const outside = (event: PointerEvent) => { if (!tabMenuRef.current?.contains(event.target as Node)) setTabMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setTabMenu(null); document.getElementById(`tab-${tabMenu.id}`)?.focus(); } };
    const blur = () => setTabMenu(null);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); window.addEventListener('blur', blur);
    requestAnimationFrame(() => tabMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('blur', blur); };
  }, [tabMenu]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = window.codex.getWorkspace().then(info => {
      const opened: Tab[] = info.restore
        ? info.restore.tabs.map(tab => ({ ...tab, initialThread: tab.thread, restoreSettings: tab.settings, ...(tab.pinned ? { pinned: true } : {}), ...(tab.archivedThread ? {} : { bridge: window.codex.forSession(tab.id) }) }))
        : info.sessions.map(session => ({ ...session, bridge: window.codex.forSession(session.id) }));
      const selected = opened[info.restore?.activeIndex ?? 0] || opened[0];
      restorePending.current = Boolean(info.restore);
      workspaceLoaded.current = true;
      setProjects(info.projects); setTabs(opened); setActiveId(selected?.id || '');
      const first = selected?.cwd || info.projects[0];
      if (first) setExpanded({ [projectKey(first)]: true });
    }).catch(e => setError(errorText(e))).finally(() => setStarting(false));
  }, []);
  useEffect(() => {
    if (starting || !restorePending.current) return;
    restorePending.current = false;
    void window.codex.completeUpdateRestore?.().catch(() => setError('Не удалось подтвердить восстановление вкладок.'));
  }, [starting, tabs]);

  const loadProjectHistory = useCallback(async (cwd: string, cursor?: string): Promise<void> => {
    const key = projectKey(cwd);
    if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
    if (historyRequests.current.has(key)) {
      if (!cursor) historyRefreshPending.current.add(key);
      return;
    }
    // Older browser fixtures only provide a scoped bridge for already-open folders.
    const existing = tabsRef.current.find(tab => sameFolder(tab.cwd, cwd) && summariesRef.current[tab.id]?.connection === 'ready');
    if (!window.codex.listProjectThreads && !existing) return;
    historyRequests.current.add(key);
    const revision = historyRevision.current;
    const empty: ProjectHistory = { threads: [], cursor: null, loaded: false, loading: false, error: '' };
    setHistories(previous => ({ ...previous, [key]: { ...(previous[key] || empty), loading: true, error: '' } }));
    try {
      const result = window.codex.listProjectThreads
        ? await window.codex.listProjectThreads(cwd, cursor)
        : await existing!.bridge!.request('thread/list', { cwd, limit: 40, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], ...(cursor ? { cursor } : {}) });
      if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
      if (revision !== historyRevision.current) { historyRefreshPending.current.add(key); return; }
      const threads: Thread[] = (result.data || []).filter((thread: Thread) => !thread.cwd || sameFolder(thread.cwd, cwd));
      setHistories(previous => {
        const prior = previous[key] || empty;
        const merged = cursor ? [...prior.threads, ...threads] : threads;
        return { ...previous, [key]: { threads: [...new Map(merged.map(thread => [thread.id, thread])).values()], cursor: result.nextCursor || null, loaded: true, loading: false, error: '' } };
      });
    } catch (e) {
      if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
      setHistories(previous => ({ ...previous, [key]: { ...(previous[key] || empty), loaded: true, loading: false, error: errorText(e) } }));
    } finally {
      historyRequests.current.delete(key);
      if (historyRefreshPending.current.delete(key)) void loadProjectHistory(cwd);
    }
  }, []);

  /** Reads the dependent conversations of a folder. One extra read-only `thread/list` with the
   * subAgent source kinds; it never touches the folder history page or its cursor. */
  const loadThreadChildren = useCallback(async (cwd: string, cursor?: string): Promise<void> => {
    const key = projectKey(cwd);
    if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
    // Older browser fixtures have no relationship bridge: relationships simply stay unknown.
    if (!window.codex.listThreadChildren) return;
    if (childRequests.current.has(key)) {
      if (!cursor) childRefreshPending.current.add(key);
      return;
    }
    childRequests.current.add(key);
    const revision = historyRevision.current;
    const empty: ProjectHistory = { threads: [], cursor: null, loaded: false, loading: false, error: '' };
    setChildHistories(previous => ({ ...previous, [key]: { ...(previous[key] || empty), loading: true, error: '' } }));
    try {
      const result = await window.codex.listThreadChildren(cwd, cursor);
      if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
      if (revision !== historyRevision.current) { childRefreshPending.current.add(key); return; }
      const threads: Thread[] = (result.data || []).filter((thread: Thread) => !thread.cwd || sameFolder(thread.cwd, cwd));
      setChildHistories(previous => {
        const prior = previous[key] || empty;
        const merged = cursor ? [...prior.threads, ...threads] : threads;
        return { ...previous, [key]: { threads: [...new Map(merged.map(thread => [thread.id, thread])).values()], cursor: result.nextCursor || null, loaded: true, loading: false, error: '' } };
      });
    } catch (e) {
      if (!projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
      setChildHistories(previous => ({ ...previous, [key]: { ...(previous[key] || empty), loaded: true, loading: false, error: errorText(e) } }));
    } finally {
      childRequests.current.delete(key);
      if (childRefreshPending.current.delete(key)) void loadThreadChildren(cwd);
    }
  }, []);

  /** Keeps the state and the ref in step: `report` writes the ref directly when it records a
   * fresh link, so a plain `setChildLinks` would be overwritten on the next report. */
  const updateChildLinks = useCallback((edit: (links: Record<string, ThreadChildLink[]>) => Record<string, ThreadChildLink[]>): void => {
    childLinksRef.current = edit(childLinksRef.current);
    setChildLinks(childLinksRef.current);
  }, []);
  /** Drops every navigation link that mentions one of `threadIds` as parent or child, so an
   * archived, deleted or unlinked executor leaves the «Исполнители» row and the tree at once. */
  const dropChildLinks = useCallback((threadIds: Iterable<string>): void => {
    const ids = new Set(threadIds);
    updateChildLinks(previous => {
      const next: Record<string, ThreadChildLink[]> = {};
      for (const [key, links] of Object.entries(previous)) next[key] = links.filter(link => !ids.has(link.childThreadId) && !ids.has(link.parentThreadId));
      return next;
    });
  }, [updateChildLinks]);
  const loadThreadChildLinks = useCallback(async (cwd: string): Promise<void> => {
    const key = projectKey(cwd);
    if (!window.codex.listThreadChildLinks || childLinkRequests.current.has(key) || !projectsRef.current.some(folder => sameFolder(folder, cwd))) return;
    childLinkRequests.current.add(key);
    try { const links = await window.codex.listThreadChildLinks(cwd); setChildLinks(previous => ({ ...previous, [key]: links || [] })); }
    catch (e) { setError(errorText(e)); }
    finally { childLinkRequests.current.delete(key); }
  }, []);


  useEffect(() => {
    for (const cwd of projects) {
      const key = projectKey(cwd);
      if (expanded[key] && !historiesRef.current[key]?.loaded && !historyRequests.current.has(key)) void loadProjectHistory(cwd);
      if (!childLinks[key] && !childLinkRequests.current.has(key)) void loadThreadChildLinks(cwd);
      // Relationships are read for a folder the user actually opened, or for the whole
      // «Подагенты» view; a collapsed folder costs no extra request.
      if (expanded[key] && !childHistoriesRef.current[key]?.loaded && !childRequests.current.has(key)) void loadThreadChildren(cwd);
    }
  }, [projects, expanded, childLinks, loadProjectHistory, loadThreadChildren, loadThreadChildLinks]);

  useEffect(() => {
    for (const [id, summary] of Object.entries(summaries)) {
      const before = previousSummaries.current[id];
      if (summary.connection !== 'ready' || !summary.cwd) continue;
      const changed = before?.connection !== 'ready' || before?.threadId !== summary.threadId || before?.title !== summary.title || (before?.busy && !summary.busy);
      if (!changed) continue;
      const key = projectKey(summary.cwd);
      if (expanded[key]) void loadProjectHistory(summary.cwd);
      else setHistories(previous => previous[key] ? { ...previous, [key]: { ...previous[key], loaded: false } } : previous);
      if (expanded[key]) void loadThreadChildren(summary.cwd);
      else setChildHistories(previous => previous[key] ? { ...previous, [key]: { ...previous[key], loaded: false } } : previous);
    }
    previousSummaries.current = summaries;
  }, [summaries, expanded, loadProjectHistory, loadThreadChildren]);

  const report = useCallback((id: string, summary: SessionSummary) => {
    if (!tabsRef.current.some(tab => tab.id === id)) return;
    // Equal reports must keep the previous state objects: a new identity on every
    // streamed delta re-renders the whole workspace and piles up nested updates.
    setSummaries(previous => sameSessionSummary(previous[id], summary) ? previous : { ...previous, [id]: summary });
    if (summary.cwd) setTabs(previous => previous.some(tab => tab.id === id && tab.cwd !== summary.cwd)
      ? previous.map(tab => tab.id === id ? { ...tab, cwd: summary.cwd } : tab) : previous);
    if (summary.cwd) setProjects(previous => previous.some(folder => sameFolder(folder, summary.cwd)) ? previous : [...previous, summary.cwd]);
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.childOf && summary.threadId && summary.cwd && window.codex.createThreadChildLink) {
      const key = projectKey(summary.cwd);
      const known = childLinksRef.current[key] || [];
      if (!known.some(link => link.childThreadId === summary.threadId)) {
        const provider = summary.settings.provider || tab.provider || 'codex';
        const link = { cwd: summary.cwd, parentThreadId: tab.childOf, childThreadId: summary.threadId, provider, model: summary.settings.model || null, effort: summary.settings.effort || null, label: tab.childLabel || null };
        updateChildLinks(previous => ({ ...previous, [key]: [...known, { id: `pending:${summary.threadId}`, ...link, createdAt: new Date().toISOString() }] }));
        void window.codex.createThreadChildLink(link).catch(() => {});
      }
      // Until the first send the default name «Агент A» lives only as the tab caption. Once the
      // conversation has an id it becomes its real title through the usual rename, which the agent
      // refuses while the thread is working — so retry on the next report instead of forcing it.
      if (tab.childLabel && !executorRenamed.current.has(summary.threadId)
        && summary.initialized && !summary.busy && !summary.loading && !summary.pending && !summary.terminalOpen) {
        const { threadId, cwd } = summary;
        const name = tab.childLabel;
        executorRenamed.current.add(threadId);
        void window.codex.manageThread({ action: 'rename', cwd, threadId, name })
          .then(result => setThreadNames(previous => ({ ...previous, [threadId]: result.thread?.name || name })))
          .catch(() => executorRenamed.current.delete(threadId));
      }
    }
  }, [updateChildLinks]);

  const activate = (id: string) => { updateState.current.activeId = id; setActiveId(id); setError(''); if (focusedWindow.current) clearAttention(id); setShowAttention(false); setTabMenu(null); };
  const loadArchive = async (cursor?: string) => {
    const request = ++archiveRequest.current;
    setArchiveLoading(true); setArchiveError('');
    try {
      const page = await window.codex.listArchivedThreads(cursor);
      if (request !== archiveRequest.current) return;
      setArchiveThreads(previous => [...new Map([...(cursor ? previous : []), ...page.data].map(thread => [thread.id, thread])).values()]);
      setArchiveCursor(page.nextCursor);
    } catch (e) { if (request === archiveRequest.current) setArchiveError(errorText(e)); }
    finally { if (request === archiveRequest.current) setArchiveLoading(false); }
  };
  const openArchive = (thread: Thread, jump?: Tab['jump']) => {
    const id = `archive:${thread.id}`;
    if (!tabsRef.current.some(tab => tab.id === id)) setTabs(previous => [...previous, { id, cwd: thread.cwd || '', archivedThread: thread, jump }]);
    else if (jump) setTabs(previous => previous.map(tab => tab.id === id ? { ...tab, jump } : tab));
    activate(id);
  };
  const open = async (cwd?: string, initialThread?: Thread, requestedProvider?: AgentProvider, jump?: Tab['jump'], options?: { fork?: Tab['fork']; restore?: UpdateTabSnapshot; draft?: string; childOf?: string; childLabel?: string }): Promise<boolean> => {
    if (pendingOpen.current || actionPending.current || closingTab.current || workspaceClosing.current || updateRequest.current) return false;
    if (cwd && initialThread && !options?.fork) {
      const existing = tabsRef.current.find(tab => {
        const state = summariesRef.current[tab.id];
        const threadId = state?.initialized ? state.threadId : state?.threadId || tab.initialThread?.id;
        return !tab.archivedThread && sameFolder(tab.cwd, cwd) && threadId === initialThread.id;
      });
      if (existing) {
        if (options?.restore) { setError('Этот диалог уже открыт. Закрытый черновик сохранён: его можно вернуть после закрытия открытой вкладки.'); return false; }
        if (jump) setTabs(previous => previous.map(tab => tab.id === existing.id ? { ...tab, jump } : tab)); activate(existing.id); return true;
      }
    }
    pendingOpen.current = true; setOpening(true); setError('');
    let created: SessionInfo | null = null;
    try {
      const selectedId = updateState.current.activeId;
      const current = summariesRef.current[selectedId];
      const source = tabsRef.current.find(tab => tab.id === selectedId && !tab.archivedThread) || tabsRef.current.find(tab => !tab.archivedThread);
      const provider = requestedProvider || initialThread?.provider || (initialThread?.id.startsWith('claude:') ? 'claude' : initialThread ? 'codex' : current?.settings.provider || source?.provider || 'codex');
      created = await window.codex.createSession({
        ...(cwd ? { cwd } : {}), ...(source ? { fromSessionId: source.id } : {}),
        ...(requestedProvider || initialThread || provider === 'claude' ? { provider } : {}),
        ...(options?.restore?.settings ? { settings: options.restore.settings } : current?.connection === 'ready' && (current.settings.provider || 'codex') === provider ? { settings: current.settings } : {}),
      });
      if (!created) return false;
      // Adding a folder that is already open selects it without keeping a spare process.
      if (!cwd) {
        const existing = tabsRef.current.find(tab => !tab.archivedThread && sameFolder(tab.cwd, created!.cwd));
        if (existing) { await window.codex.closeSession(created.id); created = null; setExpanded(previous => ({ ...previous, [projectKey(existing.cwd)]: true })); activate(existing.id); return true; }
      }
      const restored = options?.restore;
      const tab: Tab = { ...created, initialThread, bridge: window.codex.forSession(created.id), jump, ...(options?.childOf ? { childOf: options.childOf } : {}), ...(options?.childLabel ? { childLabel: options.childLabel } : {}), ...(options?.draft !== undefined ? { draft: options.draft } : {}), ...(options?.fork ? { fork: options.fork } : {}),
        ...(restored ? { draft: restored.draft, attachments: restored.attachments, preservedDraft: restored.preservedDraft, restoreSettings: restored.settings,
          pendingMessage: restored.pendingMessage, queue: restored.queue ? { ...restored.queue, paused: true } : undefined, scrollTop: restored.scrollTop, scrollAnchor: restored.scrollAnchor } : {}) };
      setTabs(previous => restored?.pinned ? setTabPinned([...previous, tab], tab.id, true) : [...previous, tab]); activate(tab.id);
      setProjects(previous => previous.some(folder => sameFolder(folder, tab.cwd)) ? previous : [...previous, tab.cwd]);
      setExpanded(previous => ({ ...previous, [projectKey(tab.cwd)]: true }));
      return true;
    } catch (e) {
      setError(errorText(e));
      if (created) await window.codex.closeSession(created.id).catch(() => {});
      return false;
    } finally { pendingOpen.current = false; setOpening(false); }
  };
  /** Creates a sibling Git worktree for `cwd` and opens it as a new tab and folder. */
  const openWorktree = async (cwd: string, name: string) => {
    if (pendingOpen.current) return;
    if (!window.codex.createWorktreeSession) { setError('Изолированные задачи доступны после обновления приложения.'); return; }
    // The folder is explicit; a tab of the same project (else any tab) only seeds model/effort/access.
    const source = tabsRef.current.find(tab => tab.id === activeId && !tab.archivedThread && sameFolder(tab.cwd, cwd)) || tabsRef.current.find(tab => !tab.archivedThread && sameFolder(tab.cwd, cwd)) || tabsRef.current.find(tab => !tab.archivedThread);
    pendingOpen.current = true; setOpening(true); setError('');
    let created: (SessionInfo & { worktree: { path: string; branch: string; created: boolean } }) | null = null;
    try {
      created = await window.codex.createWorktreeSession({ cwd, ...(source ? { fromSessionId: source.id } : {}), name });
      if (!created) return;
      const tab: Tab = { ...created, bridge: window.codex.forSession(created.id) };
      setTabs(previous => [...previous, tab]); setActiveId(tab.id);
      setProjects(previous => previous.some(folder => sameFolder(folder, tab.cwd)) ? previous : [...previous, tab.cwd]);
      setExpanded(previous => ({ ...previous, [projectKey(tab.cwd)]: true }));
      setWorktreeDialog(null); setWorktreeName('');
      setWorktreeNotice(`Задача «${created.worktree.branch}» открыта в отдельной рабочей копии: ${created.worktree.path}. Файлы основного проекта не затронуты; результат переносится через Git (merge/cherry-pick) в терминале.`);
    } catch (e) {
      setError(errorText(e));
      if (created) await window.codex.closeSession(created.id).catch(() => {});
    } finally { pendingOpen.current = false; setOpening(false); }
  };
  const tabThreadId = (tab: Tab) => summariesRef.current[tab.id]?.threadId || tab.initialThread?.id;
  /** Open executor tabs of a parent tab. A tab is only a parent of its own conversation, so an
   * executor (`childOf` set) and an archive view never own executors of their own. */
  const executorTabsOf = (id: string): Tab[] => {
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab || tab.childOf || tab.archivedThread) return [];
    const threadId = tabThreadId(tab);
    return threadId ? tabsRef.current.filter(item => item.childOf === threadId && !item.archivedThread) : [];
  };
  const executorTabName = (id: string) => {
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab) return 'Агент-исполнитель';
    return tab.childLabel || threadNames[tabThreadId(tab) || ''] || summariesRef.current[tab.id]?.title || 'Агент-исполнитель';
  };
  // The upper tab and executor row use the same guard and the same explanation.
  const closeBlockedReason = (id: string) => {
    if (summariesRef.current[id]?.terminalOpen) return 'Сначала закройте терминал этого диалога';
    // Closing a parent closes its executors, so their terminals block it just as its own does.
    const terminalChild = executorTabsOf(id).find(tab => summariesRef.current[tab.id]?.terminalOpen);
    if (terminalChild) return `Сначала закройте терминал исполнителя «${executorTabName(terminalChild.id)}»`;
    if (closingTab.current || closing) return 'Дождитесь закрытия другой вкладки';
    if (actionPending.current || actionBusy) return 'Дождитесь завершения действия с диалогами';
    if (pendingOpen.current || opening) return 'Дождитесь открытия диалога';
    return '';
  };
  const close = async (id: string) => {
    const blocked = closeBlockedReason(id);
    if (blocked) { setError(blocked); return; }
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab) { setError('Эта вкладка уже закрыта.'); return; }
    // Capture before host disposal can deliver a final status and reset the view.
    const record = closedRecord(tab);
    closingTab.current = true;
    setClosing(true); setError('');
    try {
      if (!tabsRef.current.find(tab => tab.id === id)?.archivedThread) await window.codex.closeSession(id);
      const before = tabsRef.current;
      if (record) {
        closedTabsRef.current = [record, ...closedTabsRef.current].slice(0, MAX_CLOSED_TABS);
        setClosedTabs(closedTabsRef.current);
      }
      const remaining = before.filter(tab => tab.id !== id);
      tabsRef.current = remaining;
      setTabs(remaining);
      setActiveId(current => current === id ? remaining[Math.min(before.findIndex(tab => tab.id === id), remaining.length - 1)]?.id || '' : current);
      setSummaries(previous => { const next = { ...previous }; delete next[id]; return next; });
      clearAttention(id);
      setConfirmClose(null);
    } catch (e) { setError(errorText(e)); }
    finally { cancelDeferredClose(id); closingTab.current = false; setClosing(false); }
  };
  /** Closed tabs retain their UI snapshot, while their CLI process is disposed. */
  const closedRecord = (tab: Tab): ClosedTab => {
    const state = summariesRef.current[tab.id];
    const threadId = state?.initialized ? state.threadId : state?.threadId || tab.initialThread?.id;
    const provider: AgentProvider | undefined = tab.archivedThread ? undefined : (state?.settings.provider || tab.provider || (threadId?.startsWith('claude:') ? 'claude' : undefined));
    const title = threadNames[threadId || ''] || state?.title || tab.archivedThread?.name || tab.initialThread?.name || tab.initialThread?.preview || 'Новый диалог';
    const captured = updateCaptures.current.get(tab.id)?.(true);
    const snapshot: UpdateTabSnapshot = captured || { draft: tab.draft || '', attachments: tab.attachments || [], settings: state?.settings || tab.restoreSettings,
      ...(tab.archivedThread ? { archivedThread: tab.archivedThread } : threadId ? { thread: { id: threadId, cwd: tab.cwd, name: title, ...(provider ? { provider } : {}), ...(tab.initialThread?.historyMode ? { historyMode: tab.initialThread.historyMode } : {}) } } : {}) };
    return { cwd: tab.cwd, provider, title, snapshot: { ...snapshot, ...(tab.pinned ? { pinned: true } : {}), ...(snapshot.queue ? { queue: { ...snapshot.queue, paused: true } } : {}) } };
  };
  const restoreClosed = async () => {
    const record = closedTabsRef.current[0];
    if (!record || pendingOpen.current || actionPending.current || closingTab.current || workspaceClosing.current || updateRequest.current) return;
    const snapshot = record.snapshot;
    if (snapshot.archivedThread) {
      const id = `archive:${snapshot.archivedThread.id}`;
      if (tabsRef.current.some(tab => tab.id === id)) { activate(id); }
      else {
        const tab: Tab = { id, cwd: record.cwd, archivedThread: snapshot.archivedThread, scrollTop: snapshot.scrollTop, scrollAnchor: snapshot.scrollAnchor };
        setTabs(previous => snapshot.pinned ? setTabPinned([...previous, tab], id, true) : [...previous, tab]); activate(id);
      }
    } else {
      // A closed executor comes back into the row of its parent, not as a separate root tab:
      // the navigation link survived the closure, so the restored tab belongs under it again.
      const parentId = snapshot.thread ? childParentOf(snapshot.thread.id) : undefined;
      const label = snapshot.thread ? childLinkOf(snapshot.thread.id)?.label : null;
      if (!await open(record.cwd, snapshot.thread, record.provider, undefined, { restore: snapshot, ...(parentId ? { childOf: parentId, ...(label ? { childLabel: label } : {}) } : {}) })) return;
    }
    closedTabsRef.current = closedTabsRef.current.filter(item => item !== record);
    setClosedTabs(closedTabsRef.current);
  };
  const togglePin = (id: string) => setTabs(previous => setTabPinned(previous, id, !previous.find(tab => tab.id === id)?.pinned));
  const cycleTab = (step: 1 | -1) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const index = list.findIndex(tab => tab.id === updateState.current.activeId);
    const next = list[(index + step + list.length) % list.length];
    activate(next.id);
  };
  shortcutActions.current = { cycle: cycleTab, restore: () => { void restoreClosed(); } };
  const tabWorking = (id: string) => {
    const state = summariesRef.current[id];
    return Boolean(state?.busy || state?.loading || state?.pending || state?.pendingDelivery);
  };
  /** Closes the executors of a parent tab first and the parent last, so an executor is never left
   * without the conversation whose row lists it. Stops if the host refused to close a tab. */
  const closeGroup = async (parentId: string): Promise<boolean> => {
    closingGroup.current = true;
    try {
      for (const child of executorTabsOf(parentId)) {
        await close(child.id);
        if (tabsRef.current.some(tab => tab.id === child.id)) return false;
      }
      await close(parentId);
      return !tabsRef.current.some(tab => tab.id === parentId);
    } finally { closingGroup.current = false; }
  };
  /** «Закрыть остальные» closes executor tabs before their parents, so an idle parent can never
   * leave one of its working executors behind as an orphan. */
  const closeOthers = async (id: string) => {
    const closable = (other: Tab) => {
      const state = summariesRef.current[other.id];
      return other.id !== id && !other.pinned && !state?.busy && !state?.pending && !state?.loading && !state?.terminalOpen;
    };
    for (const other of tabsRef.current.filter(other => other.childOf && closable(other))) await close(other.id);
    for (const other of tabsRef.current.filter(other => !other.childOf && closable(other))) {
      if (executorTabsOf(other.id).length) continue;
      await close(other.id);
    }
  };
  /** Why «Дождаться и закрыть» is unavailable for the whole group. The first id is the parent. */
  const waitGroupBlocked = (ids: string[]) => {
    const member = (id: string) => id === ids[0] ? 'диалога' : `исполнителя «${executorTabName(id)}»`;
    for (const id of ids) {
      const state = summariesRef.current[id];
      if (state?.pending) return `Сначала ответьте на вопрос ${member(id)}`;
      if (state?.pendingDelivery) return `Сначала проверьте неподтверждённую отправку ${member(id)}`;
    }
    for (const id of ids) {
      const state = summariesRef.current[id];
      if (state?.loading && !state.busy) return `Дождитесь загрузки ${member(id)}`;
    }
    return '';
  };
  const requestClose = (id: string) => {
    const blocked = closeBlockedReason(id);
    if (blocked) { setError(blocked); return; }
    setError('');
    const children = executorTabsOf(id);
    const group = [id, ...children.map(tab => tab.id)];
    // A parent and its executors are closed as one: confirmation is asked once, for the group.
    if (group.some(member => member in deferredCloseRef.current || tabWorking(member))) { setConfirmClose(id); return; }
    void (children.length ? closeGroup(id) : close(id));
  };
  const waitAndClose = (id: string) => {
    const blocked = closeBlockedReason(id);
    if (blocked) { setError(blocked); return; }
    const children = executorTabsOf(id);
    if (children.length) {
      const group = [id, ...children.map(tab => tab.id)];
      const waitBlocked = waitGroupBlocked(group);
      if (waitBlocked) { setError(`${waitBlocked}.`); return; }
      // Turns may have completed while the confirmation dialog was open.
      const awaited = group.filter(member => summariesRef.current[member]?.busy);
      if (!awaited.length) { void closeGroup(id); return; }
      const next = { ...deferredCloseRef.current };
      for (const member of group) next[member] = summariesRef.current[member]?.completedTurnRevision || 0;
      deferredCloseRef.current = next; setDeferredClose(next);
      cascadeCloseRef.current = { parentId: id, ids: children.map(tab => tab.id), awaited };
      setCascadeClose(cascadeCloseRef.current);
      setConfirmClose(null);
      return;
    }
    const state = summariesRef.current[id];
    if (state?.pending || state?.pendingDelivery) { setError('Сначала ответьте агенту или проверьте неподтверждённую отправку.'); return; }
    if (!state?.busy && !state?.loading) { void close(id); return; }
    if (!state?.busy) { setError('Дождитесь загрузки диалога.'); return; }
    const next = { ...deferredCloseRef.current, [id]: state.completedTurnRevision || 0 };
    deferredCloseRef.current = next; setDeferredClose(next); setConfirmClose(null);
  };
  useEffect(() => {
    const cascade = cascadeCloseRef.current;
    // While a group close runs, its remaining members must not be closed a second time.
    if (closingGroup.current) return;
    for (const [id, revision] of Object.entries(deferredClose)) {
      if (!(id in deferredCloseRef.current)) continue;
      // Members of a cascade are closed together by the effect below, never one by one.
      if (cascade && (cascade.parentId === id || cascade.ids.includes(id))) continue;
      const state = summaries[id];
      if (!tabs.some(tab => tab.id === id) || state?.pending) { cancelDeferredClose(id); continue; }
      // Keep the completion marker while another tab operation holds the shared guard.
      if (!state || (state.completedTurnRevision || 0) <= revision || state.busy || state.loading || state.pendingDelivery || closeBlockedReason(id)) continue;
      void close(id);
      break;
    }
  }, [deferredClose, summaries, tabs, closing, actionBusy, opening]);
  useEffect(() => {
    const cascade = cascadeClose;
    if (!cascade || !cascadeCloseRef.current) return;
    // Executors opened after the wait was armed count too: the group close would take them along.
    const members = new Set([cascade.parentId, ...cascade.ids, ...executorTabsOf(cascade.parentId).map(tab => tab.id)]);
    const group = [...members].filter(id => tabs.some(tab => tab.id === id));
    if (!group.includes(cascade.parentId)) { cancelCascadeClose(); return; }
    // A question or a permission request of any member cancels the whole wait: the tabs stay.
    if (group.some(id => summaries[id]?.pending)) { cancelCascadeClose(); return; }
    for (const id of group) {
      const state = summaries[id];
      if (!state || state.busy || state.loading || state.pendingDelivery) return;
      const revision = deferredClose[id];
      // A working member must report an accepted turn/completed; a lost connection is not one.
      if (cascade.awaited.includes(id) && revision !== undefined && (state.completedTurnRevision || 0) <= revision) return;
    }
    if (closeBlockedReason(cascade.parentId)) return;
    cascadeCloseRef.current = null; setCascadeClose(null);
    void closeGroup(cascade.parentId);
  }, [cascadeClose, deferredClose, summaries, tabs, closing, actionBusy, opening]);
  const closeProject = async (cwd: string, force = false) => {
    if (closing || actionPending.current || pendingOpen.current) return;
    actionPending.current = true; setActionBusy(true); setClosing(true); setError('');
    try {
      const result = await window.codex.closeProject(cwd, { force });
      const removed = new Set(result.closedSessionIds);
      const before = tabsRef.current;
      const remaining = before.filter(tab => !removed.has(tab.id) && !sameFolder(tab.cwd, cwd));
      for (const tab of before) if (!remaining.includes(tab)) removed.add(tab.id);
      // Ignore late reports and history responses from the views being removed.
      tabsRef.current = remaining; projectsRef.current = result.projects;
      setTabs(remaining); setProjects(result.projects);
      setSummaries(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))));
      setActiveId(current => removed.has(current) ? remaining[0]?.id || '' : current);
      const key = projectKey(cwd);
      setExpanded(previous => { const next = { ...previous }; delete next[key]; return next; });
      setHistories(previous => { const next = { ...previous }; delete next[key]; return next; });
      setChildHistories(previous => { const next = { ...previous }; delete next[key]; return next; });
      setExpandedGroups(previous => Object.fromEntries(Object.entries(previous).filter(([groupKey]) => !groupKey.startsWith(`${key}|`))));
      historyRefreshPending.current.delete(key);
      childRefreshPending.current.delete(key);
      setSearchRevision(value => value + 1);
      setConfirmCloseProject(null);
    } catch (e) { setError(errorText(e)); }
    finally { actionPending.current = false; setActionBusy(false); setClosing(false); }
  };
  const requestCloseProject = (cwd: string) => {
    if (closing || actionPending.current || pendingOpen.current || preparingUpdate) return;
    const affected = tabsRef.current.filter(tab => sameFolder(tab.cwd, cwd));
    if (affected.some(tab => summariesRef.current[tab.id]?.terminalOpen)) {
      setError('Сначала закройте терминал диалога этого проекта и вернитесь в приложение.');
      return;
    }
    setError('');
    if (affected.length) setConfirmCloseProject(cwd);
    else void closeProject(cwd);
  };
  useEffect(() => {
    if (!confirmCloseProject) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !actionPending.current) setConfirmCloseProject(null); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [confirmCloseProject]);
  const threadLocked = (threadId: string) => tabsRef.current.some(tab => {
    const state = summariesRef.current[tab.id];
    const id = state?.threadId || tab.initialThread?.id;
    return id === threadId && (state?.busy || state?.loading || state?.terminalOpen || state?.pendingDelivery || Boolean(state?.pending));
  });
  /** Keep failed RPCs entirely reversible in the UI. Close local views only after the agent
   * confirms the operation, including reported descendants. Returns a close error, if any. */
  const closeAffectedTabs = async (affected: Set<string>): Promise<string> => {
    let closeError = '';
    const removed = tabsRef.current.filter(tab => affected.has(tab.archivedThread?.id || summariesRef.current[tab.id]?.threadId || tab.initialThread?.id || ''));
    for (const tab of removed) if (!tab.archivedThread) {
      try { await window.codex.closeSession(tab.id); }
      catch (e) { closeError = `Операция выполнена, но соединение вкладки не закрылось: ${errorText(e)}`; }
    }
    const removedIds = new Set(removed.map(tab => tab.id));
    const remaining = tabsRef.current.filter(tab => !removedIds.has(tab.id));
    tabsRef.current = remaining;
    setTabs(remaining);
    setSummaries(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removedIds.has(id))));
    setActiveId(previous => removedIds.has(previous) ? remaining[0]?.id || '' : previous);
    setHistories(previous => Object.fromEntries(Object.entries(previous).map(([key, history]) => [key, { ...history, threads: history.threads.filter(item => !affected.has(item.id)) }])));
    setArchiveThreads(previous => previous.filter(item => !affected.has(item.id)));
    return closeError;
  };
  const performAction = async (action: ThreadAction, cwd: string, thread: Thread, name?: string) => {
    if (actionPending.current) return;
    if (threadLocked(thread.id)) { setError('Дождитесь завершения работы диалога и закройте его терминал.'); return; }
    if (action === 'rename' && !name?.trim()) { setError('Введите название диалога.'); return; }
    actionPending.current = true; setActionBusy(true); setError('');
    try {
      const result = await window.codex.manageThread({ action, cwd, threadId: thread.id, ...(action === 'rename' ? { name: name!.trim() } : {}) });
      historyRevision.current++;
      setSearchRevision(value => value + 1);
      const affected = new Set([thread.id, ...(result.affectedThreadIds || [])]);
      let closeError = '';
      if (action === 'rename') {
        const title = result.thread?.name || name!.trim();
        setThreadNames(previous => ({ ...previous, [thread.id]: title }));
        setHistories(previous => Object.fromEntries(Object.entries(previous).map(([key, history]) => [key, { ...history, threads: history.threads.map(item => item.id === thread.id ? { ...item, name: title } : item) }])));
        // An executor carries its name in the navigation link as well, so the row and the next
        // free letter stay in step after a rename. The link is presentation data: a failure here
        // never reverses the rename the agent already accepted.
        if (childParentOf(thread.id) && window.codex.manageThreadChildLink) {
          updateChildLinks(previous => {
            const next: Record<string, ThreadChildLink[]> = {};
            for (const [key, links] of Object.entries(previous)) next[key] = links.map(link => link.childThreadId === thread.id ? { ...link, label: title } : link);
            return next;
          });
          await window.codex.manageThreadChildLink({ action: 'relabel', childThreadId: thread.id, label: title }).catch(() => {});
        }
      } else {
        closeError = await closeAffectedTabs(affected);
        // The host forgets the links of a deleted conversation; archiving hides it from the
        // folder just as finally, so drop them here too — otherwise the «Исполнители» row keeps
        // a nameless ghost of a conversation that is no longer in the folder.
        if (action === 'archive' && window.codex.manageThreadChildLink) for (const id of affected) await window.codex.manageThreadChildLink({ action: 'unlink', childThreadId: id }).catch(() => {});
        if (action === 'archive' || action === 'delete') dropChildLinks(affected);
        if (action === 'restore') {
          const folder = result.thread?.cwd || cwd;
          if (folder) {
            setProjects(previous => previous.some(path => sameFolder(path, folder)) ? previous : [...previous, folder]);
            setExpanded(previous => ({ ...previous, [projectKey(folder)]: true }));
          }
        }
      }
      setActionDialog(null);
      if (closeError) setError(closeError);
      if (cwd) void loadProjectHistory(cwd);
      if (cwd) void loadThreadChildren(cwd);
      if (action !== 'rename') void loadArchive();
    } catch (e) { setError(errorText(e)); }
    finally { actionPending.current = false; setActionBusy(false); }
  };
  const forkThread = (cwd: string, thread: Thread, lastTurnId?: string) => {
    if (pendingOpen.current || actionPending.current || threadLocked(thread.id)) return;
    void open(cwd, thread, thread.provider || (thread.id.startsWith('claude:') ? 'claude' : 'codex'), undefined, { fork: lastTurnId ? { lastTurnId } : {} });
  };
  const knownThread = (threadId: string, cwd: string): Thread | undefined => {
    const key = projectKey(cwd);
    const tab = tabsRef.current.find(item => (summariesRef.current[item.id]?.threadId || item.initialThread?.id) === threadId);
    const summary = tab && summariesRef.current[tab.id];
    return (histories[key]?.threads || []).find(thread => thread.id === threadId) || (childHistories[key]?.threads || []).find(thread => thread.id === threadId)
      || (summary ? { id: threadId, cwd: summary.cwd, name: summary.title, provider: summary.settings.provider || tab?.provider || 'codex' } : tab?.initialThread);
  };
  const threadTitle = (threadId: string, cwd = '') => threadNames[threadId] || knownThread(threadId, cwd)?.name || knownThread(threadId, cwd)?.preview;
  const childLinkOf = (threadId: string) => Object.values(childLinksRef.current).flat().find(link => link.childThreadId === threadId);
  const childParentOf = (threadId: string) => childLinkOf(threadId)?.parentThreadId;
  const executorMutationBlockedReason = (thread: ExecutorThread) => {
    if (preparingUpdate || savingBeforeClose) return 'Дождитесь сохранения рабочего места';
    if (updateStatus?.state === 'waiting') return 'Приложение ожидает завершения работы перед обновлением';
    if (confirmCloseProject) return 'Сначала завершите закрытие проекта';
    if (pendingOpen.current || opening) return 'Дождитесь открытия диалога';
    if (actionPending.current || actionBusy || closingTab.current || closing) return 'Дождитесь завершения действия с диалогами';
    if (thread.id.startsWith('session:')) return 'Диалог ещё не создан';
    if (threadLocked(thread.id)) return 'Сначала завершите работу диалога и закройте его терминал';
    if (!window.codex.manageThreadChildLink) return 'Управление связями диалогов недоступно';
    return '';
  };
  const childThreadsFor = (parentThreadId: string, cwd?: string): ExecutorThread[] => {
    const children = new Map<string, ExecutorThread>();
    for (const link of Object.values(childLinksRef.current).flat()) {
      if (link.parentThreadId !== parentThreadId || (cwd && !sameFolder(link.cwd, cwd))) continue;
      children.set(link.childThreadId, { ...knownThread(link.childThreadId, link.cwd), id: link.childThreadId, cwd: link.cwd, provider: link.provider, label: link.label || undefined });
    }
    const siblingTabs = tabsRef.current.filter(tab => tab.childOf === parentThreadId && !tab.archivedThread && (!cwd || sameFolder(tab.cwd, cwd)));
    for (const tab of siblingTabs) {
      if (tab.childOf !== parentThreadId || tab.archivedThread || (cwd && !sameFolder(tab.cwd, cwd))) continue;
      const summary = summariesRef.current[tab.id];
      const id = summary?.threadId || tab.initialThread?.id || `session:${tab.id}`;
      const fallbackLabel = nextExecutorLabel(siblingTabs.slice(0, siblingTabs.indexOf(tab)).map(item => item.childLabel));
      const label = children.get(id)?.label || tab.childLabel || fallbackLabel;
      children.set(id, { ...children.get(id), id, cwd: tab.cwd, provider: summary?.settings.provider || tab.provider || 'codex', name: threadNames[id] || label || summary?.title || tab.initialThread?.name, label, sessionId: tab.id,
        busy: summary?.busy, pending: summary?.pending, loading: summary?.loading, connection: summary?.connection, terminalOpen: summary?.terminalOpen,
        pendingKind: summary?.pendingKind, unread: Boolean(attention[tab.id]), attentionKind: attention[tab.id]?.kind,
        closeWhenComplete: tab.id in deferredClose, closeBlockedReason: closeBlockedReason(tab.id) });
    }
    return [...children.values()].map(thread => ({ ...thread, unlinkBlockedReason: executorMutationBlockedReason(thread) }));
  };
  const createExecutor = (cwd: string, parentThreadId: string, draft?: string) => {
    if (pendingOpen.current || actionPending.current || childParentOf(parentThreadId)) return;
    const parentTab = tabsRef.current.find(tab => (summariesRef.current[tab.id]?.threadId || tab.initialThread?.id) === parentThreadId);
    const parent = knownThread(parentThreadId, cwd);
    const provider = (parentTab && summariesRef.current[parentTab.id]?.settings.provider) || parent?.provider || parentTab?.provider || (parentThreadId.startsWith('claude:') ? 'claude' : 'codex');
    const label = nextExecutorLabel(childThreadsFor(parentThreadId, cwd).map(thread => thread.label || thread.name));
    void open(cwd, undefined, provider, undefined, { childOf: parentThreadId, childLabel: label, ...(draft !== undefined ? { draft } : {}) });
  };
  /** Opens an executor from any entry point: the row of its parent or the project tree. An open
   * tab is only activated; otherwise the parent is opened first, so the executor always appears
   * selected in the «Исполнители» row of a visible parent instead of a separate root tab. */
  const openExecutor = async (cwd: string, thread: ExecutorThread) => {
    const sessionId = thread.sessionId || tabsRef.current.find(tab => tab.childOf && tabThreadId(tab) === thread.id)?.id;
    if (sessionId && tabsRef.current.some(tab => tab.id === sessionId)) { activate(sessionId); return; }
    if (thread.id.startsWith('session:')) return;
    const parentId = childParentOf(thread.id);
    if (!parentId) { void open(cwd, thread, thread.provider); return; }
    const parentOpen = tabsRef.current.some(tab => !tab.childOf && !tab.archivedThread && tabThreadId(tab) === parentId);
    // The parent keeps the focus only until the executor itself opens right after it.
    if (!parentOpen && !await openParentThread(cwd, parentId)) return;
    await open(cwd, thread, thread.provider, undefined, { childOf: parentId, childLabel: thread.label || childLinkOf(thread.id)?.label || thread.name || undefined });
  };
  const openParentThread = async (cwd: string, parentThreadId: string) => {
    const existing = tabsRef.current.find(tab => tabThreadId(tab) === parentThreadId);
    if (existing) { activate(existing.id); return true; }
    const parent = knownThread(parentThreadId, cwd) || { id: parentThreadId, cwd, provider: parentThreadId.startsWith('claude:') ? 'claude' as const : 'codex' as const };
    return open(cwd, parent, parent.provider);
  };
  const executorAction = (action: ExecutorAction, cwd: string, thread: ExecutorThread) => {
    if (action === 'close') { if (thread.sessionId) requestClose(thread.sessionId); else setError('Вкладка уже закрыта. Её запись можно убрать из ряда.'); return; }
    const blocked = executorMutationBlockedReason(thread);
    if (blocked) { setError(blocked); return; }
    if (action !== 'unlink') { threadAction(action, cwd, thread); return; }
    if (!window.codex.manageThreadChildLink) { setError('Управление связями диалогов недоступно'); return; }
    actionPending.current = true; setActionBusy(true); setError('');
    void window.codex.manageThreadChildLink({ action: 'unlink', childThreadId: thread.id }).then(() => {
      if (thread.sessionId) cancelDeferredClose(thread.sessionId);
      dropChildLinks([thread.id]);
      setTabs(previous => previous.map(tab => {
        if (tab.id !== thread.sessionId && (summariesRef.current[tab.id]?.threadId || tab.initialThread?.id) !== thread.id) return tab;
        const { childOf, childLabel, ...plain } = tab;
        return plain;
      }));
    }).catch(error => setError(errorText(error))).finally(() => { actionPending.current = false; setActionBusy(false); });
  };
  const cancelBulk = () => { if (bulkRunRef.current?.phase === 'running') return; setBulkScope(null); setBulkSelected([]); };
  const closeBulkRun = () => {
    const run = bulkRunRef.current;
    if (!run || run.phase === 'running') return;
    setBulkRun(null);
    if (run.phase === 'done') setBulkSelected(previous => previous.filter(id => !run.outcomes.some(outcome => outcome.id === id && outcome.ok)));
  };
  const runBulkArchive = async () => {
    const run = bulkRunRef.current;
    if (!run || run.phase !== 'confirm' || actionPending.current) return;
    const outcomes: BulkOutcome[] = [];
    actionPending.current = true; setActionBusy(true); bulkStop.current = false;
    setBulkRun({ ...run, phase: 'running' });
    try {
      for (const target of run.targets) {
        if (bulkStop.current) break;
        setBulkRun({ ...run, phase: 'running', outcomes: [...outcomes], current: target.title });
        try {
          if (threadLocked(target.id)) throw new Error('Дождитесь завершения работы диалога и закройте его терминал.');
          const result = await window.codex.manageThread({ action: 'archive', cwd: target.cwd, threadId: target.id });
          const affected = new Set([target.id, ...(result.affectedThreadIds || [])]);
          const closeError = await closeAffectedTabs(affected);
          if (closeError) setError(closeError);
          for (const id of affected) await window.codex.manageThreadChildLink?.({ action: 'unlink', childThreadId: id }).catch(() => {});
          dropChildLinks(affected);
          historyRevision.current++;
          setSearchRevision(value => value + 1);
          outcomes.push({ ...target, ok: true });
        } catch (error) { outcomes.push({ ...target, ok: false, error: errorText(error) }); }
        setBulkRun({ ...run, phase: 'running', outcomes: [...outcomes] });
      }
      setBulkRun({ ...run, phase: 'done', outcomes, stopped: bulkStop.current });
      for (const cwd of new Set(run.targets.map(target => target.cwd))) { void loadProjectHistory(cwd); void loadThreadChildren(cwd); }
      void loadArchive();
    } finally { actionPending.current = false; setActionBusy(false); }
  };
  const requestBulkArchive = (scope: BulkScope, rows: BulkRow[]) => {
    if (!sameBulkScope(bulkScope, scope) || bulkRunRef.current || actionPending.current) return;
    const plan = planBulkArchive({ rows, selected: bulkSelected, names: threadNames, locked: threadLocked });
    if (!plan.targets.length) return;
    setBulkRun({ phase: 'confirm', scope, scopeLabel: bulkScopeLabel(scope, folderName), targets: plan.targets, blocked: plan.blocked, outcomes: [] });
  };
  const threadAction = (action: ThreadAction, cwd: string, thread: Thread) => {
    if (actionPending.current) return;
    if (action === 'rename' || action === 'delete') {
      setError(''); setNewName(threadNames[thread.id] || thread.name || thread.preview || ''); setActionDialog({ action, cwd, thread });
    } else void performAction(action, cwd, thread);
  };
  useEffect(() => {
    if (!actionDialog) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !actionPending.current) setActionDialog(null); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [actionDialog]);
  // Once the user confirms Close, stop accepting new work while the helper
  // waits for the already-running task to finish. Otherwise a new send can
  // race the updater and keep the Nightly in `waiting` indefinitely.
  const updateWaiting = updateStatus?.state === 'waiting';
  const controls: WorkspaceControls = {
    openLibrary: () => setShowLibrary(true),
    projects, opening: opening || actionBusy || Boolean(confirmCloseProject) || preparingUpdate || savingBeforeClose || updateWaiting, expanded, histories, threadNames, searchRevision,
    archiveOpen, archiveThreads, archiveLoading, archiveError, archiveCursor, actionBusy: actionBusy || Boolean(confirmCloseProject) || preparingUpdate || savingBeforeClose || updateWaiting,
    archiveThreadId: tabs.find(tab => tab.id === activeId)?.archivedThread?.id,
    toggleArchive: () => { setArchiveOpen(previous => !previous); if (!archiveOpen) void loadArchive(); },
    refreshArchive: cursor => void loadArchive(cursor), openArchivedThread: openArchive, threadAction, threadLocked,
    activeCwd: summaries[activeId]?.cwd || tabs.find(tab => tab.id === activeId)?.cwd || '',
    activeThreadId: summaries[activeId]?.threadId,
    addProject: () => void open(),
    closeProject: requestCloseProject,
    newWorktree: (cwd: string) => { setError(''); setWorktreeName(''); setWorktreeDialog({ cwd }); },
    showTasks: (cwd: string) => { setError(''); setTasksPanel({ cwd }); },
    toggleProject: cwd => setExpanded(previous => ({ ...previous, [projectKey(cwd)]: !previous[projectKey(cwd)] })),
    refreshProject: (cwd, cursor) => void loadProjectHistory(cwd, cursor),
    newChat: (cwd: string, provider?: AgentProvider) => void open(cwd, undefined, provider), openThread: (cwd, thread) => void open(cwd, thread), report, registerUpdateCapture, onSessionStateChange, flushSessionState, onSessionAttention,
    handoff: (cwd, provider, text) => open(cwd, undefined, provider, undefined, { draft: text }),
    childParentOf, createExecutor, childThreads: childThreadsFor, openChildThread: openExecutor, executorAction, openParentThread, threadTitle, executorLabel: sessionId => tabsRef.current.find(tab => tab.id === sessionId)?.childLabel,
    closeWhenComplete: sessionId => sessionId in deferredClose,
    childCount: (threadId, cwd) => childThreadsFor(threadId, cwd).filter(thread => !thread.id.startsWith('session:')).length,
    childHistories, expandedGroups, toggleGroup: (cwd, parentId) => setExpandedGroups(previous => ({ ...previous, [`${projectKey(cwd)}|${parentId}`]: !previous[`${projectKey(cwd)}|${parentId}`] })),
    startBulk: scope => { setBulkScope(scope); setBulkSelected([]); }, cancelBulk: () => { setBulkScope(null); setBulkSelected([]); }, toggleBulk: (scope, id) => setBulkSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]), setBulkSelection: (_scope, ids) => setBulkSelected(ids), requestBulkArchive, bulkScope, bulkSelected, bulkBusy: Boolean(bulkRun), openPalette: () => setShowPalette(true),
  };
  const attentionTabs = tabs.filter(tab => !tab.archivedThread && (summaries[tab.id]?.pending || attention[tab.id]));
  const parallelSessions = tabs.map(tab => {
    const state = summaries[tab.id];
    const threadId = state?.threadId || (!state?.initialized ? tab.initialThread?.id : undefined);
    return {
      id: tab.id, cwd: state?.cwd || tab.cwd, threadId,
      provider: state?.settings.provider || tab.provider || 'codex',
      title: threadNames[threadId || ''] || state?.title || tab.initialThread?.name || tab.initialThread?.preview || 'Новый диалог',
      busy: state?.busy, loading: state?.loading, pending: state?.pending, terminalOpen: state?.terminalOpen,
      archived: Boolean(tab.archivedThread), changedFiles: state?.changedFiles,
    };
  });
  /** Ctrl+K palette: switch/reopen dialogs and run workspace actions. Built on open so it reflects the current tabs. */
  const paletteCommands = (): PaletteCommand[] => {
    const active = tabs.find(tab => tab.id === activeId);
    const activeState = summaries[activeId];
    const activeCwd = activeState?.cwd || active?.cwd || projects[0] || '';
    const activeThread = activeState?.threadId ? { id: activeState.threadId, cwd: activeCwd, name: activeState.title, provider: activeState.settings.provider } : undefined;
    const busyActive = Boolean(activeState?.busy || activeState?.loading || activeState?.terminalOpen || activeState?.pending);
    const activeIsExecutor = Boolean(active?.childOf);
    const tabTitle = (tab: Tab) => { const state = summaries[tab.id]; return threadNames[state?.threadId || tab.initialThread?.id || ''] || state?.title || tab.archivedThread?.name || tab.initialThread?.name || tab.initialThread?.preview || 'Новый диалог'; };
    const commands: PaletteCommand[] = tabs.map(tab => ({
      id: `tab:${tab.id}`, group: 'Открытые вкладки', label: `${folderName(tab.cwd)} · ${tabTitle(tab)}`, hint: `${tab.cwd}${tab.pinned ? ' · закреплена' : ''}${activeId === tab.id ? ' · текущая' : ''}`, keywords: tab.cwd,
      icon: tab.archivedThread ? Archive : summaries[tab.id]?.busy ? LoaderCircle : MessageSquare, run: () => activate(tab.id),
    }));
    commands.push(
      { id: 'new-codex', group: 'Действия', label: 'Новый диалог Codex', hint: activeCwd ? folderName(activeCwd) : 'Текущая папка', icon: Plus, disabled: opening || !activeCwd, run: () => void open(activeCwd, undefined, 'codex') },
      { id: 'new-claude', group: 'Действия', label: 'Новый диалог Claude Code', hint: activeCwd ? folderName(activeCwd) : 'Текущая папка', icon: Plus, disabled: opening || !activeCwd, run: () => void open(activeCwd, undefined, 'claude') },
      { id: 'executor', group: 'Действия', label: 'Новый агент-исполнитель', hint: activeIsExecutor ? 'У агента-исполнителя своих исполнителей нет' : activeThread ? 'Чистый диалог этой папки' : 'Сначала откройте диалог', icon: Bot, disabled: activeIsExecutor || !activeThread || opening, run: () => { if (activeThread) createExecutor(activeCwd, activeThread.id); } },
      { id: 'restore-closed', group: 'Действия', label: 'Вернуть закрытую вкладку', hint: closedTabs[0] ? `${folderName(closedTabs[0].cwd)} · ${closedTabs[0].title}` : 'Закрытых вкладок нет', shortcut: 'Ctrl+Shift+T', icon: RotateCcw, disabled: !closedTabs.length || opening, run: restoreClosed },
      { id: 'pin', group: 'Действия', label: active?.pinned ? 'Открепить текущую вкладку' : 'Закрепить текущую вкладку', icon: active?.pinned ? PinOff : Pin, disabled: !active, run: () => { if (active) togglePin(active.id); } },
      { id: 'close-tab', group: 'Действия', label: 'Закрыть текущую вкладку', icon: X, disabled: !active || closing || Boolean(activeState?.terminalOpen), run: () => { if (active) requestClose(active.id); } },
      { id: 'next-tab', group: 'Действия', label: 'Следующая вкладка', shortcut: 'Ctrl+Tab', icon: History, disabled: tabs.length < 2, run: () => cycleTab(1) },
      { id: 'worktree', group: 'Действия', label: 'Новая задача в отдельной ветке', hint: activeCwd ? folderName(activeCwd) : undefined, icon: GitBranch, disabled: !activeCwd || opening, run: () => { setError(''); setWorktreeName(''); setWorktreeDialog({ cwd: activeCwd }); } },
      { id: 'tasks', group: 'Действия', label: 'Задачи проекта…', hint: 'Список рабочих копий, перенос результата и удаление', icon: FolderTree, disabled: !activeCwd, run: () => { setError(''); setTasksPanel({ cwd: activeCwd }); } },
      { id: 'library', group: 'Действия', label: 'История и закладки', hint: 'Поиск по сообщениям Codex и Claude', icon: BookMarked, run: () => setShowLibrary(true) },
      { id: 'archive', group: 'Действия', label: archiveOpen ? 'Скрыть архив' : 'Показать архив', icon: ArchiveRestore, run: () => { setArchiveOpen(previous => !previous); if (!archiveOpen) void loadArchive(); } },
      { id: 'attention', group: 'Действия', label: 'Требуют внимания', hint: attentionTabs.length ? `${attentionTabs.length} диалог(ов)` : 'Все просмотрено', icon: BellRing, run: () => setShowAttention(true) },
      { id: 'release-notes', group: 'Действия', label: 'Что нового?', hint: releaseNotes.state?.currentVersion ? `Изменения версии ${releaseNotes.state.currentVersion}` : 'Изменения Кузьмича', icon: Sparkles, run: () => setShowReleaseNotes(true) },
      { id: 'app-updates', group: 'Действия', label: 'Обновления приложения', hint: 'Новая версия Кузьмича', icon: RefreshCw, run: () => setShowAppUpdates(true) },
      { id: 'notifications', group: 'Действия', label: 'Настройки уведомлений', icon: Bell, run: () => setShowNotificationSettings(true) },
    );
    const openIds = new Set(tabs.map(tab => `${projectKey(tab.cwd)}:${summaries[tab.id]?.threadId || tab.initialThread?.id || ''}`));
    for (const cwd of projects) {
      const history = histories[projectKey(cwd)];
      for (const thread of (history?.threads || []).slice(0, 30)) {
        if (openIds.has(`${projectKey(cwd)}:${thread.id}`)) continue;
        const name = threadNames[thread.id] || thread.name || thread.preview || 'Новый диалог';
        commands.push({ id: `thread:${projectKey(cwd)}:${thread.id}`, group: 'Открыть диалог из истории', label: name, hint: `${folderName(cwd)} · ${thread.id.startsWith('claude:') ? 'Claude Code' : 'Codex'}`, keywords: cwd, icon: thread.id.startsWith('claude:') ? Terminal : MessageSquare, disabled: opening, run: () => void open(cwd, thread) });
      }
    }
    return commands;
  };

  const activeExecutor = tabs.find(tab => tab.id === activeId && tab.childOf);
  const executorName = (child: ExecutorThread) => child.label || child.name || child.preview || 'Агент-исполнитель';
  /** The «Исполнители» row lives inside the parent's own view, so from any other tab this badge
   * is the only sign of their work: waiting outranks working, and a result finished in the
   * background keeps an unread dot until the executor is opened. */
  const parentExecutorState = (parentId: string, cwd: string) => {
    const children = childThreadsFor(parentId, cwd);
    const selected = activeExecutor ? children.find(child => child.sessionId === activeExecutor.id) : undefined;
    const waiting = children.filter(child => child.pending || (child.unread && child.attentionKind === 'question'));
    const rest = children.filter(child => !waiting.includes(child));
    const running = rest.filter(child => child.busy);
    const unread = rest.filter(child => child.unread);
    return {
      selected, waiting, running, unread,
      hint: [
        ...waiting.map(child => `${executorName(child)} ждёт ответа`),
        ...running.map(child => `${executorName(child)} работает`),
        ...unread.filter(child => !child.busy).map(child => `${executorName(child)}: ${child.attentionKind === 'error' ? 'ошибка' : 'новый результат'}`),
      ].join('\n'),
    };
  };
  const executorBadge = (state: ReturnType<typeof parentExecutorState>) => {
    const count = state.waiting.length || state.running.length || state.unread.length;
    if (!state.selected && !count) return null;
    const tone = state.waiting.length ? 'waiting' : state.running.length ? 'running' : '';
    return <span className={`session-executor-badge ${tone}`} aria-hidden="true">
      {tone === 'running' ? <LoaderCircle size={11} className="spin" /> : <Bot size={11} />}
      <span>{state.selected ? shortExecutorName(executorName(state.selected)) : count}</span>
      {state.unread.length > 0 && <span className="tab-unread" />}
    </span>;
  };
  const missingParent = activeExecutor && !tabs.some(tab => !tab.childOf && !tab.archivedThread && sameFolder(tab.cwd, activeExecutor.cwd) && (summaries[tab.id]?.threadId || tab.initialThread?.id) === activeExecutor.childOf) ? activeExecutor : undefined;
  const closeState = confirmClose ? summaries[confirmClose] : undefined;
  const closeExecutor = confirmClose ? tabs.find(tab => tab.id === confirmClose)?.childOf : undefined;
  const closeDeferred = Boolean(confirmClose && confirmClose in deferredClose);
  // Closing a parent closes its executors too, so one dialog answers for the whole group.
  const closeChildren = confirmClose ? executorTabsOf(confirmClose) : [];
  const closeGroupIds = confirmClose ? [confirmClose, ...closeChildren.map(tab => tab.id)] : [];
  const closeBusy = closeGroupIds.filter(id => summaries[id]?.busy || summaries[id]?.loading);
  const closeGroupNames = closeChildren.map(tab => executorTabName(tab.id)).join(', ');
  const closeBusyNames = closeBusy.map(id => id === confirmClose ? 'этот диалог' : executorTabName(id)).join(', ');
  const waitBlocked = closeChildren.length ? waitGroupBlocked(closeGroupIds)
    : closeState?.pending ? 'Сначала ответьте агенту' : closeState?.pendingDelivery ? 'Сначала проверьте неподтверждённую отправку' : closeState?.loading && !closeState.busy ? 'Дождитесь загрузки диалога' : '';

  return <OpenAppUpdatesContext.Provider value={() => setShowAppUpdates(true)}><div className="workspace-window"><AppUpdateBanner control={appUpdates} onDetails={() => setShowAppUpdates(true)} /><UpdateNoticeContext.Provider value={{ status: updateStatus, deciding: decidingUpdate, decide: decision => void decideUpdate(decision), force: () => void forceUpdate(), dismiss: () => setUpdateStatus(null) }}><div className="workspace-shell" ref={shellRef}>
    <div className="workspace-tabs-bar">
      <div className="session-tabs" role="tablist" aria-label="Открытые диалоги">
        {tabs.filter(tab => !tab.childOf).map(tab => {
          const state = summaries[tab.id];
          const referenced = tab.archivedThread || tab.initialThread;
          const title = threadNames[state?.threadId || referenced?.id || ''] || state?.title || referenced?.name || referenced?.preview || 'Новый диалог';
          const children = parentExecutorState(tab.archivedThread ? '' : state?.threadId || referenced?.id || '', tab.cwd);
          const childActive = Boolean(children.selected);
          const executorDescription = `${children.selected ? `, открыт исполнитель ${executorName(children.selected)}` : ''}${children.hint ? `, ${children.hint}` : ''}`;
          const status = state?.terminalOpen ? 'Открыт в терминале' : state?.pending ? 'Ожидает ответа' : state?.busy ? 'Выполняется' : state?.connection === 'error' ? 'Ошибка подключения' : 'Готов';
          const dropClass = dropTarget?.id === tab.id && dragTabId && dragTabId !== tab.id ? (dropTarget.after ? 'drop-after' : 'drop-before') : '';
          return <div className={`session-tab ${activeId === tab.id ? 'active' : childActive ? 'child-active' : ''} ${attention[tab.id] ? 'has-unread' : ''} ${tab.pinned ? 'pinned' : ''} ${dragTabId === tab.id ? 'dragging' : ''} ${dropClass}`} data-session-id={tab.id} data-pinned={tab.pinned ? 'true' : undefined} key={tab.id}
            draggable onDragStart={event => { setDragTabId(tab.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); }}
            onDragOver={event => { if (!dragTabId || dragTabId === tab.id || Boolean(tabs.find(item => item.id === dragTabId)?.pinned) !== Boolean(tab.pinned)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const box = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: tab.id, after: event.clientX > box.left + box.width / 2 }); }}
            onDragLeave={() => setDropTarget(current => current?.id === tab.id ? null : current)}
            onDrop={event => { event.preventDefault(); const from = dragTabId || event.dataTransfer.getData('text/plain'); if (from) { const box = event.currentTarget.getBoundingClientRect(); setTabs(previous => reorderTabs(previous, from, tab.id, event.clientX > box.left + box.width / 2)); } setDragTabId(null); setDropTarget(null); }}
            onDragEnd={() => { setDragTabId(null); setDropTarget(null); }}
            onContextMenu={event => { event.preventDefault(); setShowAttention(false); setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY }); }}>
            <button id={`tab-${tab.id}`} role="tab" aria-selected={activeId === tab.id} aria-label={`${folderName(tab.cwd)}: ${title}${executorDescription}`} aria-controls={`view-${tab.id}`} data-tooltip={`${tab.cwd}\n${title} · ${status}${tab.pinned ? ' · Закреплена' : ''}${executorDescription}`} onClick={() => activate(tab.id)} onKeyDown={event => {
              const index = tabs.findIndex(value => value.id === tab.id);
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next >= 0) { event.preventDefault(); activate(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); }
              if (event.shiftKey && event.key === 'F10' || event.key === 'ContextMenu') { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setTabMenu({ id: tab.id, x: box.left + 12, y: box.bottom }); }
            }}>
              {tab.archivedThread ? <Archive size={13} /> : state?.terminalOpen ? <Terminal size={13} /> : state?.busy ? <LoaderCircle size={13} className="spin" /> : <AgentLogo provider={(state?.settings.provider || tab.provider) === 'claude' ? 'claude' : 'codex'} size={13} />}
              <span className="session-tab-label"><strong>{folderName(tab.cwd)}</strong><span>{title}</span></span>
              {executorBadge(children)}
              {tab.pinned && <Pin size={11} className="session-tab-pin" aria-label="Закреплена" />}
              <span className={`tab-state ${state?.pending ? 'waiting' : state?.busy ? 'running' : state?.connection === 'error' ? 'error' : ''}`} aria-label={status} />
              {attention[tab.id] && <span className="tab-unread" aria-label={attention[tab.id].kind === 'completed' ? 'Непрочитанный результат' : 'Непрочитанное событие'} data-tooltip={attention[tab.id].kind === 'completed' ? 'Новый результат' : 'Требует внимания'} />}
            </button>
            {/* A clean executor never touches the parent's conversation, so a working parent is not a reason to block it. */}
            {activeId === tab.id && !tab.childOf && state?.threadId && <button type="button" className="session-tab-child" aria-label="Новый агент-исполнитель" data-tooltip="Новый агент-исполнитель: чистый диалог этой папки" disabled={opening || actionBusy} onClick={event => { event.stopPropagation(); createExecutor(state.cwd || tab.cwd, state.threadId!); }}><Bot size={15} /></button>}
            {!tab.pinned && <button className={`session-tab-close ${tab.id in deferredClose ? 'close-when-complete' : ''}`} aria-label={`Закрыть вкладку ${folderName(tab.cwd)}: ${title}`}
              data-tooltip={closeBlockedReason(tab.id) || (tab.id in deferredClose ? 'Закроется по завершении' : executorTabsOf(tab.id).length ? 'Закрыть вкладку вместе с исполнителями' : 'Закрыть вкладку')}
              disabled={Boolean(closeBlockedReason(tab.id))} onClick={() => requestClose(tab.id)}>{tab.id in deferredClose ? <Clock3 size={12} /> : <X size={13} />}</button>}
          </div>;
        })}
        {missingParent && (() => {
          const parentId = missingParent.childOf!;
          const title = threadTitle(parentId, missingParent.cwd) || 'Родительский диалог';
          const children = parentExecutorState(parentId, missingParent.cwd);
          return <div className="session-tab child-active" data-parent-thread-id={parentId}>
            <button type="button" role="tab" aria-selected={false} aria-label={`${folderName(missingParent.cwd)}: ${title}, открыт исполнитель ${executorName(children.selected!)}${children.hint ? `, ${children.hint}` : ''}`} data-tooltip={`${title} · Открыть родительский диалог${children.hint ? `\n${children.hint}` : ''}`} disabled={controls.opening || closing} onClick={() => openParentThread(missingParent.cwd, parentId)}>
              <MessageSquare size={13} /><span className="session-tab-label"><strong>{folderName(missingParent.cwd)}</strong><span>{title}</span></span>{executorBadge(children)}
            </button>
          </div>;
        })()}
      </div>
      <button className="icon-button tab-add" data-tooltip="Новый диалог в текущей папке" aria-label="Открыть новый диалог" disabled={opening || starting} onClick={() => void open(tabs.find(tab => tab.id === activeId)?.cwd || projects[0])}><Plus size={17} /></button>
      <div className="workspace-alert-tools">
        <ParallelActivity sessions={parallelSessions} activeId={activeId} onActivate={activate} />
        <button type="button" className={`icon-button small app-update-trigger ${appUpdates.bannerVisible ? 'has-update' : ''}`} aria-label="Обновления приложения" data-tooltip="Обновления приложения" onClick={() => { setTabMenu(null); setShowAttention(false); setShowAppUpdates(true); }}><RefreshCw size={14} /></button>
        <button type="button" className="icon-button small" aria-label="Палитра команд" data-tooltip="Палитра команд (Ctrl+K)" onClick={() => { setTabMenu(null); setShowPalette(true); }}><Command size={15} /></button>
        <div className="workspace-attention">
          <button ref={attentionButton} type="button" className={`attention-toggle ${attentionTabs.length ? 'has-attention' : ''}`} aria-label="Требуют внимания" data-tooltip="Требуют внимания" aria-expanded={showAttention} aria-controls="attention-dialogues" onClick={() => setShowAttention(value => !value)}><Bell size={15} /><span className="attention-count">{attentionTabs.length}</span></button>
          {showAttention && <div ref={attentionMenu} id="attention-dialogues" className="attention-menu" role="region" aria-label="Диалоги, требующие внимания">
            <div className="attention-menu-heading">Требуют внимания</div>
            {!attentionTabs.length && <p className="attention-empty">Все результаты просмотрены. Ожидающих вопросов нет.</p>}
            {attentionTabs.map(tab => {
              const summary = summaries[tab.id];
              const event = attention[tab.id];
              const label = summary?.pending ? 'Ожидает вашего ответа' : event?.kind === 'error' ? 'Ошибка или потеря соединения' : event?.kind === 'completed' ? 'Новый результат' : 'Новое событие';
              return <button type="button" className={`attention-item ${summary?.pending ? 'waiting' : event?.kind === 'error' ? 'error' : 'unread'}`} key={tab.id} onClick={() => { activate(tab.id); requestAnimationFrame(() => document.getElementById(`tab-${tab.id}`)?.focus()); }}><Bell size={14} /><span><strong>{summary?.title || tab.initialThread?.name || 'Новый диалог'}</strong><small>{folderName(tab.cwd)} · {label}</small></span></button>;
            })}
          </div>}
        </div>
        <button type="button" className="icon-button small" aria-label="Настройки уведомлений" data-tooltip="Настройки уведомлений" onClick={() => { setShowAttention(false); setShowNotificationSettings(true); }}><Bell size={14} /><span aria-hidden="true">⋮</span></button>
      </div>
    </div>
    {(error || saveError) && <div className="workspace-notices">
      {error && <div className="workspace-error" role="alert"><span>{error}</span><button className="icon-button small" aria-label="Скрыть ошибку сессий" onClick={() => setError('')}><X size={14} /></button></div>}
      {saveError && <div className="workspace-error" role="alert"><span>{saveError}</span><button className="text-button" onClick={() => { saveRevision.current++; autoSave(); }}>Повторить сохранение</button></div>}
    </div>}
    <div className="workspace-views">
      {tabs.map(tab => <div className="session-view" id={`view-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} data-session-id={tab.id} hidden={activeId !== tab.id} key={tab.id}>
        {tab.archivedThread ? <ArchiveView thread={tab.archivedThread} active={activeId === tab.id} initialScrollTop={tab.scrollTop} initialScrollAnchor={tab.scrollAnchor} jump={tab.jump} workspace={controls} /> : <App bridge={tab.bridge} sessionId={tab.id} active={activeId === tab.id} initialThread={tab.initialThread} executorOf={tab.childOf} executorLabel={tab.childLabel} initialFork={tab.fork} initialDraft={tab.draft} initialAttachments={tab.attachments} initialPreservedDraft={tab.preservedDraft} initialQueue={tab.queue} initialPendingMessage={tab.pendingMessage} initialScrollTop={tab.scrollTop} initialScrollAnchor={tab.scrollAnchor} jump={tab.jump} restoreSettings={tab.restoreSettings} workspace={controls} />}
      </div>)}
      {!tabs.length && <div className="session-view folder-empty-view"><div className="app-shell panel-hidden">
        <aside className="sidebar"><div className="brand"><ProductLogo /><ProductBrand /><BuildBadge /></div><ProjectSidebar controls={controls} /><div className="sidebar-bottom"><div className="local-engine"><span className="status-dot" /><span>Локальный Codex CLI</span><span className="connection-label">OFF</span></div></div></aside>
        <main className="main-column"><div className="workspace-empty">
        {starting ? <><LoaderCircle className="spin" size={24} /><p>Открываем рабочие папки…</p></> : <>
          <MessageSquare size={32} /><h2>Откройте диалог</h2><p>Выберите рабочую папку или добавьте ещё одну.</p>
          <div className="empty-projects">{projects.map(project => <button className="secondary-button" data-tooltip={project} key={project} disabled={opening} onClick={() => void open(project)}>{folderName(project)}</button>)}</div>
          <button className="primary-button" aria-label="Выбрать папку проекта" disabled={opening} onClick={() => void open()}><FolderPlus size={16} />Выбрать папку проекта</button>
          {window.codex.setup && <button className="text-button" onClick={() => window.dispatchEvent(new Event('codex-desk:open-setup'))}>Настроить агентов</button>}
        </>}
      </div><div className="composer-area"><UpdateNotice /></div></main></div></div>}
    </div>
    {tabMenu && (() => {
      const tab = tabs.find(item => item.id === tabMenu.id);
      if (!tab) return null;
      const state = summaries[tab.id];
      const menuTitle = threadNames[state?.threadId || tab.initialThread?.id || ''] || state?.title || tab.archivedThread?.name || tab.initialThread?.name || 'Новый диалог';
      const style = { left: Math.max(8, Math.min(tabMenu.x, window.innerWidth - 300)), top: Math.max(8, Math.min(tabMenu.y, window.innerHeight - 220)) };
      return <div ref={tabMenuRef} className="tab-context-menu" role="menu" aria-label={`Вкладка: ${menuTitle}`} style={style} onKeyDown={event => {
        const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = entries.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); entries[event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus(); }
        else if (event.key === 'Tab') { setTabMenu(null); }
      }}>
        <button type="button" role="menuitem" onClick={() => { togglePin(tab.id); setTabMenu(null); }}>{tab.pinned ? <PinOff size={14} /> : <Pin size={14} />}{tab.pinned ? 'Открепить вкладку' : 'Закрепить вкладку'}</button>
        <button type="button" role="menuitem" disabled={Boolean(closeBlockedReason(tab.id))} data-tooltip={closeBlockedReason(tab.id) || undefined} onClick={() => { setTabMenu(null); requestClose(tab.id); }}><X size={14} />Закрыть вкладку</button>
        <button type="button" role="menuitem" disabled={closing || actionBusy || tabs.filter(other => other.id !== tab.id && !other.pinned).some(other => summaries[other.id]?.terminalOpen || summaries[other.id]?.busy || summaries[other.id]?.pending || summaries[other.id]?.loading) || tabs.every(other => other.id === tab.id || other.pinned)} data-tooltip="Закрываются только простаивающие незакреплённые вкладки" onClick={() => { setTabMenu(null); void closeOthers(tab.id); }}><X size={14} />Закрыть остальные</button>
        <hr />
        <button type="button" role="menuitem" disabled={!closedTabs.length || opening} onClick={() => { setTabMenu(null); restoreClosed(); }}><RotateCcw size={14} />Вернуть закрытую вкладку<kbd>Ctrl+Shift+T</kbd></button>
      </div>;
    })()}
    {showPalette && <CommandPalette onClose={() => setShowPalette(false)} commands={paletteCommands()} />}
    {confirmClose && <div className="modal-backdrop"><section className={`confirm-modal ${closeExecutor || closeChildren.length ? 'executor-close-modal' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="close-session-title">
      <h2 id="close-session-title">{closeChildren.length
        ? closeDeferred ? 'Диалог и исполнители закроются по завершении' : 'Закрыть диалог вместе с исполнителями?'
        : closeDeferred ? 'Вкладка закроется по завершении' : 'Закрыть работающий диалог?'}</h2>
      {closeChildren.length
        ? <>
          <p>Вместе с этой вкладкой закроются её исполнители: {closeGroupNames}.</p>
          {closeBusyNames && <p>Сейчас заняты: {closeBusyNames}.</p>}
          <p>{closeDeferred ? 'Можно отменить отложенное закрытие или остановить всех сейчас.' : 'Остановите всех сейчас или дождитесь завершения текущих ходов. Вопрос или запрос разрешения у любого исполнителя отменит отложенное закрытие.'} Беседы останутся в истории папки.</p>
        </>
        : <p>{closeExecutor ? closeDeferred ? 'Можно отменить отложенное закрытие или остановить исполнителя сейчас.' : 'Остановите исполнителя сейчас или дождитесь завершения текущего хода. Вопрос или запрос разрешения отменит отложенное закрытие.' : 'Выполнение в этой вкладке остановится.'} Беседа останется в истории папки.</p>}
      {confirmClose && closeBlockedReason(confirmClose) && <p role="status">{closeBlockedReason(confirmClose)}</p>}
      {error && <p className="thread-action-error" role="alert">{error}</p>}
      <div className="confirm-actions">
        <button className="secondary-button" disabled={closing} autoFocus onClick={() => setConfirmClose(null)}>Отмена</button>
        {(closeExecutor || closeChildren.length > 0) && (closeDeferred
          ? <button className="secondary-button" disabled={closing} onClick={() => { cancelCloseWait(confirmClose); setConfirmClose(null); }}>Отменить отложенное закрытие</button>
          : <button className="secondary-button" disabled={Boolean(closeBlockedReason(confirmClose) || waitBlocked)} data-tooltip={waitBlocked || undefined} onClick={() => waitAndClose(confirmClose)}>Дождаться и закрыть</button>)}
        <button className="danger-button" disabled={Boolean(closeBlockedReason(confirmClose))} onClick={() => void (closeChildren.length ? closeGroup(confirmClose) : close(confirmClose))}>Остановить и закрыть</button>
      </div>
    </section></div>}
    {confirmCloseProject && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !closing) setConfirmCloseProject(null); }}><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="close-project-title">
      <h2 id="close-project-title">Закрыть проект «{folderName(confirmCloseProject)}»?</h2>
      <p className="close-project-path">{confirmCloseProject}</p>
      <p>Проект исчезнет из списка, а его открытые вкладки закроются. Выполнение запросов остановится. Неотправленные сообщения и вложения в этих вкладках будут потеряны.</p>
      <p>Файлы и история диалогов сохранятся. Чтобы вернуться, добавьте эту папку через «Новый проект».</p>
      {error && <p className="thread-action-error" role="alert">{error}</p>}
      <div className="confirm-actions"><button className="secondary-button" disabled={closing} autoFocus onClick={() => setConfirmCloseProject(null)}>Отмена</button><button className="danger-button" disabled={closing} onClick={() => void closeProject(confirmCloseProject, true)}>{closing ? 'Закрываем…' : 'Закрыть проект'}</button></div>
    </section></div>}
    {actionDialog && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !actionBusy) setActionDialog(null); }}><form className="confirm-modal thread-action-modal" role={actionDialog.action === 'delete' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={actionDialog.action === 'rename' ? 'Переименовать диалог' : 'Удалить диалог'} onSubmit={event => { event.preventDefault(); void performAction(actionDialog.action, actionDialog.cwd, actionDialog.thread, newName); }}>
      <h2>{actionDialog.action === 'rename' ? 'Переименовать диалог' : 'Удалить диалог?'}</h2>
      {actionDialog.action === 'rename' ? <label className="thread-name-label">Название<input autoFocus aria-label="Название диалога" value={newName} maxLength={200} disabled={actionBusy} onChange={event => setNewName(event.target.value)} /></label> : <><p>«{threadNames[actionDialog.thread.id] || actionDialog.thread.name || actionDialog.thread.preview || 'Новый диалог'}» будет удалён без возможности восстановления.</p><p className="muted">Codex также удалит связанные дочерние диалоги. Файлы проекта останутся.</p></>}
      {error && <p className="thread-action-error" role="alert">{error}</p>}
      <div className="confirm-actions"><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setActionDialog(null)}>Отмена</button><button type="submit" className={actionDialog.action === 'delete' ? 'danger-button' : 'primary-button'} disabled={actionBusy || (actionDialog.action === 'rename' && !newName.trim())}>{actionBusy ? 'Выполняем…' : actionDialog.action === 'rename' ? 'Сохранить' : 'Удалить'}</button></div>
    </form></div>}
    {bulkRun && <BulkArchiveDialog run={bulkRun} busy={actionBusy} onConfirm={() => void runBulkArchive()} onStop={() => { bulkStop.current = true; }} onClose={closeBulkRun} />}
    {worktreeDialog && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !opening) setWorktreeDialog(null); }}><form className="confirm-modal thread-action-modal" role="dialog" aria-modal="true" aria-label="Новая задача в отдельной ветке" onSubmit={event => { event.preventDefault(); void openWorktree(worktreeDialog.cwd, worktreeName.trim()); }}>
      <h2>Новая задача в отдельной ветке</h2>
      <p className="muted">Git создаст ветку и отдельную рабочую копию рядом с проектом: <code>{folderName(worktreeDialog.cwd)}.worktrees/…</code>. Диалог откроется в новой вкладке в этой копии, а файлы основной папки останутся без изменений.</p>
      <label className="thread-name-label">Имя ветки и папки<input autoFocus aria-label="Имя задачи" value={worktreeName} maxLength={64} disabled={opening} placeholder="например, fix-login" onChange={event => setWorktreeName(event.target.value)} /></label>
      {error && <p className="thread-action-error" role="alert">{error}</p>}
      <div className="confirm-actions"><button type="button" className="secondary-button" disabled={opening} onClick={() => setWorktreeDialog(null)}>Отмена</button><button type="submit" className="primary-button" disabled={opening || !worktreeName.trim()}>{opening ? 'Создаём…' : 'Создать и открыть'}</button></div>
    </form></div>}
    {tasksPanel && <WorktreePanel cwd={tasksPanel.cwd} openTabs={folder => tabsRef.current.filter(tab => !tab.archivedThread && sameFolder(tab.cwd, folder)).length}
      onClose={() => setTasksPanel(null)}
      onOpen={folder => { setTasksPanel(null); void open(folder); }}
      onNewTask={() => { const cwd = tasksPanel.cwd; setTasksPanel(null); setError(''); setWorktreeName(''); setWorktreeDialog({ cwd }); }}
      onCloseTabs={async folder => { for (const tab of tabsRef.current.filter(tab => !tab.archivedThread && sameFolder(tab.cwd, folder))) await close(tab.id); }} />}
    {worktreeNotice && <div className="alert notice-alert workspace-notice" role="status"><span>{worktreeNotice}</span><button className="icon-button small" aria-label="Скрыть уведомление" data-tooltip="Скрыть" onClick={() => setWorktreeNotice('')}><X size={14} /></button></div>}
    {preparingUpdate && <div className="nightly-update-overlay" role="dialog" aria-modal="true" aria-labelledby="nightly-update-title" tabIndex={-1}><section><LoaderCircle size={24} className="spin" /><h2 id="nightly-update-title">Nightly обновляется…</h2><p>Сохраняем вкладки и перезапускаем приложение.</p></section></div>}
    {showAppUpdates && <AppUpdateDialog control={appUpdates} onClose={() => setShowAppUpdates(false)} />}
    {showReleaseNotes && <ReleaseNotesDialog control={releaseNotes} onClose={() => setShowReleaseNotes(false)} />}
    {showNotificationSettings && <NotificationSettings onClose={() => setShowNotificationSettings(false)} />}
    {showLibrary && <HistoryLibrary projects={projects} initialCwd={controls.activeCwd} onClose={() => setShowLibrary(false)} onOpen={(target: HistoryTarget) => {
      setShowLibrary(false);
      const jump = { itemId: target.itemId, turnId: target.turnId, key: Date.now(), excerpt: target.excerpt };
      if (target.archived || target.thread.archived) openArchive(target.thread, jump);
      else void open(target.cwd, target.thread, target.provider, jump);
    }} />}
    {savingBeforeClose && !preparingUpdate && <div className="nightly-update-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-save-title" tabIndex={-1}><section><LoaderCircle size={24} className="spin" /><h2 id="workspace-save-title">Сохраняем рабочее место…</h2><p>Вкладки, черновики и очередь вернутся при следующем запуске.</p></section></div>}
  </div></UpdateNoticeContext.Provider></div></OpenAppUpdatesContext.Provider>;
}
