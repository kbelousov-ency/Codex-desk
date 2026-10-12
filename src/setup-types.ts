import type { AgentProvider } from './types';

export type SetupComponentId = AgentProvider | 'git';
export type SetupComponent = {
  id: SetupComponentId;
  status: 'installed' | 'missing' | 'error';
  executable?: string;
  version?: string;
  message?: string;
};
export type SetupConfigInfo = {
  targetPath: string;
  defaultPath: string;
  customHome: boolean;
  exists: boolean;
};
export type RouterStatus = {
  configured: boolean;
  reachable: boolean | null;
  baseUrl?: string;
  modelCount?: number;
  status?: number;
  message: string;
};
export type BoatswainStatus = {
  installed: boolean;
  online: boolean;
  configuredProducts: AgentProvider[];
  machine?: string;
  portal?: string;
};
export type SetupScan = {
  components: SetupComponent[];
  config: SetupConfigInfo;
  router: RouterStatus;
  platformSupported: boolean;
};
export type SetupConfigPreview = SetupConfigInfo & { previewId: string; filename: string };
export type PortalConfigFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalMs: number;
  browserOpened?: boolean;
};
export type PortalConfigValue = string | number | boolean | null;
export type PortalConfigPreview = {
  previewId: string;
  configPath: string;
  exists: boolean;
  model: string;
  providerName: string;
  providerLabel: string;
  baseUrl: string;
  changes: { key: string; before?: PortalConfigValue; after?: PortalConfigValue }[];
};
export type SetupAuthStatus = {
  state: 'signed-in' | 'signed-out' | 'provider' | 'unknown';
  message?: string;
  email?: string;
};
export type SetupProgress = {
  component: SetupComponentId;
  stage: 'installing' | 'checking' | 'done' | 'error';
  message: string;
};
/**
 * Portal sign-in state for the Kuzmich wizard. The session cookie stays in the main
 * process: only this projection crosses the bridge, never the cookie or the router key.
 * `keyState` mirrors the portal contract (docs/PORTAL_COMMITTED_API.md §3): a key may
 * exist without approval, and `held-elsewhere` names the account that already owns it.
 * `products` is the portal's own decision per agent, independent of what is installed.
 */
/**
 * Per-agent outcome of the programmatic connect (plan path A). `skipped` covers an agent
 * the portal does not allow; `error` keeps the step usable and retryable per agent.
 * `configPath`/`backupPath` are the files Kuzmich wrote, shown so the user can audit them.
 */
export type PortalConnectProductState = {
  state: 'idle' | 'working' | 'done' | 'error' | 'skipped';
  message?: string; configPath?: string; backupPath?: string | null;
};
export type PortalConnectStatus = {
  running: boolean;
  products: Partial<Record<AgentProvider, PortalConnectProductState>>;
};
export type PortalSessionStatus = {
  state: 'signed-out' | 'signing-in' | 'signed-in';
  email?: string; name?: string;
  keyState: 'none' | 'pending' | 'approved' | 'held-elsewhere';
  heldBy?: string;
  products: { codex: boolean; claude: boolean };
  message?: string;
};
export interface SetupBridge {
  state(): Promise<{ show: boolean; completed: boolean; deferred: boolean; preferredProvider?: AgentProvider; experimental3?: boolean }>;
  scan(): Promise<SetupScan>;
  checkRouter(): Promise<RouterStatus>;
  install(id: SetupComponentId): Promise<SetupScan>;
  update(id: 'codex'): Promise<SetupScan>;
  chooseExecutable(id: SetupComponentId): Promise<SetupScan | null>;
  previewConfig(): Promise<SetupConfigPreview | null>;
  applyConfig(options: { previewId: string; replaceExisting: boolean }): Promise<{ configPath: string; backupPath: string | null }>;
  startPortalConfig(): Promise<PortalConfigFlow>;
  pollPortalConfig(flowId: string): Promise<{ state: 'pending'; intervalMs: number } | { state: 'ready'; preview: PortalConfigPreview }>;
  openPortalVerification(flowId: string): Promise<void>;
  cancelPortalConfig(flowId: string): Promise<void>;
  applyPortalConfig(options: { previewId: string }): Promise<{ configPath: string; backupPath: string | null; message?: string } | { blocked: true; message: string }>;
  portalSession(options?: { refresh?: boolean }): Promise<PortalSessionStatus>;
  portalLogin(): Promise<PortalSessionStatus>;
  portalLogout(): Promise<PortalSessionStatus>;
  portalRequestKey(): Promise<PortalSessionStatus>;
  focusPortalLogin(): Promise<boolean>;
  portalConnect(options?: { products?: AgentProvider[] }): Promise<PortalConnectStatus>;
  portalConnectStatus(): Promise<PortalConnectStatus>;
  authStatus(provider: AgentProvider): Promise<SetupAuthStatus>;
  login(provider: AgentProvider): Promise<{ started: true }>;
  openPortal(): Promise<void>;
  boatswainStatus(): Promise<BoatswainStatus>;
  openGitWebsite(): Promise<void>;
  complete(options: { provider?: AgentProvider; deferred?: boolean }): Promise<void>;
  onProgress(listener: (progress: SetupProgress) => void): () => void;
}
