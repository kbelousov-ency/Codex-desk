import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Archive, ArchiveRestore, Bell, BellRing, BookMarked, Command, FolderPlus, FolderTree, GitBranch, GitFork, History, LoaderCircle, MessageSquare, Pin, PinOff, Plus, RotateCcw, Terminal, X } from 'lucide-react';
import CommandPalette, { type PaletteCommand } from './CommandPalette';
import AgentLogo from './AgentLogo';
import WorktreePanel from './WorktreePanel';
import App, { type SessionSummary, type WorkspaceControls } from './App';
import { projectKey, type ProjectHistory } from './ProjectTree';
import ProjectSidebar from './ProjectSidebar';
import ArchiveView from './ArchiveView';
import { BuildBadge } from './BuildInfo';
import { errorText, folderName } from './useCodex';
import type { AgentProvider, Attachment, CodexBridge, HistoryTarget, MessageQueueState, PendingMessage, PreservedDraft, ScrollAnchor, SessionAttentionEvent, SessionInfo, Settings, Thread, ThreadAction, UpdateSnapshot, UpdateStatus, UpdateTabSnapshot } from './types';
import './nightly-update.css';
import './workspace-state.css';
import UpdateNotice, { UpdateNoticeContext } from './UpdateNotice';
import { NotificationSettings } from './NotificationSettings';
import './notifications.css';
import HistoryLibrary from './HistoryLibrary';
import SetupGate from './SetupGate';

type Tab = SessionInfo & { bridge?: CodexBridge; initialThread?: Thread; archivedThread?: Thread; draft?: string; attachments?: Attachment[]; preservedDraft?: PreservedDraft; restoreSettings?: Settings; queue?: MessageQueueState; scrollTop?: number; scrollAnchor?: ScrollAnchor; jump?: { itemId: string; turnId?: string; key: number; excerpt?: string }; pinned?: boolean; pendingMessage?: PendingMessage; fork?: { lastTurnId?: string } };
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

export default function Workspace() {
  // Keep the existing single-session fixtures useful for renderer regressions.
  if (!window.codex?.getWorkspace) return <App />;
  return <SetupGate><TabbedWorkspace /></SetupGate>;
}

function TabbedWorkspace() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [activeId, setActiveId] = useState('');
  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [histories, setHistories] = useState<Record<string, ProjectHistory>>({});
  const [starting, setStarting] = useState(true);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmCloseProject, setConfirmCloseProject] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [attention, setAttention] = useState<Record<string, SessionAttentionEvent>>({});
  const [showAttention, setShowAttention] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const focusedWindow = useRef(document.hasFocus());
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
  const previousSummaries = useRef<Record<string, SessionSummary>>({});
  tabsRef.current = tabs;
  projectsRef.current = projects;
  summariesRef.current = summaries;
  historiesRef.current = histories;
  const updateState = useRef({ activeId, starting, opening, closing, confirmClose, confirmCloseProject, actionDialog, showNotificationSettings, showLibrary, showPalette });
  updateState.current = { activeId, starting, opening, closing, confirmClose, confirmCloseProject, actionDialog, showNotificationSettings, showLibrary, showPalette };
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
    if (workspaceClosing.current || updateRequest.current || !tabsRef.current.some(tab => tab.id === id && !tab.archivedThread)) return;
    if (!focusedWindow.current || updateState.current.activeId !== id) setAttention(previous => ({ ...previous, [id]: event }));
    // Host checks actual native focus independently and suppresses visible-tab toasts.
    void window.codex.notifySession?.({ ...event, sessionId: id, title: title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160) }).catch(() => {});
  }, []);
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
    void window.codex.setNotificationContext?.({ activeSessionId: selected?.id }).catch(() => {});
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
        if (current.starting || current.opening || current.closing || current.confirmClose || current.confirmCloseProject || current.actionDialog || current.showNotificationSettings || current.showLibrary || current.showPalette || actionPending.current || pendingOpen.current) {
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

  useEffect(() => {
    for (const cwd of projects) {
      const key = projectKey(cwd);
      if (expanded[key] && !historiesRef.current[key]?.loaded && !historyRequests.current.has(key)) void loadProjectHistory(cwd);
    }
  }, [projects, expanded, loadProjectHistory]);

  useEffect(() => {
    for (const [id, summary] of Object.entries(summaries)) {
      const before = previousSummaries.current[id];
      if (summary.connection !== 'ready' || !summary.cwd) continue;
      const changed = before?.connection !== 'ready' || before?.threadId !== summary.threadId || before?.title !== summary.title || (before?.busy && !summary.busy);
      if (!changed) continue;
      const key = projectKey(summary.cwd);
      if (expanded[key]) void loadProjectHistory(summary.cwd);
      else setHistories(previous => previous[key] ? { ...previous, [key]: { ...previous[key], loaded: false } } : previous);
    }
    previousSummaries.current = summaries;
  }, [summaries, expanded, loadProjectHistory]);

  const report = useCallback((id: string, summary: SessionSummary) => {
    if (!tabsRef.current.some(tab => tab.id === id)) return;
    setSummaries(previous => ({ ...previous, [id]: summary }));
    if (summary.cwd) setTabs(previous => previous.map(tab => tab.id === id && tab.cwd !== summary.cwd ? { ...tab, cwd: summary.cwd } : tab));
    if (summary.cwd) setProjects(previous => previous.some(folder => sameFolder(folder, summary.cwd)) ? previous : [...previous, summary.cwd]);
  }, []);

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
  const open = async (cwd?: string, initialThread?: Thread, requestedProvider?: AgentProvider, jump?: Tab['jump'], options?: { fork?: Tab['fork']; restore?: UpdateTabSnapshot }): Promise<boolean> => {
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
      const tab: Tab = { ...created, initialThread, bridge: window.codex.forSession(created.id), jump, ...(options?.fork ? { fork: options.fork } : {}),
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
  const close = async (id: string) => {
    if (closingTab.current || actionPending.current || pendingOpen.current) return;
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab || summariesRef.current[id]?.terminalOpen) return;
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
      setConfirmClose(null);
    } catch (e) { setError(errorText(e)); }
    finally { closingTab.current = false; setClosing(false); }
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
    } else if (!await open(record.cwd, snapshot.thread, record.provider, undefined, { restore: snapshot })) return;
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
  const requestClose = (id: string) => {
    const state = summaries[id];
    if (state?.terminalOpen) return;
    if (state?.busy || state?.loading || state?.pending) setConfirmClose(id);
    else void close(id);
  };
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
      historyRefreshPending.current.delete(key);
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
      } else {
        // Keep failed RPCs entirely reversible in the UI. Close local views only
        // after Codex confirms the operation, including reported descendants.
        const removed = tabsRef.current.filter(tab => affected.has(tab.archivedThread?.id || summariesRef.current[tab.id]?.threadId || tab.initialThread?.id || ''));
        for (const tab of removed) if (!tab.archivedThread) {
          try { await window.codex.closeSession(tab.id); }
          catch (e) { closeError = `Операция выполнена, но соединение вкладки не закрылось: ${errorText(e)}`; }
        }
        const removedIds = new Set(removed.map(tab => tab.id));
        const remaining = tabsRef.current.filter(tab => !removedIds.has(tab.id));
        setTabs(remaining);
        setSummaries(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removedIds.has(id))));
        setActiveId(previous => removedIds.has(previous) ? remaining[0]?.id || '' : previous);
        setHistories(previous => Object.fromEntries(Object.entries(previous).map(([key, history]) => [key, { ...history, threads: history.threads.filter(item => !affected.has(item.id)) }])));
        setArchiveThreads(previous => previous.filter(item => !affected.has(item.id)));
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
      if (action !== 'rename') void loadArchive();
    } catch (e) { setError(errorText(e)); }
    finally { actionPending.current = false; setActionBusy(false); }
  };
  /** Opens a copy of `thread` as a new tab; the source dialog stays as it is. */
  const forkThread = (cwd: string, thread: Thread, lastTurnId?: string) => {
    if (pendingOpen.current || actionPending.current) return;
    if (threadLocked(thread.id)) { setError('Дождитесь завершения работы диалога перед ответвлением.'); return; }
    const provider: AgentProvider = thread.provider || (thread.id.startsWith('claude:') ? 'claude' : 'codex');
    void open(cwd, thread, provider, undefined, { fork: lastTurnId ? { lastTurnId } : {} });
  };
  const threadAction = (action: ThreadAction, cwd: string, thread: Thread) => {
    if (actionPending.current) return;
    if (action === 'fork') { forkThread(cwd, thread); return; }
    if (action === 'rename' || action === 'delete') {
      setError(''); setNewName(threadNames[thread.id] || thread.name || thread.preview || ''); setActionDialog({ action, cwd, thread });
    } else void performAction(action, cwd, thread);
  };
  useEffect(() => {
    if (!actionDialog) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !actionPending.current) setActionDialog(null); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [actionDialog]);
  const controls: WorkspaceControls = {
    openLibrary: () => setShowLibrary(true),
    projects, opening: opening || actionBusy || Boolean(confirmCloseProject) || preparingUpdate || savingBeforeClose, expanded, histories, threadNames, searchRevision,
    archiveOpen, archiveThreads, archiveLoading, archiveError, archiveCursor, actionBusy: actionBusy || Boolean(confirmCloseProject) || preparingUpdate || savingBeforeClose,
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
    forkThread, openPalette: () => setShowPalette(true),
  };
  const attentionTabs = tabs.filter(tab => !tab.archivedThread && (summaries[tab.id]?.pending || attention[tab.id]));
  /** Ctrl+K palette: switch/reopen dialogs and run workspace actions. Built on open so it reflects the current tabs. */
  const paletteCommands = (): PaletteCommand[] => {
    const active = tabs.find(tab => tab.id === activeId);
    const activeState = summaries[activeId];
    const activeCwd = activeState?.cwd || active?.cwd || projects[0] || '';
    const activeThread = activeState?.threadId ? { id: activeState.threadId, cwd: activeCwd, name: activeState.title, provider: activeState.settings.provider } : undefined;
    const busyActive = Boolean(activeState?.busy || activeState?.loading || activeState?.terminalOpen || activeState?.pending);
    const tabTitle = (tab: Tab) => { const state = summaries[tab.id]; return threadNames[state?.threadId || tab.initialThread?.id || ''] || state?.title || tab.archivedThread?.name || tab.initialThread?.name || tab.initialThread?.preview || 'Новый диалог'; };
    const commands: PaletteCommand[] = tabs.map(tab => ({
      id: `tab:${tab.id}`, group: 'Открытые вкладки', label: `${folderName(tab.cwd)} · ${tabTitle(tab)}`, hint: `${tab.cwd}${tab.pinned ? ' · закреплена' : ''}${activeId === tab.id ? ' · текущая' : ''}`, keywords: tab.cwd,
      icon: tab.archivedThread ? Archive : summaries[tab.id]?.busy ? LoaderCircle : MessageSquare, run: () => activate(tab.id),
    }));
    commands.push(
      { id: 'new-codex', group: 'Действия', label: 'Новый диалог Codex', hint: activeCwd ? folderName(activeCwd) : 'Текущая папка', icon: Plus, disabled: opening || !activeCwd, run: () => void open(activeCwd, undefined, 'codex') },
      { id: 'new-claude', group: 'Действия', label: 'Новый диалог Claude Code', hint: activeCwd ? folderName(activeCwd) : 'Текущая папка', icon: Plus, disabled: opening || !activeCwd, run: () => void open(activeCwd, undefined, 'claude') },
      { id: 'fork', group: 'Действия', label: 'Ответвить текущую беседу', hint: activeThread ? 'Копия беседы в новой вкладке. Папка и файлы общие' : 'В текущей вкладке нет диалога', icon: GitFork, disabled: !activeThread || busyActive || opening, run: () => { if (activeThread) forkThread(activeCwd, activeThread); } },
      { id: 'restore-closed', group: 'Действия', label: 'Вернуть закрытую вкладку', hint: closedTabs[0] ? `${folderName(closedTabs[0].cwd)} · ${closedTabs[0].title}` : 'Закрытых вкладок нет', shortcut: 'Ctrl+Shift+T', icon: RotateCcw, disabled: !closedTabs.length || opening, run: restoreClosed },
      { id: 'pin', group: 'Действия', label: active?.pinned ? 'Открепить текущую вкладку' : 'Закрепить текущую вкладку', icon: active?.pinned ? PinOff : Pin, disabled: !active, run: () => { if (active) togglePin(active.id); } },
      { id: 'close-tab', group: 'Действия', label: 'Закрыть текущую вкладку', icon: X, disabled: !active || closing || Boolean(activeState?.terminalOpen), run: () => { if (active) requestClose(active.id); } },
      { id: 'next-tab', group: 'Действия', label: 'Следующая вкладка', shortcut: 'Ctrl+Tab', icon: History, disabled: tabs.length < 2, run: () => cycleTab(1) },
      { id: 'worktree', group: 'Действия', label: 'Новая задача в отдельной ветке', hint: activeCwd ? folderName(activeCwd) : undefined, icon: GitBranch, disabled: !activeCwd || opening, run: () => { setError(''); setWorktreeName(''); setWorktreeDialog({ cwd: activeCwd }); } },
      { id: 'tasks', group: 'Действия', label: 'Задачи проекта…', hint: 'Список рабочих копий, перенос результата и удаление', icon: FolderTree, disabled: !activeCwd, run: () => { setError(''); setTasksPanel({ cwd: activeCwd }); } },
      { id: 'library', group: 'Действия', label: 'История и закладки', hint: 'Поиск по сообщениям Codex и Claude', icon: BookMarked, run: () => setShowLibrary(true) },
      { id: 'archive', group: 'Действия', label: archiveOpen ? 'Скрыть архив' : 'Показать архив', icon: ArchiveRestore, run: () => { setArchiveOpen(previous => !previous); if (!archiveOpen) void loadArchive(); } },
      { id: 'attention', group: 'Действия', label: 'Требуют внимания', hint: attentionTabs.length ? `${attentionTabs.length} диалог(ов)` : 'Все просмотрено', icon: BellRing, run: () => setShowAttention(true) },
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

  return <UpdateNoticeContext.Provider value={{ status: updateStatus, deciding: decidingUpdate, decide: decision => void decideUpdate(decision), dismiss: () => setUpdateStatus(null) }}><div className="workspace-shell" ref={shellRef}>
    <div className="workspace-tabs-bar">
      <div className="session-tabs" role="tablist" aria-label="Открытые диалоги">
        {tabs.map(tab => {
          const state = summaries[tab.id];
          const referenced = tab.archivedThread || tab.initialThread;
          const title = threadNames[state?.threadId || referenced?.id || ''] || state?.title || referenced?.name || referenced?.preview || 'Новый диалог';
          const status = state?.terminalOpen ? 'Открыт в терминале' : state?.pending ? 'Ожидает ответа' : state?.busy ? 'Выполняется' : state?.connection === 'error' ? 'Ошибка подключения' : 'Готов';
          const dropClass = dropTarget?.id === tab.id && dragTabId && dragTabId !== tab.id ? (dropTarget.after ? 'drop-after' : 'drop-before') : '';
          return <div className={`session-tab ${activeId === tab.id ? 'active' : ''} ${attention[tab.id] ? 'has-unread' : ''} ${tab.pinned ? 'pinned' : ''} ${dragTabId === tab.id ? 'dragging' : ''} ${dropClass}`} data-session-id={tab.id} data-pinned={tab.pinned ? 'true' : undefined} key={tab.id}
            draggable onDragStart={event => { setDragTabId(tab.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); }}
            onDragOver={event => { if (!dragTabId || dragTabId === tab.id || Boolean(tabs.find(item => item.id === dragTabId)?.pinned) !== Boolean(tab.pinned)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const box = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: tab.id, after: event.clientX > box.left + box.width / 2 }); }}
            onDragLeave={() => setDropTarget(current => current?.id === tab.id ? null : current)}
            onDrop={event => { event.preventDefault(); const from = dragTabId || event.dataTransfer.getData('text/plain'); if (from) { const box = event.currentTarget.getBoundingClientRect(); setTabs(previous => reorderTabs(previous, from, tab.id, event.clientX > box.left + box.width / 2)); } setDragTabId(null); setDropTarget(null); }}
            onDragEnd={() => { setDragTabId(null); setDropTarget(null); }}
            onContextMenu={event => { event.preventDefault(); setShowAttention(false); setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY }); }}>
            <button id={`tab-${tab.id}`} role="tab" aria-selected={activeId === tab.id} aria-controls={`view-${tab.id}`} title={`${tab.cwd}\n${title} · ${status}${tab.pinned ? ' · Закреплена' : ''}`} onClick={() => activate(tab.id)} onKeyDown={event => {
              const index = tabs.findIndex(value => value.id === tab.id);
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next >= 0) { event.preventDefault(); activate(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); }
              if (event.shiftKey && event.key === 'F10' || event.key === 'ContextMenu') { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setTabMenu({ id: tab.id, x: box.left + 12, y: box.bottom }); }
            }}>
              {tab.archivedThread ? <Archive size={13} /> : state?.terminalOpen ? <Terminal size={13} /> : state?.busy ? <LoaderCircle size={13} className="spin" /> : <AgentLogo provider={(state?.settings.provider || tab.provider) === 'claude' ? 'claude' : 'codex'} size={13} />}
              <span className="session-tab-label"><strong>{folderName(tab.cwd)}</strong><span>{title}</span></span>
              {tab.pinned && <Pin size={11} className="session-tab-pin" aria-label="Закреплена" />}
              <span className={`tab-state ${state?.pending ? 'waiting' : state?.busy ? 'running' : state?.connection === 'error' ? 'error' : ''}`} aria-label={status} />
              {attention[tab.id] && <span className="tab-unread" aria-label={attention[tab.id].kind === 'completed' ? 'Непрочитанный результат' : 'Непрочитанное событие'} title={attention[tab.id].kind === 'completed' ? 'Новый результат' : 'Требует внимания'} />}
            </button>
            {!tab.pinned && <button className="session-tab-close" aria-label={`Закрыть вкладку ${folderName(tab.cwd)}: ${title}`} title={state?.terminalOpen ? 'Сначала закройте терминал этого диалога' : 'Закрыть вкладку'} disabled={closing || actionBusy || state?.terminalOpen} onClick={() => requestClose(tab.id)}><X size={13} /></button>}
          </div>;
        })}
      </div>
      <button className="icon-button tab-add" title="Новый диалог в текущей папке" aria-label="Открыть новый диалог" disabled={opening || starting} onClick={() => void open(tabs.find(tab => tab.id === activeId)?.cwd || projects[0])}><Plus size={17} /></button>
      <div className="workspace-alert-tools">
        <button type="button" className="icon-button small" aria-label="Палитра команд" title="Палитра команд (Ctrl+K)" onClick={() => { setTabMenu(null); setShowPalette(true); }}><Command size={15} /></button>
        <div className="workspace-attention">
          <button ref={attentionButton} type="button" className={`attention-toggle ${attentionTabs.length ? 'has-attention' : ''}`} aria-label="Требуют внимания" title="Требуют внимания" aria-expanded={showAttention} aria-controls="attention-dialogues" onClick={() => setShowAttention(value => !value)}><Bell size={15} /><span className="attention-count">{attentionTabs.length}</span></button>
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
        <button type="button" className="icon-button small" aria-label="Настройки уведомлений" title="Настройки уведомлений" onClick={() => { setShowAttention(false); setShowNotificationSettings(true); }}><Bell size={14} /><span aria-hidden="true">⋮</span></button>
      </div>
    </div>
    {(error || saveError) && <div className="workspace-notices">
      {error && <div className="workspace-error" role="alert"><span>{error}</span><button className="icon-button small" aria-label="Скрыть ошибку сессий" onClick={() => setError('')}><X size={14} /></button></div>}
      {saveError && <div className="workspace-error" role="alert"><span>{saveError}</span><button className="text-button" onClick={() => { saveRevision.current++; autoSave(); }}>Повторить сохранение</button></div>}
    </div>}
    <div className="workspace-views">
      {tabs.map(tab => <div className="session-view" id={`view-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} data-session-id={tab.id} hidden={activeId !== tab.id} key={tab.id}>
        {tab.archivedThread ? <ArchiveView thread={tab.archivedThread} active={activeId === tab.id} initialScrollTop={tab.scrollTop} initialScrollAnchor={tab.scrollAnchor} jump={tab.jump} workspace={controls} /> : <App bridge={tab.bridge} sessionId={tab.id} active={activeId === tab.id} initialThread={tab.initialThread} initialFork={tab.fork} initialDraft={tab.draft} initialAttachments={tab.attachments} initialPreservedDraft={tab.preservedDraft} initialQueue={tab.queue} initialPendingMessage={tab.pendingMessage} initialScrollTop={tab.scrollTop} initialScrollAnchor={tab.scrollAnchor} jump={tab.jump} restoreSettings={tab.restoreSettings} workspace={controls} />}
      </div>)}
      {!tabs.length && <div className="session-view folder-empty-view"><div className="app-shell panel-hidden">
        <aside className="sidebar"><div className="brand"><div className="brand-mark"><Terminal size={19} strokeWidth={2.4} /></div><span>codex<span className="brand-light"> desk</span></span><BuildBadge /></div><ProjectSidebar controls={controls} /><div className="sidebar-bottom"><div className="local-engine"><span className="status-dot" /><span>Локальный Codex CLI</span><span className="connection-label">OFF</span></div></div></aside>
        <main className="main-column"><div className="workspace-empty">
        {starting ? <><LoaderCircle className="spin" size={24} /><p>Открываем рабочие папки…</p></> : <>
          <MessageSquare size={32} /><h2>Откройте диалог</h2><p>Выберите рабочую папку или добавьте ещё одну.</p>
          <div className="empty-projects">{projects.map(project => <button className="secondary-button" title={project} key={project} disabled={opening} onClick={() => void open(project)}>{folderName(project)}</button>)}</div>
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
        <button type="button" role="menuitem" disabled={closing || actionBusy || Boolean(state?.terminalOpen)} onClick={() => { setTabMenu(null); requestClose(tab.id); }}><X size={14} />Закрыть вкладку</button>
        <button type="button" role="menuitem" disabled={closing || actionBusy || tabs.filter(other => other.id !== tab.id && !other.pinned).some(other => summaries[other.id]?.terminalOpen || summaries[other.id]?.busy || summaries[other.id]?.pending || summaries[other.id]?.loading) || tabs.every(other => other.id === tab.id || other.pinned)} title="Закрываются только простаивающие незакреплённые вкладки" onClick={async () => { setTabMenu(null); for (const other of tabsRef.current.filter(other => other.id !== tab.id && !other.pinned)) { const state = summariesRef.current[other.id]; if (!state?.busy && !state?.pending && !state?.loading && !state?.terminalOpen) await close(other.id); } }}><X size={14} />Закрыть остальные</button>
        <hr />
        <button type="button" role="menuitem" disabled={!closedTabs.length || opening} onClick={() => { setTabMenu(null); restoreClosed(); }}><RotateCcw size={14} />Вернуть закрытую вкладку<kbd>Ctrl+Shift+T</kbd></button>
      </div>;
    })()}
    {showPalette && <CommandPalette onClose={() => setShowPalette(false)} commands={paletteCommands()} />}
    {confirmClose && <div className="modal-backdrop"><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="close-session-title">
      <h2 id="close-session-title">Закрыть работающий диалог?</h2><p>Выполнение в этой вкладке остановится. Беседа останется в истории папки.</p>
      <div className="confirm-actions"><button className="secondary-button" disabled={closing} autoFocus onClick={() => setConfirmClose(null)}>Отмена</button><button className="danger-button" disabled={closing} onClick={() => void close(confirmClose)}>Остановить и закрыть</button></div>
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
    {worktreeNotice && <div className="alert notice-alert workspace-notice" role="status"><span>{worktreeNotice}</span><button className="icon-button small" aria-label="Скрыть уведомление" title="Скрыть" onClick={() => setWorktreeNotice('')}><X size={14} /></button></div>}
    {preparingUpdate && <div className="nightly-update-overlay" role="dialog" aria-modal="true" aria-labelledby="nightly-update-title" tabIndex={-1}><section><LoaderCircle size={24} className="spin" /><h2 id="nightly-update-title">Nightly обновляется…</h2><p>Сохраняем вкладки и перезапускаем приложение.</p></section></div>}
    {showNotificationSettings && <NotificationSettings onClose={() => setShowNotificationSettings(false)} />}
    {showLibrary && <HistoryLibrary projects={projects} initialCwd={controls.activeCwd} onClose={() => setShowLibrary(false)} onOpen={(target: HistoryTarget) => {
      setShowLibrary(false);
      const jump = { itemId: target.itemId, turnId: target.turnId, key: Date.now(), excerpt: target.excerpt };
      if (target.archived || target.thread.archived) openArchive(target.thread, jump);
      else void open(target.cwd, target.thread, target.provider, jump);
    }} />}
    {savingBeforeClose && !preparingUpdate && <div className="nightly-update-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-save-title" tabIndex={-1}><section><LoaderCircle size={24} className="spin" /><h2 id="workspace-save-title">Сохраняем рабочее место…</h2><p>Вкладки, черновики и очередь вернутся при следующем запуске.</p></section></div>}
  </div></UpdateNoticeContext.Provider>;
}
