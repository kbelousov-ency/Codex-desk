export type ConnectionState = 'online' | 'offline' | 'unknown';
export type InstallationStatus = 'online' | 'offline' | 'pairing' | 'revoked';
export type TabStatus = 'running' | 'idle' | 'blocked' | 'unavailable' | 'ambiguous' | 'unknown';

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: Record<string, unknown>;
  version?: string;
  platform?: string;
  colorScheme?: 'light' | 'dark';
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  MainButton?: { show?: () => void; hide?: () => void; setText?: (text: string) => void };
}

export interface TelegramGlobal {
  WebApp?: TelegramWebApp;
}

export interface TelegramContext {
  initData: string;
  startParam?: string;
  isFixture: boolean;
  webApp: TelegramWebApp;
}

export interface TabSummary {
  tab_id: string;
  name: string;
  agent: string;
  project: string;
  status: TabStatus;
  queueLength: number;
  queuePaused: boolean;
  updatedAt: string;
}

export interface InstallationSummary {
  installation_id: string;
  label?: string | null;
  name?: string | null;
  status: InstallationStatus;
  last_seen_at?: string | number | null;
  revision?: number;
  tabs: TabSummary[];
}

export interface RelaySnapshot {
  revision?: number;
  kuzmich: {
    status: ConnectionState;
    updated_at?: string | null;
  };
  installations: InstallationSummary[];
}
export interface NotificationSettings {
  turnCompleted: boolean;
  actionRequired: boolean;
  commandFailed: boolean;
  presence: boolean;
}

export interface MiniAppSession {
  session_token: string;
  expires_at: string | number;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  status?: number;
}

/** Command status is kept in the relay's wire form.  The client never invents a status. */
export type CommandAction = 'send' | 'stop' | 'get_state' | 'get_last_answer';
export type CommandStatus = 'queued' | 'accepted' | 'executed' | 'uncertain' | 'rejected';
export type CommandOutcome = 'succeeded' | 'interrupted' | 'failed' | null;

export interface CommandDetail {
  code: string;
  message: string;
  requiresComputer?: boolean;
}

export interface CommandSummary {
  commandId: string;
  tabId: string;
  action: CommandAction;
  status: CommandStatus | null;
  outcome: CommandOutcome;
  dispatchState?: 'sent' | 'delivery_unknown';
  /** Relay recovery diagnostic, independent of the bridge's wire status. */
  replayUnavailable?: string | null;
  detail: CommandDetail | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandResponse {
  command: CommandSummary;
  duplicate?: boolean;
  /** Present only in the initiating POST for read actions; never returned by status GET. */
  payload?: unknown;
}

export interface SendCommandInput {
  commandId: string;
  tabId: string;
  action: CommandAction;
  text?: string;
  expectedTurnId?: string;
}
