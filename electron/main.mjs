import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, safeStorage, shell } from 'electron';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { directoryPath, decodeImage } from './host-utils.mjs';
import { openLink, showLocalPathMenu } from './file-links.mjs';
import { listProjectThreads } from './project-history.mjs';
import { listProjectFiles } from './project-files.mjs';
import { getGitStatus, getGitDiff } from './git-reader.mjs';
import { GitRollbackService } from './git-rollback.mjs';
import { createWorktree, mergeWorktree, previewWorktreeMerge, removeWorktree, worktreeSummary } from './git-worktree.mjs';
import { prepareComposerFiles } from './composer-files.mjs';
import { readClipboardFilePaths } from './clipboard-files.mjs';
import { ClaudeHistory } from './claude-history.mjs';
import { ClaudeThreadManagement } from './claude-threads.mjs';
import { ClaudeArchiveStore } from './claude-archive.mjs';
import { ClaudeAuthService } from './claude-auth.mjs';
import { ClaudeLaunchGate, ClaudeTokenStore } from './claude-token.mjs';
import { HistorySearch } from './history-search.mjs';
import { BookmarkStore } from './bookmarks.mjs';
import { searchProjectFiles, readProjectFile } from './file-viewer.mjs';
import { saveConversation } from './conversation-export.mjs';
import { ThreadActionCoordinator, ThreadManagement } from './thread-management.mjs';
import { McpConfigService } from './mcp-service.mjs';
import { readAttachment, hydrateAttachmentPreviews } from './attachments.mjs';
import { SettingsStore, WorkspaceStore, WindowSession, cleanSettings, sessionForEvent, windowForEvent } from './window-session.mjs';
import { createDiagnostics } from './diagnostics.mjs';
import { resolveReleaseChannel, resolveChannelPaths, initializeChannelProfile } from './release-channel.mjs';
import { createNightlyUpdate } from './nightly-update.mjs';
import { captureUpdateCheckpoint, createUpdateCheckpoint } from './update-checkpoint.mjs';
import { captureWorkspaceState, createWorkspaceState, createWorkspaceSaveHandshake } from './workspace-state.mjs';
import { NotificationService, NotificationSettingsStore } from './notification-service.mjs';
import { applicationIdentity } from './app-identity.mjs';
import { persistShellIcon, watchShellShortcutIcon } from './windows-shell-icon.mjs';
import { SetupService } from './setup-service.mjs';
import { SetupAuth, setupProvider } from './setup-auth.mjs';
import { AppUpdateService, AppUpdateStore } from './app-updates.mjs';
import { RouterUsageClient } from './router-usage.mjs';
import { ReleaseNotesService, ReleaseNotesStore, parseReleaseNotes } from './release-notes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let buildInfo = {};
try { buildInfo = JSON.parse(readFileSync(path.join(here, 'build-info.json'), 'utf8')); } catch { /* Development build. */ }
let releaseNotes = [];
try { releaseNotes = parseReleaseNotes(JSON.parse(readFileSync(path.join(here, 'release-notes.json'), 'utf8'))); }
catch {
  // Source runs do not have the packaged artifact; keep the same notes as a
  // packaged build by reading the repository changelog when available.
  try { releaseNotes = parseReleaseNotes(readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8')); } catch { /* no notes in a minimal fixture */ }
}
let releaseInfo;
try { releaseInfo = resolveReleaseChannel({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, buildInfo: { ...buildInfo, version: buildInfo.version || app.getVersion() } }); }
catch {
  dialog.showErrorBox('Не удалось открыть Codex Desk', 'Повреждены сведения о канале сборки. Скопируйте всю папку приложения заново.');
  app.exit(1);
  throw new Error('Invalid release channel metadata.');
}
const channelLabel = { stable: 'Release', nightly: 'Nightly', development: 'Development' }[releaseInfo.channel];
const channelPaths = resolveChannelPaths({ appData: app.getPath('appData'), channel: releaseInfo.channel, dataDirOverride: process.env.CODEX_DESK_DATA_DIR });
const standardChannelPaths = resolveChannelPaths({ appData: app.getPath('appData'), channel: releaseInfo.channel });
const isolatedProfile = path.resolve(channelPaths.userData).toLowerCase() !== path.resolve(standardChannelPaths.userData).toLowerCase();
const identity = applicationIdentity(releaseInfo.channel, process.env.CODEX_DESK_TEST === '1' || isolatedProfile ? process.pid : undefined);
const applicationName = identity.name;
let windowIcon = path.join(here, 'icon.ico');
let shellIcon = app.getPath('exe');
let stopWatchingShellIcon;
app.setName(applicationName);
app.setPath('userData', channelPaths.userData);
app.setAppUserModelId(identity.appId);
const diagnosticsDirectory = path.join(channelPaths.userData, 'logs');
const diagnostics = createDiagnostics({ directory: diagnosticsDirectory, metadata: {
  appVersion: app.getVersion(), electronVersion: process.versions.electron, chromeVersion: process.versions.chrome,
  nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, osRelease: os.release(),
  packaged: app.isPackaged, buildId: releaseInfo.buildId, builtAt: releaseInfo.builtAt, releaseChannel: releaseInfo.channel,
} });
diagnostics.record('info', 'app.start');
// Observe fatal errors without suppressing Electron's normal fatal-error handling.
process.on('uncaughtExceptionMonitor', error => diagnostics.error('app.fatal', error));
process.on('unhandledRejection', error => diagnostics.error('app.unhandled', error));
app.on('child-process-gone', (_event, details) => diagnostics.record('error', 'app.childGone', { reason: details.reason, exitCode: details.exitCode }));
const windows = new Map();
const releaseNotesStore = new ReleaseNotesStore(path.join(channelPaths.userData, 'release-state.json'));
let releaseNotesService;
const appUpdates = new AppUpdateService({
  buildInfo: releaseInfo,
  store: new AppUpdateStore(path.join(channelPaths.userData, 'updates.json')),
  fetch: (url, options) => net.fetch(url, options),
  openExternal: url => shell.openExternal(url),
  // Test/isolated profiles must not poll GitHub, including packaged host tests.
  networkAllowed: process.env.CODEX_DESK_TEST !== '1' && !isolatedProfile && process.platform === 'win32' && process.arch === 'x64',
  publish: status => {
    for (const { window } of windows.values()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('host:appUpdateStatus', status);
    }
  },
});
const threadActions = new ThreadActionCoordinator();
const routerUsage = new RouterUsageClient({ fetchImpl: (...args) => net.fetch(...args) });
// A long-lived `claude setup-token` credential, encrypted with DPAPI, keeps the app's Claude processes off the
// shared single-use refresh token that Claude Desktop, IDE extensions and parallel tabs otherwise race for.
const claudeToken = new ClaudeTokenStore({
  filename: path.join(app.getPath('userData'), 'claude-token.json'),
  encrypt: value => safeStorage.encryptString(value), decrypt: bytes => safeStorage.decryptString(bytes),
  available: () => safeStorage.isEncryptionAvailable(),
  onChange: kind => diagnostics.record('info', `claude.token.${kind}`),
});
const claudeGate = new ClaudeLaunchGate();
const claudeAuth = new ClaudeAuthService({
  getSessions: () => [...windows.values()].flatMap(record => [...record.sessions.values()]),
  getEnvironment: async () => ({ ...process.env, ...(await claudeToken.environment()) }),
  getLoginEnvironment: () => ({ ...process.env }),
  assertAvailable: () => {
    if (quitting) throw new Error('Приложение закрывается.');
    if (setupService?.busy || setupAuth.activeProvider || setupAuth.checking.size) throw new Error('Дождитесь завершения настройки агента.');
    if (threadActions.locks.size) throw new Error('Дождитесь завершения операции с диалогом.');
  },
});
const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
const workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
const notificationSettings = new NotificationSettingsStore(path.join(app.getPath('userData'), 'notifications.json'));
const claudeHistory = new ClaudeHistory();
const bookmarks = new BookmarkStore(app.getPath('userData'));
const claudeArchive = new ClaudeArchiveStore(app.getPath('userData'));
const gitRollback = new GitRollbackService({ directory: path.join(app.getPath('userData'), 'git-rollback') });
const rollbackPreviews = new Map();
const rollbackReservations = new Set();
const rollbackJobs = new Set();
const pathsOverlap = (left, right) => {
  const a = path.resolve(left || '').toLowerCase(), b = path.resolve(right || '').toLowerCase();
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
};
let quitting = false;
let settingsFlushed = false;
let operationSequence = 0;
let pendingOperations = 0;
let updateFrozen = false;
let updater = null;
let latestUpdateStatus = null;
let updatePreparation = null;
let updateGeneration = 0;
let updateStorageBusy = false;
let checkpointCleanup = Promise.resolve();
let setupService;
let codexUpdatePrepared = false;
let setupInitiallyNew = false;
const setupAuth = new SetupAuth({
  getSettings: provider => settingsStore.snapshotProvider(provider),
  getClaudeEnvironment: async () => ({ ...process.env, ...(await claudeToken.environment()) }),
  assertMutable: provider => assertSetupMutable(provider),
  loginClaude: async record => {
    if (setupService?.busy || setupAuth.activeProvider) throw new Error('Дождитесь завершения настройки.');
    record.setupClaudeSession ??= new WindowSession({ settings: { provider: 'claude', cwd: os.homedir() }, claudeAuth });
    record.setupClaudeSession.settings = { ...await settingsStore.snapshotProvider('claude'), provider: 'claude', cwd: os.homedir() };
    return claudeAuth.login(record.setupClaudeSession);
  },
  onCodexState: data => {
    for (const record of windows.values()) for (const session of record.sessions.values()) {
      if ((session.settings.provider || 'codex') !== 'codex') continue;
      session.send('auth', { ...data, provider: 'codex' });
      if (data.state === 'opened') session.stop();
    }
  },
});
function assertSetupMutable(provider) {
  if (quitting || updateFrozen || threadActions.locks.size || rollbackReservations.size || claudeAuth.active) throw new Error('Дождитесь завершения текущих действий.');
  for (const record of windows.values()) for (const session of record.sessions.values()) {
    if (provider !== 'git' && (session.settings.provider || 'codex') !== provider) continue;
    if (session.terminal || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size || session.mcpRefreshing) {
      throw new Error('Завершите задачи и подтверждения выбранного агента перед изменением настройки.');
    }
  }
}
function reconnectAfterSetup(provider, message) {
  for (const record of windows.values()) {
    // Read-only history clients also cache executable/configuration choices.
    record.historySearch?.dispose(); record.historySearch = null;
    record.historySession?.stop(); record.historySession = null;
    record.management?.dispose(); record.management = null;
    for (const session of record.sessions.values()) {
      if ((session.settings.provider || 'codex') !== provider) continue;
      session.send('auth', { state: 'opened', provider, message });
      session.stop();
      session.send('auth', { state: 'closed', provider, message });
    }
  }
}
const notifications = new NotificationService({
  // Automated IPC fixtures use isolated profiles and must never toast on the user's desktop.
  Notification: process.env.CODEX_DESK_TEST === '1' || isolatedProfile ? null : Notification,
  settings: notificationSettings, icon: path.join(here, 'icon.ico'), diagnostics,
  available: () => !quitting && !updateFrozen,
});
const updateCheckpoint = createUpdateCheckpoint(channelPaths.userData);
const workspaceState = createWorkspaceState(channelPaths.userData);
const workspaceSave = createWorkspaceSaveHandshake({
  send: (record, request) => {
    if (record.restoration || record.rendererGone || record.window.isDestroyed() || record.window.webContents.isDestroyed()) throw new Error("Окно недоступно.");
    record.window.webContents.send('host:workspaceSave', request);
  },
  save: (record, snapshot) => workspaceState.save(captureWorkspaceState(snapshot, record.sessions)),
});
const updateAllowedChannels = new Set(['host:completeWorkspaceSave', 'host:completeUpdatePrepare', 'host:completeUpdateRestore', 'host:getUpdateStatus', 'host:decideUpdate', 'host:getBuildInfo', 'host:getReleaseNotes', 'host:acknowledgeReleaseNotes', 'host:getDiagnosticsStatus', 'host:exportDiagnostics', 'host:openDiagnosticsFolder', 'host:getNotificationSettings', 'host:setNotificationContext', 'host:notifySession', 'host:getWindowFocus']);
const projectKey = cwd => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);

function updateBusy() {
  if (quitting || claudeAuth.active || setupService?.busy || setupAuth.activeProvider || pendingOperations || updateStorageBusy || rollbackReservations.size || windows.size !== 1 || threadActions.locks.size) return true;
  return [...windows.values()].some(record => record.diagnosticsExport || [...record.sessions.values()].some(session =>
    session.terminal || session.mcpRefreshing || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size));
}
function updateStatus(state) {
  if (state === 'error' || (['busy', 'waiting', 'manual'].includes(state) && updateFrozen)) {
    updateGeneration++;
    updateFrozen = false;
    updatePreparation?.reject(new Error('Подготовка обновления прервана.')); updatePreparation = null;
    checkpointCleanup = checkpointCleanup.then(() => updateCheckpoint.clear()).catch(() => {});
  }
  latestUpdateStatus = { state: state === 'busy' ? 'waiting' : state === 'ready' ? 'preparing' : state };
  for (const { window } of windows.values()) if (!window.isDestroyed()) window.webContents.send('host:updateStatus', latestUpdateStatus);
}
async function prepareUpdate({ requestId }) {
  if (updateBusy()) return false;
  const generation = ++updateGeneration;
  updateFrozen = true;
  const record = [...windows.values()][0];
  try {
    const snapshot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Не удалось сохранить окно перед обновлением.')), 15_000);
      updatePreparation = { record, requestId, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      record.window.webContents.send('host:updatePrepare', { requestId });
    });
    if (generation !== updateGeneration || quitting) return false;
    updatePreparation = null;
    if (!snapshot || updateBusy()) { updateStatus('busy'); return false; }
    updateStorageBusy = true;
    try {
      await checkpointCleanup;
      if (generation !== updateGeneration || quitting) return false;
      await updateCheckpoint.save(snapshot);
      await workspaceState.save(snapshot);
      await Promise.all([settingsStore.flush(), workspaceStore.flush(), workspaceState.flush(), notificationSettings.flush()]);
      if (generation !== updateGeneration || quitting) { await updateCheckpoint.clear(); return false; }
    } finally { updateStorageBusy = false; }
    return true;
  } catch (error) {
    if (generation !== updateGeneration) return false;
    updatePreparation = null; updateFrozen = false;
    diagnostics.error('update.failed', error); updateStatus('error');
    throw error;
  }
}

async function traced(channel, event, context, fn) {
  if (updateFrozen && !updateAllowedChannels.has(channel)) throw new Error('Nightly перезапускается для применения обновления.');
  const owner = windows.get(event.sender.id);
  if (owner?.workspaceClosing) {
    const reads = new Set(['host:completeWorkspaceSave', 'host:getWorkspace', 'host:getSettings', 'host:getBuildInfo', 'host:getReleaseNotes', 'host:getDiagnosticsStatus', 'host:exportDiagnostics', 'host:openDiagnosticsFolder', 'host:completeUpdateRestore', 'host:getNotificationSettings', 'host:setNotificationContext', 'host:notifySession', 'host:getWindowFocus', 'host:getRouterUsage']);
    const rpcReads = new Set(['thread/read', 'thread/list', 'thread/items/list', 'thread/turns/list', 'model/list', 'account/read', 'config/read']);
    if (!reads.has(channel) && !(channel === 'codex:request' && rpcReads.has(context.method))) throw new Error('Окно закрывается. Новые действия остановлены.');
  }
  const started = performance.now();
  const data = { channel, windowId: event.sender.id, requestId: ++operationSequence, ...context };
  diagnostics.record('info', 'ipc.start', data);
  if (!updateAllowedChannels.has(channel)) pendingOperations++;
  try {
    const result = await fn();
    diagnostics.record('info', 'ipc.complete', { ...data, durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    diagnostics.error('ipc.failed', error, { ...data, durationMs: Math.round(performance.now() - started) });
    throw error;
  } finally { if (!updateAllowedChannels.has(channel)) pendingOperations--; }
}

function handle(channel, argumentCount, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    windowForEvent(windows, event);
    const count = typeof argumentCount === 'function' ? argumentCount(args) : argumentCount;
    let scoped;
    try { scoped = sessionForEvent(windows, event, args[count]); }
    catch (error) { diagnostics.error('ipc.failed', error, { channel, windowId: event.sender.id }); throw error; }
    const provider = scoped.session.settings.provider || 'codex';
    if ((setupService?.busy && [provider, 'git'].includes(setupService.activeComponent)) || setupAuth.activeProvider === provider) {
      if (!['host:getSettings', 'host:readAttachment'].includes(channel)) throw new Error('Дождитесь завершения настройки агента.');
    }
    if ([...rollbackReservations].some(cwd => pathsOverlap(cwd, scoped.session.currentCwd))) {
      const safe = channel === 'host:getGitStatus' || channel === 'host:getGitDiff' || channel === 'host:listGitRollbacks' || channel === 'host:getSettings' || channel === 'host:readAttachment' || channel === 'host:listFiles';
      if (!safe) throw new Error('Дождитесь завершения отката файла.');
    }
    if (scoped.closingProjects?.has(projectKey(scoped.session.currentCwd)) || (channel === 'codex:start' && scoped.closingProjects?.size)) throw new Error('Проект закрывается.');
    return traced(channel, event, { sessionId: diagnostics.id(scoped.sessionId), projectId: diagnostics.id(scoped.session.currentCwd),
      ...(channel === 'codex:request' ? { method: args[0] } : {}),
    }, () => fn(scoped, ...args.slice(0, count)));
  });
}

function workspaceHandle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const record = windowForEvent(windows, event);
    if ((setupService?.busy || setupAuth.activeProvider) && ['host:listProjectThreads', 'host:listArchivedThreads', 'host:searchThreads', 'host:readArchivedThread', 'host:manageThread', 'host:searchHistory', 'host:resolveHistoryTarget', 'host:createSession', 'host:createWorktreeSession', 'host:mergeWorktree', 'host:removeWorktree'].includes(channel)) throw new Error('Дождитесь завершения настройки агента.');
    if (rollbackReservations.size && ['host:createSession', 'host:closeSession', 'host:closeProject', 'host:manageThread'].includes(channel)) throw new Error('Дождитесь завершения отката файла.');
    return traced(channel, event, {}, () => fn(record, event, ...args));
  });
}

function addSession(record, settings) {
  if (record.window.isDestroyed() || quitting) throw new Error('Окно уже закрыто.');
  if (settings.cwd && record.closingProjects?.has(projectKey(settings.cwd))) throw new Error('Проект закрывается.');
  const id = randomUUID();
  const session = new WindowSession({
    settings,
    attachmentsDirectory: channelPaths.attachmentsDirectory, claudeHistory, claudeAuth,
    claudeEnvironment: () => claudeToken.environment(), claudeGate,
    diagnostics,
    diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(id) },
    threadActions,
    persistSettings: patch => Promise.all([settingsStore.updateProvider(settings.provider || 'codex', patch), ...(patch.cwd ? [workspaceStore.addProject(patch.cwd)] : [])]),
    send: (type, data) => {
      const win = record.window;
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('codex:event', { sessionId: id, defaultSession: record.defaultSessionId === id, type, data });
      }
    },
  });
  record.sessions.set(id, session);
  record.defaultSessionId ??= id;
  diagnostics.record('info', 'session.created', { windowId: record.window.webContents.id, sessionId: diagnostics.id(id), projectId: diagnostics.id(session.currentCwd) });
  return { id, cwd: session.currentCwd, ...(settings.provider ? { provider: settings.provider } : {}) };
}

function installHandlers() {
  workspaceHandle('host:getRouterUsage', () => routerUsage.overview());
  workspaceHandle('memoryRules:preview', (_record, _event, provider) => setupService.previewMemoryRules(provider));
  workspaceHandle('memoryRules:apply', async (_record, _event, options) => {
    const result = await setupService.applyMemoryRules(options);
    if (result.changed) reconnectAfterSetup(options.provider, 'Правила памяти изменены. Начните новый диалог, чтобы использовать их.');
    return result;
  });
  workspaceHandle('setup:state', async () => ({ ...await setupService.state(), preferredProvider: (await settingsStore.snapshot()).provider }));
  workspaceHandle('setup:scan', () => setupService.scan());
  workspaceHandle('setup:update', async (record, _event) => {
    codexUpdatePrepared = false;
    try {
      const result = await setupService.update('codex', progress => {
        if (!record.window.isDestroyed()) record.window.webContents.send('setup:progress', progress);
      });
      reconnectAfterSetup('codex', 'Codex CLI обновлён. Подключение и каталог моделей обновляются.');
      return result;
    } catch (error) {
      if (codexUpdatePrepared) reconnectAfterSetup('codex', 'Обновление Codex CLI не завершилось. Подключение восстановлено.');
      throw error;
    } finally {
      codexUpdatePrepared = false;
    }
  });
  workspaceHandle('setup:install', (record, _event, id) => setupService.install(id, progress => {
    if (!record.window.isDestroyed()) record.window.webContents.send('setup:progress', progress);
  }));
  workspaceHandle('setup:chooseExecutable', async (record, event, id) => {
    setupProvider(id);
    const selected = await dialog.showOpenDialog(record.window, { title: `Выбрать ${id}.exe`, properties: ['openFile'], filters: [{ name: 'Приложение', extensions: ['exe'] }] });
    windowForEvent(windows, event);
    if (selected.canceled || !selected.filePaths[0]) return null;
    const result = await setupService.setExecutable(id, selected.filePaths[0]);
    reconnectAfterSetup(id, 'Путь к агенту изменён. Подключение обновлено.');
    return result;
  });
  workspaceHandle('setup:previewConfig', async (record, event) => {
    const selected = await dialog.showOpenDialog(record.window, { title: 'Выбрать конфигурацию Codex', properties: ['openFile'], filters: [{ name: 'Конфигурация TOML', extensions: ['toml'] }] });
    windowForEvent(windows, event);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return setupService.previewConfig(selected.filePaths[0]);
  });
  workspaceHandle('setup:applyConfig', async (_record, _event, options) => {
    const result = await setupService.applyConfig(options);
    reconnectAfterSetup('codex', 'Конфигурация применена. Подключение обновлено.');
    return result;
  });
  workspaceHandle('setup:authStatus', (_record, _event, provider) => {
    setupProvider(provider);
    if (setupService.busy || (provider === 'claude' && claudeAuth.active)) return { state: 'unknown', message: 'Дождитесь завершения настройки в открытом окне.' };
    return setupAuth.status(provider);
  });
  workspaceHandle('setup:login', (record, _event, provider) => {
    if (setupService.busy) throw new Error('Дождитесь завершения настройки.');
    return setupAuth.login(provider, record);
  });
  workspaceHandle('setup:openPortal', () => shell.openExternal('https://coder-portal.encycam.com'));
  workspaceHandle('setup:openGitWebsite', () => shell.openExternal('https://git-scm.com/downloads/win'));
  workspaceHandle('setup:complete', async (_record, _event, options) => {
    if (options?.provider !== undefined) setupProvider(options.provider);
    const result = await setupService.complete(options);
    if (options?.provider) await settingsStore.update({ provider: options.provider });
    for (const record of windows.values()) for (const session of record.sessions.values()) {
      if (!claudeAuth.active && !setupAuth.activeProvider && !session.bootstrap && !session.pendingBoots && !session.disposed) {
        session.send('auth', { state: 'closed', provider: session.settings.provider || 'codex', message: 'Настройка завершена. Подключение обновлено.' });
      }
    }
    return result;
  });
  workspaceHandle('host:getNotificationSettings', () => notifications.getSettings());
  workspaceHandle('host:setNotificationSettings', (_record, _event, patch) => notifications.setSettings(patch));
  workspaceHandle('host:setNotificationContext', (record, _event, context) => notifications.setContext(record, context));
  workspaceHandle('host:notifySession', (record, _event, payload) => notifications.notify(record, payload));
  workspaceHandle('host:getWindowFocus', record => notifications.focused(record));
  workspaceHandle('host:saveWorkspaceState', (record, _event, snapshot) => {
    // Once close begins, only its final handshake may write newer state.
    if (record.workspaceClosing || record.rendererGone) throw new Error('Окно недоступно для автосохранения.');
    if (record.restoration) throw new Error("Рабочее место ещё восстанавливается.");
    return workspaceState.save(captureWorkspaceState(snapshot, record.sessions));
  });
  workspaceHandle('host:completeWorkspaceSave', (record, _event, response) => workspaceSave.complete(record, response));
  workspaceHandle('host:getUpdateStatus', () => latestUpdateStatus);
  workspaceHandle('host:decideUpdate', (_record, _event, decision) => {
    if (!['close', 'later'].includes(decision) || !updater) throw new Error('Обновление сейчас недоступно.');
    updater.decide(decision);
    return latestUpdateStatus;
  });
  workspaceHandle('host:completeUpdatePrepare', (record, _event, response) => {
    const current = updatePreparation;
    if (!updateFrozen || !current || current.record !== record || response?.requestId !== current.requestId) throw new Error('Сохранение окна уже завершено.');
    if (response.defer === true) { current.resolve(null); return; }
    try { current.resolve(captureUpdateCheckpoint(response.snapshot, record.sessions)); }
    catch (error) { current.reject(error); throw new Error('Не удалось сохранить вкладки перед обновлением.'); }
  });
  workspaceHandle('host:completeUpdateRestore', async record => {
    if (record.restoration) {
      if (record.restoration.kind === 'update') await updateCheckpoint.clear();
      record.restoration = null;
    }
  });
  workspaceHandle('host:getBuildInfo', () => releaseInfo);
  workspaceHandle('host:getReleaseNotes', () => releaseNotesService?.get() ?? {
    currentVersion: releaseInfo.version, previousVersion: null, releases: [], shouldShow: false,
  });
  workspaceHandle('host:acknowledgeReleaseNotes', () => releaseNotesService?.acknowledge());
  workspaceHandle('host:getAppUpdateStatus', () => appUpdates.status());
  workspaceHandle('host:checkAppUpdates', () => appUpdates.check());
  workspaceHandle('host:setAppUpdatePreferences', (_record, _event, patch) => appUpdates.setPreferences(patch));
  workspaceHandle('host:openAppUpdateDownload', () => appUpdates.openDownload());
  workspaceHandle('host:getDiagnosticsStatus', async () => {
    await diagnostics.flush();
    const status = diagnostics.status();
    return { enabled: status.available, directory: diagnosticsDirectory, ...(status.writeErrors ? { error: 'Не все события удалось записать на диск. Отчёт содержит доступные записи.' } : {}) };
  });
  workspaceHandle('host:openDiagnosticsFolder', async () => {
    await mkdir(diagnosticsDirectory, { recursive: true });
    const error = await shell.openPath(diagnosticsDirectory);
    if (error) throw new Error('Не удалось открыть папку журналов.');
  });
  workspaceHandle('host:exportDiagnostics', record => {
    // One native save dialog per window, even if several controls request export.
    if (record.diagnosticsExport) return record.diagnosticsExport;
    record.diagnosticsExport = (async () => {
      const result = await dialog.showSaveDialog(record.window, {
        title: 'Сохранить диагностику Codex Desk',
        defaultPath: `Codex-Desk-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        filters: [{ name: 'Диагностика Codex Desk', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        await diagnostics.exportReport(result.filePath);
        diagnostics.record('info', 'diagnostics.exported');
        return { canceled: false, path: result.filePath };
      } catch (error) {
        diagnostics.error('diagnostics.exportFailed', error);
        throw new Error('Не удалось сохранить диагностику. Выберите другую папку и повторите.');
      }
    })().finally(() => { record.diagnosticsExport = null; });
    return record.diagnosticsExport;
  });
  ipcMain.on('host:rendererError', (event, payload) => {
    let record;
    try { record = windowForEvent(windows, event); } catch { return; }
    if (!payload || !['error', 'unhandledrejection', 'react'].includes(payload.kind)) return;
    const fields = ['name', 'message', 'stack', 'componentStack'];
    if (fields.some(key => payload[key] !== undefined && typeof payload[key] !== 'string')) return;
    if (fields.reduce((size, key) => size + Buffer.byteLength(payload[key] || '', 'utf8'), 0) > 8192) return;
    const now = Date.now();
    if (!record.rendererRate || now - record.rendererRate.start >= 60_000) record.rendererRate = { start: now, count: 0 };
    if (++record.rendererRate.count > 20) return;
    const error = new Error(payload.message || 'Renderer failure');
    error.name = payload.name || 'Error';
    error.stack = `${payload.stack || ''}\n${payload.componentStack || ''}`;
    diagnostics.error('renderer.error', error, { windowId: event.sender.id, kind: payload.kind });
  });
  handle('host:getSettings', 0, ({ session }) => session.getSettings());
  handle('host:setSettings', 1, ({ session }, patch) => session.setSettings(patch));
  handle('host:getClaudeAuthStatus', 0, ({ session }) => claudeAuth.status(session));
  handle('host:loginClaude', 0, ({ session }) => claudeAuth.login(session));
  handle('host:setupClaudeToken', 0, ({ session }) => claudeAuth.setupToken(session));
  handle('host:getClaudeToken', 0, ({ session }) => { claudeAuth.assertClaude(session); return claudeToken.info(); });
  // Idle Claude tabs relaunch with the new environment through the same reconnect path as a browser login.
  const relaunchClaudeTabs = () => {
    let restarted = 0, busy = 0;
    for (const owned of claudeAuth.sessions()) {
      if (!owned.client && !owned.bootstrap) continue;
      if (owned.terminal || owned.pendingBoots || owned.pendingMutations || owned.requests.size || owned.activeThreadTurns.size || owned.compactingThreads.size || owned.mcpRefreshing) { busy++; continue; }
      owned.send('auth', { state: 'opened' });
      owned.stop();
      owned.send('auth', { state: 'closed', message: 'Настройка токена Claude Code изменена. Подключение обновлено.' });
      restarted++;
    }
    return { restarted, busy };
  };
  handle('host:setClaudeToken', 1, async ({ session }, token) => {
    claudeAuth.assertClaude(session);
    if (claudeAuth.active) throw new Error('Дождитесь завершения входа в Claude Code.');
    const info = await claudeToken.set(token);
    return { ...info, ...relaunchClaudeTabs() };
  });
  handle('host:clearClaudeToken', 0, async ({ session }) => {
    claudeAuth.assertClaude(session);
    if (claudeAuth.active) throw new Error('Дождитесь завершения входа в Claude Code.');
    const info = await claudeToken.clear();
    return { ...info, ...relaunchClaudeTabs() };
  });
  handle('host:openTerminal', 1, async ({ session, window, sessionId }, options) => {
    const result = await session.openTerminal(options);
    notifications.dismissSession(windows.get(window.webContents.id), sessionId);
    return result;
  });
  const mcpConfig = session => { if (session.settings.provider === 'claude') throw new Error('MCP Claude Code управляется через его CLI.'); session.mcpConfigService ??= new McpConfigService(session); return session.mcpConfigService.manager; };
  handle('host:getMcpConfig', 0, ({ session }) => mcpConfig(session).list());
  handle('host:previewMcpImport', 1, ({ session }, text) => mcpConfig(session).preview(text));
  handle('host:saveMcpImport', 1, ({ session }, options) => mcpConfig(session).save(options));
  handle('host:reloadMcp', 0, ({ session }) => session.mcpRuntime());
  handle('host:checkMcp', 0, ({ session }) => session.mcpRuntime(true));
  handle('codex:start', 1, ({ session }, options) => session.start(options));
  handle('codex:request', 2, ({ session }, method, params) => session.request(method, params));
  handle('codex:respond', 2, ({ session }, id, result) => session.respond(id, result));
  workspaceHandle('host:getWorkspace', async record => {
    const workspace = await workspaceStore.snapshot();
    return { ...workspace, sessions: [...record.sessions].map(([id, session]) => ({ id, cwd: session.currentCwd, ...(session.settings.provider ? { provider: session.settings.provider } : {}) })), ...(record.restoration ? { restore: record.restoration } : {}) };
  });
  const management = (record, event) => {
    record.management ??= new ThreadManagement({
      coordinator: threadActions,
      getSessions: () => [...windows.values()].flatMap(item => [...item.sessions.values()].filter(session => session.settings.provider !== 'claude')),
      getSettings: () => settingsStore.snapshotProvider('codex'),
      createSession: settings => new WindowSession({ settings, diagnostics, diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(randomUUID()) } }),
      assertActive: () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); },
      onRestore: async cwd => {
        await directoryPath(cwd);
        if (record.closingProjects.has(projectKey(cwd))) throw new Error('Проект закрывается.');
        await workspaceStore.addProject(cwd);
      },
    });
    return record.management;
  };
  const claudeManagement = (record, event) => {
    record.claudeManagement ??= new ClaudeThreadManagement({
      coordinator: threadActions,
      history: claudeHistory,
      archive: claudeArchive,
      getSessions: () => [...windows.values()].flatMap(item => [...item.sessions.values()].filter(session => session.settings.provider === 'claude')),
      assertActive: () => {
        if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.');
        if (claudeAuth.active) throw new Error('Дождитесь завершения входа в Claude Code.');
      },
      onRestore: async cwd => {
        await directoryPath(cwd);
        if (record.closingProjects.has(projectKey(cwd))) throw new Error('Проект закрывается.');
        await workspaceStore.addProject(cwd);
      },
    });
    return record.claudeManagement;
  };
  const registeredProject = async (record, event, cwd) => {
    const canonical = await directoryPath(cwd);
    windowForEvent(windows, event);
    const saved = await workspaceStore.snapshot();
    const projects = await Promise.all(saved.projects.map(project => directoryPath(project).catch(() => null)));
    windowForEvent(windows, event);
    if (!projects.some(project => project && projectKey(project) === projectKey(canonical))) throw new Error('Папка не добавлена в рабочую область.');
    return canonical;
  };
  workspaceHandle('host:searchHistory', async (record, event, options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['query', 'cwd', 'provider', 'cursor'].includes(key))) throw new Error('Некорректный поиск истории.');
    const cwd = await registeredProject(record, event, options.cwd);
    const store = management(record, event);
    record.historySearch ??= new HistorySearch({
      listThreads: async ({ cwd, provider, cursor, limit }) => {
        if (provider === 'claude') {
          const [page, archived] = await Promise.all([claudeHistory.list({ cwd, cursor, limit }), claudeArchive.ids(cwd)]);
          return { ...page, data: page.data.map(thread => (archived.has(thread.id) ? { ...thread, archived: true } : thread)) };
        }
        let page = { cursor: cursor || undefined, archived: false };
        if (cursor?.startsWith('search:')) {
          page = JSON.parse(Buffer.from(cursor.slice(7), 'base64url').toString('utf8'));
        }
        return store.enqueue(async request => {
          const result = await request('thread/list', { cwd, limit, archived: page.archived, sortKey: 'updated_at', sourceKinds: ['appServer', 'cli', 'vscode'], ...(page.cursor ? { cursor: page.cursor } : {}) });
          const next = result.nextCursor ? { cursor: result.nextCursor, archived: page.archived } : !page.archived ? { archived: true } : null;
          return { data: (result.data || []).filter(thread => !thread.cwd || projectKey(thread.cwd) === projectKey(cwd)).map(thread => ({ ...thread, cwd, provider: 'codex', archived: page.archived })), nextCursor: next ? `search:${Buffer.from(JSON.stringify(next)).toString('base64url')}` : null };
        });
      },
      readThread: async ({ cwd, provider, thread, cursor }) => {
        if (provider === 'claude') {
        const result = await claudeHistory.read({ cwd, threadId: thread.id });
        return { ...result, thread: { ...result.thread, ...(thread.archived ? { archived: true } : {}) } };
      }
        return store.enqueue(async request => {
          const info = await request('thread/read', { threadId: thread.id, includeTurns: false });
          if (info.thread?.id !== thread.id || (info.thread.cwd && projectKey(info.thread.cwd) !== projectKey(cwd))) throw new Error('Диалог перемещён в другую папку.');
          if (info.thread.historyMode === 'paginated') {
            const page = await request('thread/items/list', { threadId: thread.id, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
            return { thread: { ...info.thread, archived: thread.archived }, items: (page.data || []).map(entry => ({ ...entry.item, turnId: entry.turnId })), nextCursor: page.nextCursor || null };
          }
          const result = await request('thread/read', { threadId: thread.id, includeTurns: true });
          return { thread: { ...result.thread, archived: thread.archived } };
        });
      },
    });
    const page = await record.historySearch.search({ ...options, cwd });
    windowForEvent(windows, event);
    return page;
  });
  workspaceHandle('host:listBookmarks', async (_record, _event, options = {}) => bookmarks.list(options));
  workspaceHandle('host:resolveHistoryTarget', async (record, event, options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['cwd', 'provider', 'threadId'].includes(key))
      || !['codex', 'claude'].includes(options.provider) || typeof options.threadId !== 'string') throw new Error('Некорректная ссылка на сообщение.');
    const nativeId = options.provider === 'claude' ? options.threadId.replace(/^claude:/, '') : options.threadId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)
      || (options.provider === 'claude' && !options.threadId.startsWith('claude:'))) throw new Error('Диалог принадлежит другому агенту или ссылка повреждена.');
    const cwd = await registeredProject(record, event, options.cwd);
    if (options.provider === 'claude') {
      let result;
      try { result = await claudeHistory.read({ cwd, threadId: options.threadId, includeTurns: false }); }
      catch { throw new Error('Не удалось открыть исходный диалог Claude. Он мог быть удалён или стать недоступным. Сохранённая закладка остаётся в библиотеке.'); }
      const archived = await claudeArchive.has(options.threadId).catch(() => false);
      windowForEvent(windows, event);
      return { ...result.thread, provider: 'claude', archived };
    }
    return management(record, event).enqueue(async request => {
      let result;
      try { result = await request('thread/read', { threadId: options.threadId, includeTurns: false }); }
      catch { throw new Error('Не удалось открыть исходный диалог Codex. Он мог быть удалён или стать недоступным. Сохранённая закладка остаётся в библиотеке.'); }
      const thread = result?.thread;
      if (thread?.id !== options.threadId) throw new Error('Исходный диалог не найден. Сохранённая закладка остаётся в библиотеке.');
      if (!thread.cwd || projectKey(thread.cwd) !== projectKey(cwd)) throw new Error('Диалог теперь находится в другой папке. Откройте его через историю этой папки.');
      // Native Thread metadata has no archived flag. Query membership instead of
      // trusting a stale bookmark or deriving state from an internal file path.
      let cursor;
      const cursors = new Set();
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await request('thread/list', { cwd, archived: true, limit: 100, sortKey: 'updated_at', modelProviders: [],
          sourceKinds: ['appServer', 'cli', 'vscode', 'exec', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
          ...(cursor ? { cursor } : {}) });
        if ((page.data || []).some(candidate => candidate.id === thread.id)) return { ...thread, provider: 'codex', archived: true };
        cursor = page.nextCursor;
        if (!cursor) return { ...thread, provider: 'codex', archived: false };
        if (typeof cursor !== 'string' || cursor.length > 16384 || cursors.has(cursor)) throw new Error('Не удалось проверить состояние архива: Codex повторил страницу. Повторите открытие.');
        cursors.add(cursor);
      }
      throw new Error('Архив проекта слишком велик для проверки ссылки. Откройте диалог через список истории или архива.');
    });
  });
  workspaceHandle('host:saveBookmark', async (record, event, value) => {
    if (!value || typeof value !== 'object') throw new Error('Некорректная закладка.');
    // Editing an app-owned snapshot still works after its project was removed.
    // The store verifies that an existing id keeps exactly the same source.
    if (value.id !== undefined) return bookmarks.save(value);
    const cwd = await registeredProject(record, event, value.cwd);
    return bookmarks.save({ ...value, cwd });
  });
  workspaceHandle('host:removeBookmark', (_record, _event, id) => bookmarks.remove(id));
  workspaceHandle('host:exportConversation', (record, event, value) => saveConversation(value, options => dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), options)));
  const archivedClaudeEntry = async threadId => {
    const entry = await claudeArchive.find(threadId);
    if (!entry) throw new Error('Диалог уже не находится в архиве. Обновите список.');
    return entry;
  };
  const readArchivedClaudeThread = async (record, event, options) => {
    if (options.cursor !== undefined) throw new Error('Для этой истории нет следующей страницы.');
    const entry = await archivedClaudeEntry(options.threadId);
    windowForEvent(windows, event);
    // Read-only: the native transcript is parsed without starting the CLI.
    const { thread } = await claudeHistory.read({ cwd: entry.cwd, threadId: options.threadId });
    windowForEvent(windows, event);
    const turns = thread.turns ?? [];
    return { thread: { ...thread, archived: true }, turns, nextCursor: null,
      items: turns.flatMap(turn => (turn.items ?? []).map(item => ({ ...item, turnId: turn.id, complete: true }))) };
  };
  workspaceHandle('host:listArchivedThreads', async (record, event, cursor) => {
    const page = await management(record, event).listArchivedThreads(cursor);
    windowForEvent(windows, event);
    // Claude's archive is the shell's own finite list, not a paginated server query:
    // it accompanies the first page and is never repeated on the following ones.
    if (cursor) return page;
    const claude = (await claudeArchive.list()).map(entry => ({ ...entry, provider: 'claude', historyMode: 'legacy', archived: true }));
    windowForEvent(windows, event);
    return { ...page, data: [...page.data, ...claude].sort((a, b) => (b.updatedAt || b.archivedAt || 0) - (a.updatedAt || a.archivedAt || 0)) };
  });
  workspaceHandle('host:searchThreads', (record, event, options) => management(record, event).searchThreads(options));
  workspaceHandle('host:readArchivedThread', async (record, event, options) => {
    const result = typeof options?.threadId === 'string' && options.threadId.startsWith('claude:')
      ? await readArchivedClaudeThread(record, event, options)
      : await management(record, event).readArchivedThread(options);
    result.items = await hydrateAttachmentPreviews(result.items, channelPaths.attachmentsDirectory);
    windowForEvent(windows, event);
    return result;
  });
  workspaceHandle('host:manageThread', (record, event, options) => {
    const claude = typeof options?.threadId === 'string' && options.threadId.startsWith('claude:');
    return (claude ? claudeManagement(record, event) : management(record, event)).manageThread(options);
  });
  workspaceHandle('host:openArchivedPath', async (record, event, options) => {
    const thread = typeof options?.threadId === 'string' && options.threadId.startsWith('claude:')
      ? await archivedClaudeEntry(options.threadId)
      : await management(record, event).readArchivedMetadata(options?.threadId);
    const assertActive = () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); };
    const params = { target: options?.target, cwd: thread.cwd, shell, assertActive };
    if (options?.menu) return showLocalPathMenu({ ...params, clipboard, Menu, window: record.window });
    return openLink(params);
  });
  workspaceHandle('host:listProjectThreads', async (record, event, cwd, cursor) => {
    const assertWindow = () => {
      if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.');
    };
    let paging;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 32768)) throw new Error('Некорректная страница истории.');
    if (typeof cursor === 'string' && cursor.startsWith('desk:')) {
      try { paging = JSON.parse(Buffer.from(cursor.slice(5), 'base64url').toString('utf8')); } catch { throw new Error('Некорректная страница истории.'); }
      if (!paging || paging.cwd !== cwd || (paging.codex !== null && typeof paging.codex !== 'string') || (paging.claude !== null && typeof paging.claude !== 'string')) throw new Error('Некорректная страница истории.');
    }
    const defaults = await settingsStore.snapshot(); assertWindow();
    const includeClaude = Boolean(paging || defaults.providers?.claude || [...record.sessions.values()].some(session => session.settings.provider === 'claude'));
    const codexRead = paging?.codex === null ? Promise.resolve({ data: [], nextCursor: null }) : listProjectThreads({
      record, workspaceStore, cwd, cursor: paging?.codex || cursor, assertWindow,
      createHistorySession: async folder => {
        if (!record.historySession) {
          const settings = await settingsStore.snapshotProvider('codex');
          assertWindow();
          // A single read-only connection also serves history when no tabs are
          // open. It never publishes events or changes persisted cwd/settings.
          record.historySession ??= new WindowSession({ settings: { ...settings, cwd: folder }, diagnostics, diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(randomUUID()) } });
        }
        return record.historySession;
      },
    });
    // Attach the rejection handler before any independent folder checks await.
    const codexOutcome = codexRead.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
    if (!includeClaude) return codexRead;
    const folder = await directoryPath(cwd); assertWindow();
    const workspace = await workspaceStore.snapshot(); assertWindow();
    if (!workspace.projects.some(project => projectKey(project) === projectKey(folder))) throw new Error('Папка не добавлена в рабочую область.');
    const claudeRead = paging?.claude === null ? Promise.resolve({ data: [], nextCursor: null }) : (async () => {
      const [page, archived] = await Promise.all([claudeHistory.list({ cwd: folder, cursor: paging?.claude || undefined, limit: 40 }), claudeArchive.ids(folder)]);
      return { ...page, data: page.data.filter(thread => !archived.has(thread.id)) };
    })();
    const [codexPage, claudePage] = await Promise.all([codexOutcome, Promise.allSettled([claudeRead]).then(([page]) => page)]);
    assertWindow();
    if (codexPage.status === 'rejected' && claudePage.status === 'rejected') throw codexPage.reason;
    const a = codexPage.status === 'fulfilled' ? codexPage.value : { data: [], nextCursor: null };
    const b = claudePage.status === 'fulfilled' ? claudePage.value : { data: [], nextCursor: null };
    const next = a.nextCursor || b.nextCursor ? `desk:${Buffer.from(JSON.stringify({ cwd, codex: a.nextCursor || null, claude: b.nextCursor || null })).toString('base64url')}` : null;
    return { data: [...a.data, ...b.data].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)), nextCursor: next };
  });
  const createSessionFor = async (record, event, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Некорректные параметры сессии.');
    const sourceId = options.fromSessionId ?? record.defaultSessionId;
    const source = sourceId == null ? null : sessionForEvent(windows, event, sourceId).session;
    if (options.provider !== undefined && !['codex', 'claude'].includes(options.provider)) throw new Error('Неизвестный агент.');
    const provider = options.provider || source?.settings.provider || (await settingsStore.snapshot()).provider || 'codex';
    const sameProvider = provider === (source?.settings.provider || 'codex');
    const snapshot = source && sameProvider ? source.getSettings() : await settingsStore.snapshotProvider(provider);
    const effective = cleanSettings(options.settings);
    const settings = { ...snapshot };
    if (provider === 'claude' || options.provider) settings.provider = provider;
    for (const key of ['model', 'effort', 'access']) {
      if (sameProvider && effective[key] !== undefined) settings[key] = effective[key];
    }
    if (provider === 'claude' && settings.access === 'danger-full-access') settings.access = 'workspace-write';
    let selected = options.cwd;
    if (selected === undefined) {
      const result = await dialog.showOpenDialog(record.window, { title: 'Добавить рабочую папку', defaultPath: source?.currentCwd || snapshot.cwd, properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      selected = result.filePaths[0];
    }
    const cwd = await directoryPath(selected);
    windowForEvent(windows, event);
    source?.assertActive();
    if (quitting) return null;
    if (record.closingProjects?.has(projectKey(cwd))) throw new Error('Проект закрывается.');
    await workspaceStore.addProject(cwd);
    windowForEvent(windows, event);
    source?.assertActive();
    return addSession(record, { ...settings, cwd });
  };
  workspaceHandle('host:createSession', createSessionFor);
  // Isolated task: a sibling Git worktree on its own branch, opened as a new tab and project folder.
  workspaceHandle('host:createWorktreeSession', async (record, event, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Некорректные параметры задачи.');
    const sourceId = options.fromSessionId ?? record.defaultSessionId;
    const source = sourceId == null ? null : sessionForEvent(windows, event, sourceId).session;
    source?.assertLocalControl();
    // The project folder comes from the menu; the source session only seeds settings.
    const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : source?.currentCwd;
    if (!cwd || !path.isAbsolute(cwd) || cwd.length >= 4096) throw new Error('Сначала выберите рабочую папку.');
    const assertActive = () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); source?.assertActive(); };
    const worktree = await createWorktree({ cwd, name: options.name, assertActive });
    assertActive();
    const created = await createSessionFor(record, event, { ...(sourceId == null ? {} : { fromSessionId: sourceId }), cwd: worktree.path, ...(options.provider ? { provider: options.provider } : {}) });
    return created ? { ...created, worktree } : null;
  });
  // Worktree management: read-only listing/preview for any registered folder; merge and remove require idle sessions in the repository.
  const worktreeFolder = value => { if (typeof value !== 'string' || !value || value.length >= 4096 || !path.isAbsolute(value)) throw new Error('Некорректная папка рабочей копии.'); return value; };
  const worktreeGuard = (record, event) => () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); };
  const assertRepositoryIdle = (paths) => {
    for (const item of windows.values()) for (const session of item.sessions.values()) {
      if (!session.currentCwd || !paths.some(folder => pathsOverlap(folder, session.currentCwd))) continue;
      if (session.terminal || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size) throw new Error('Дождитесь завершения задач и подтверждений во вкладках этого репозитория; закройте его терминал.');
    }
    if (rollbackReservations.size && [...rollbackReservations].some(cwd => paths.some(folder => pathsOverlap(folder, cwd)))) throw new Error('В проекте выполняется откат файла.');
  };
  workspaceHandle('host:listWorktrees', (record, event, cwd) => worktreeSummary({ cwd: worktreeFolder(cwd), assertActive: worktreeGuard(record, event) }));
  workspaceHandle('host:previewWorktreeMerge', (record, event, cwd) => previewWorktreeMerge({ cwd: worktreeFolder(cwd), assertActive: worktreeGuard(record, event) }));
  workspaceHandle('host:mergeWorktree', async (record, event, cwd) => {
    const folder = worktreeFolder(cwd);
    const preview = await previewWorktreeMerge({ cwd: folder, assertActive: worktreeGuard(record, event) });
    assertRepositoryIdle([preview.mainPath, preview.worktreePath]);
    return mergeWorktree({ cwd: folder, assertActive: () => { worktreeGuard(record, event)(); assertRepositoryIdle([preview.mainPath, preview.worktreePath]); } });
  });
  workspaceHandle('host:removeWorktree', async (record, event, cwd, options = {}) => {
    const folder = worktreeFolder(cwd);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['force', 'deleteBranch'].includes(key) || typeof options[key] !== 'boolean')) throw new Error('Некорректные параметры удаления копии.');
    for (const item of windows.values()) for (const session of item.sessions.values()) {
      if (session.currentCwd && pathsOverlap(folder, session.currentCwd)) throw new Error('Сначала закройте вкладки этой рабочей копии.');
    }
    assertRepositoryIdle([folder]);
    return removeWorktree({ cwd: folder, force: Boolean(options.force), deleteBranch: Boolean(options.deleteBranch), assertActive: worktreeGuard(record, event) });
  });
  workspaceHandle('host:closeSession', (record, event, id) => {
    if (typeof id !== 'string' || !id) throw new Error('Некорректная сессия.');
    const { session } = sessionForEvent(windows, event, id);
    session.assertLocalControl();
    session.dispose();
    record.sessions.delete(id);
    notifications.closeSession(record, id);
    if (record.defaultSessionId === id) record.defaultSessionId = record.sessions.keys().next().value ?? null;
  });
  workspaceHandle('host:closeProject', async (record, event, cwd, options = {}) => {
    if (typeof cwd !== 'string' || !cwd || cwd.length >= 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)
      || !options || typeof options !== 'object' || Array.isArray(options) || (options.force !== undefined && typeof options.force !== 'boolean')) throw new Error('Некорректная папка проекта.');
    const key = projectKey(cwd);
    if (record.closingProjects.has(key)) throw new Error('Проект уже закрывается.');
    record.closingProjects.add(key);
    try {
      if (threadActions.locks.size || [...record.sessions.values()].some(session => session.pendingBoots)) throw new Error('Дождитесь завершения подключения или операции с диалогом.');
      const sessions = [...record.sessions].filter(([, session]) => projectKey(session.currentCwd) === key);
      for (const [, session] of sessions) {
        session.assertLocalControl();
        if (session.pendingBoots || session.mcpRefreshing || session.pendingMutations) throw new Error('Дождитесь завершения подключения или текущей операции проекта.');
      }
      if (sessions.length && options.force !== true) throw new Error('Подтвердите закрытие открытых вкладок проекта.');
      await workspaceStore.removeProject(cwd);
      windowForEvent(windows, event);
      for (const [id, session] of sessions) { session.dispose(); record.sessions.delete(id); notifications.closeSession(record, id); }
      if (!record.sessions.has(record.defaultSessionId)) record.defaultSessionId = record.sessions.keys().next().value ?? null;
      if (record.historySession && projectKey(record.historySession.currentCwd) === key) { record.historySession.dispose(); record.historySession = null; }
      return { ...(await workspaceStore.snapshot()), closedSessionIds: sessions.map(([id]) => id) };
    } finally { record.closingProjects.delete(key); }
  });
  handle('host:chooseDirectory', 0, async ({ window, session }) => {
    const result = await dialog.showOpenDialog(window, { title: 'Выберите папку проекта', defaultPath: session.currentCwd, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('host:chooseExecutable', 0, async ({ window, session }) => {
    const claude = session.settings.provider === 'claude';
    const result = await dialog.showOpenDialog(window, { title: claude ? 'Выберите claude.exe' : 'Выберите codex.exe', properties: ['openFile'], filters: [{ name: claude ? 'Claude Code' : 'Codex', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
    if (result.canceled) return null;
    await session.setSettings({ executable: result.filePaths[0] });
    return result.filePaths[0];
  });
  handle('host:chooseComposerFiles', 1, async ({ window, session }, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['imageSlots', 'imagesSupported'].includes(key)) || (options.imageSlots !== undefined && (!Number.isInteger(options.imageSlots) || options.imageSlots < 0 || options.imageSlots > 10)) || (options.imagesSupported !== undefined && typeof options.imagesSupported !== 'boolean')) throw new Error('Некорректные параметры выбора файлов.');
    if (session.composerPicker) throw new Error('Окно выбора файлов уже открыто.');
    const generation = session.generation, cwd = session.currentCwd;
    const assertActive = () => { session.assertActive(generation); if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Выберите файлы снова.'); };
    session.composerPicker = true;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: 'Добавить файлы в сообщение', defaultPath: cwd, properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Все файлы', extensions: ['*'] }, { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      assertActive();
      if (selected.canceled || !selected.filePaths.length) return null;
      return await prepareComposerFiles(selected.filePaths, { ...options, assertActive });
    } finally { session.composerPicker = false; }
  });
  handle('host:readClipboardFiles', 1, async ({ session }, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['imageSlots', 'imagesSupported'].includes(key)) || (options.imageSlots !== undefined && (!Number.isInteger(options.imageSlots) || options.imageSlots < 0 || options.imageSlots > 10)) || (options.imagesSupported !== undefined && typeof options.imagesSupported !== 'boolean')) throw new Error('Некорректные параметры вставки файлов.');
    if (session.composerClipboard) throw new Error('Дождитесь завершения вставки файлов.');
    const generation = session.generation, cwd = session.currentCwd;
    const assertActive = () => { session.assertActive(generation); if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Вставьте файлы снова.'); };
    session.composerClipboard = true;
    try {
      const paths = await readClipboardFilePaths();
      assertActive();
      if (!paths) return null;
      return await prepareComposerFiles(paths, { ...options, assertActive });
    } finally { session.composerClipboard = false; }
  });
  handle('host:saveImages', 1, async (_record, images) => {
    if (!Array.isArray(images) || images.length > 12) throw new Error('Можно прикрепить до 12 изображений.');
    const decoded = images.map(decodeImage);
    if (decoded.reduce((sum, item) => sum + item.bytes.length, 0) > 60 * 1024 * 1024) throw new Error('Общий размер изображений не должен превышать 60 МБ.');
    const dir = channelPaths.attachmentsDirectory;
    await mkdir(dir, { recursive: true });
    return Promise.all(decoded.map(async (item, index) => {
      const filename = path.join(dir, `${randomUUID()}.${item.extension}`);
      await writeFile(filename, item.bytes, { flag: 'wx' });
      return { path: filename, name: String(images[index].name || 'Изображение').slice(0, 200), dataUrl: images[index].dataUrl };
    }));
  });
  handle('host:readAttachment', 1, (_record, target) => readAttachment(channelPaths.attachmentsDirectory, target));
  handle('host:openPath', 1, ({ session }, target) => {
    const generation = session.generation;
    const cwd = session.currentCwd;
    return openLink({ target, cwd, shell, assertActive: () => {
      session.assertActive(generation);
      if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Откройте ссылку повторно.');
    } });
  });
  handle('host:listFiles', 2, ({ session }, relativePath, cursor) => {
    const generation = session.generation;
    const cwd = session.currentCwd;
    return listProjectFiles({ cwd, relativePath, cursor, assertActive: () => {
      session.assertActive(generation);
      if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Обновите дерево файлов.');
    } });
  });
  const viewerContext = session => {
    const generation = session.generation, cwd = session.currentCwd;
    return { cwd, assertActive: () => { session.assertActive(generation); if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Откройте файл снова.'); } };
  };
  handle('host:searchProjectFiles', 1, ({ session }, options) => {
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['query', 'cursor'].includes(key))) throw new Error('Некорректный поиск файла.');
    return searchProjectFiles({ ...options, ...viewerContext(session) });
  });
  handle('host:readProjectFile', 1, ({ session }, options) => {
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => key !== 'path')) throw new Error('Некорректный путь файла.');
    return readProjectFile({ ...options, ...viewerContext(session) });
  });
  const gitContext = session => {
    const generation = session.generation;
    const cwd = session.currentCwd;
    return { cwd, assertActive: () => {
      session.assertActive(generation);
      if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Обновите Git.');
    } };
  };
  handle('host:getGitStatus', 0, ({ session }) => getGitStatus(gitContext(session)));
  handle('host:getGitDiff', 1, ({ session }, options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['path', 'area'].includes(key))) throw new Error('Некорректный запрос сравнения Git.');
    return getGitDiff({ ...options, ...gitContext(session) });
  });
  const rollbackOption = (value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value[key] !== 'string' || !value[key] || value[key].length > 32768) throw new Error('Некорректный запрос отката.');
    return value[key];
  };
  const ensureRollbackIdle = session => {
    if (session.settings.access === 'read-only') throw new Error('В режиме «Только чтение» откат недоступен.');
    for (const record of windows.values()) for (const other of record.sessions.values()) {
      if (!pathsOverlap(other.currentCwd, session.currentCwd)) continue;
      if (other.terminal || other.mcpRefreshing || other.pendingBoots || other.pendingMutations || other.requests.size || other.activeThreadTurns.size || other.compactingThreads.size) throw new Error('Завершите задачи, запросы разрешений и работу в терминале этого проекта перед откатом.');
    }
  };
  const rollbackContext = session => {
    const context = gitContext(session);
    return { ...context, assertActive: () => { context.assertActive(); ensureRollbackIdle(session); } };
  };
  const rememberRollbackPreview = (session, value) => {
    const now = Date.now();
    for (const [id, preview] of rollbackPreviews) if (Date.parse(preview.expiresAt) <= now || preview.session.disposed) rollbackPreviews.delete(id);
    rollbackPreviews.set(value.previewId, { session, generation: session.generation, cwd: session.currentCwd, operation: value.operation, expiresAt: value.expiresAt });
    while (rollbackPreviews.size > 100) rollbackPreviews.delete(rollbackPreviews.keys().next().value);
    return value;
  };
  handle('host:previewGitRollback', 1, async ({ session }, options) => {
    const context = rollbackContext(session); context.assertActive();
    const value = await gitRollback.preview({ ...context, path: rollbackOption(options, 'path') });
    context.assertActive(); return rememberRollbackPreview(session, value);
  });
  handle('host:previewUndoGitRollback', 1, async ({ session }, options) => {
    const context = rollbackContext(session); context.assertActive();
    const value = await gitRollback.previewUndo({ ...context, undoId: rollbackOption(options, 'undoId') });
    context.assertActive(); return rememberRollbackPreview(session, value);
  });
  handle('host:listGitRollbacks', 0, ({ session }) => gitRollback.list(gitContext(session)));
  const rollbackHunks = value => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.length > 10_000 || value.some(index => !Number.isSafeInteger(index) || index < 0 || index >= 10_000)) throw new Error('Некорректный выбор фрагментов отката.');
    return value;
  };
  const applyRollback = (session, options, operation) => {
    const hunks = operation === 'restore' && options && typeof options === 'object' && 'hunks' in options ? rollbackHunks(options.hunks) : undefined;
    if (hunks !== undefined) options = { previewId: options.previewId };
    const previewId = rollbackOption(options, 'previewId');
    const preview = rollbackPreviews.get(previewId);
    if (!preview || preview.session !== session || preview.generation !== session.generation || preview.cwd !== session.currentCwd || preview.operation !== operation || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('Предпросмотр устарел или относится к другому диалогу. Откройте его снова.');
    const context = rollbackContext(session); context.assertActive();
    if ([...rollbackReservations].some(cwd => pathsOverlap(cwd, context.cwd))) throw new Error('В проекте уже выполняется откат.');
    rollbackPreviews.delete(previewId);
    rollbackReservations.add(context.cwd);
    const job = Promise.resolve().then(() => operation === 'restore' ? gitRollback.apply({ ...context, previewId, ...(hunks ? { hunks } : {}) }) : gitRollback.applyUndo({ ...context, previewId })).finally(() => { rollbackReservations.delete(context.cwd); rollbackJobs.delete(job); });
    rollbackJobs.add(job);
    return job;
  };
  handle('host:applyGitRollback', 1, ({ session }, options) => applyRollback(session, options, 'restore'));
  handle('host:undoGitRollback', 1, ({ session }, options) => applyRollback(session, options, 'undo'));
  // Older callers supply (target, sessionId); options occupy the new second slot.
  handle('host:showPathMenu', args => args.length < 3 && typeof args[1] === 'string' ? 1 : 2, ({ session, window }, target, options) => {
    const generation = session.generation;
    const cwd = session.currentCwd;
    return showLocalPathMenu({ target, cwd, shell, clipboard, Menu, window, options, assertActive: () => {
      session.assertActive(generation);
      if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Откройте ссылку повторно.');
    } });
  });
}

async function createWindow(initialSettings, checkpoint = null, restoreKind = 'workspace') {
  const defaults = initialSettings ?? await settingsStore.snapshot();
  const settings = initialSettings ?? await settingsStore.snapshotProvider(defaults.provider === 'claude' ? 'claude' : 'codex');
  let cwd = settings.cwd || process.cwd();
  try { cwd = await directoryPath(cwd); } catch { /* Keep a missing saved folder visible so it can be corrected. */ }
  if (settings.cwd || (!setupInitiallyNew && !existsSync(setupService.filename))) await workspaceStore.initializeProjects(cwd);
  const workspace = await workspaceStore.snapshot();
  cwd = workspace.projects.find(project => projectKey(project) === projectKey(cwd)) || workspace.projects[0];
  if (quitting) return null;
  const win = new BrowserWindow({
    width: 1480, height: 960, minWidth: 940, minHeight: 640,
    title: `Codex Desk — ${channelLabel}`, icon: windowIcon, show: false, backgroundColor: '#101311', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  if (process.platform === 'win32') win.setAppDetails({
    appId: identity.appId, appIconPath: shellIcon, appIconIndex: 0,
    relaunchCommand: `"${app.getPath('exe')}"`, relaunchDisplayName: identity.name,
  });
  win.show();
  const record = { window: win, sessions: new Map(), defaultSessionId: null, historySession: null, closingProjects: new Set() };
  if (checkpoint) {
    record.restoration = { kind: restoreKind, activeIndex: checkpoint.activeIndex, tabs: checkpoint.tabs.map(tab => {
      if (tab.archivedThread) return { id: `archive:${tab.archivedThread.id}`, cwd: tab.archivedThread.cwd || '', archivedThread: tab.archivedThread, scrollTop: tab.scrollTop, scrollAnchor: tab.scrollAnchor, pinned: tab.pinned };
      const created = addSession(record, tab.settings);
      return { ...created, thread: tab.thread, draft: tab.draft, attachments: tab.attachments, settings: tab.settings, queue: tab.queue, scrollTop: tab.scrollTop, scrollAnchor: tab.scrollAnchor, preservedDraft: tab.preservedDraft, pinned: tab.pinned, pendingMessage: tab.pendingMessage };
    }) };
  } else if (cwd) addSession(record, { ...settings, cwd });
  const contentsId = win.webContents.id;
  windows.set(contentsId, record);
  notifications.registerWindow(record);
  win.on('focus', () => notifications.focusChanged(record));
  win.on('blur', () => notifications.focusChanged(record));
  win.on('minimize', () => notifications.focusChanged(record));
  win.on('restore', () => notifications.focusChanged(record));
  diagnostics.record('info', 'window.created', { windowId: contentsId });
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame) diagnostics.record('error', 'window.loadFailed', { windowId: contentsId, code });
  });
  win.webContents.on('preload-error', (_event, _preloadPath, error) => diagnostics.error('window.preloadError', error, { windowId: contentsId }));
  win.on('unresponsive', () => diagnostics.record('warn', 'window.unresponsive', { windowId: contentsId }));
  win.webContents.on('render-process-gone', (_event, details) => {
    record.historySearch?.dispose(); record.historySearch = null;
    record.rendererGone = true;
    notifications.closeWindow(record);
    workspaceSave.cancel(record);
    if (updatePreparation?.record === record) updatePreparation.reject(new Error('Окно закрыто во время обновления.'));
    diagnostics.record('error', 'window.rendererGone', { windowId: contentsId, reason: details.reason, exitCode: details.exitCode });
    for (const session of record.sessions.values()) session.stop();
    record.historySession?.stop();
    record.management?.dispose();
    record.management = null;
  });
  win.on('close', event => {
    if (setupService?.busy && !quitting) {
      event.preventDefault();
      void dialog.showMessageBox(win, { type: 'info', title: 'Настройка Codex Desk', message: 'Дождитесь завершения установки или применения конфигурации.', buttons: ['Хорошо'] });
      return;
    }
    if (record.closeReady || settingsFlushed || updateFrozen) return;
    event.preventDefault();
    if (record.workspaceClosing) return;
    record.workspaceClosing = true;
    void workspaceSave.request(record).then(async () => { await Promise.allSettled([...rollbackJobs]); await workspaceState.flush(); await bookmarks.flush(); }).finally(() => {
      record.closeReady = true;
      if (!win.isDestroyed()) win.close();
    });
  });
  win.on('closed', () => {
    record.historySearch?.dispose();
    notifications.closeWindow(record);
    workspaceSave.cancel(record);
    if (updatePreparation?.record === record) updatePreparation.reject(new Error('Окно закрыто во время обновления.'));
    diagnostics.record('info', 'window.closed', { windowId: contentsId });
    windows.delete(contentsId);
    for (const session of record.sessions.values()) session.dispose();
    record.historySession?.dispose();
    record.setupClaudeSession?.dispose();
    record.management?.dispose();
  });
  const devUrl = process.env.CODEX_DESK_DEV_URL;
  try {
    if (devUrl && new URL(devUrl).origin === 'http://127.0.0.1:5178') await win.loadURL(devUrl);
    else await win.loadFile(path.join(here, '..', 'dist', 'index.html'));
    return win.isDestroyed() ? null : win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

const reportWindowError = error => {
  diagnostics.error('window.openFailed', error);
  if (!quitting) dialog.showErrorBox('Не удалось открыть Codex Desk', `${error.message}\n\nЖурналы приложения: ${diagnosticsDirectory}`);
};

const gotLock = process.env.CODEX_DESK_TEST === '1' || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    const win = [...windows.values()].find(record => !record.window.isDestroyed())?.window;
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(async () => {
    const initialized = await initializeChannelProfile(channelPaths);
    if (process.platform === 'win32') {
      try {
        shellIcon = await persistShellIcon({ source: windowIcon, userData: channelPaths.userData });
        windowIcon = shellIcon;
        notifications.icon = shellIcon;
        // Electron's PE ProductName is shared by both channels. It asynchronously
        // recreates this shortcut for notifications, dropping IconLocation.
        // Watch only production registrations and patch only this process's link.
        if (app.isPackaged && process.env.CODEX_DESK_TEST !== '1' && !isolatedProfile) {
          stopWatchingShellIcon = watchShellShortcutIcon({
            shell, shortcut: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Codex Desk.lnk'),
            executable: app.getPath('exe'), appId: identity.appId, icon: shellIcon,
          }, { onError: error => diagnostics.error('app.shellIcon', error) });
        }
      } catch (error) { diagnostics.error('app.shellIcon', error); }
    }
    setupInitiallyNew = !['settings.json', 'workspace.json', 'workspace-state.json'].some(name => existsSync(path.join(channelPaths.userData, name)));
    setupService = new SetupService({
      directory: channelPaths.userData, initialExisting: !setupInitiallyNew,
      getSettings: provider => settingsStore.snapshotProvider(provider),
      saveSettings: async (provider, patch) => {
        await settingsStore.updateProvider(provider, patch);
        for (const record of windows.values()) for (const session of record.sessions.values()) {
          if ((session.settings.provider || 'codex') === provider) session.settings = { ...session.settings, ...patch };
        }
      },
      getClaudeEnvironment: async () => ({ ...process.env, ...(await claudeToken.environment()) }),
      beforeUpdate: async provider => {
        if (provider !== 'codex') return;
        codexUpdatePrepared = true;
        for (const record of windows.values()) for (const session of record.sessions.values()) {
          if ((session.settings.provider || 'codex') === provider) session.stop();
        }
      },
      assertMutable: provider => {
        if (provider === null) {
          if (quitting || updateFrozen) throw new Error('Приложение закрывается.');
          return; // Finishing or deferring setup does not alter either CLI or its authorization.
        }
        if (setupAuth.activeProvider) throw new Error('Завершите вход в открытом окне авторизации.');
        if (setupAuth.checking.size) throw new Error('Дождитесь завершения проверки входа.');
        assertSetupMutable(provider);
      },
    });
    await setupService.state();
    releaseNotesService = new ReleaseNotesService({ channel: releaseInfo.channel, currentVersion: releaseInfo.version,
      releases: releaseNotes, store: releaseNotesStore, isNewProfile: setupInitiallyNew });
    diagnostics.record(initialized.status === 'failed' ? 'warn' : 'info', 'app.profile', { success: initialized.status !== 'failed', count: initialized.copied.length });
    diagnostics.record('info', 'app.ready'); installHandlers();
    let checkpoint = null;
    let restoreKind = 'workspace';
    if (releaseInfo.channel === 'nightly') {
      try { checkpoint = await updateCheckpoint.read(); } catch (error) { diagnostics.error('update.failed', error); dialog.showErrorBox('Восстановление Nightly', error.message); }
    }
    if (checkpoint) restoreKind = 'update';
    else {
      try { checkpoint = await workspaceState.read(); }
      catch (error) { diagnostics.error('window.openFailed', error); dialog.showErrorBox("Восстановление рабочего места", error.message); }
    }
    const win = await createWindow(undefined, checkpoint, restoreKind);
    // A settings/network failure must never prevent the workspace from opening.
    void appUpdates.start().catch(error => diagnostics.error('update.failed', error));
    const executable = app.getPath('exe');
    const executableDirectory = path.dirname(executable);
    if (app.isPackaged && releaseInfo.channel === 'nightly' && path.basename(executableDirectory).toLowerCase() === 'nightly') {
      try {
        updater = await createNightlyUpdate({ releaseRoot: path.dirname(executableDirectory), executable, userData: channelPaths.userData,
          cwd: process.cwd(), buildId: releaseInfo.buildId, getBusy: updateBusy, prepare: prepareUpdate, quit: () => app.quit(), notify: updateStatus });
      } catch (error) { diagnostics.error('update.failed', error); }
    }
    return win;
  }).catch(reportWindowError);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (settingsFlushed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    setupAuth.dispose();
    claudeAuth.dispose();
    stopWatchingShellIcon?.();
    const closeUpdater = updater?.close();
    const closeAppUpdates = appUpdates.close();
    void (async () => {
      await setupService?.waitForIdle();
      setupService?.dispose();
      // Capture while sessions still exist; the final quit then skips window handshakes.
      const records = [...windows.values()];
      if (!updateFrozen) await Promise.all(records.map(record => {
        record.workspaceClosing = true;
        return record.closeReady ? undefined : workspaceSave.request(record);
      }));
      await Promise.allSettled([...rollbackJobs]);
      for (const record of records) {
        record.historySearch?.dispose();
        notifications.closeWindow(record);
        for (const session of record.sessions.values()) session.dispose();
        record.historySession?.dispose();
        record.management?.dispose();
      }
      await Promise.all([settingsStore.flush(), workspaceStore.flush(), workspaceState.flush(), notificationSettings.flush(), bookmarks.flush(), claudeToken.flush(), releaseNotesStore.flush(), closeUpdater, closeAppUpdates]);
      diagnostics.record('info', 'app.quit');
      await diagnostics.flush();
      settingsFlushed = true; app.quit();
    })().catch(error => {
      diagnostics.error('app.unhandled', error);
      settingsFlushed = true; app.quit();
    });
  });
}
