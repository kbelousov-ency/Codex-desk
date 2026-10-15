import { FIXTURE_SNAPSHOT } from './fixture';
import type { ApiErrorShape, CommandResponse, CommandSummary, MiniAppSession, NotificationSettings, RelaySnapshot, SendCommandInput } from './types';

export interface RelayApiOptions {
  baseUrl?: string;
  initData: string;
  fixture?: boolean;
  fetchImpl?: typeof fetch;
}

export class RelayApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(shape: ApiErrorShape) {
    super(friendlyErrorMessage(shape.code, shape.message));
    this.name = 'RelayApiError';
    this.code = shape.code;
    this.status = shape.status;
  }
}

function friendlyErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'telegram_init_data_missing':
    case 'expired_init_data':
    case 'invalid_init_data':
    case 'session_expired': return 'Откройте приложение заново из Telegram.';
    case 'origin_not_allowed': return 'Приложение открыто с недопустимого адреса.';
    case 'rate_limited': return 'Слишком много запросов. Попробуйте позже.';
    case 'relay_unavailable': return 'Сервер Кузьмича временно недоступен.';
    case 'credential_verifier_unavailable': return 'Сервер временно не может проверить вход. Попробуйте позже.';
    case 'pairing_not_found':
    case 'pairing_expired': return 'Код привязки недействителен или срок его действия истёк.';
    case 'pairing_attempts_exhausted': return 'Код привязки больше нельзя использовать. Создайте новый на компьютере.';
    default: return fallback;
  }
}

export class RelayApi {
  private readonly baseUrl: string;
  private readonly initData: string;
  private readonly fixture: boolean;
  private readonly fetchImpl: typeof fetch;
  private session?: MiniAppSession;
  private fixtureSnapshot?: RelaySnapshot;
  private readonly fixtureCommands = new Map<string, CommandResponse & { __text?: string; __expectedTurnId?: string }>();
  private readonly commandListeners = new Set<(installationId: string, command: CommandSummary) => void>();

  constructor(options: RelayApiOptions) {
    this.baseUrl = options.baseUrl ?? (import.meta.env.VITE_RELAY_URL || '/api');
    this.initData = options.initData;
    this.fixture = Boolean(options.fixture);
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.fixtureSnapshot = this.fixture ? structuredClone(FIXTURE_SNAPSHOT) : undefined;
  }

  async getSnapshot(signal?: AbortSignal): Promise<RelaySnapshot> {
    if (this.fixture) return structuredClone(this.fixtureSnapshot ?? FIXTURE_SNAPSHOT);
    await this.ensureSession(signal);
    const payload = await this.request<ServerInstallationsResponse>('/installations', { signal });
    return normalizeSnapshot(payload);
  }

  async getNotificationSettings(signal?: AbortSignal): Promise<NotificationSettings> {
    if (this.fixture) return { turnCompleted: true, actionRequired: true, commandFailed: true, presence: true };
    await this.ensureSession(signal);
    return this.request<NotificationSettings>('/notifications', { signal });
  }

  async updateNotificationSettings(settings: NotificationSettings, signal?: AbortSignal): Promise<NotificationSettings> {
    if (this.fixture) return settings;
    await this.ensureSession(signal);
    return this.request<NotificationSettings>('/notifications', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings), signal
    });
  }

  async unbind(installationId: string, signal?: AbortSignal): Promise<void> {
    if (this.fixture) {
      if (this.fixtureSnapshot) {
        this.fixtureSnapshot.installations = this.fixtureSnapshot.installations.filter((item) => item.installation_id !== installationId);
        this.fixtureSnapshot.kuzmich.status = this.fixtureSnapshot.installations.some((item) => item.status === 'online') ? 'online' : 'offline';
      }
      return;
    }
    await this.ensureSession(signal);
    await this.request<{ ok: true }>(`/installations/${encodeURIComponent(installationId)}`, {
      method: 'DELETE',
      signal
    });
  }

  /** Submit one command. The caller owns commandId and may safely submit it again. */
  async sendCommand(installationId: string, input: SendCommandInput, signal?: AbortSignal): Promise<CommandResponse> {
    if (this.fixture) return this.fixtureSendCommand(installationId, input);
    await this.ensureSession(signal);
    const raw = await this.request<CommandResponse | CommandSummary>(`/installations/${encodeURIComponent(installationId)}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal
    });
    return normalizeCommandResponse(raw);
  }

  /** Status-only lookup. It is intentionally separate from read-action payload delivery. */
  async getCommand(installationId: string, commandId: string, signal?: AbortSignal): Promise<CommandSummary> {
    if (this.fixture) {
      const response = this.fixtureCommands.get(`${installationId}:${commandId}`);
      if (!response) throw new RelayApiError({ code: 'command_not_found', message: 'Команда не найдена.', status: 404 });
      return structuredClone(response.command);
    }
    await this.ensureSession(signal);
    const raw = await this.request<{ command?: CommandSummary } | CommandSummary>(
      `/installations/${encodeURIComponent(installationId)}/commands/${encodeURIComponent(commandId)}`,
      { signal }
    );
    return normalizeCommand(raw);
  }

  async claimPairing(nonce: string, signal?: AbortSignal): Promise<{ pairing_id: string; status: string; expires_at: string | number }> {
    if (this.fixture) return { pairing_id: 'fixture-pairing', status: 'phone_confirmed', expires_at: Date.now() + 600_000 };
    await this.ensureSession(signal);
    return this.request('/pairings/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, confirm: true }),
      signal
    });
  }

  /** URL for the optional live stream. Consumers still keep polling as a resync fallback. */
  streamUrl(): string {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/events`, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  getSessionId(): string | undefined {
    return this.session?.session_token;
  }

  /** Subscribe to status-only WebSocket command updates; payloads are never accepted here. */
  subscribeCommands(listener: (installationId: string, command: CommandSummary) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  receiveCommandUpdate(installationId: string, command: CommandSummary): void {
    const normalized = normalizeCommand(command);
    for (const listener of this.commandListeners) {
      try { listener(installationId, normalized); } catch { /* a view must not break the stream */ }
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.session && toEpochMs(this.session.expires_at) > Date.now() + 15_000) return;
    if (!this.initData) throw new RelayApiError({ code: 'telegram_init_data_missing', message: 'Откройте приложение из Telegram.' });
    this.session = await this.request<MiniAppSession>('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: this.initData }),
      signal,
      includeSession: false
    });
  }

  private async request<T>(path: string, options: RequestInit & { includeSession?: boolean } = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (options.includeSession !== false && this.session?.session_token) {
      headers.set('Authorization', `Bearer ${this.session.session_token}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers
    });
    if (!response.ok) {
      let body: { error?: Partial<ApiErrorShape> } = {};
      try {
        body = await response.json();
      } catch {
        // The relay may be unavailable before an HTTP response is produced.
      }
      throw new RelayApiError({
        code: body.error?.code || (response.status >= 500 ? 'relay_unavailable' : 'request_failed'),
        message: body.error?.message || `Ошибка relay (${response.status}).`,
        status: response.status
      });
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private fixtureSendCommand(installationId: string, input: SendCommandInput): CommandResponse {
    const installation = this.fixtureSnapshot?.installations.find((item) => item.installation_id === installationId);
    if (!installation || installation.status !== 'online') {
      throw new RelayApiError({ code: 'not_connected', message: 'Компьютер сейчас не подключён.', status: 409 });
    }
    const key = `${installationId}:${input.commandId}`;
    const existing = this.fixtureCommands.get(key);
    if (existing) {
      const same = existing.command.tabId === input.tabId && existing.command.action === input.action &&
        (input.action !== 'send' || existing.__text === input.text) &&
        (input.action !== 'stop' || existing.__expectedTurnId === input.expectedTurnId);
      if (!same) throw new RelayApiError({ code: 'request_conflict', message: 'Этот идентификатор уже использован для другой команды.', status: 409 });
      // Read payloads are one-shot HTTP responses. A duplicate is a status lookup,
      // never a replay of the assistant text or state snapshot.
      return structuredClone({ command: existing.command, duplicate: true });
    }
    const now = new Date().toISOString();
    const terminal = input.action === 'send' || input.action === 'stop' || input.action === 'get_state' || input.action === 'get_last_answer';
    const command: CommandSummary = { commandId: input.commandId, tabId: input.tabId, action: input.action,
      status: terminal ? 'executed' : null, outcome: terminal ? (input.action === 'stop' ? 'interrupted' : 'succeeded') : null,
      dispatchState: 'sent', detail: null, createdAt: now, updatedAt: now };
    const response: CommandResponse & { __text?: string; __expectedTurnId?: string } = { command, duplicate: false };
    response.__text = input.text;
    response.__expectedTurnId = input.expectedTurnId;
    if (input.action === 'get_state') response.payload = { state: { tabId: input.tabId, title: 'Демо-проект', agent: 'Codex', project: 'CodexDesk', status: 'running', queueLength: 2, queuePaused: false, updatedAt: now, activeTurnId: 'fixture-turn-1', actions: { send: true, stop: true } } };
    if (input.action === 'get_last_answer') response.payload = { answer: { answerId: 'fixture-answer-1', turnId: 'fixture-turn-1', text: 'Ответ фиктивного bridge.', truncated: false, completedAt: now } };
    this.fixtureCommands.set(key, response);
    const first = structuredClone({ command, duplicate: false, ...(response.payload === undefined ? {} : { payload: response.payload }) });
    if (input.action === 'get_state' || input.action === 'get_last_answer') delete response.payload;
    return first;
  }
}

interface ServerTab {
  tab_id: string;
  title: string;
  agent: string;
  project: string;
  status: string;
  queueLength: number;
  queuePaused: boolean;
  updatedAt: string;
}

interface ServerInstallation {
  installation_id: string;
  label?: string | null;
  online: boolean;
  last_seen?: string | number | null;
  revision?: number;
  tabs: ServerTab[];
}

export interface ServerInstallationsResponse {
  revision?: number;
  installations: ServerInstallation[];
}

export function normalizeSnapshot(payload: ServerInstallationsResponse): RelaySnapshot {
  const installations = (payload.installations ?? []).map((installation) => ({
    installation_id: installation.installation_id,
    label: installation.label,
    name: installation.label,
    status: installation.online ? 'online' as const : 'offline' as const,
    last_seen_at: installation.last_seen,
    revision: installation.revision,
    tabs: (installation.tabs ?? []).map((tab) => ({
      tab_id: tab.tab_id,
      name: tab.title,
      agent: tab.agent,
      project: tab.project,
      status: normalizeTabStatus(tab.status),
      queueLength: tab.queueLength,
      queuePaused: tab.queuePaused,
      updatedAt: tab.updatedAt
    }))
  }));
  return {
    revision: payload.revision,
    kuzmich: { status: installations.some((item) => item.status === 'online') ? 'online' : 'offline' },
    installations
  };
}

function normalizeTabStatus(status: string): import('./types').TabStatus {
  if (status === 'running' || status === 'idle' || status === 'blocked' || status === 'unavailable' || status === 'ambiguous') return status;
  return 'unknown';
}

function toEpochMs(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value);
}

export function normalizeCommandResponse(raw: CommandResponse | CommandSummary): CommandResponse {
  if ('command' in raw && raw.command) return { command: normalizeCommand(raw.command), duplicate: raw.duplicate, ...(raw.payload === undefined ? {} : { payload: raw.payload }) };
  return { command: normalizeCommand(raw) };
}

export function normalizeCommand(raw: CommandSummary | { command?: CommandSummary }): CommandSummary {
  const command = 'command' in raw && raw.command ? raw.command : raw as CommandSummary;
  return {
    commandId: command.commandId,
    tabId: command.tabId,
    action: command.action,
    status: command.status ?? null,
    outcome: command.outcome ?? null,
    dispatchState: command.dispatchState,
    replayUnavailable: typeof command.replayUnavailable === 'string' ? command.replayUnavailable : null,
    detail: command.detail ?? null,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt
  };
}
