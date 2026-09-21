import { useCallback, useEffect, useRef, useState } from 'react';
import type { Access, AgentCapabilities, AgentDetails, AgentProvider, Attachment, CodexBridge, BridgeEvent, Item, Model, PendingMessage, Request, SessionAttentionEvent, Settings, Thread, TurnWork, SettingSources, UsageLimits } from './types';
import { agentName } from './AgentContext';
import { mergeHistoricalTurnWork, observeTurnWork } from './turn-work';
import { historicalCacheActivity, responseTime } from './cache-history';

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

const resumeErrorText = (error: unknown) => /already has an active writer/i.test(errorText(error))
  ? 'Этот диалог уже открыт для записи в другом сеансе Codex. Закройте его там и повторите подключение. Сохранённую переписку можно читать здесь.'
  : `Не удалось подключить диалог: ${errorText(error)}. Повторите подключение перед продолжением.`;

type CompactionOperation = {
  sequence: number;
  threadId: string;
  turnId: string | null;
  turnStarted: boolean;
  usageUpdated: boolean;
  previousTurns: Set<string>;
};
type InterruptedTurn = { threadId: string; turnId: string };
type AuthCompletion = { loggedIn?: boolean; error?: string; message?: string };
const STOPPED_NOTICE = 'Выполнение остановлено. Можно продолжить диалог.';
const providerCapabilities = (provider: AgentProvider): AgentCapabilities => provider === 'claude'
  ? { compact: false, steer: false, terminal: false, mcp: false, archive: false, usage: false }
  : { compact: true, steer: true, terminal: true, mcp: true, archive: true, usage: false };

export function accessParams(access: Access, cwd: string, turn = false) {
  if (access === 'inherited') return {};
  const common = { approvalPolicy: access === 'danger-full-access' ? 'never' : 'on-request', approvalsReviewer: access === 'auto' ? 'auto_review' : 'user' };
  if (!turn) return { ...common, sandbox: access === 'auto' ? 'workspace-write' : access };
  const sandboxPolicy = access === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : access === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { ...common, sandboxPolicy };
}

export function useCodex(bridge: CodexBridge = window.codex, options?: { restoreSettings?: Settings; restorePendingMessage?: PendingMessage; onAttention?(event: SessionAttentionEvent): void }) {
  const attentionCallback = useRef(options?.onAttention);
  attentionCallback.current = options?.onAttention;
  const attentionSuppressed = useRef(false);
  const attentionSeen = useRef(new Set<string>());
  const reportAttention = useCallback((kind: SessionAttentionEvent['kind'], eventId: string) => {
    const key = `${kind}:${eventId}`;
    if (attentionSeen.current.has(key)) return;
    attentionSeen.current.add(key);
    if (attentionSeen.current.size > 300) attentionSeen.current.delete(attentionSeen.current.values().next().value!);
    attentionCallback.current?.({ kind, eventId });
  }, []);
  // Restored workspace tabs keep their explicitly selected settings.
  const restoreSettingsRef = useRef(options?.restoreSettings);
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [provider, setProvider] = useState<AgentProvider>(options?.restoreSettings?.provider || 'codex');
  const providerRef = useRef<AgentProvider>(options?.restoreSettings?.provider || 'codex');
  const [capabilities, setCapabilities] = useState(() => providerCapabilities(options?.restoreSettings?.provider || 'codex'));
  const [cwd, setCwd] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [access, setAccess] = useState<Access>('workspace-write');
  const [account, setAccount] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [executable, setExecutable] = useState('');
  const [cliVersion, setCliVersion] = useState('');
  const [sources, setSources] = useState<SettingSources>({ model: 'default', effort: 'default', access: 'default' });
  const [history, setHistory] = useState<Thread[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadReady, setThreadReady] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [turnWork, setTurnWork] = useState<Record<string, TurnWork>>({});
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [authInProgress, setAuthInProgress] = useState(false);
  const authRef = useRef(false);
  const restoreAuthRef = useRef<(data: AuthCompletion) => Promise<void>>(async () => {});
  const pendingAuthRestoreRef = useRef<AuthCompletion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [interruptedTurn, setInterruptedTurn] = useState<InterruptedTurn | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [diff, setDiff] = useState('');
  const [diffTurnId, setDiffTurnId] = useState<string | undefined>();
  const [turnDiffs, setTurnDiffs] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any>(null);
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const usageRequestRef = useRef(0);
  const [agentDetails, setAgentDetails] = useState<AgentDetails | null>(null);
  const [agentDetailsLoading, setAgentDetailsLoading] = useState(false);
  const [cacheActivityAt, setCacheActivityAt] = useState<number | null>(null);
  const [cacheGeneration, setCacheGeneration] = useState(0);
  const [cacheTurnCompleted, setCacheTurnCompleted] = useState(0);
  const [queueCompletion, setQueueCompletion] = useState(0);
  const [queuePause, setQueuePause] = useState({ revision: 0, reason: '' });
  const [steering, setSteering] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(options?.restorePendingMessage || null);
  const pendingMessageRef = useRef<PendingMessage | null>(options?.restorePendingMessage || null);
  const acceptedMessagesRef = useRef(new Map<string, { turnId?: string; status?: string }>());
  const updatePendingMessage = (message: PendingMessage | null) => { pendingMessageRef.current = message; setPendingMessage(message); };
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const threadRef = useRef<Thread | null>(null);
  const interruptedRef = useRef<InterruptedTurn | null>(null);
  const resumedThreadRef = useRef<string | null>(null);
  const historyLoadSequenceRef = useRef(0);
  const turnRef = useRef<string | null>(null);
  const cwdRef = useRef('');
  const connectingRef = useRef(false);
  const activeRef = useRef(false);
  const connectionRef = useRef<'connecting' | 'ready' | 'error'>('connecting');
  const loadingRef = useRef(false);
  const resumingRef = useRef(false);
  const pendingRequestIdsRef = useRef(new Set<Request['id']>());
  const settledTurnsRef = useRef(new Set<string>());
  const cacheTurnRef = useRef<{ id: string | null; observed: boolean; suppressed: boolean }>({ id: null, observed: false, suppressed: true });
  const cacheRevisionRef = useRef(0);
  const settingsRef = useRef<Settings>({});
  const lifecycleRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const steerPendingRef = useRef(false);
  const queuePauseRevisionRef = useRef(0);
  const attachmentCacheRef = useRef(new Map<string, Promise<string | null>>());
  const turnHistoryRef = useRef<{ cursor: string | null; known: Set<string> }>({ cursor: null, known: new Set() });
  const compactionRef = useRef<CompactionOperation | null>(null);
  const terminalRef = useRef<{ threadId: string; state: 'opening' | 'open' | 'restoring' } | null>(null);
  const restoreTerminalRef = useRef<(data: { threadId: string; error?: string }) => Promise<void>>(async () => {});
  const updateInterrupted = useCallback((value: InterruptedTurn | null) => {
    interruptedRef.current = value; setInterruptedTurn(value);
  }, []);
  const pauseQueue = useCallback((reason: string) => {
    const revision = ++queuePauseRevisionRef.current;
    setQueuePause({ revision, reason });
  }, []);

  const observeTurn = useCallback((turn: any) => {
    const observedAt = Date.now();
    setTurnWork(current => {
      const work = observeTurnWork(current[turn.id], turn, observedAt);
      return work ? { ...current, [work.id]: work } : current;
    });
  }, []);

  const hydrateTurns = useCallback((turns: any[]) => {
    for (const turn of turns) if (turn.id) {
      turnHistoryRef.current.known.add(turn.id);
      if (turn.id !== turnRef.current && ['completed', 'failed', 'interrupted'].includes(turn.status)) settledTurnsRef.current.add(turn.id);
    }
    setTurnWork(current => mergeHistoricalTurnWork(current, turns));
  }, []);

  const hydrateEarlierTurns = useCallback(async (threadId: string, loaded: Item[]) => {
    const required = loaded.flatMap(item => item.turnId ? [item.turnId] : []);
    const pagination = turnHistoryRef.current;
    // Follow metadata pages only for the items the user has actually loaded.
    // Bound each operation if a server returns inconsistent cursors/turn IDs.
    for (let pageIndex = 0; pageIndex < 5 && pagination.cursor && required.some(id => !pagination.known.has(id)); pageIndex++) {
      const cursor = pagination.cursor;
      const page = await bridge.request('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (threadRef.current?.id !== threadId || turnHistoryRef.current !== pagination) return;
      pagination.cursor = page.nextCursor === cursor ? null : page.nextCursor ?? null;
      hydrateTurns(page.data || []);
    }
  }, [bridge, hydrateTurns]);

  const updateConnection = useCallback((value: 'connecting' | 'ready' | 'error') => {
    connectionRef.current = value; setConnection(value);
  }, []);
  const updateLoading = useCallback((value: boolean) => {
    loadingRef.current = value; setLoading(value);
  }, []);
  const invalidateCache = useCallback(() => {
    cacheRevisionRef.current++;
    cacheTurnRef.current.suppressed = true;
    setCacheActivityAt(null); setCacheGeneration(value => value + 1);
  }, []);
  const finishCompaction = useCallback((operation: CompactionOperation, status: 'completed' | 'failed' | 'interrupted', message?: string) => {
    if (compactionRef.current !== operation || operation.sequence !== sendSequenceRef.current || operation.threadId !== threadRef.current?.id) return;
    compactionRef.current = null;
    setCompacting(false); activeRef.current = false; turnRef.current = null; setBusy(false);
    lifecycleRef.current++;
    if (operation.turnId) {
      settledTurnsRef.current.add(operation.turnId);
      cacheTurnRef.current.id = operation.turnId;
      observeTurn({ id: operation.turnId, status });
    }
    pendingRequestIdsRef.current.clear(); setRequests([]);
    if (status === 'completed') {
      // A previous request's input is not a measurement of the compacted
      // context. Keep cumulative counters, and await real new usage data.
      if (!operation.usageUpdated) setTokens((previous: any) => previous ? { ...previous, last: null } : previous);
      setNotice('Контекст сжат. Можно продолжить диалог.');
    } else if (status === 'interrupted') {
      setNotice('Сжатие контекста остановлено. Можно продолжить диалог.');
    } else {
      setNotice(''); setError(message || 'Не удалось сжать контекст. Можно повторить команду.');
    }
  }, [observeTurn]);
  const matchCompactionTurn = useCallback((turnId: unknown) => {
    const operation = compactionRef.current;
    if (!operation || typeof turnId !== 'string' || !turnId || operation.previousTurns.has(turnId) || settledTurnsRef.current.has(turnId)) return null;
    if (operation.turnId && operation.turnId !== turnId) return null;
    operation.turnId = turnId;
    turnRef.current = turnId; cacheTurnRef.current.id = turnId;
    return operation;
  }, []);
  const observeModelResponse = useCallback((turnId: string | undefined, liveDelta = false) => {
    if (!turnId || connectionRef.current !== 'ready' || cacheTurnRef.current.suppressed) return;
    if ((!activeRef.current && !resumingRef.current) || settledTurnsRef.current.has(turnId)) return;
    const expected = turnRef.current || cacheTurnRef.current.id;
    if (expected && expected !== turnId) return;
    // Usage snapshots and completed items can be replayed while attaching history.
    // A streaming delta, unlike a snapshot, demonstrates a new model response.
    if (resumingRef.current && !cacheTurnRef.current.observed && !liveDelta) return;
    if (!expected && !resumingRef.current) return;
    cacheTurnRef.current.id = turnId; cacheTurnRef.current.observed = true;
    cacheRevisionRef.current++;
    setCacheActivityAt(Date.now());
  }, []);

  const restorePreviews = useCallback((loaded: Item[], threadId: string) => {
    void Promise.all(loaded.filter(item => item.type === 'userMessage' && !item.previews?.length).map(async item => {
      const images = (item.content || []).filter((part: any) => ['image', 'localImage'].includes(part.type));
      if (!images.length) return null;
      const previews = await Promise.all(images.map(async (part: any) => {
        let dataUrl = part.url?.startsWith('data:') ? part.url : undefined;
        if (part.path && bridge.readAttachment) {
          if (!attachmentCacheRef.current.has(part.path)) attachmentCacheRef.current.set(part.path, bridge.readAttachment(part.path).catch(() => null));
          dataUrl = await attachmentCacheRef.current.get(part.path) || undefined;
        }
        return { name: part.path ? folderName(part.path) : 'Изображение', path: part.path, dataUrl };
      }));
      return { id: item.id, previews };
    })).then(restored => {
      if (threadRef.current?.id !== threadId) return;
      const previews = new Map(restored.filter(value => value !== null).map(value => [value.id, value.previews]));
      setItems(previous => previous.map(item => previews.has(item.id) && !item.previews?.length ? { ...item, previews: previews.get(item.id) } : item));
    });
  }, [bridge]);

  const saveSettings = useCallback(async (partial: Partial<Settings>) => {
    settingsRef.current = { ...settingsRef.current, ...partial };
    await bridge.setSettings(partial).catch(e => setError(errorText(e)));
  }, [bridge]);

  /** Plan rate limits (Claude only). Never throws: an unavailable answer is shown as a plain label. */
  /** Skills/commands, subagents and MCP status of the connected Claude CLI (read-only control requests). */
  const refreshAgentDetails = useCallback(async () => {
    if (providerRef.current !== 'claude' || connectionRef.current !== 'ready' || terminalRef.current) return;
    setAgentDetailsLoading(true);
    try { const result = await bridge.request('agent/capabilities', {}); if (result && typeof result === 'object') setAgentDetails(result as AgentDetails); }
    catch (e) { setAgentDetails({ commands: [], agents: [], mcpServers: null, mcpError: errorText(e) }); }
    finally { setAgentDetailsLoading(false); }
  }, [bridge]);

  const refreshUsage = useCallback(async () => {
    if (providerRef.current !== 'claude' || connectionRef.current !== 'ready' || terminalRef.current) return;
    const sequence = ++usageRequestRef.current;
    setUsageLoading(true);
    try {
      const result = await bridge.request('usage/read', {});
      if (sequence === usageRequestRef.current && result && typeof result === 'object') setUsage({ available: Boolean(result.available), subscription: result.subscription ?? null, windows: Array.isArray(result.windows) ? result.windows : [], updatedAt: result.updatedAt, message: result.message });
    } catch (e) {
      if (sequence === usageRequestRef.current) setUsage({ available: false, windows: [], message: errorText(e) });
    } finally { if (sequence === usageRequestRef.current) setUsageLoading(false); }
  }, [bridge]);

  const refreshHistory = useCallback(async (path = cwdRef.current, cursor?: string) => {
    if (terminalRef.current || authRef.current || !path) return;
    setHistoryLoading(true);
    try {
      const result = await bridge.request('thread/list', { cwd: path, limit: 40, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], ...(cursor ? { cursor } : {}) });
      if (path !== cwdRef.current) return;
      setHistory(previous => cursor ? [...previous, ...result.data.filter((t: Thread) => !previous.some(p => p.id === t.id))] : result.data || []);
      setHistoryCursor(result.nextCursor ?? null);
    } catch (e) { if (!terminalRef.current && !authRef.current) setError(`Не удалось загрузить историю: ${errorText(e)}`); }
    finally { setHistoryLoading(false); }
  }, [bridge]);

  const clearThread = useCallback((preservePending = false) => {
    if (terminalRef.current || authRef.current) return;
    if (pendingMessageRef.current && !preservePending) { setNotice('Проверьте неподтверждённую отправку перед сменой диалога.'); return; }
    attentionSuppressed.current = false;
    pauseQueue('Диалог отключён. Откройте прежний диалог перед продолжением очереди.');
    updateInterrupted(null);
    historyLoadSequenceRef.current++;
    resumedThreadRef.current = null; setThreadReady(false);
    lifecycleRef.current++; sendSequenceRef.current++;
    compactionRef.current = null; setCompacting(false);
    invalidateCache(); settledTurnsRef.current.clear();
    cacheTurnRef.current = { id: null, observed: false, suppressed: true };
    pendingRequestIdsRef.current.clear();
    turnHistoryRef.current = { cursor: null, known: new Set() };
    threadRef.current = null; turnRef.current = null; activeRef.current = false;
    if (!preservePending) { pendingMessageRef.current = null; setPendingMessage(null); }
    acceptedMessagesRef.current.clear();
    setThread(null); setItems([]); setTurnWork({}); setDiff(''); setDiffTurnId(undefined); setTurnDiffs({}); setPlan([]); setRequests([]); setItemCursor(null); setTokens(null); setBusy(false); setError('');
  }, [invalidateCache, updateInterrupted, pauseQueue]);

  const detachThread = useCallback(() => {
    if (terminalRef.current) return;
    attentionSuppressed.current = false;
    pauseQueue('Соединение восстанавливается. Проверьте историю перед продолжением очереди.');
    updateInterrupted(null);
    historyLoadSequenceRef.current++;
    resumedThreadRef.current = null; setThreadReady(false);
    lifecycleRef.current++; sendSequenceRef.current++;
    compactionRef.current = null; setCompacting(false);
    invalidateCache(); settledTurnsRef.current.clear();
    cacheTurnRef.current = { id: null, observed: false, suppressed: true };
    pendingRequestIdsRef.current.clear(); setRequests([]);
    turnRef.current = null; activeRef.current = false; setBusy(false);
    setTurnWork(current => Object.fromEntries(Object.entries(current).map(([id, work]) => [id, work.status === 'inProgress' ? { ...work, status: 'disconnected' } : work])));
  }, [invalidateCache, updateInterrupted, pauseQueue]);

  const connect = useCallback(async (directory?: string, options?: { keepThread?: boolean }) => {
    if (connectingRef.current || terminalRef.current || authRef.current) return;
    if (directory && pendingMessageRef.current) { setNotice('Проверьте неподтверждённую отправку перед сменой папки.'); return; }
    connectingRef.current = true;
    if (compactionRef.current) {
      compactionRef.current = null; setCompacting(false);
      lifecycleRef.current++; sendSequenceRef.current++;
      activeRef.current = false; turnRef.current = null; setBusy(false);
    }
    invalidateCache(); updateConnection('connecting'); setError('');
    try {
      if (!bridge) throw new Error('Откройте Codex Desk как приложение: npm start. Подключение к Codex доступно в окне Electron.');
      const saved = await bridge.getSettings();
      settingsRef.current = saved;
      providerRef.current = saved.provider || 'codex'; setProvider(providerRef.current);
      setCapabilities(providerCapabilities(providerRef.current));
      const result = await bridge.start(directory ? { cwd: directory } : saved.cwd ? { cwd: saved.cwd } : undefined);
      providerRef.current = result.provider || saved.provider || 'codex'; setProvider(providerRef.current);
      setCapabilities({ ...providerCapabilities(providerRef.current), ...result.capabilities });
      const effective = result.config?.config || result.config || {};
      cwdRef.current = result.cwd; setCwd(result.cwd);
      const visibleModels = (Array.isArray(result.models) ? result.models : (result.models as any)?.data || []).filter((m: Model) => !m.hidden);
      setModels(visibleModels); setConfig(effective); setExecutable(result.executable);
      setCliVersion(typeof result.cliVersion === 'string' ? result.cliVersion : '');
      setAccount(result.account?.account ?? result.account);
      const restored = restoreSettingsRef.current;
      setModel(restored?.model ?? (saved.model || effective.model || visibleModels.find((m: Model) => m.isDefault)?.model || ''));
      setEffort(restored?.effort ?? (saved.effort || effective.model_reasoning_effort || ''));
      // New sessions start with manual approvals. Preserve explicit legacy modes;
      // remembered full access still requires selection and confirmation here.
      setAccess(restored?.access ?? (saved.access === 'danger-full-access' ? 'workspace-write' : saved.access || 'workspace-write'));
      setSources({
        model: restored?.model ? 'tab' : saved.model ? 'saved' : effective.model ? 'cli' : 'default',
        effort: restored?.effort ? 'tab' : saved.effort ? 'saved' : effective.model_reasoning_effort ? 'cli' : 'default',
        access: restored?.access ? 'tab' : saved.access && saved.access !== 'danger-full-access' ? 'saved' : 'default',
      });
      restoreSettingsRef.current = undefined;
      updateConnection('ready');
      if (options?.keepThread && threadRef.current) detachThread(); else clearThread(!directory && Boolean(pendingMessageRef.current));
      await saveSettings({ cwd: result.cwd });
      await refreshHistory(result.cwd);
      setUsage(null); setAgentDetails(null); if (providerRef.current === 'claude' && result.capabilities?.usage !== false) void refreshUsage();
    } catch (e) { if (!authRef.current) { invalidateCache(); updateConnection('error'); setError(errorText(e)); } }
    finally {
      connectingRef.current = false;
      const pending = pendingAuthRestoreRef.current;
      pendingAuthRestoreRef.current = null;
      if (pending) void restoreAuthRef.current(pending);
    }
  }, [bridge, clearThread, detachThread, refreshHistory, refreshUsage, saveSettings, invalidateCache, updateConnection]);
  void refreshAgentDetails; // declared above for the settings dialog

  useEffect(() => {
    if (!bridge) { void connect(); return; }
    const upsert = (id: string, patch: Partial<Item> | ((item: Item) => Item), type = 'agentMessage') => {
      setItems(previous => {
        const index = previous.findIndex(item => item.id === id);
        const old = index < 0 ? { id, type } : previous[index];
        const next = typeof patch === 'function' ? patch(old) : { ...old, ...patch };
        if (index < 0) return [...previous, next];
        const copy = [...previous]; copy[index] = next; return copy;
      });
    };
    const unsubscribe = bridge.onEvent((event: BridgeEvent) => {
      const data = event.data;
      if (event.type === 'auth') {
        if (providerRef.current !== (data.provider || 'claude')) return;
        if (data.state === 'opened') {
          if (authRef.current) return;
          detachThread();
          authRef.current = true; setAuthInProgress(true);
          updateConnection('connecting'); setError('');
          pauseQueue('Изменяются настройки агента. Проверьте диалог перед продолжением очереди.');
          setNotice(data.message || `Завершите вход в ${providerRef.current === 'claude' ? 'Claude' : 'Codex'} в браузере и окне авторизации.`);
        } else if (data.state === 'closed') {
          authRef.current = false; setAuthInProgress(false);
          void restoreAuthRef.current(data);
        }
        return;
      }
      if (event.type === 'mcp') { invalidateCache(); return; }
      if (event.type === 'terminal') {
        const operation = terminalRef.current;
        if (!operation || operation.threadId !== data.threadId) return;
        if (data.state === 'opened' && operation.state === 'opening') {
          operation.state = 'open';
          setNotice('Диалог открыт в терминале. После его закрытия история обновится.');
        } else if (data.state === 'closed' && operation.state !== 'restoring') void restoreTerminalRef.current(data);
        return;
      }
      if (terminalRef.current || authRef.current) return;
      if (event.type === 'diagnostic') {
        const message = typeof data === 'string' ? data : data.message || JSON.stringify(data);
        setDiagnostics(p => [...p.slice(-79), message]); return;
      }
      if (event.type === 'status') {
        const status = typeof data === 'string' ? data : data.state ?? data.status;
        if (['disconnected', 'stopped', 'error', 'exited'].includes(status)) {
          if (connectionRef.current === 'ready') reportAttention('error', `connection:${lifecycleRef.current}`);
          pauseQueue('Соединение прервано. Проверьте историю перед продолжением очереди.');
          updateInterrupted(null);
          historyLoadSequenceRef.current++;
          resumedThreadRef.current = null; setThreadReady(false);
          resumingRef.current = false; updateLoading(false);
          setTurnWork(current => Object.fromEntries(Object.entries(current).map(([id, work]) => [id, work.status === 'inProgress' ? { ...work, status: 'disconnected' } : work])));
          lifecycleRef.current++; sendSequenceRef.current++; invalidateCache(); updateConnection('error');
          compactionRef.current = null; setCompacting(false); setNotice('');
          setBusy(false); activeRef.current = false; turnRef.current = null;
          pendingRequestIdsRef.current.clear(); setRequests([]);
          setError(data.message || `Соединение с ${agentName(providerRef.current)} прервано. Подключитесь снова, затем откройте диалог из истории.`);
        }
        return;
      }
      if (event.type === 'serverRequest') {
        if (data.params?.threadId && data.params.threadId !== threadRef.current?.id) return;
        const kind = ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(data.method) ? 'question'
          : ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'applyPatchApproval', 'execCommandApproval'].includes(data.method) ? 'approval' : null;
        if (kind && !pendingRequestIdsRef.current.has(data.id)) reportAttention(kind, `${threadRef.current?.id || ''}:${data.params?.turnId || ''}:${data.id}`);
        pendingRequestIdsRef.current.add(data.id);
        setRequests(previous => previous.some(r => r.id === data.id) ? previous : [...previous, data]); return;
      }
      const { method, params: p = {} } = data;
      if (p.threadId && p.threadId !== threadRef.current?.id) return;
      if (method === 'message/receipt') {
        if (p.accepted && p.clientUserMessageId) acceptedMessagesRef.current.set(p.clientUserMessageId, { turnId: p.turnId, status: p.status });
        return;
      }
      if (method === 'turn/started') {
        if (connectionRef.current !== 'ready' || !p.turn?.id) return;
        if (settledTurnsRef.current.has(p.turn.id)) return;
        if (activeRef.current && turnRef.current && turnRef.current !== p.turn.id) return;
        if (!activeRef.current) attentionSuppressed.current = false;
        updateInterrupted(null);
        if (compactionRef.current) {
          const operation = matchCompactionTurn(p.turn.id);
          if (!operation) return;
          operation.turnStarted = true;
        }
        observeTurn({ ...p.turn, status: 'inProgress' });
        const observed = cacheTurnRef.current.id === p.turn.id && cacheTurnRef.current.observed;
        const suppressed = activeRef.current ? cacheTurnRef.current.suppressed : false;
        cacheTurnRef.current = { id: p.turn.id, observed, suppressed };
        lifecycleRef.current++;
        turnRef.current = p.turn.id; activeRef.current = true; setBusy(true); setDiff(''); setDiffTurnId(p.turn.id); setPlan([]);
      } else if (method === 'turn/completed') {
        const turnId = p.turn?.id;
        if (providerRef.current === 'claude') void refreshUsage();
        if (compactionRef.current) {
          const operation = matchCompactionTurn(turnId);
          if (!operation) return;
          observeTurn(p.turn);
          finishCompaction(operation, p.turn.status === 'interrupted' ? 'interrupted' : p.turn.status === 'completed' && !p.turn.error ? 'completed' : 'failed', p.turn.error?.message);
          void refreshHistory();
          return;
        }
        const expected = turnRef.current || cacheTurnRef.current.id;
        if (!turnId || settledTurnsRef.current.has(turnId) || (expected ? expected !== turnId : !activeRef.current && !resumingRef.current)) return;
        // A completion snapshot alone does not prove new work during attachment.
        // The loaded latest turn must win over replayed completions of older turns.
        if (resumingRef.current && !activeRef.current && !cacheTurnRef.current.observed) return;
        observeTurn(p.turn);
        lifecycleRef.current++;
        settledTurnsRef.current.add(turnId);
        if (!resumingRef.current && activeRef.current && connectionRef.current === 'ready' && !attentionSuppressed.current) {
          if (p.turn.status === 'completed' && !p.turn.error) reportAttention('completed', `turn:${turnId}`);
          else if (p.turn.error || p.turn.status === 'failed') reportAttention('error', `turn:${turnId}`);
        }
        if (p.turn.status === 'completed' && !p.turn.error) {
          if (!resumingRef.current && connectionRef.current === 'ready') setQueueCompletion(value => value + 1);
          if (!cacheTurnRef.current.suppressed && connectionRef.current === 'ready') {
            if (!cacheTurnRef.current.observed) {
              const at = resumingRef.current
                ? historicalCacheActivity([p.turn], [], false, Date.now())
                : responseTime(p.turn.completedAt, Date.now());
              // A replayed completion on resume must not restart the countdown.
              setCacheActivityAt(at ?? (p.turn.completedAt == null && !resumingRef.current ? Date.now() : null));
            }
            cacheRevisionRef.current++;
            setCacheTurnCompleted(value => value + 1);
          }
        } else {
          pauseQueue(p.turn.status === 'interrupted' ? 'Выполнение остановлено.' : 'Задача завершилась с ошибкой.');
          invalidateCache();
        }
        cacheTurnRef.current.id = turnId;
        turnRef.current = null; activeRef.current = false; setBusy(false);
        pendingRequestIdsRef.current.clear(); setRequests([]);
        if (p.turn.error) setError(p.turn.error.message || `${agentName(providerRef.current)} завершил работу с ошибкой.`);
        if (p.turn.status === 'interrupted' && threadRef.current) {
          updateInterrupted({ threadId: threadRef.current.id, turnId }); setNotice(STOPPED_NOTICE);
        } else updateInterrupted(null);
        void refreshHistory();
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = p.item;
        if (!item?.id) return;
        if (item.type === 'contextCompaction' && compactionRef.current) {
          const operation = matchCompactionTurn(p.turnId);
          if (!operation) return;
          upsert(item.id, { ...item, turnId: p.turnId, complete: method === 'item/completed' });
          // Older servers can report only the compaction item. If they emitted
          // turn/started, keep the lock until that turn actually completes.
          if (method === 'item/completed' && !operation.turnStarted) {
            finishCompaction(operation, 'completed');
            void refreshHistory();
          }
          return;
        }
        if (item.type === 'agentMessage' && item.phase === 'final_answer' && p.turnId) {
          const answerStartedAt = Date.now();
          setTurnWork(current => {
            const previous = current[p.turnId];
            return { ...current, [p.turnId]: { ...(previous || { id: p.turnId, status: 'inProgress' }), answerStartedAt: previous?.answerStartedAt ?? answerStartedAt } };
          });
        }
        if (method === 'item/completed' && ['agentMessage', 'reasoning', 'plan'].includes(item.type)) observeModelResponse(p.turnId);
        if (item.type === 'userMessage') {
          for (const id of [item.clientId, item.clientUserMessageId, item.id].filter(Boolean)) acceptedMessagesRef.current.set(id, { turnId: p.turnId });
          setItems(previous => {
            const clientId = item.clientId || item.clientUserMessageId;
            const contentKey = (content: any[]) => JSON.stringify(content.map(part => part.type === 'text' ? ['text', part.text] : [part.type, part.path || part.url]));
            const optimistic = previous.find(i => i.optimistic && (clientId ? i.clientId === clientId : (!i.turnId || i.turnId === p.turnId) && contentKey(i.content || []) === contentKey(item.content || [])));
            const existing = previous.find(i => i.id === item.id);
            const next = { ...existing, ...item, previews: existing?.previews || optimistic?.previews, optimistic: false, turnId: p.turnId, complete: method === 'item/completed' };
            const remaining = previous.filter(i => i.id !== optimistic?.id);
            const index = remaining.findIndex(i => i.id === item.id);
            if (index < 0) return [...remaining, next];
            return remaining.map((value, i) => i === index ? next : value);
          });
          restorePreviews([item], p.threadId);
        } else upsert(item.id, { ...item, turnId: p.turnId, complete: method === 'item/completed' });
      } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
        if (p.delta) observeModelResponse(p.turnId, true);
        upsert(p.itemId, item => ({ ...item, text: (item.text || '') + p.delta, turnId: p.turnId }), method.includes('/plan/') ? 'plan' : 'agentMessage');
      } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
        if (p.delta) observeModelResponse(p.turnId, true);
        const key = method.includes('summary') ? 'summary' : 'content';
        const index = p.summaryIndex ?? p.contentIndex ?? 0;
        upsert(p.itemId, item => { const parts = [...(item[key] || [])]; parts[index] = (parts[index] || '') + p.delta; return { ...item, [key]: parts, turnId: p.turnId }; }, 'reasoning');
      } else if (method === 'item/commandExecution/outputDelta') {
        upsert(p.itemId, item => ({ ...item, aggregatedOutput: (item.aggregatedOutput || '') + p.delta, turnId: p.turnId || item.turnId }), 'commandExecution');
      } else if (method === 'item/fileChange/patchUpdated') {
        upsert(p.itemId, item => ({ ...item, changes: p.changes, turnId: p.turnId || item.turnId }), 'fileChange');
      } else if (method === 'turn/diff/updated') {
        const id = p.turnId || turnRef.current || cacheTurnRef.current.id;
        if (id && typeof p.diff === 'string') setTurnDiffs(previous => ({ ...previous, [id]: p.diff }));
        const latest = turnRef.current || cacheTurnRef.current.id;
        if (!p.turnId || !latest || p.turnId === latest) { setDiff(p.diff || ''); setDiffTurnId(id || undefined); }
      }
      else if (method === 'turn/plan/updated') setPlan(p.plan || []);
      else if (method === 'thread/tokenUsage/updated') {
        if (compactionRef.current) {
          const operation = matchCompactionTurn(p.turnId);
          if (!operation) return;
          operation.usageUpdated = true;
        }
        const expected = turnRef.current || cacheTurnRef.current.id;
        if (!p.turnId || (expected && expected !== p.turnId) || (!expected && !activeRef.current && !resumingRef.current)) return;
        if (settledTurnsRef.current.has(p.turnId) && (activeRef.current || p.turnId !== cacheTurnRef.current.id)) return;
        setTokens(p.tokenUsage);
        if (p.tokenUsage?.last) observeModelResponse(p.turnId);
      }
      else if (method === 'thread/compacted' && compactionRef.current) {
        const operation = matchCompactionTurn(p.turnId);
        if (operation && !operation.turnStarted) {
          finishCompaction(operation, 'completed');
          void refreshHistory();
        }
      }
      else if (method === 'usage/updated' && p.window?.key) {
        setUsage(previous => {
          const windows = [...(previous?.windows || [])];
          const index = windows.findIndex(window => window.key === p.window.key);
          if (index >= 0) windows[index] = p.window; else windows.push(p.window);
          return { available: true, subscription: previous?.subscription ?? null, windows, updatedAt: new Date().toISOString() };
        });
      }
      else if (method === 'serverRequest/resolved') {
        pendingRequestIdsRef.current.delete(p.requestId ?? p.id);
        setRequests(previous => previous.filter(r => r.id !== (p.requestId ?? p.id)));
      }
      else if (method === 'error') {
        const expected = turnRef.current || cacheTurnRef.current.id;
        if (p.turnId && ((expected && expected !== p.turnId) || settledTurnsRef.current.has(p.turnId))) return;
        if (p.willRetry !== true) invalidateCache();
        if (p.willRetry !== true && !resumingRef.current && !attentionSuppressed.current) reportAttention('error', `turn:${p.turnId || expected || lifecycleRef.current}`);
        pauseQueue(`${agentName(providerRef.current)} сообщил об ошибке. Проверьте результат перед продолжением очереди.`);
        if (compactionRef.current && p.willRetry !== true) {
          const operation = p.turnId ? matchCompactionTurn(p.turnId) : compactionRef.current;
          if (!operation) return;
          finishCompaction(operation, 'failed', p.error?.message || p.message || 'Ошибка сжатия контекста.');
        }
        setError(p.error?.message || p.message || `Ошибка ${agentName(providerRef.current)}`);
      } else if (method === 'configWarning' || method === 'deprecationNotice' || method === 'model/rerouted') {
        if (method === 'model/rerouted') invalidateCache();
        setNotice(p.message || p.reason || `${agentName(providerRef.current)} обновил параметры текущего сеанса.`);
      }
    });
    void connect();
    return unsubscribe;
  }, [bridge, connect, detachThread, refreshHistory, restorePreviews, invalidateCache, observeModelResponse, updateConnection, updateLoading, observeTurn, matchCompactionTurn, finishCompaction, updateInterrupted, pauseQueue, reportAttention]);

  const selectDirectory = async () => {
    if (terminalRef.current || authRef.current || busy || loading) return;
    try { const selected = await bridge.chooseDirectory(); if (selected && selected !== cwd) await connect(selected); }
    catch (e) { setError(errorText(e)); }
  };

  const selectExecutable = async () => {
    if (terminalRef.current || authRef.current || pendingMessageRef.current) return;
    try {
      const path = await bridge.chooseExecutable();
      if (path) { await saveSettings({ executable: path }); await connect(); }
    } catch (e) { setError(errorText(e)); }
  };

  const selectModel = (value: string) => {
    if (terminalRef.current || authRef.current) return;
    const selected = models.find(m => m.model === value);
    const nextEffort = selected?.supportedReasoningEfforts.some(e => e.reasoningEffort === effort) ? effort : selected?.defaultReasoningEffort || '';
    if (value !== model || nextEffort !== effort) invalidateCache();
    setModel(value); setEffort(nextEffort); setSources(previous => ({ ...previous, model: 'selected', effort: 'selected' })); void saveSettings({ model: value, effort: nextEffort });
  };
  const selectEffort = (value: string) => { if (terminalRef.current || authRef.current) return; if (value !== effort) invalidateCache(); setEffort(value); setSources(previous => ({ ...previous, effort: 'selected' })); void saveSettings({ effort: value }); };
  const selectAccess = (value: Access) => {
    if (terminalRef.current || authRef.current || pendingMessageRef.current) return;
    if (value !== access) invalidateCache();
    if (value === 'inherited' && access !== 'inherited' && thread) {
      clearThread(); setNotice(`Открыт новый диалог: доступ будет взят из конфигурации ${agentName(providerRef.current)}. Предыдущий диалог сохранён в истории.`);
    }
    setAccess(value); setSources(previous => ({ ...previous, access: 'selected' })); void saveSettings({ access: value });
  };

  /** `fork` opens a copy of `selected` as a new thread (App Server `thread/fork`, Claude SDK forkSession) in this tab. */
  const resume = async (selected: Thread, preserveSettings = false, fork?: { lastTurnId?: string; title?: string }) => {
    if (pendingMessageRef.current && (fork || pendingMessageRef.current.threadId !== selected.id)) { setNotice('Проверьте неподтверждённую отправку перед сменой диалога.'); return false; }
    if (terminalRef.current || activeRef.current || loadingRef.current || connectionRef.current !== 'ready') return false;
    if ((selected.provider || 'codex') !== providerRef.current) { setError('Этот диалог принадлежит другому агенту. Откройте его в отдельной вкладке.'); return false; }
    updateInterrupted(null);
    updateLoading(true); setError(''); setNotice('');
    const sameThread = threadRef.current?.id === selected.id;
    if (!sameThread) clearThread(pendingMessageRef.current?.threadId === selected.id);
    else invalidateCache();
    threadRef.current = selected; setThread(selected);
    resumedThreadRef.current = null; setThreadReady(false);
    resumingRef.current = true;
    turnHistoryRef.current = { cursor: null, known: new Set() };
    cacheTurnRef.current = { id: null, observed: false, suppressed: false };
    const lifecycle = lifecycleRef.current;
    const cacheRevision = cacheRevisionRef.current;
    const sequence = ++historyLoadSequenceRef.current;
    const previousItems = new Map((sameThread ? items : []).map(item => [item.id, item]));
    let expectedId = selected.id;
    const isCurrent = () => historyLoadSequenceRef.current === sequence && threadRef.current?.id === expectedId && connectionRef.current === 'ready';
    const showHistory = (turns: any[], loaded: Item[]) => {
      hydrateTurns(turns);
      // Events can arrive during resume or paging; retain newer streamed items.
      setItems(current => {
        const streamed = new Map(current.map(item => [item.id, item]));
        const loadedIds = new Set(loaded.map(item => item.id));
        // A retry may replace a full read with only the latest page. Older
        // already-visible history stays before that page; new live items after it.
        const retained = current.filter(item => !loadedIds.has(item.id));
        return [...retained.filter(item => previousItems.has(item.id)), ...loaded.map(item => {
          const live = streamed.get(item.id);
          return live && live !== previousItems.get(item.id) ? { ...item, ...live } : { ...item, ...(live?.previews ? { previews: live.previews } : {}) };
        }), ...retained.filter(item => !previousItems.has(item.id))];
      });
      restorePreviews(loaded, selected.id);
    };
    const turnItems = (turns: any[]) => turns.flatMap((t: any) => (t.items || []).map((item: Item) => ({ ...item, turnId: t.id, complete: t.status !== 'inProgress' })));
    try {
      const result = fork
        ? await bridge.request('thread/fork', { threadId: selected.id, cwd, ...accessParams(access, cwd), ...(fork.lastTurnId ? { lastTurnId: fork.lastTurnId } : {}), ...(fork.title ? { title: fork.title } : {}), ...(selected.historyMode === 'paginated' ? { excludeTurns: true } : {}) })
        : await bridge.request('thread/resume', { threadId: selected.id, cwd, ...accessParams(access, cwd), ...(selected.historyMode === 'paginated' ? { excludeTurns: true } : {}) });
      if (!isCurrent()) return false;
      if (fork) {
        // The copy has its own id; from here on this tab shows the fork, never the source.
        if (!result?.thread?.id || result.thread.id === selected.id) throw new Error('Агент не вернул новую ветку диалога.');
        expectedId = result.thread.id;
        selected = { ...selected, ...result.thread, historyMode: result.thread.historyMode || selected.historyMode };
      }
      threadRef.current = result.thread; setThread(result.thread);
      resumedThreadRef.current = result.thread.id; setThreadReady(true);
      // Counters stored with the transcript (Claude history) are shown as-is; they are not a live model response
      // and never move the cache estimate, which comes from turn timestamps below.
      if (result.tokenUsage && lifecycleRef.current === lifecycle) setTokens(result.tokenUsage);
      if (lifecycleRef.current === lifecycle) {
        const activeTurn = result.thread.turns?.find((t: any) => t.status === 'inProgress');
        turnRef.current = activeTurn?.id || null;
        activeRef.current = Boolean(activeTurn || result.thread.status?.type === 'active');
        setBusy(activeRef.current);
      }
      if (!preserveSettings) {
        if (result.model) setModel(result.model);
        setEffort(result.reasoningEffort || '');
      }
      let turns = result.thread.turns || [];
      let descendingTurns = false;
      let hasRecentTurns = true;
      let loaded: Item[] = turnItems(turns);
      if (result.thread.historyMode === 'paginated') {
        const [itemsResult, turnsResult] = await Promise.allSettled([
          bridge.request('thread/items/list', { threadId: selected.id, limit: 100, sortDirection: 'desc' }),
          bridge.request('thread/turns/list', { threadId: selected.id, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded' }),
        ]);
        if (!isCurrent()) return false;
        if (turnsResult.status === 'fulfilled') {
          turns = turnsResult.value.data || [];
          descendingTurns = true;
          turnHistoryRef.current.cursor = turnsResult.value.nextCursor ?? null;
        } else {
          hasRecentTurns = false;
          setDiagnostics(previous => [...previous.slice(-79), `Turn history: ${errorText(turnsResult.reason)}`]);
        }
        if (itemsResult.status === 'fulfilled') {
          const activeIds = new Set(turns.filter((t: any) => t.status === 'inProgress').map((t: any) => t.id));
          loaded = [...itemsResult.value.data].reverse().map((entry: any) => ({ ...entry.item, turnId: entry.turnId, complete: !activeIds.has(entry.turnId) }));
          setItemCursor(itemsResult.value.nextCursor ?? null);
        } else {
          // Some CLI versions cannot page this store. Read the stored transcript
          // without another resume, which could acquire a second writer.
          const read = await bridge.request('thread/read', { threadId: selected.id, includeTurns: true });
          if (!isCurrent()) return false;
          turns = read.thread.turns || []; loaded = turnItems(turns);
          descendingTurns = false; hasRecentTurns = true;
          setItemCursor(null);
        }
      }
      showHistory(turns, loaded);
      const activeTurn = turns.find((t: any) => t.status === 'inProgress');
      if (lifecycleRef.current === lifecycle) {
        turnRef.current = activeTurn?.id || null;
        if (activeTurn) cacheTurnRef.current.id = activeTurn.id;
        activeRef.current = Boolean(activeTurn || result.thread.status?.type === 'active');
        setBusy(activeRef.current);
      }
      if (hasRecentTurns && lifecycleRef.current === lifecycle && cacheRevisionRef.current === cacheRevision && !activeRef.current) {
        setCacheActivityAt(fork ? null : historicalCacheActivity(turns, loaded, descendingTurns, Date.now()));
      }
      // Extra timing pages are optional: a failure must not discard readable history.
      await hydrateEarlierTurns(selected.id, loaded).catch(e => setDiagnostics(previous => [...previous.slice(-79), `Turn history: ${errorText(e)}`]));
      return isCurrent();
    } catch (e) {
      if (!isCurrent()) return false;
      const restoreReadCache = cacheRevisionRef.current === cacheRevision && lifecycleRef.current === lifecycle;
      invalidateCache();
      const readCacheRevision = cacheRevisionRef.current;
      const attached = resumedThreadRef.current === selected.id;
      if (fork && !attached) { threadRef.current = null; setThread(null); setThreadReady(false); }
      setError(attached ? `Не удалось загрузить переписку: ${errorText(e)}` : resumeErrorText(e));
      // Read access does not need writer ownership. Keep the selected ID and
      // transcript, but never mistake a readable thread for a resumed one.
      if (!attached && !fork) {
        try {
          const read = await bridge.request('thread/read', { threadId: selected.id, includeTurns: true });
          if (!isCurrent()) return false;
          threadRef.current = read.thread; setThread(read.thread);
          const turns = read.thread.turns || [];
          const loaded = turnItems(turns);
          showHistory(turns, loaded); setItemCursor(null);
          if (restoreReadCache && cacheRevisionRef.current === readCacheRevision && lifecycleRef.current === lifecycle && read.thread.status?.type !== 'active') {
            setCacheActivityAt(historicalCacheActivity(turns, loaded, false, Date.now()));
          }
          if (!preserveSettings) {
            if (read.thread.model) setModel(read.thread.model);
            if (read.thread.reasoningEffort !== undefined) setEffort(read.thread.reasoningEffort || '');
          }
        } catch (readError) {
          if (isCurrent()) setDiagnostics(previous => [...previous.slice(-79), `Stored history: ${errorText(readError)}`]);
        }
      }
      return false;
    } finally {
      if (historyLoadSequenceRef.current === sequence) { resumingRef.current = false; updateLoading(false); }
    }
  };

  const reconnect = async () => {
    const previous = threadRef.current;
    await connect(undefined, { keepThread: Boolean(previous) });
    if (connectionRef.current !== 'ready') return false;
    if (!previous || threadRef.current?.id !== previous.id || terminalRef.current) return true;
    return resume(previous, true);
  };

  restoreAuthRef.current = async data => {
    // A tab created during login may still be finishing its rejected bootstrap.
    // Reconnect only after that attempt releases the connection guard.
    if (connectingRef.current) { pendingAuthRestoreRef.current = data; return; }
    if (authRef.current) return;
    // Keep this tab's effective model/effort and already confirmed access.
    restoreSettingsRef.current ??= { provider: providerRef.current, ...(model ? { model } : {}), ...(effort ? { effort } : {}), access };
    setNotice('Обновляем подключение после настройки…');
    const restored = await reconnect();
    if (authRef.current) return;
    if (data.error) setError(data.error);
    if (restored) setNotice(data.message || (data.loggedIn ? 'Вход выполнен. Подключение обновлено.' : 'Окно авторизации закрыто. Состояние входа можно проверить в настройках.'));
  };

  const loadEarlier = async () => {
    if (terminalRef.current || !thread || !itemCursor || loadingRef.current) return;
    updateLoading(true);
    try {
      const page = await bridge.request('thread/items/list', { threadId: thread.id, cursor: itemCursor, limit: 100, sortDirection: 'desc' });
      const previous = [...page.data].reverse().map((entry: any) => ({ ...entry.item, turnId: entry.turnId, complete: true }));
      setItems(current => [...previous.filter((item: Item) => !current.some(i => i.id === item.id)), ...current]);
      restorePreviews(previous, thread.id);
      setItemCursor(page.nextCursor ?? null);
      await hydrateEarlierTurns(thread.id, previous).catch(e => setDiagnostics(current => [...current.slice(-79), `Turn history: ${errorText(e)}`]));
    } catch (e) { setError(errorText(e)); }
    finally { updateLoading(false); }
  };

  const readMessageStatus = async (clientUserMessageId: string, threadId = threadRef.current?.id) => {
    if (!threadId) return { accepted: false, rejected: false };
    const known = threadId === threadRef.current?.id ? acceptedMessagesRef.current.get(clientUserMessageId) : undefined;
    const receipt = known ? { accepted: true, ...known } : await bridge.request('message/status', { threadId, clientUserMessageId });
    if (receipt.accepted && threadRef.current?.id === threadId) {
      acceptedMessagesRef.current.set(clientUserMessageId, receipt);
      if (receipt.item) setItems(previous => {
        const index = previous.findIndex(item => item.id === receipt.item.id || item.clientId === clientUserMessageId);
        const existing = index >= 0 ? previous[index] : undefined;
        const next = { ...existing, ...receipt.item, ...(existing?.previews ? { previews: existing.previews } : {}), turnId: receipt.turnId, optimistic: false };
        if (index < 0) {
          const turnIndex = previous.findIndex(item => item.turnId === receipt.turnId);
          if (turnIndex < 0) return [...previous, next];
          return [...previous.slice(0, turnIndex), next, ...previous.slice(turnIndex)];
        }
        return previous.flatMap((item, i) => i === index ? [next] : item.id === receipt.item.id || item.clientId === clientUserMessageId ? [] : [item]);
      });
      if (receipt.turnId && !settledTurnsRef.current.has(receipt.turnId) && receipt.status === 'inProgress') {
        turnRef.current = receipt.turnId; activeRef.current = true; setBusy(true);
      } else if (receipt.turnId && ['completed', 'failed', 'interrupted'].includes(receipt.status || '') && (!turnRef.current || turnRef.current === receipt.turnId)) {
        settledTurnsRef.current.add(receipt.turnId); observeTurn({ id: receipt.turnId, status: receipt.status });
        turnRef.current = null; activeRef.current = false; setBusy(false);
      }
    }
    if (receipt.rejected && threadRef.current?.id === threadId) setItems(previous => previous.filter(item => !item.optimistic || item.clientId !== clientUserMessageId));
    return receipt as { accepted: boolean; rejected?: boolean; turnId?: string; status?: string };
  };

  const reconcileQueuedMessage = async (clientUserMessageId: string) => {
    const receipt = await readMessageStatus(clientUserMessageId);
    if ((receipt.accepted || receipt.rejected) && pendingMessageRef.current?.clientUserMessageId === clientUserMessageId) { updatePendingMessage(null); setError(''); }
    return receipt;
  };

  const reconcileMessage = async () => {
    const message = pendingMessageRef.current;
    if (!message) return { accepted: false };
    try {
      const receipt = await readMessageStatus(message.clientUserMessageId, message.threadId);
      if (pendingMessageRef.current === message) {
        if (receipt.accepted || receipt.rejected) { updatePendingMessage(null); setError(''); }
        if (receipt.accepted) setNotice('Сообщение принято. Повторная отправка не нужна.');
        else if (receipt.rejected) { if (message.kind === 'start' && !turnRef.current) { activeRef.current = false; setBusy(false); } setNotice('Сервер отклонил отправку. Текст сохранён, его можно изменить и отправить снова.'); }
        else setNotice('Подтверждение пока не найдено. Сообщение могло быть принято; повторная отправка заблокирована. Проверьте позже.');
      }
      return { ...receipt, message };
    } catch (e) { setNotice(`Проверка отправки недоступна: ${errorText(e)}`); return { accepted: false, message }; }
  };

  const send = async (text: string, attachments: Attachment[], silentCompletion = false, messageId?: string) => {
    if (pendingMessageRef.current) { setNotice('Проверьте неподтверждённую отправку перед новым сообщением.'); return false; }
    if (terminalRef.current || activeRef.current || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size || (!text.trim() && !attachments.length)) return false;
    const selected = threadRef.current;
    if (selected && resumedThreadRef.current !== selected.id) {
      // Retry attachment before storing images or creating an optimistic item.
      // A failed resume must never fall through to turn/start (or a new thread).
      if (!await resume(selected, true)) return false;
      if (threadRef.current?.id !== selected.id || activeRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size) return false;
    }
    const previousInterrupted = interruptedRef.current;
    attentionSuppressed.current = silentCompletion;
    const lifecycle = lifecycleRef.current;
    updateInterrupted(null);
    cacheTurnRef.current = { id: null, observed: false, suppressed: false };
    activeRef.current = true; setBusy(true); setError(''); setNotice('');
    const sequence = ++sendSequenceRef.current;
    let clientId: string | undefined;
    let submittedThreadId: string | undefined;
    try {
      const saved = attachments.length ? await bridge.saveImages(attachments) : [];
      if (sendSequenceRef.current !== sequence || connectionRef.current !== 'ready') return false;
      let current = threadRef.current;
      if (!current) {
        const result = await bridge.request('thread/start', { cwd, ...accessParams(access, cwd), ...(model ? { model } : {}) });
        if (sendSequenceRef.current !== sequence || connectionRef.current !== 'ready') return false;
        current = result.thread as Thread; threadRef.current = current; setThread(current);
        resumedThreadRef.current = current.id; setThreadReady(true);
        if (result.model) setModel(result.model);
      }
      const input: any[] = [];
      if (text.trim()) input.push({ type: 'text', text: text.trim(), text_elements: [] });
      saved.forEach(image => input.push({ type: 'localImage', path: image.path }));
      clientId = messageId || crypto.randomUUID();
      setItems(previous => [...previous, { id: clientId!, clientId, type: 'userMessage', content: input, previews: saved, optimistic: true }]);
      submittedThreadId = current.id;
      const result = await bridge.request('turn/start', {
        threadId: current.id, clientUserMessageId: clientId, input, cwd,
        ...accessParams(access, cwd, true), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      });
      if (sendSequenceRef.current === sequence && threadRef.current?.id === current.id && result.turn?.id) {
        observeTurn({ ...result.turn, status: result.turn.status || 'inProgress' });
        setItems(previous => previous.map(item => item.clientId === clientId && !item.turnId ? { ...item, turnId: result.turn.id } : item));
      }
      if (sendSequenceRef.current === sequence && activeRef.current && (!turnRef.current || turnRef.current === result.turn.id) && !settledTurnsRef.current.has(result.turn.id)) {
        turnRef.current = result.turn.id; cacheTurnRef.current.id = result.turn.id;
      }
      void refreshHistory();
      return true;
    } catch (e) {
      if (clientId && submittedThreadId && /timed?\s*out|timeout|не ответил|stream.*closed|exited|not running|соединени|подключени|поток.*закрыт|cli.*завершился/i.test(errorText(e))) {
        try { if ((await readMessageStatus(clientId, submittedThreadId)).accepted) { setNotice('Сервер принял сообщение; подтверждение отправки восстановлено.'); return true; } } catch { /* The connection may still be unavailable. */ }
        updatePendingMessage({ threadId: submittedThreadId, clientUserMessageId: clientId, kind: 'start', text, attachments });
        pauseQueue('Отправка не подтверждена. Повторная отправка заблокирована до сверки идентификатора.');
        setError(''); setNotice('Отправка не подтверждена. Сообщение могло быть принято сервером.');
        // A timeout is not a failed turn: retain live lifecycle, optimistic message and stop control.
        if (!turnRef.current) { activeRef.current = false; setBusy(false); }
        return false;
      }
      // A reply from a previous request must not tear down a newer live turn.
      pauseQueue('Отправка завершилась с ошибкой. Проверьте историю перед продолжением очереди.');
      if (sendSequenceRef.current === sequence) {
        if (!silentCompletion) reportAttention('error', `turn:${turnRef.current || `send-${sequence}`}`);
        if (turnRef.current) { settledTurnsRef.current.add(turnRef.current); observeTurn({ id: turnRef.current, status: 'failed' }); }
        if (/thread.*not found|already has an active writer/i.test(errorText(e))) { resumedThreadRef.current = null; setThreadReady(false); }
        invalidateCache(); setError(/already has an active writer/i.test(errorText(e)) ? resumeErrorText(e) : errorText(e)); activeRef.current = false; turnRef.current = null; setBusy(false);
        if (previousInterrupted && lifecycleRef.current === lifecycle && threadRef.current?.id === previousInterrupted.threadId && connectionRef.current === 'ready') {
          updateInterrupted(previousInterrupted); setNotice(STOPPED_NOTICE);
        }
      }
      if (clientId) setItems(previous => previous.filter(item => item.id !== clientId));
      return false;
    }
  };

  const sendPing = async (text: string) => {
    if (!threadRef.current || resumedThreadRef.current !== threadRef.current.id || activeRef.current || busy || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size || requests.length) return false;
    // send reserves activeRef synchronously before its first await. A timer and
    // the composer therefore cannot launch two turns, or create a ping thread.
    return send(text, [], true);
  };

  const steer = async (text: string, attachments: Attachment[]) => {
    if (pendingMessageRef.current) { setNotice('Проверьте неподтверждённую отправку перед уточнением.'); return false; }
    if (!capabilities.steer) { setError(`Уточнения во время выполнения для ${agentName(provider)} пока недоступны. Добавьте сообщение в очередь.`); return false; }
    const current = threadRef.current;
    const expectedTurnId = turnRef.current;
    if (!current || !expectedTurnId || !activeRef.current || steerPendingRef.current || terminalRef.current || compactionRef.current || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size || (!text.trim() && !attachments.length)) return false;
    steerPendingRef.current = true; setSteering(true); setError('');
    let clientId: string | undefined;
    try {
      const saved = attachments.length ? await bridge.saveImages(attachments) : [];
      // Images can take time to save. Never steer a later turn or fall back to start.
      if (threadRef.current?.id !== current.id || turnRef.current !== expectedTurnId || !activeRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size) {
        setError('Текущая задача уже завершилась или ожидает ответа. Уточнение осталось в поле ввода.'); return false;
      }
      const input: any[] = [];
      if (text.trim()) input.push({ type: 'text', text: text.trim(), text_elements: [] });
      saved.forEach(image => input.push({ type: 'localImage', path: image.path }));
      clientId = crypto.randomUUID();
      setItems(previous => [...previous, { id: clientId!, clientId, type: 'userMessage', content: input, previews: saved, optimistic: true, turnId: expectedTurnId }]);
      await bridge.request('turn/steer', { threadId: current.id, expectedTurnId, clientUserMessageId: clientId, input });
      return true;
    } catch (e) {
      if (clientId && /timed?\s*out|timeout|не ответил|stream.*closed|exited|not running|соединени|подключени|поток.*закрыт|cli.*завершился/i.test(errorText(e))) {
        try { if ((await readMessageStatus(clientId, current.id)).accepted) return true; } catch { /* Remain uncertain. */ }
        updatePendingMessage({ threadId: current.id, clientUserMessageId: clientId, kind: 'steer', text, attachments });
        setError(''); setNotice('Уточнение не подтверждено. Текст сохранён, повторная отправка заблокирована до сверки.');
        pauseQueue('Уточнение не подтверждено. Проверьте отправку.');
        return false;
      }
      if (clientId) setItems(previous => previous.filter(item => item.id !== clientId));
      setError(`Уточнение не подтверждено: ${errorText(e)}. Текст сохранён. Проверьте историю перед повторной отправкой.`);
      pauseQueue('Уточнение не подтверждено. Проверьте историю.');
      return false;
    } finally { steerPendingRef.current = false; setSteering(false); }
  };

  const canSendQueued = (pauseRevision = queuePause.revision) => !pendingMessageRef.current && pauseRevision === queuePauseRevisionRef.current && !terminalRef.current && !activeRef.current && !loadingRef.current && !steerPendingRef.current && connectionRef.current === 'ready' && !pendingRequestIdsRef.current.size && (!threadRef.current || resumedThreadRef.current === threadRef.current.id);

  const continueTurn = async () => {
    const stopped = interruptedRef.current;
    if (!stopped || stopped.threadId !== threadRef.current?.id || resumedThreadRef.current !== stopped.threadId || terminalRef.current || activeRef.current || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size) return false;
    // A visible user message uses the ordinary send path; composer drafts and
    // attachments never become part of this explicit shortcut.
    return send('Продолжай', []);
  };

  const compact = async () => {
    if (pendingMessageRef.current) { setNotice('Проверьте неподтверждённую отправку перед сжатием.'); return false; }
    if (!capabilities.compact) { setError(`Сжатие контекста ${agentName(provider)} из приложения пока недоступно.`); return false; }
    const current = threadRef.current;
    if (terminalRef.current || !current || resumedThreadRef.current !== current.id || activeRef.current || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size) return false;
    updateInterrupted(null);
    const previousTurns = new Set([...turnHistoryRef.current.known, ...settledTurnsRef.current]);
    if (cacheTurnRef.current.id) previousTurns.add(cacheTurnRef.current.id);
    const operation: CompactionOperation = {
      sequence: ++sendSequenceRef.current, threadId: current.id,
      turnId: null, turnStarted: false, usageUpdated: false, previousTurns,
    };
    compactionRef.current = operation;
    activeRef.current = true; setBusy(true); setCompacting(true); setError('');
    setNotice('Сжатие контекста…');
    invalidateCache();
    cacheTurnRef.current = { id: null, observed: false, suppressed: true };
    try {
      // Acknowledgment accepts the operation; only lifecycle events finish it.
      // No synthetic message, model override, or hidden instruction is sent.
      await bridge.request('thread/compact/start', { threadId: current.id });
      return operation.sequence === sendSequenceRef.current && threadRef.current?.id === current.id;
    } catch (e) {
      finishCompaction(operation, 'failed', `Не удалось сжать контекст: ${errorText(e)}`);
      return false;
    }
  };

  const openTerminal = async () => {
    if (pendingMessageRef.current) { setNotice('Проверьте неподтверждённую отправку перед открытием терминала.'); return false; }
    if (!capabilities.terminal) { setError(`Продолжение ${agentName(provider)} в терминале пока недоступно.`); return false; }
    const current = threadRef.current;
    if (terminalRef.current || !current || resumedThreadRef.current !== current.id || activeRef.current || loadingRef.current || connectionRef.current !== 'ready' || pendingRequestIdsRef.current.size) return false;
    pauseQueue('Диалог открыт в терминале. Проверьте историю перед продолжением очереди.');
    updateInterrupted(null);
    const operation = { threadId: current.id, state: 'opening' as 'opening' | 'open' | 'restoring' };
    terminalRef.current = operation; setTerminalOpen(true); setError('');
    invalidateCache(); setNotice('Открываем текущий диалог в терминале…');
    try {
      await bridge.openTerminal({ threadId: current.id, model, effort, access });
      if (terminalRef.current === operation && operation.state === 'opening') {
        operation.state = 'open'; setNotice('Диалог открыт в терминале. После его закрытия история обновится.');
      }
      return true;
    } catch (e) {
      if (terminalRef.current === operation && operation.state !== 'restoring') {
        terminalRef.current = null; setTerminalOpen(false); setNotice(''); setError(`Не удалось открыть терминал: ${errorText(e)}`);
      }
      return false;
    }
  };

  restoreTerminalRef.current = async data => {
    const operation = terminalRef.current;
    const selected = threadRef.current;
    if (!operation || operation.threadId !== data.threadId || operation.state === 'restoring' || selected?.id !== data.threadId) return;
    operation.state = 'restoring';
    updateConnection('connecting'); setNotice('Обновляем диалог после терминала…');
    try {
      await bridge.start({ cwd: cwdRef.current });
      if (terminalRef.current !== operation) return;
      // resume reserves loading synchronously; no composer request can race
      // between releasing terminal ownership and reading fresh history.
      terminalRef.current = null;
      updateConnection('ready');
      const restored = await resume(selected, true);
      setTerminalOpen(false);
      if (!restored) { updateConnection('error'); setNotice(''); return; }
      setNotice(data.error ? '' : 'Терминал закрыт. Диалог обновлён.');
      if (data.error) setError(data.error);
      void refreshHistory();
    } catch (e) {
      if (terminalRef.current === operation) terminalRef.current = null;
      setTerminalOpen(false); updateConnection('error'); setNotice('');
      setError(`Не удалось обновить диалог после терминала: ${errorText(e)}`);
    }
  };

  const stop = async () => {
    if (terminalRef.current) return;
    pauseQueue('Выполнение остановлено пользователем.');
    invalidateCache();
    if (!threadRef.current) return;
    const threadId = threadRef.current.id;
    const sequence = sendSequenceRef.current;
    const isCurrent = () => activeRef.current && threadRef.current?.id === threadId && sendSequenceRef.current === sequence;
    try {
      if (!turnRef.current) {
        const result = await bridge.request('thread/read', { threadId, includeTurns: true });
        if (!isCurrent()) return;
        turnRef.current = result.thread.turns?.find((turn: any) => turn.status === 'inProgress')?.id || null;
        if (compactionRef.current && turnRef.current) {
          const operation = matchCompactionTurn(turnRef.current);
          if (!operation) turnRef.current = null;
          else operation.turnStarted = true;
        }
      }
      if (!turnRef.current) throw new Error(`${agentName(providerRef.current)} ещё запускает запрос. Повторите остановку через секунду.`);
      if (!isCurrent()) return;
      await bridge.request('turn/interrupt', { threadId, turnId: turnRef.current });
    } catch (e) { if (isCurrent()) setError(errorText(e)); }
  };

  const respond = async (request: Request, result: any) => {
    await bridge.respond(request.id, result);
    pendingRequestIdsRef.current.delete(request.id);
    setRequests(previous => previous.filter(r => r.id !== request.id));
  };

  return {
    connection, provider, capabilities, cwd, models, model, effort, access, account, config, executable, cliVersion, sources, history, historyCursor, historyLoading,
    thread, threadReady, items, turnWork, itemCursor, busy, compacting, terminalOpen, authInProgress, loading, error, notice,
    canContinue: Boolean(interruptedTurn && notice === STOPPED_NOTICE), requests, diff, diffTurnId, turnDiffs, plan, tokens, diagnostics,
    cacheActivityAt, cacheGeneration, cacheTurnCompleted, queueCompletion, queuePause, steering, usage, usageLoading, refreshUsage, agentDetails, agentDetailsLoading, refreshAgentDetails,
    connect, reconnect, selectDirectory, selectExecutable, selectModel, selectEffort, selectAccess, refreshHistory, clearThread,
    resume, loadEarlier, send, steer, canSendQueued, sendPing, continueTurn, compact, openTerminal, stop, respond, setError, setNotice, pendingMessage, reconcileMessage, reconcileQueuedMessage,
  };
}
