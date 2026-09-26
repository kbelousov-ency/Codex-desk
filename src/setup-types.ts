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
export type SetupScan = {
  components: SetupComponent[];
  config: SetupConfigInfo;
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
export interface SetupBridge {
  state(): Promise<{ show: boolean; completed: boolean; deferred: boolean; preferredProvider?: AgentProvider }>;
  scan(): Promise<SetupScan>;
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
  authStatus(provider: AgentProvider): Promise<SetupAuthStatus>;
  login(provider: AgentProvider): Promise<{ started: true }>;
  openPortal(): Promise<void>;
  openGitWebsite(): Promise<void>;
  complete(options: { provider?: AgentProvider; deferred?: boolean }): Promise<void>;
  onProgress(listener: (progress: SetupProgress) => void): () => void;
}
