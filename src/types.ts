import type { SetupBridge } from './setup-types';
import type { MemoryRulesBridge } from './memory-rules-types';
export type Access = 'inherited' | 'auto' | 'rules' | 'read-only' | 'workspace-write' | 'danger-full-access';
export type AgentProvider = 'codex' | 'claude';
export type AgentCapabilities = { compact: boolean; steer: boolean; terminal: boolean; mcp: boolean; archive: boolean; usage?: boolean };
export type AgentDetails = { commands: { name: string; description: string; builtin: boolean }[]; agents: { name: string; description: string }[]; mcpServers: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error?: string; scope?: string }[] | null; mcpError?: string };
export type AgentSkillSource = 'project' | 'user' | 'shared' | 'synced' | 'plugin';
export type AgentSkill = { id: string; name: string; description: string; source: AgentSkillSource; root: string; path: string; directory: string; updatedAt: string | null; plugin?: string; duplicates?: string[] };
export type AgentSkillsSnapshot = { provider: AgentProvider; cwd: string; readAt: string; roots: { source: AgentSkillSource; path: string; exists: boolean; count: number }[]; skills: AgentSkill[]; errors: { path: string; message: string }[]; truncated: boolean };
export interface AgentSkillsBridge { list(options: { provider: AgentProvider; cwd?: string }): Promise<AgentSkillsSnapshot>; }
export type UsageWindow = { key: string; label: string; utilization: number | null; resetsAt: string | null };
export type UsageLimits = { available: boolean; subscription?: string | null; windows: UsageWindow[]; updatedAt?: string; message?: string };
export type RouterBand = { name: string | null; left: number | null; resetAt: string | null; blocked: boolean | null; band?: string | null; hours?: number | null; sharePercent?: number | null; usedPercent?: number | null; limitCredits?: number | null; usedCredits?: number | null; remainingCredits?: number | null };
export type RouterLimit = { key?: string | null; name?: string | null; available?: boolean | null; tier: string | null; state: string | null; reset_at?: string | null; resetAt?: string | null; limit_credits?: number | null; used_credits?: number | null; ledger_used_credits?: number | null; remaining_credits?: number | null; used_percent?: number | null; left?: number | null; blocked?: boolean | null; blockedReason?: string | null; usedPercent?: number | null; limitCredits?: number | null; usedCredits?: number | null; remainingCredits?: number | null; ledgerUsedCredits?: number | null; bonusCredits?: number | null; bands?: RouterBand[] };
export type RouterCreditSpend = { credits: number | null; partial?: boolean; reason?: string; threadCount?: number };
export type RouterUsageSnapshot = { available: boolean; provider?: AgentProvider; fetchedAt?: string; overview?: Record<string, unknown>; limits?: RouterLimit[]; status?: number; reason?: string; limitReason?: string; overviewReason?: string; spend?: { session: RouterCreditSpend; today: RouterCreditSpend & { since: string } } };
export type ClaudeAuthStatus = { loggedIn: boolean; authMethod?: string; email?: string; subscriptionType?: string; apiProvider?: string; configDirectory?: string; loginInProgress: boolean };
export type ClaudeTokenInfo = { configured: boolean; savedAt?: string; encryptionAvailable: boolean; error?: string; restarted?: number; busy?: number };
export type ConnectionSource = 'inherited' | 'account' | 'router';
export type Settings = { cwd?: string; model?: string; effort?: string; access?: Access; executable?: string; provider?: AgentProvider; connectionSource?: ConnectionSource };
export type RouterConnectionInfo = { configured: boolean; encryptionAvailable: boolean; savedAt?: string; baseUrl?: string; providerName?: string; model?: string; error?: string };
export type RouterConnectionPreview = { previewId: string; agent: 'claude'; providerName?: string; baseUrl: string; model?: string; expiresAt: string };
/** Where a tab's effective value came from: restored tab snapshot, saved agent defaults, CLI configuration, a built-in default, or the user's choice in this tab. */
export type SettingSource = 'tab' | 'saved' | 'cli' | 'default' | 'selected';
export type SettingSources = { model: SettingSource; effort: SettingSource; access: SettingSource };
export type BridgeEvent = { type: 'notification' | 'serverRequest' | 'status' | 'diagnostic' | 'terminal' | 'mcp' | 'auth'; data: any };
export type Attachment = { name: string; dataUrl: string; path?: string };
export type ComposerFiles = { images: Attachment[]; paths: string[]; message?: string };
export type QueuedMessage = { id: string; text: string; attachments: Attachment[]; state?: 'waiting' | 'uncertain'; remote?: RemoteDispatchContext };
export type MessageQueueState = { items: QueuedMessage[]; paused: boolean; reason?: string; threadId?: string; cwd?: string };
export type PreservedDraft = { text: string; attachments: Attachment[] };
export type PendingMessage = { threadId: string; clientUserMessageId: string; kind: 'start' | 'steer'; text: string; attachments: Attachment[]; origin?: 'remote'; remote?: RemoteDispatchContext };
export type ScrollAnchor = { itemId: string; offset: number };
export type NotificationKind = 'completed' | 'question' | 'approval' | 'error';
export type NotificationPreferences = { enabled: boolean; sound: boolean; completed: boolean; question: boolean; approval: boolean; error: boolean };
export type NotificationSettingsInfo = { settings: NotificationPreferences; supported: boolean };
export type SessionAttentionEvent = { kind: NotificationKind; eventId: string };
export type Item = { id: string; type: string; turnId?: string; complete?: boolean; [key: string]: any };
// Internal timestamps are milliseconds; App Server turn timestamps are seconds.
export type TurnWork = { id: string; status: string; startedAt?: number; completedAt?: number; durationMs?: number; answerStartedAt?: number; answerItemId?: string };
export type Thread = { id: string; name?: string; preview?: string; cwd?: string; updatedAt?: number; turns?: any[]; provider?: AgentProvider; [key: string]: any };
/** Kuzmich's own grouping of conversations. Presentation metadata owned by the shell:
 * it is not a claim about the agent's native parent/child lineage, and the CLI never sees it. */
export type ThreadGroupMember = { threadId: string; addedAt: string };
export type ThreadGroup = { id: string; name: string; cwd: string; rootThreadId: string | null; createdAt: string; updatedAt: string; members: ThreadGroupMember[] };
export type ThreadGroupAction =
  | { action: 'create'; name: string; cwd: string; rootThreadId?: string }
  | { action: 'rename'; groupId: string; name: string }
  | { action: 'delete'; groupId: string }
  | { action: 'assign'; groupId: string; threadId: string; root?: boolean }
  | { action: 'unassign'; threadId: string };
export type ThreadGroupResult = { group?: ThreadGroup; removedGroupId?: string; removedThreadId?: string };
/** Navigation-only link between a conversation and an executor agent of the same folder.
 * `label` is the default executor name («Агент A»); records written before it existed have none. */
export type ThreadChildLink = { id: string; cwd: string; parentThreadId: string; childThreadId: string; provider: AgentProvider; model?: string | null; effort?: string | null; label?: string | null; createdAt: string };
/** An executor agent as the «Исполнители» row shows it: the conversation plus its default
 * name and, while a tab is open, the session that already hosts it. A tab that has not sent
 * anything yet has no conversation id, so it is addressed by `sessionId` alone. */
export type ExecutorThread = Thread & {
  label?: string;
  sessionId?: string;
  /** Live state is absent when only the saved parent link remains. */
  busy?: boolean;
  pending?: number;
  loading?: boolean;
  connection?: string;
  terminalOpen?: boolean;
  unread?: boolean;
  attentionKind?: NotificationKind;
  pendingKind?: 'question' | 'approval';
  /** Only kept for this application run, never written into the parent link. */
  closeWhenComplete?: boolean;
  closeBlockedReason?: string;
  unlinkBlockedReason?: string;
};
/** Context-menu actions of an executor sub-tab. `unlink` only drops the navigation link —
 * the conversation stays and becomes a plain dialog of the same folder. */
export type ExecutorAction = 'rename' | 'unlink' | 'archive' | 'close';
export type ThreadChildLinkAction = { action: 'relabel'; childThreadId: string; label: string | null } | { action: 'unlink'; childThreadId: string };
export type ThreadAction = 'rename' | 'archive' | 'delete' | 'restore' | 'fork';
export type ArchivedThreadPage = { thread: Thread; items: Item[]; turns: any[]; nextCursor: string | null };
export type ApprovalRuleKind = 'commands' | 'paths' | 'hosts';
/** What «Разрешить и запомнить» would save for a pending request, as [kind, value] pairs. */
export type DerivedRule = [ApprovalRuleKind, string];
export type ApprovalRule = { kind: ApprovalRuleKind; value: string };
export type ApprovalRules = { cwd: string; rules: ApprovalRule[] };
export type Request = { id: number | string; method: string; params: any; rules?: DerivedRule[] };
export type Model = { id: string; model: string; displayName: string; hidden?: boolean; unavailable?: boolean; isDefault?: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; inputModalities?: string[] };

export type SessionInfo = { id: string; cwd: string; provider?: AgentProvider };
export type WorktreeInfo = { path: string; branch: string; created: boolean; root: string };
export type WorktreeEntry = { path: string; branch: string | null; head: string | null; detached: boolean; bare: boolean; main: boolean; current: boolean; dirty: boolean | null; ahead: number | null; behind: number | null };
export type WorktreeSummary = { root: string; mainBranch: string | null; mainPath: string | null; worktrees: WorktreeEntry[] };
export type WorktreeMergePreview = { branch: string; target: string; mainPath: string; worktreePath: string; commits: { hash: string; subject: string }[]; stat: string; ahead: number | null; behind: number | null; mainDirty: boolean; worktreeDirty: boolean; blocked: string | null };
export type UpdateTabSnapshot = { sessionId?: string; thread?: Thread; archivedThread?: Thread; settings?: Settings; draft: string; attachments: Attachment[]; preservedDraft?: PreservedDraft; queue?: MessageQueueState; scrollTop?: number; scrollAnchor?: ScrollAnchor; pinned?: boolean; pendingMessage?: PendingMessage; childOf?: string; childLabel?: string; executorAutoReview?: import('./executor-auto-review').ExecutorAutoReviewState };
export type UpdateSnapshot = { version: 1; activeIndex: number; tabs: UpdateTabSnapshot[] };
export type RestoredTab = SessionInfo & { thread?: Thread; archivedThread?: Thread; settings?: Settings; draft?: string; attachments?: Attachment[]; preservedDraft?: PreservedDraft; queue?: MessageQueueState; scrollTop?: number; scrollAnchor?: ScrollAnchor; pinned?: boolean; pendingMessage?: PendingMessage; childOf?: string; childLabel?: string; executorAutoReview?: import('./executor-auto-review').ExecutorAutoReviewState };
export type UpdateStatus = { state: 'awaiting' | 'waiting' | 'manual' | 'preparing' | 'error'; message?: string };
export type WorkspaceInfo = { projects: string[]; sessions: SessionInfo[]; restore?: { activeIndex: number; tabs: RestoredTab[]; kind?: 'workspace' | 'update' } };
export type AppUpdateStatus = {
  currentVersion: string;
  channel: 'stable' | 'nightly' | 'experimental3' | 'development';
  enabled: boolean;
  supported: boolean;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'up-to-date' | 'error' | 'disabled';
  checkedAt?: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  filename?: string;
  sha256?: string;
  sizeBytes?: number;
  downloadedPath?: string;
  downloadedVersion?: string;
  error?: string;
  skippedVersion?: string;
  /** Тихая установка доступна только упакованному Release. */
  canApply?: boolean;
  /** Проверка упёрлась в отсутствующий вход в Portal — окно предлагает войти. */
  needsPortalLogin?: boolean;
  progress?: { received: number; total: number };
  /** Итог прошлой попытки тихой установки, прочитанный при запуске. */
  outcome?: { state: 'applied'; version: string } | { state: 'failed'; version: string; reason: 'ok' | 'timeout' | 'error' | 'unknown'; installerPath: string | null };
};
/** Curated user-facing changes shown once after a stable release update. */
export type ReleaseNotesRelease = { version: string; date?: string; items: string[] };
export type ReleaseNotesState = {
  currentVersion: string;
  previousVersion?: string | null;
  releases: ReleaseNotesRelease[];
  shouldShow: boolean;
};
export type BuildInfo = { channel: 'stable' | 'nightly' | 'experimental3' | 'development'; version: string; buildId?: string; builtAt?: string; buildNumber?: number | null };
export type DiagnosticsStatus = { enabled: boolean; directory: string | null; error?: string };
export type RendererErrorReport = { kind: 'error' | 'unhandledrejection' | 'react'; name?: string; message?: string; stack?: string; componentStack?: string };
export type ProjectFile = { name: string; path: string; type: 'directory' | 'file' | 'link' };
export type ProjectFilePage = { path: string; entries: ProjectFile[]; nextCursor: number | null };
export type ProjectSearchPage = { files: { path: string; name: string }[]; nextCursor: string | null; truncated?: boolean };
export type ProjectFilePreview = { path: string; kind: 'text' | 'markdown' | 'image' | 'unsupported'; text?: string; dataUrl?: string; language?: string; truncated?: boolean; message?: string };
export type HistoryTarget = { cwd: string; provider: AgentProvider; thread: Thread; itemId: string; turnId?: string; snippet?: string; excerpt?: string; archived?: boolean };
export type HistorySearchPage = { matches: HistoryTarget[]; nextCursor: string | null; scannedThreads: number; scannedPages: number; warnings?: string[] };
export type Bookmark = { id: string; provider: AgentProvider; cwd: string; threadId: string; itemId: string; turnId?: string; threadName: string; excerpt: string; label: string; createdAt: string; updatedAt: string; archived?: boolean };
export type GitArea = 'staged' | 'unstaged' | 'untracked';
export type GitEntry = { path: string; originalPath?: string; status: string; indexStatus: string; worktreeStatus: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean; submodule?: boolean };
export type GitStatus = { available: boolean; reason?: 'not-repository' | 'git-unavailable' | 'bare'; root?: string; branch?: string; detached?: boolean; unborn?: boolean; head?: string; entries: GitEntry[]; truncated?: boolean; message?: string };
export type GitDiff = { path: string; area: GitArea; diff: string; binary?: boolean; truncated?: boolean; message?: string };
export type GitRollbackHunk = { index: number; header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; removed: number; added: number; excerpt: string };
export type GitRollbackPreview = { previewId: string; path: string; diff: string; binary?: boolean; truncated?: boolean; message?: string; expiresAt: string; operation: 'restore' | 'undo'; hunks?: GitRollbackHunk[] };
export type GitRollbackRecord = { undoId: string; path: string; createdAt: string };
export type McpServerSummary = { name: string; transport: 'http' | 'stdio'; address: string; enabled: boolean; headerNames: string[]; envNames: string[] };
export type McpConfigInfo = { configPath: string; servers: McpServerSummary[] };
export type McpImportPreview = { previewId: string; configPath: string; servers: (McpServerSummary & { exists: boolean })[]; conflicts: string[] };
export type McpRemovalPreview = { previewId: string; configPath: string; server: McpServerSummary };
export type McpSaveResult = { configPath: string; backupPath: string | null; servers: string[]; message?: string };
export type McpConnectionReport = { servers: { name: string; authStatus: string; status: string; toolCount: number }[]; message?: string };
export interface CodexBridge {
  getRemoteThreadAccess?(): Promise<RemoteThreadAccessState>;
  setRemoteThreadAccess?(options: SetRemoteThreadAccess): Promise<RemoteThreadAccessState>;
  publishRemoteState?(snapshot: RemoteRuntimeSnapshot): Promise<RemoteThreadAccessState>;
  publishRemoteAnswer?(answer: RemoteAnswer): Promise<void>;
  completeRemoteDispatch?(response: { dispatchId: string; result: RemoteDispatchResult }): Promise<void>;
  onRemoteDispatch?(listener: (request: RemoteDispatchRequest) => void): () => void;
  onRemoteAccess?(listener: (state: RemoteThreadAccessState) => void): () => void;
  onRemoteCancel?(listener: (request: { operationIds: string[]; reason: string }) => void): () => void;

  start(options?: { cwd?: string; refreshModels?: boolean }): Promise<{ initialize: any; models: Model[]; account: any; config: any; cwd: string; executable: string; provider?: AgentProvider; capabilities?: AgentCapabilities; cliVersion?: string; routerSource?: boolean }>;
  request(method: string, params?: any): Promise<any>;
  respond(id: number | string, result: any, options?: { remember?: boolean }): Promise<void>;
  listApprovalRules(): Promise<ApprovalRules>;
  dropApprovalRule(number: number): Promise<ApprovalRules>;
  chooseDirectory(): Promise<string | null>;
  saveImages(images: Attachment[]): Promise<Attachment[]>;
  chooseComposerFiles(options?: { imageSlots?: number; imagesSupported?: boolean }): Promise<ComposerFiles | null>;
  getPathForFile(file: File): string;
  readClipboardFiles(options?: { imageSlots?: number; imagesSupported?: boolean }): Promise<ComposerFiles | null>;
  readAttachment(path: string): Promise<string | null>;
  onEvent(listener: (event: BridgeEvent) => void): () => void;
  getSettings(): Promise<Settings>;
  setSettings(settings: Partial<Settings>): Promise<void>;
  openPath(path: string): Promise<void>;
  showPathMenu(path: string, options?: { askCodex?: boolean }): Promise<void | { action: 'askCodex'; path: string }>;
  listFiles(relativePath?: string, cursor?: number): Promise<ProjectFilePage>;
  searchProjectFiles(options: { query: string; cursor?: string }): Promise<ProjectSearchPage>;
  readProjectFile(options: { path: string }): Promise<ProjectFilePreview>;
  getGitStatus(): Promise<GitStatus>;
  getGitDiff(options: { path: string; area: GitArea }): Promise<GitDiff>;
  previewGitRollback(options: { path: string }): Promise<GitRollbackPreview>;
  applyGitRollback(options: { previewId: string; hunks?: number[] }): Promise<GitRollbackRecord>;
  listGitRollbacks(): Promise<GitRollbackRecord[]>;
  previewUndoGitRollback(options: { undoId: string }): Promise<GitRollbackPreview>;
  undoGitRollback(options: { previewId: string }): Promise<{ path: string }>;
  chooseExecutable(): Promise<string | null>;
  openTerminal(options: { threadId: string; model: string; effort: string; access: Access }): Promise<{ threadId: string }>;
  getClaudeAuthStatus(): Promise<ClaudeAuthStatus>;
  loginClaude(): Promise<{ started: true }>;
  getClaudeToken(): Promise<ClaudeTokenInfo>;
  setClaudeToken(token: string): Promise<ClaudeTokenInfo>;
  clearClaudeToken(): Promise<ClaudeTokenInfo>;
  setupClaudeToken(): Promise<{ started: true }>;
  getRouterConnection?(): Promise<RouterConnectionInfo>;
  connectRouterPortal?(): Promise<RouterConnectionPreview | null>;
  cancelRouterConnection?(): Promise<void>;
  openRouterPortal?(): Promise<void>;
  previewRouterInstaller?(): Promise<RouterConnectionPreview | null>;
  applyRouterConnection?(options: { previewId: string }): Promise<RouterConnectionInfo>;
  getMcpConfig(): Promise<McpConfigInfo>;
  previewMcpImport(text: string): Promise<McpImportPreview>;
  saveMcpImport(options: { previewId: string; replaceExisting: boolean }): Promise<McpSaveResult>;
  previewMcpRemoval(name: string): Promise<McpRemovalPreview>;
  removeMcpServer(options: { previewId: string }): Promise<McpSaveResult>;
  reloadMcp(): Promise<{ status: 'applied' | 'deferred'; message: string }>;
  checkMcp(): Promise<McpConnectionReport>;
  getRouterUsage?(options?: { threadId?: string | null }): Promise<RouterUsageSnapshot>;
}
export interface WorkspaceBridge extends CodexBridge {
  relayBridge?: RelayBridge;
  setup?: SetupBridge;
  memoryRules?: MemoryRulesBridge;
  skills?: AgentSkillsBridge;
  searchHistory(options: { query: string; cwd: string; provider: AgentProvider | 'all'; cursor?: string }): Promise<HistorySearchPage>;
  resolveHistoryTarget(options: { cwd: string; provider: AgentProvider; threadId: string }): Promise<Thread>;
  listBookmarks(options?: { cwd?: string; provider?: AgentProvider | 'all' }): Promise<Bookmark[]>;
  saveBookmark(bookmark: Omit<Bookmark, 'id' | 'createdAt' | 'updatedAt' | 'label'> & { id?: string; label?: string }): Promise<Bookmark>;
  removeBookmark(id: string): Promise<{ removed: boolean }>;
  getNotificationSettings(): Promise<NotificationSettingsInfo>;
  setNotificationSettings(settings: Partial<NotificationPreferences>): Promise<NotificationSettingsInfo>;
  setNotificationContext(context: { activeSessionId?: string }): Promise<void>;
  notifySession(event: SessionAttentionEvent & { sessionId: string; title: string }): Promise<void>;
  onNotificationActivated(listener: (event: { sessionId: string }) => void): () => void;
  getWindowFocus(): Promise<boolean>;
  onWindowFocus(listener: (focused: boolean) => void): () => void;
  getBuildInfo(): Promise<BuildInfo>;
  getAppUpdateStatus(): Promise<AppUpdateStatus>;
  checkAppUpdates(): Promise<AppUpdateStatus>;
  setAppUpdatePreferences(patch: { enabled?: boolean; skippedVersion?: string | null }): Promise<AppUpdateStatus>;
  openAppUpdateDownload(): Promise<void>;
  installAppUpdate(): Promise<AppUpdateStatus>;
  acknowledgeAppUpdateOutcome(): Promise<AppUpdateStatus>;
  revealAppUpdateFile(): Promise<AppUpdateStatus>;
  onAppUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void;
  getReleaseNotes?(): Promise<ReleaseNotesState>;
  acknowledgeReleaseNotes?(): Promise<void>;
  getDiagnosticsStatus(): Promise<DiagnosticsStatus>;
  exportDiagnostics(): Promise<{ canceled: boolean; path?: string }>;
  exportConversation(file: { filename: string; content: string; format: 'markdown' | 'html' }): Promise<{ canceled: boolean; path?: string }>;
  openDiagnosticsFolder(): Promise<void>;
  reportRendererError(report: RendererErrorReport): void;
  getWorkspace(): Promise<WorkspaceInfo>;
  saveWorkspaceState(snapshot: UpdateSnapshot): Promise<void>;
  onWorkspaceSave(listener: (request: { requestId: string }) => void): () => void;
  completeWorkspaceSave(result: { requestId: string; snapshot?: UpdateSnapshot }): Promise<void>;
  onUpdatePrepare(listener: (request: { requestId: string }) => void): () => void;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  getUpdateStatus(): Promise<UpdateStatus | null>;
  decideUpdate(decision: 'close' | 'later'): Promise<UpdateStatus>;
  forceUpdate(): Promise<UpdateStatus>;
  completeUpdatePrepare(result: { requestId: string; snapshot?: UpdateSnapshot; defer?: boolean }): Promise<void>;
  completeUpdateRestore(): Promise<void>;
  listProjectThreads(cwd: string, cursor?: string): Promise<{ data: Thread[]; nextCursor: string | null }>;
  /** Dependent (child) conversations of a folder, read separately from its history page. Codex only. */
  listThreadChildren?(cwd: string, cursor?: string): Promise<{ data: Thread[]; nextCursor: string | null }>;
  listThreadGroups?(cwd?: string): Promise<ThreadGroup[]>;
  manageThreadGroup?(options: ThreadGroupAction): Promise<ThreadGroupResult>;
  listThreadChildLinks?(cwd?: string): Promise<ThreadChildLink[]>;
  createThreadChildLink?(options: Omit<ThreadChildLink, 'id' | 'createdAt'>): Promise<{ link: ThreadChildLink }>;
  manageThreadChildLink?(options: ThreadChildLinkAction): Promise<{ changed: boolean; link: ThreadChildLink | null }>;
  searchThreads(options: { query: string; archived: boolean; cursor?: string }): Promise<{ data: Thread[]; nextCursor: string | null }>;
  listArchivedThreads(cursor?: string): Promise<{ data: Thread[]; nextCursor: string | null }>;
  readArchivedThread(options: { threadId: string; cursor?: string }): Promise<ArchivedThreadPage>;
  openArchivedPath(options: { threadId: string; target: string; menu?: boolean }): Promise<void>;
  manageThread(options: { action: ThreadAction; threadId: string; cwd: string; name?: string }): Promise<{ thread?: Thread; affectedThreadIds?: string[] }>;
  createSession(options?: { cwd?: string; fromSessionId?: string; settings?: Settings; provider?: AgentProvider }): Promise<SessionInfo | null>;
  createWorktreeSession?(options: { cwd: string; fromSessionId?: string; name: string; provider?: AgentProvider }): Promise<(SessionInfo & { worktree: WorktreeInfo }) | null>;
  listWorktrees?(cwd: string): Promise<WorktreeSummary>;
  previewWorktreeMerge?(cwd: string): Promise<WorktreeMergePreview>;
  mergeWorktree?(cwd: string): Promise<{ branch: string; target: string; mainPath: string; before: string; after: string; commits: number }>;
  removeWorktree?(cwd: string, options?: { force?: boolean; deleteBranch?: boolean }): Promise<{ path: string; branch: string | null; branchDeleted: boolean }>;
  closeSession(id: string): Promise<void>;
  closeProject(cwd: string, options?: { force?: boolean }): Promise<{ projects: string[]; closedSessionIds: string[] }>;
  forSession(id: string): CodexBridge;
}
declare global {
  interface Window { codex: WorkspaceBridge; }
}


// Telegram-independent remote control v1; see docs/REMOTE_CONTROL_CONTRACT.md.
export type RemoteTarget = {
  grantId: string;               // постоянный UUID разрешения на точную беседу
  generation: number;             // durable, увеличивается при отзыве/перепривязке
  provider: AgentProvider;
  threadId: string;               // точный ID оболочки, включая claude:UUID
  projectKey: string;             // непрозрачный ID проекта, назначает host
  sessionId: string;              // текущая runtime-сессия, никогда не достаточен один
  runtimeId: string;              // UUID incarnation владельца/транспорта
};

export type RemoteBlockReason =
  | 'busy' | 'approval' | 'question' | 'terminal' | 'restoring'
  | 'uncertain_delivery' | 'disconnected' | 'queue_paused' | 'queue_not_empty'
  | 'queue_full' | 'local_action' | 'closing' | 'settings_changing'
  | 'model_unavailable' | 'compacting' | 'unsupported' | 'ambiguous_owner';

export type RemoteThreadState = {
  target: RemoteTarget;
  revision: number;              // монотонно внутри runtimeId, не заменяет turnId
  phase: 'idle' | 'running' | 'blocked' | 'unavailable';
  activeTurnId: string | null;    // null также во время ещё не подтверждённого start
  queue: { count: number; limit: 50; paused: boolean };
  blockers: RemoteBlockReason[];
  actions: { send: boolean; enqueue: boolean; steer: boolean; stop: boolean };
  requiresComputer: boolean;
  updatedAt: string;
};

export type RemoteThread = {
  grantId: string;
  title: string;                 // название явно разрешённой беседы
  projectLabel: string;          // короткое имя, без абсолютного cwd
  provider: AgentProvider;
  target: RemoteTarget | null;   // null: закрыта, восстанавливается или неоднозначна
  availability: 'available' | 'unavailable' | 'ambiguous';
};

export type RemoteAnswer = {
  answerId: string;
  turnId: string;
  text: string;                  // только итоговый текст ассистента
  completedAt: string | null;    // null, если история не сообщает время
  truncated: boolean;
};


type RemoteCommandBase = { requestId: string; target: RemoteTarget };
export type RemoteCommand = RemoteCommandBase & (
  | { kind: 'send'; text: string }
  | { kind: 'enqueue'; text: string }
  | { kind: 'steer'; text: string; expectedTurnId: string }
  | { kind: 'stop'; expectedTurnId: string }
);

export type RemoteErrorCode =
  | 'access_denied' | 'stale_target' | 'stale_turn' | 'ambiguous_owner'
  | 'unavailable' | 'blocked' | 'queue_full' | 'invalid_command'
  | 'request_conflict' | 'persistence_failed' | 'not_found';
export type RemoteError = {
  code: RemoteErrorCode;
  message: string;               // безопасный текст, без raw error/stack/команд
  requiresComputer: boolean;
  reason?: RemoteBlockReason;
};
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteError };

export type RemoteOperation = {
  operationId: string;           // внутренний UUID, постоянный
  requestId: string;
  target: RemoteTarget;          // исходный адрес, неизменяемый
  kind: RemoteCommand['kind'];
  phase: 'received' | 'queued' | 'accepted' | 'completed'
    | 'blocked' | 'stale' | 'rejected' | 'uncertain' | 'cancelled';
  revision: number;
  clientUserMessageId: string | null; // отдельный UUID для send/enqueue/steer
  expectedTurnId: string | null;
  executionTurnId: string | null; // у Claude steer может отличаться от expectedTurnId
  queuePosition: number | null;  // снимок позиции, не обещание постоянного номера
  outcome: 'succeeded' | 'interrupted' | 'failed' | null;
  error: RemoteError | null;
  createdAt: string;
  updatedAt: string;
};


export type RemoteEventNotice = { eventId: string }; // непрозрачный сигнал без содержимого
export type RemoteEvent = {
  eventId: string;
  target: RemoteTarget;
  at: string;
} & (
  | { kind: 'operation_changed'; operation: RemoteOperation }
  | { kind: 'state_changed'; state: RemoteThreadState }
  | { kind: 'answer_ready'; answer: RemoteAnswer; requestId: string | null }
  | { kind: 'computer_action_required'; message: 'Требуется действие на компьютере' }
);

export interface RemoteControl {
  listThreads(): Promise<RemoteResult<RemoteThread[]>>;
  getThreadState(target: RemoteTarget): Promise<RemoteResult<RemoteThreadState>>;
  getLastAnswer(target: RemoteTarget): Promise<RemoteResult<RemoteAnswer | null>>;
  execute(command: RemoteCommand): Promise<RemoteResult<RemoteOperation>>;
  getOperation(options: { target: RemoteTarget; requestId: string }): Promise<RemoteResult<RemoteOperation>>;
  subscribe(listener: (notice: RemoteEventNotice) => void): () => void;
  readEvent(eventId: string): Promise<RemoteResult<RemoteEvent>>;
}


// Подключение к relay-серверу (docs/RELAY_CONTRACT.md). Секрет установки и соль адресов
// в renderer не возвращаются никогда: сюда приходит только состояние.
export type RelayConnectionPhase = 'disabled' | 'unconfigured' | 'connecting' | 'online' | 'pairing' | 'error';
export type RelayPairingState = {
  pairingId: string;
  label: string;                 // имя установки, выбранное для этой привязки
  code: string;                  // одноразовый nonce, показывается только на ПК
  link: string | null;           // ссылка для QR; null, пока сервер не назвал имя бота
  expiresAt: string;
  claimant: null | { telegramUserId: string; displayName: string; username: string | null };
  confirmExpiresAt: string | null;
};
export type RelayBridgeState = {
  enabled: boolean;
  relayUrl: string;
  label: string;
  linked: boolean;               // есть действующий device credential
  encryptionAvailable: boolean;
  connection: RelayConnectionPhase;
  owner: null | { telegramUserId: string; displayName: string };
  pairing: RelayPairingState | null;
  publishedTabs: number;         // сколько разрешённых вкладок видит сервер
  error: string | null;          // очищенная причина, без секрета и без URL запроса
};
export interface RelayBridge {
  getState(): Promise<RelayBridgeState>;
  setRelayUrl(url: string): Promise<RelayBridgeState>;
  setLabel(label: string): Promise<RelayBridgeState>;
  setEnabled(enabled: boolean): Promise<RelayBridgeState>;
  startPairing(label?: string): Promise<RelayBridgeState>;
  confirmPairing(): Promise<RelayBridgeState>;
  cancelPairing(): Promise<RelayBridgeState>;
  unlink(): Promise<RelayBridgeState>;
  onState(listener: (state: RelayBridgeState) => void): () => void;
}
export type RelayConnectionSettingsProps = {
  bridge: RelayBridge;
  disabled?: boolean;
};


export type RemoteThreadAccessState = {
  provider: AgentProvider;
  threadId: string | null;
  accessRevision: string;        // CAS token локального вида, меняется при смене адреса
  enabled: boolean;
  canEnable: boolean;
  reason: string | null;         // локальное безопасное пояснение
  target: RemoteTarget | null;
};
export type SetRemoteThreadAccess = {
  enabled: boolean;
  expected: { provider: AgentProvider; threadId: string; accessRevision: string };
};

/** Одна открытая вкладка текущего окна в списке «Доступ бесед» раздела «Телефон».
 * Механика та же, что у переключателя во вкладке «Агент»: `state` приходит от ядра
 * (`grantId`/`accessRevision`), `change` вызывает тот же `setRemoteThreadAccess`.
 * `state: null` или `state.threadId: null` — беседа ещё не начата: разрешать нечего. */
export type RemoteAccessTab = {
  sessionId: string;
  title: string;
  project: string;               // короткое имя папки, без абсолютного пути
  provider: AgentProvider;
  state: RemoteThreadAccessState | null;
  busy: boolean;
  change(enabled: boolean): Promise<void>;
};

// Props именованных export-компонентов из src/PhoneAccessSettings.tsx
// и src/TelegramThreadAccess.tsx соответственно:
export type PhoneAccessSettingsProps = {
  tabs: RemoteAccessTab[];
  disabled?: boolean;
};
export type TelegramThreadAccessProps = {
  state: RemoteThreadAccessState | null;
  busy: boolean;
  disabled?: boolean;
  onChange(enabled: boolean): Promise<void>; // error/reload обрабатывает parent
};

export type RemoteDispatchContext = { operationId: string; target: RemoteTarget; kind: RemoteCommand['kind']; expectedTurnId?: string; clientUserMessageId: string | null };
export type RemoteRuntimeSnapshot = Omit<RemoteThreadState, 'target'> & { threadId: string | null; provider: AgentProvider; ready: boolean; title: string; lastAnswer: RemoteAnswer | null; reservationOperationId?: string };
export type RemoteDispatchResult = { phase: RemoteOperation['phase']; turnId?: string; queuePosition?: number; error?: RemoteError; outcome?: 'succeeded' | 'interrupted' | 'failed'; consumed?: boolean };
export type RemoteDispatchRequest = { dispatchId: string; command: RemoteCommand; operation: RemoteOperation };
