import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CodexClient, codexVersionFrom } from './codex-client.mjs';
import { ClaudeClient, CLAUDE_CAPABILITIES } from './claude-client.mjs';
import { directoryPath, findCodex, findClaude, publicConfig } from './host-utils.mjs';
import { launchSessionTerminal } from './terminal-launcher.mjs';
import { findAcceptedMessage, uncertainDelivery } from './message-status.mjs';

const allowedMethods = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/list', 'thread/items/list', 'thread/turns/list', 'thread/name/set', 'thread/compact/start', 'turn/start', 'turn/interrupt', 'turn/steer', 'model/list', 'account/read', 'config/read', 'usage/read', 'agent/capabilities']);
const projectMethods = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/list', 'turn/start', 'config/read']);
const readOnlyMethods = new Set(['thread/read', 'thread/list', 'thread/items/list', 'thread/turns/list', 'model/list', 'account/read', 'config/read', 'usage/read', 'agent/capabilities']);
const threadUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
allowedMethods.add('message/status');
readOnlyMethods.add('message/status');

export function cleanSettings(patch) {
  const clean = {};
  for (const key of ['cwd', 'model', 'effort', 'access', 'executable']) {
    if (typeof patch?.[key] === 'string' && patch[key].length < 4096) clean[key] = patch[key];
  }
  if (patch?.provider === 'codex' || patch?.provider === 'claude') clean.provider = patch.provider;
  return clean;
}

/** Shared defaults on disk; existing sessions keep their own snapshot on reconnect. */
export class SettingsStore {
  constructor(filename) {
    this.filename = filename;
    this.queue = Promise.resolve();
  }

  async _read() {
    try {
      const settings = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
      return settings;
    }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Не удалось прочитать настройки Codex Desk.');
    }
  }

  snapshot() {
    // Reads also join the queue so they cannot see an in-progress write.
    const job = this.queue.catch(() => {}).then(() => this._read());
    this.queue = job;
    return job;
  }

  update(patch) {
    const clean = cleanSettings(patch);
    return this._update(previous => ({ ...previous, ...clean }));
  }

  async snapshotProvider(provider) {
    const current = await this.snapshot();
    if (!['codex', 'claude'].includes(provider)) throw new Error('Неизвестный агент.');
    // Legacy top-level values belong to Codex. They never seed Claude defaults.
    const profile = current.providers?.[provider];
    return { ...cleanSettings(profile || (provider === 'codex' ? current : {})), ...(current.cwd ? { cwd: current.cwd } : {}), provider };
  }

  updateProvider(provider, patch) {
    if (!['codex', 'claude'].includes(provider)) throw new Error('Неизвестный агент.');
    const clean = cleanSettings(patch); delete clean.provider;
    return this._update(previous => {
      const priorProfile = cleanSettings(previous.providers?.[provider] || (provider === 'codex' ? previous : {}));
      delete priorProfile.provider;
      return { ...previous, ...(provider === 'codex' ? clean : clean.cwd ? { cwd: clean.cwd } : {}),
        providers: { ...previous.providers, [provider]: { ...priorProfile, ...clean } } };
    });
  }

  _update(updater) {
    const job = this.queue.catch(() => {}).then(async () => {
      const next = updater(await this._read());
      await mkdir(path.dirname(this.filename), { recursive: true });
      // Readers, including the next app launch, always see one complete version.
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.filename);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.queue = job;
    return job;
  }

  async flush() {
    let pending;
    do {
      pending = this.queue;
      await pending.catch(() => {});
    } while (pending !== this.queue);
  }
}

function projectIdentity(cwd) {
  const normalized = path.normalize(cwd).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function uniqueProjects(projects) {
  const seen = new Set();
  return (Array.isArray(projects) ? projects : []).filter(cwd => {
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096) return false;
    const key = projectIdentity(cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Folder order survives restarts; thread history remains owned by Codex. */
export class WorkspaceStore extends SettingsStore {
  async snapshot() {
    const value = await super.snapshot();
    return { projects: uniqueProjects(value.projects) };
  }

  addProject(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096) throw new Error('Некорректная папка проекта.');
    return this._update(previous => ({ ...previous, projects: uniqueProjects([...(Array.isArray(previous.projects) ? previous.projects : []), cwd]) }));
  }

  initializeProjects(fallbackCwd) {
    if (typeof fallbackCwd !== 'string' || !fallbackCwd || fallbackCwd.length >= 4096) throw new Error('Некорректная папка проекта.');
    // An existing empty list means the user explicitly closed every project.
    // Only migrate settings.cwd when no project list has ever been stored.
    return this._update(previous => ({ ...previous, projects: Array.isArray(previous.projects) ? uniqueProjects(previous.projects) : [fallbackCwd] }));
  }

  removeProject(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096) throw new Error('Некорректная папка проекта.');
    const key = projectIdentity(cwd);
    return this._update(previous => ({ ...previous, projects: uniqueProjects(previous.projects).filter(folder => projectIdentity(folder) !== key) }));
  }
}

/** One tab owns one transport, boot queue, settings snapshot and approvals. */
export class WindowSession {
  constructor({ settings = {}, persistSettings = async () => {}, send = () => {}, onCwd = () => {},
    createClient = options => new CodexClient(options), resolveDirectory = directoryPath,
    resolveExecutable = findCodex, fallbackCwd = process.cwd(), launchTerminal = launchSessionTerminal, threadActions = null,
    diagnostics = null, diagnosticContext = {}, createClaudeClient = options => new ClaudeClient(options), resolveClaudeExecutable = findClaude, attachmentsDirectory, claudeHistory } = {}) {
    this.settings = cleanSettings(settings);
    this.persistSettings = persistSettings;
    this.send = send;
    this.onCwd = onCwd;
    this.createClient = createClient;
    this.createClaudeClient = createClaudeClient;
    this.resolveClaudeExecutable = resolveClaudeExecutable;
    this.attachmentsDirectory = attachmentsDirectory;
    this.claudeHistory = claudeHistory;
    this.resolveDirectory = resolveDirectory;
    this.resolveExecutable = resolveExecutable;
    this.fallbackCwd = fallbackCwd;
    this.launchTerminal = launchTerminal;
    this.threadActions = threadActions;
    this.diagnostics = diagnostics;
    this.diagnosticContext = diagnosticContext;
    this.currentThreadId = null;
    this.pendingThreadIds = new Map();
    this.messageReceipts = new Map();
    this.compactingThreads = new Set();
    this.compactingTurnIds = new Map();
    this.terminal = null;
    this.mcpRefreshing = false;
    this.pendingBoots = 0;
    this.pendingMutations = 0;
    this.activeThreadTurns = new Map();
    this.currentCwd = this.settings.cwd;
    this.client = null;
    this.bootstrap = null;
    this.executable = null;
    this.requests = new Map();
    this.bootQueue = Promise.resolve();
    this.generation = 0;
    this.disposed = false;
  }

  assertActive(generation = this.generation) {
    if (this.disposed || generation !== this.generation) throw new Error('Сеанс окна завершён.');
  }

  assertLocalControl() {
    if (this.terminal) throw new Error('Диалог открыт в терминале. Закройте терминал, чтобы продолжить здесь.');
    if (this.mcpRefreshing) throw new Error('Дождитесь обновления MCP-серверов.');
  }

  getSettings() {
    this.assertActive();
    return { ...this.settings };
  }

  setSettings(patch) {
    this.assertActive();
    this.assertLocalControl();
    const clean = cleanSettings(patch);
    if (clean.provider && clean.provider !== (this.settings.provider || 'codex')) throw new Error('Смена агента открывает отдельный диалог.');
    this.settings = { ...this.settings, ...clean };
    return this.persistSettings(clean);
  }

  start(options = {}) {
    this.assertActive();
    this.assertLocalControl();
    this.threadActions?.assertAllowed(this.currentThreadId);
    const generation = this.generation;
    this.pendingBoots++;
    const job = this.bootQueue.catch(() => {}).then(() => this._boot(options ?? {}, generation)).finally(() => { this.pendingBoots--; });
    this.bootQueue = job;
    return job;
  }

  async _boot(options, generation) {
    this.assertActive(generation);
    this.assertLocalControl();
    this.threadActions?.assertAllowed(this.currentThreadId);
    const cwd = await this.resolveDirectory(options.cwd || this.currentCwd || this.settings.cwd || this.fallbackCwd);
    this.assertActive(generation);
    const provider = this.settings.provider || 'codex';
    const nextExecutable = await (provider === 'claude' ? this.resolveClaudeExecutable : this.resolveExecutable)(this.settings.executable);
    this.assertActive(generation);
    if (this.bootstrap && this.client && this.currentCwd === cwd && this.executable === nextExecutable) return this.bootstrap;
    const previous = this.client;
    this.mcpConfigService?.dispose(); this.mcpConfigService = null;
    this.client = null;
    previous?.stop();
    this.requests.clear();
    this.activeThreadTurns.clear();
    this.compactingThreads.clear();
    this.compactingTurnIds.clear();
    this.bootstrap = null;
    this.currentCwd = cwd;
    this.settings = { ...this.settings, cwd };
    this.executable = nextExecutable;
    this.onCwd(cwd);
    const owned = (provider === 'claude' ? this.createClaudeClient : this.createClient)({ executable: nextExecutable, cwd, ...(provider === 'claude' ? { settings: this.settings, attachmentsDirectory: this.attachmentsDirectory, history: this.claudeHistory } : {}), ...(this.diagnostics ? {
      diagnostics: this.diagnostics, diagnosticContext: { ...this.diagnosticContext, projectId: this.diagnostics.id(cwd) },
    } : {}) });
    this.client = owned;
    const current = () => !this.disposed && generation === this.generation && owned === this.client;
    const checkCurrent = () => {
      this.assertActive(generation);
      if (owned !== this.client) throw new Error('Подключение Codex изменилось.');
    };
    for (const event of ['notification', 'serverRequest', 'status', 'diagnostic']) {
      owned.on(event, data => {
        if (!current()) return;
        if (event === 'notification' && ['item/started', 'item/completed'].includes(data.method) && data.params?.item?.type === 'userMessage') {
          const { item, threadId, turnId } = data.params;
          for (const id of [item.clientId, item.clientUserMessageId, item.id].filter(Boolean)) this.rememberMessage(threadId, id, { accepted: true, turnId, item });
        }
        if (event === 'notification' && data.method === 'message/receipt') {
          const { threadId, clientUserMessageId, ...receipt } = data.params;
          this.rememberMessage(threadId, clientUserMessageId, receipt);
        }
        if (event === 'serverRequest') this.requests.set(data.id, data);
        if (event === 'notification' && data.method === 'serverRequest/resolved') this.requests.delete(data.params?.requestId);
        if (event === 'notification' && data.method === 'thread/started' && data.params?.thread?.id) {
          this.currentThreadId = data.params.thread.id;
          this.threadActions?.remember(data.params.thread);
        }
        if (event === 'notification' && this.compactingThreads.has(data.params?.threadId)) {
          const threadId = data.params.threadId;
          if (data.method === 'turn/started' && data.params?.turn?.id) this.compactingTurnIds.set(threadId, data.params.turn.id);
          const compactionTurn = this.compactingTurnIds.get(threadId);
          const completedTurn = data.method === 'turn/completed' && compactionTurn && compactionTurn === data.params?.turn?.id;
          const completedItem = !compactionTurn && (data.method === 'thread/compacted' || (data.method === 'item/completed' && data.params?.item?.type === 'contextCompaction'));
          const failed = data.method === 'error' && !data.params?.willRetry && (!compactionTurn || !data.params?.turnId || data.params.turnId === compactionTurn);
          if (completedTurn || completedItem || failed) { this.compactingThreads.delete(threadId); this.compactingTurnIds.delete(threadId); }
        }
        if (event === 'notification' && data.method === 'turn/started' && data.params?.threadId && data.params?.turn?.id) this.activeThreadTurns.set(data.params.threadId, data.params.turn.id);
        if (event === 'notification' && data.method === 'turn/completed' && this.activeThreadTurns.get(data.params?.threadId) === data.params?.turn?.id) this.activeThreadTurns.delete(data.params.threadId);
        if (event === 'notification' && data.method === 'turn/completed') {
          for (const [key, receipt] of this.messageReceipts) if (key.startsWith(`${data.params.threadId}:`) && receipt.turnId === data.params.turn.id) receipt.status = data.params.turn.status;
        }
        if (event === 'status' && ['error', 'stopped'].includes(data.state)) {
          this.client = null;
          this.bootstrap = null;
          this.requests.clear();
          this.activeThreadTurns.clear();
          this.compactingThreads.clear();
          this.compactingTurnIds.clear();
        }
        this.send(event, data);
      });
    }
    try {
      const initialize = await owned.start();
      checkCurrent();
      const models = [];
      let cursor;
      do {
        const page = await owned.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100 });
        checkCurrent();
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      const [account, configResponse] = await Promise.all([
        owned.request('account/read', { refreshToken: false }),
        owned.request('config/read', { cwd, includeLayers: false }),
      ]);
      checkCurrent();
      await this.setSettings({ cwd });
      checkCurrent();
      const cliVersion = provider === 'claude' ? (typeof initialize?.version === 'string' ? initialize.version : undefined) : codexVersionFrom(initialize?.userAgent);
      this.bootstrap = { initialize, models, account, config: publicConfig(configResponse.config), cwd, executable: nextExecutable, provider, ...(cliVersion ? { cliVersion } : {}),
        capabilities: provider === 'claude' ? { ...CLAUDE_CAPABILITIES } : { compact: true, steer: true, terminal: true, mcp: true, archive: true, usage: false } };
      return this.bootstrap;
    } catch (error) {
      const failedCurrent = current();
      if (failedCurrent) {
        this.client = null;
        this.bootstrap = null;
        this.requests.clear();
      }
      owned.stop();
      if (failedCurrent && !this.disposed && generation === this.generation) this.send('status', { state: 'error', message: error.message });
      throw error;
    }
  }

  async request(method, params = {}) {
    this.assertActive();
    if (!allowedMethods.has(method)) throw new Error('Этот метод недоступен в Codex Desk.');
    if (params.threadId && (this.settings.provider === 'claude') !== String(params.threadId).startsWith('claude:')) throw new Error('Диалог принадлежит другому агенту.');
    const mutation = !readOnlyMethods.has(method);
    if (mutation) {
      this.assertLocalControl();
      this.threadActions?.assertAllowed(params.threadId || this.currentThreadId);
    }
    if (!this.client || !this.bootstrap) throw new Error('Нет подключения к Codex. Нажмите «Подключиться».');
    const owned = this.client;
    const generation = this.generation;
    if (method === 'message/status') {
      if (!params.threadId || !threadUuid.test(params.clientUserMessageId || '')) throw new Error('Некорректный идентификатор сообщения.');
      const key = `${params.threadId}:${params.clientUserMessageId}`;
      const receipt = this.messageReceipts.get(key);
      if (receipt?.accepted || receipt?.rejected) return { ...receipt, status: this.activeThreadTurns.get(params.threadId) === receipt.turnId ? 'inProgress' : receipt.status };
      const read = await owned.request('thread/read', { threadId: params.threadId, includeTurns: true });
      this.assertActive(generation);
      if (owned !== this.client) throw new Error('Подключение Codex изменилось.');
      if (read.thread?.id !== params.threadId) throw new Error('Агент вернул другой диалог при проверке отправки.');
      const found = findAcceptedMessage(read.thread, params.clientUserMessageId);
      if (found) { this.rememberMessage(params.threadId, params.clientUserMessageId, found); return found; }
      return { accepted: false, rejected: false };
    }
    // Project operations and history remain bound to this tab's working folder.
    if (projectMethods.has(method)) params = { ...params, cwd: this.currentCwd };
    if (mutation) {
      this.pendingMutations++;
      if (params.threadId) this.pendingThreadIds.set(params.threadId, (this.pendingThreadIds.get(params.threadId) || 0) + 1);
      if (method === 'thread/compact/start') { this.compactingThreads.add(params.threadId); this.compactingTurnIds.set(params.threadId, null); }
    }
    let result;
    try { result = await owned.request(method, params); }
    catch (error) {
      if (method === 'thread/compact/start') { this.compactingThreads.delete(params.threadId); this.compactingTurnIds.delete(params.threadId); }
      if (['turn/start', 'turn/steer'].includes(method) && params.clientUserMessageId && typeof error.code === 'number' && !uncertainDelivery(error)) this.rememberMessage(params.threadId, params.clientUserMessageId, { accepted: false, rejected: true });
      throw error;
    }
    finally {
      if (mutation) {
        this.pendingMutations--;
        if (params.threadId) {
          const pending = (this.pendingThreadIds.get(params.threadId) || 1) - 1;
          if (pending) this.pendingThreadIds.set(params.threadId, pending); else this.pendingThreadIds.delete(params.threadId);
        }
      }
    }
    this.assertActive(generation);
    if (owned !== this.client) throw new Error('Подключение Codex изменилось.');
    if (['turn/start', 'turn/steer'].includes(method) && params.clientUserMessageId) this.rememberMessage(params.threadId, params.clientUserMessageId, { accepted: true, turnId: result.turn?.id || result.turnId, status: result.turn?.status });
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method) && result?.thread?.id) this.currentThreadId = result.thread.id;
    if (method === 'turn/start' && result?.turn?.status === 'inProgress' && result.turn.id) this.activeThreadTurns.set(params.threadId, result.turn.id);
    if (result?.thread) this.threadActions?.remember(result.thread);
    return method === 'config/read' ? { ...result, config: publicConfig(result.config), layers: null, origins: {} } : result;
  }

  rememberMessage(threadId, id, receipt) {
    if (!threadId || !id) return;
    const key = `${threadId}:${id}`;
    if (this.messageReceipts.get(key)?.accepted && !receipt.accepted) return;
    this.messageReceipts.set(key, receipt);
    if (this.messageReceipts.size > 1000) this.messageReceipts.delete(this.messageReceipts.keys().next().value);
  }

  async respond(id, result) {
    this.assertActive();
    this.assertLocalControl();
    this.threadActions?.assertAllowed(this.currentThreadId);
    if (!this.client || !this.requests.has(id)) throw new Error('Запрос уже завершён.');
    this.requests.delete(id);
    await this.client.respond(id, result);
  }

  async mcpRuntime(check = false) {
    if (this.settings.provider === 'claude') throw new Error('MCP Claude Code управляется через его CLI и настройки.');
    this.assertActive();
    const deferred = () => ({ status: 'deferred', message: 'Дождитесь завершения задачи и закройте терминал, затем примените MCP в этой сессии.' });
    if (this.terminal || this.mcpRefreshing || this.pendingBoots || this.pendingMutations || this.requests.size || this.activeThreadTurns.size || this.compactingThreads.size) {
      if (check) return { servers: [], message: deferred().message };
      return deferred();
    }
    if (!this.client || !this.bootstrap) throw new Error('Нет подключения к Codex. Подключите сессию и повторите.');
    const owned = this.client, generation = this.generation;
    this.mcpRefreshing = true;
    this.send('mcp', { state: 'refreshing' });
    try {
      await owned.request('config/mcpServer/reload', {});
      this.assertActive(generation);
      if (owned !== this.client) throw new Error('Подключение изменилось.');
      if (!check) return { status: 'applied', message: 'Codex перечитал MCP. Обновление подключений применяется к следующим запросам этой сессии.' };
      const servers = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await owned.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly', ...(this.currentThreadId ? { threadId: this.currentThreadId } : {}), ...(cursor ? { cursor } : {}) });
        this.assertActive(generation);
        if (owned !== this.client) throw new Error('Подключение изменилось.');
        for (const server of page.data || []) servers.push({ name: server.name, authStatus: server.authStatus || 'unknown', status: typeof server.runtimeStatus === 'string' ? server.runtimeStatus : server.runtimeStatus?.state || 'unknown', toolCount: Object.keys(server.tools || {}).length });
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Повтор страницы.');
        seen.add(cursor);
      } while (cursor);
      return { servers, message: 'Статус по данным Codex; неизвестный статус не подтверждает подключение. Инструменты не запускались.' };
    } catch {
      throw new Error('Не удалось обновить или проверить MCP через Codex. Проверьте доступность сервера и поддержку MCP в установленной версии.');
    } finally {
      this.mcpRefreshing = false;
      if (!this.disposed && generation === this.generation) this.send('mcp', { state: 'ready' });
    }
  }

  async openTerminal(options = {}) {
    this.assertActive();
    this.assertLocalControl();
    const provider = this.settings.provider || 'codex';
    const rawThreadId = provider === 'claude' && typeof options?.threadId === 'string' ? options.threadId.replace(/^claude:/, '') : options?.threadId;
    if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.threadId !== 'string' || !threadUuid.test(rawThreadId) || (provider === 'claude' && !options.threadId.startsWith('claude:'))) throw new Error('Некорректный идентификатор диалога.');
    this.threadActions?.assertAllowed(options.threadId);
    if (!this.client || !this.bootstrap || !this.executable) throw new Error('Нет подключения к Codex.');
    if (this.pendingBoots || this.pendingMutations || this.requests.size || this.activeThreadTurns.has(options.threadId) || this.compactingThreads.has(options.threadId)) throw new Error('Дождитесь завершения работы и подтверждений Codex.');
    const threadId = options.threadId;
    const owned = this.client;
    const generation = this.generation;
    const cwd = this.currentCwd;
    const executable = this.executable;
    const model = options.model ?? this.settings.model ?? '';
    const effort = options.effort ?? this.settings.effort ?? '';
    const access = options.access ?? this.settings.access ?? 'inherited';
    if (typeof model !== 'string' || model.length > 256 || (model && !(provider === 'claude' ? /^[a-zA-Z0-9][a-zA-Z0-9._/:+\[\]\-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]*$/).test(model))) throw new Error('Некорректный идентификатор модели.');
    if (typeof effort !== 'string' || effort.length > 64 || (effort && !/^[a-zA-Z0-9_-]+$/.test(effort))) throw new Error('Некорректный уровень рассуждений.');
    if (!['inherited', 'auto', 'read-only', 'workspace-write', 'danger-full-access'].includes(access)) throw new Error('Неизвестный режим доступа.');
    const terminal = { threadId, child: null, paused: false };
    // Reserve before the read so another IPC cannot start a turn or change cwd.
    this.terminal = terminal;
    try {
      const result = await owned.request('thread/read', { threadId, includeTurns: true });
      this.assertActive(generation);
      if (this.terminal !== terminal || this.client !== owned || this.currentCwd !== cwd || this.executable !== executable) throw new Error('Подключение Codex изменилось.');
      const thread = result?.thread;
      if (thread?.id !== threadId) throw new Error('Codex вернул другой диалог.');
      if (thread.cwd && path.resolve(thread.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error('Диалог находится в другой рабочей папке.');
      if (thread.status?.type === 'active' || thread.turns?.some(turn => turn.status === 'inProgress') || this.activeThreadTurns.has(threadId) || this.requests.size || this.pendingMutations) throw new Error('Дождитесь завершения работы и подтверждений Codex.');
      terminal.paused = true;
      this.stop();
      const terminalGeneration = this.generation;
      const child = this.launchTerminal({ executable, cwd, threadId, model, effort, access, ...(provider === 'claude' ? { provider } : {}) });
      terminal.child = child;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const closed = (error, exitCode, signal) => {
          if (this.terminal !== terminal) return;
          this.terminal = null;
          const context = { ...this.diagnosticContext, threadId: this.diagnostics?.id(threadId), exitCode, signal };
          if (error) this.diagnostics?.error('terminal.failed', error, context);
          else this.diagnostics?.record('info', 'terminal.closed', context);
          if (!settled) { settled = true; reject(error || new Error('Терминал закрылся до запуска.')); }
          if (!this.disposed) this.send('terminal', { state: 'closed', threadId, ...(error ? { error: error.message || String(error) } : {}) });
        };
        child.once('error', closed);
        child.once('close', (code, signal) => closed(code || signal ? new Error(`Терминал завершился ${signal ? `по сигналу ${signal}` : `с кодом ${code}`}.`) : undefined, code, signal));
        child.once('spawn', () => {
          child.unref?.();
          if (settled) return;
          settled = true;
          if (this.disposed || this.terminal !== terminal || this.generation !== terminalGeneration) { reject(new Error('Сеанс окна завершён.')); return; }
          this.send('terminal', { state: 'opened', threadId });
          this.diagnostics?.record('info', 'terminal.opened', { ...this.diagnosticContext, threadId: this.diagnostics.id(threadId) });
          resolve({ threadId });
        });
      });
    } catch (error) {
      // The console, once created, owns its lifetime even if the app is closed.
      if (this.terminal === terminal && !terminal.child) {
        this.terminal = null;
        if (terminal.paused && !this.disposed) this.send('terminal', { state: 'closed', threadId, error: error.message || String(error) });
      }
      throw error;
    }
  }

  stop() {
    this.mcpConfigService?.dispose(); this.mcpConfigService = null;
    // Invalidates both in-flight awaits and queued boots, including renderer crashes.
    this.generation += 1;
    const owned = this.client;
    this.client = null;
    this.bootstrap = null;
    this.requests.clear();
    this.activeThreadTurns.clear();
    this.compactingThreads.clear();
    this.compactingTurnIds.clear();
    this.bootQueue = Promise.resolve();
    owned?.stop();
  }

  dispose() {
    this.diagnostics?.record('info', 'session.disposed', this.diagnosticContext);
    this.disposed = true;
    this.stop();
  }
}

/** A session ID is valid only inside the window whose main frame sent the IPC. */
export function windowForEvent(windows, event) {
  const record = windows.get(event.sender.id);
  if (!record || record.window.isDestroyed() || event.sender !== record.window.webContents ||
    event.senderFrame !== record.window.webContents.mainFrame) {
    throw new Error('Недопустимый источник запроса.');
  }
  return record;
}

export function sessionForEvent(windows, event, sessionId) {
  const record = windowForEvent(windows, event);
  const id = sessionId === undefined ? record.defaultSessionId : sessionId;
  const session = typeof id === 'string' ? record.sessions.get(id) : undefined;
  if (!session || session.disposed) throw new Error('Недопустимая или закрытая сессия.');
  return { ...record, session, sessionId: id };
}
