import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { directoryPath, decodeImage } from './host-utils.mjs';
import { openLink, showLocalPathMenu } from './file-links.mjs';
import { listProjectThreads } from './project-history.mjs';
import { listProjectFiles } from './project-files.mjs';
import { ThreadActionCoordinator, ThreadManagement } from './thread-management.mjs';
import { McpConfigService } from './mcp-service.mjs';
import { readAttachment, hydrateAttachmentPreviews } from './attachments.mjs';
import { SettingsStore, WorkspaceStore, WindowSession, cleanSettings, sessionForEvent, windowForEvent } from './window-session.mjs';
import { createDiagnostics } from './diagnostics.mjs';
import { resolveReleaseChannel, resolveChannelPaths, initializeChannelProfile } from './release-channel.mjs';
import { createNightlyUpdate } from './nightly-update.mjs';
import { captureUpdateCheckpoint, createUpdateCheckpoint } from './update-checkpoint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let buildInfo = {};
try { buildInfo = JSON.parse(readFileSync(path.join(here, 'build-info.json'), 'utf8')); } catch { /* Development build. */ }
let releaseInfo;
try { releaseInfo = resolveReleaseChannel({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, buildInfo: { ...buildInfo, version: buildInfo.version || app.getVersion() } }); }
catch {
  dialog.showErrorBox('Не удалось открыть Codex Desk', 'Повреждены сведения о канале сборки. Скопируйте всю папку приложения заново.');
  app.exit(1);
  throw new Error('Invalid release channel metadata.');
}
const channelLabel = { stable: 'Release', nightly: 'Nightly', development: 'Development' }[releaseInfo.channel];
const applicationName = releaseInfo.channel === 'stable' ? 'Codex Desk' : `Codex Desk ${channelLabel}`;
const channelPaths = resolveChannelPaths({ appData: app.getPath('appData'), channel: releaseInfo.channel, dataDirOverride: process.env.CODEX_DESK_DATA_DIR });
app.setName(applicationName);
app.setPath('userData', channelPaths.userData);
app.setAppUserModelId(`local.codex.desk.${releaseInfo.channel}`);
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
const threadActions = new ThreadActionCoordinator();
const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
const workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
let quitting = false;
let settingsFlushed = false;
let operationSequence = 0;
let pendingOperations = 0;
let updateFrozen = false;
let updater = null;
let updatePreparation = null;
let updateGeneration = 0;
let updateStorageBusy = false;
let checkpointCleanup = Promise.resolve();
const updateCheckpoint = createUpdateCheckpoint(channelPaths.userData);
const updateAllowedChannels = new Set(['host:completeUpdatePrepare', 'host:completeUpdateRestore', 'host:getBuildInfo', 'host:getDiagnosticsStatus', 'host:exportDiagnostics', 'host:openDiagnosticsFolder']);

function updateBusy() {
  if (quitting || pendingOperations || updateStorageBusy || windows.size !== 1 || threadActions.locks.size) return true;
  return [...windows.values()].some(record => record.diagnosticsExport || [...record.sessions.values()].some(session =>
    session.terminal || session.mcpRefreshing || session.pendingBoots || session.pendingMutations || session.requests.size || session.activeThreadTurns.size || session.compactingThreads.size));
}
function updateStatus(state) {
  if (state === 'error' || (state === 'busy' && updateFrozen)) {
    updateGeneration++;
    updateFrozen = false;
    updatePreparation?.reject(new Error('Подготовка обновления прервана.')); updatePreparation = null;
    checkpointCleanup = checkpointCleanup.then(() => updateCheckpoint.clear()).catch(() => {});
  }
  for (const { window } of windows.values()) if (!window.isDestroyed()) window.webContents.send('host:updateStatus', { state: state === 'busy' ? 'waiting' : state === 'ready' ? 'preparing' : state });
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
      await Promise.all([settingsStore.flush(), workspaceStore.flush()]);
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
    let scoped;
    try { scoped = sessionForEvent(windows, event, args[argumentCount]); }
    catch (error) { diagnostics.error('ipc.failed', error, { channel, windowId: event.sender.id }); throw error; }
    return traced(channel, event, { sessionId: diagnostics.id(scoped.sessionId), projectId: diagnostics.id(scoped.session.currentCwd),
      ...(channel === 'codex:request' ? { method: args[0] } : {}),
    }, () => fn(scoped, ...args.slice(0, argumentCount)));
  });
}

function workspaceHandle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const record = windowForEvent(windows, event);
    return traced(channel, event, {}, () => fn(record, event, ...args));
  });
}

function addSession(record, settings) {
  if (record.window.isDestroyed() || quitting) throw new Error('Окно уже закрыто.');
  const id = randomUUID();
  const session = new WindowSession({
    settings,
    diagnostics,
    diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(id) },
    threadActions,
    persistSettings: patch => Promise.all([settingsStore.update(patch), ...(patch.cwd ? [workspaceStore.addProject(patch.cwd)] : [])]),
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
  return { id, cwd: session.currentCwd };
}

function installHandlers() {
  workspaceHandle('host:completeUpdatePrepare', (record, _event, response) => {
    const current = updatePreparation;
    if (!updateFrozen || !current || current.record !== record || response?.requestId !== current.requestId) throw new Error('Сохранение окна уже завершено.');
    if (response.defer === true) { current.resolve(null); return; }
    try { current.resolve(captureUpdateCheckpoint(response.snapshot, record.sessions)); }
    catch (error) { current.reject(error); throw new Error('Не удалось сохранить вкладки перед обновлением.'); }
  });
  workspaceHandle('host:completeUpdateRestore', async record => {
    if (record.restoration) { await updateCheckpoint.clear(); record.restoration = null; }
  });
  workspaceHandle('host:getBuildInfo', () => releaseInfo);
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
  handle('host:openTerminal', 1, ({ session }, options) => session.openTerminal(options));
  const mcpConfig = session => { session.mcpConfigService ??= new McpConfigService(session); return session.mcpConfigService.manager; };
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
    return { ...workspace, sessions: [...record.sessions].map(([id, session]) => ({ id, cwd: session.currentCwd })), ...(record.restoration ? { restore: record.restoration } : {}) };
  });
  const management = (record, event) => {
    record.management ??= new ThreadManagement({
      coordinator: threadActions,
      getSessions: () => [...windows.values()].flatMap(item => [...item.sessions.values()]),
      getSettings: () => settingsStore.snapshot(),
      createSession: settings => new WindowSession({ settings, diagnostics, diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(randomUUID()) } }),
      assertActive: () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); },
      onRestore: async cwd => { await directoryPath(cwd); await workspaceStore.addProject(cwd); },
    });
    return record.management;
  };
  workspaceHandle('host:listArchivedThreads', (record, event, cursor) => management(record, event).listArchivedThreads(cursor));
  workspaceHandle('host:searchThreads', (record, event, options) => management(record, event).searchThreads(options));
  workspaceHandle('host:readArchivedThread', async (record, event, options) => {
    const result = await management(record, event).readArchivedThread(options);
    result.items = await hydrateAttachmentPreviews(result.items, channelPaths.attachmentsDirectory);
    windowForEvent(windows, event);
    return result;
  });
  workspaceHandle('host:manageThread', (record, event, options) => management(record, event).manageThread(options));
  workspaceHandle('host:openArchivedPath', async (record, event, options) => {
    const thread = await management(record, event).readArchivedMetadata(options?.threadId);
    const assertActive = () => { if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.'); };
    const params = { target: options?.target, cwd: thread.cwd, shell, assertActive };
    if (options?.menu) return showLocalPathMenu({ ...params, Menu, window: record.window });
    return openLink(params);
  });
  workspaceHandle('host:listProjectThreads', (record, event, cwd, cursor) => {
    const assertWindow = () => {
      if (windowForEvent(windows, event) !== record || quitting) throw new Error('Окно уже закрыто.');
    };
    return listProjectThreads({
      record, workspaceStore, cwd, cursor, assertWindow,
      createHistorySession: async folder => {
        if (!record.historySession) {
          const settings = await settingsStore.snapshot();
          assertWindow();
          // A single read-only connection also serves history when no tabs are
          // open. It never publishes events or changes persisted cwd/settings.
          record.historySession ??= new WindowSession({ settings: { ...settings, cwd: folder }, diagnostics, diagnosticContext: { windowId: record.window.webContents.id, sessionId: diagnostics.id(randomUUID()) } });
        }
        return record.historySession;
      },
    });
  });
  workspaceHandle('host:createSession', async (record, event, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Некорректные параметры сессии.');
    const sourceId = options.fromSessionId ?? record.defaultSessionId;
    const source = sourceId == null ? null : sessionForEvent(windows, event, sourceId).session;
    const snapshot = source ? source.getSettings() : await settingsStore.snapshot();
    const effective = cleanSettings(options.settings);
    const settings = { ...snapshot };
    for (const key of ['model', 'effort', 'access']) {
      if (effective[key] !== undefined) settings[key] = effective[key];
    }
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
    await workspaceStore.addProject(cwd);
    windowForEvent(windows, event);
    source?.assertActive();
    return addSession(record, { ...settings, cwd });
  });
  workspaceHandle('host:closeSession', (record, event, id) => {
    if (typeof id !== 'string' || !id) throw new Error('Некорректная сессия.');
    const { session } = sessionForEvent(windows, event, id);
    session.assertLocalControl();
    session.dispose();
    record.sessions.delete(id);
    if (record.defaultSessionId === id) record.defaultSessionId = record.sessions.keys().next().value ?? null;
  });
  handle('host:chooseDirectory', 0, async ({ window, session }) => {
    const result = await dialog.showOpenDialog(window, { title: 'Выберите папку проекта', defaultPath: session.currentCwd, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('host:chooseExecutable', 0, async ({ window, session }) => {
    const result = await dialog.showOpenDialog(window, { title: 'Выберите codex.exe', properties: ['openFile'], filters: [{ name: 'Codex', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
    if (result.canceled) return null;
    await session.setSettings({ executable: result.filePaths[0] });
    return result.filePaths[0];
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
  handle('host:showPathMenu', 1, ({ session, window }, target) => {
    const generation = session.generation;
    const cwd = session.currentCwd;
    return showLocalPathMenu({ target, cwd, shell, Menu, window, assertActive: () => {
      session.assertActive(generation);
      if (session.currentCwd !== cwd) throw new Error('Рабочая папка изменилась. Откройте ссылку повторно.');
    } });
  });
}

async function createWindow(initialSettings, checkpoint = null) {
  const settings = initialSettings ?? await settingsStore.snapshot();
  let cwd = settings.cwd || process.cwd();
  try { cwd = await directoryPath(cwd); } catch { /* Keep a missing saved folder visible so it can be corrected. */ }
  await workspaceStore.addProject(cwd);
  if (quitting) return null;
  const win = new BrowserWindow({
    width: 1480, height: 960, minWidth: 940, minHeight: 640,
    title: `Codex Desk — ${channelLabel}`, icon: path.join(here, 'icon.ico'), backgroundColor: '#101311', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const record = { window: win, sessions: new Map(), defaultSessionId: null, historySession: null };
  if (checkpoint) {
    record.restoration = { activeIndex: checkpoint.activeIndex, tabs: checkpoint.tabs.map(tab => {
      if (tab.archivedThread) return { id: `archive:${tab.archivedThread.id}`, cwd: tab.archivedThread.cwd || '', archivedThread: tab.archivedThread };
      const created = addSession(record, tab.settings);
      return { ...created, thread: tab.thread, draft: tab.draft, attachments: tab.attachments, settings: tab.settings };
    }) };
  } else addSession(record, { ...settings, cwd });
  const contentsId = win.webContents.id;
  windows.set(contentsId, record);
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
    if (updatePreparation?.record === record) updatePreparation.reject(new Error('Окно закрыто во время обновления.'));
    diagnostics.record('error', 'window.rendererGone', { windowId: contentsId, reason: details.reason, exitCode: details.exitCode });
    for (const session of record.sessions.values()) session.stop();
    record.historySession?.stop();
    record.management?.dispose();
    record.management = null;
  });
  win.on('closed', () => {
    if (updatePreparation?.record === record) updatePreparation.reject(new Error('Окно закрыто во время обновления.'));
    diagnostics.record('info', 'window.closed', { windowId: contentsId });
    windows.delete(contentsId);
    for (const session of record.sessions.values()) session.dispose();
    record.historySession?.dispose();
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
    diagnostics.record(initialized.status === 'failed' ? 'warn' : 'info', 'app.profile', { success: initialized.status !== 'failed', count: initialized.copied.length });
    diagnostics.record('info', 'app.ready'); installHandlers();
    let checkpoint = null;
    if (releaseInfo.channel === 'nightly') {
      try { checkpoint = await updateCheckpoint.read(); } catch (error) { diagnostics.error('update.failed', error); dialog.showErrorBox('Восстановление Nightly', error.message); }
    }
    const win = await createWindow(undefined, checkpoint);
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
    const closeUpdater = updater?.close();
    for (const record of windows.values()) {
      for (const session of record.sessions.values()) session.dispose();
      record.historySession?.dispose();
      record.management?.dispose();
    }
    void Promise.all([settingsStore.flush(), workspaceStore.flush(), closeUpdater]).then(async () => {
      diagnostics.record('info', 'app.quit');
      await diagnostics.flush();
      settingsFlushed = true; app.quit();
    });
  });
}
