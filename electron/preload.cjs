const { contextBridge, ipcRenderer, webUtils } = require('electron');

function forSession(sessionId) {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new Error('Некорректная сессия.');
  return {
    start: (options) => ipcRenderer.invoke('codex:start', options, sessionId),
    request: (method, params) => ipcRenderer.invoke('codex:request', method, params, sessionId),
    respond: (id, result) => ipcRenderer.invoke('codex:respond', id, result, sessionId),
    chooseDirectory: () => ipcRenderer.invoke('host:chooseDirectory', sessionId),
    chooseExecutable: () => ipcRenderer.invoke('host:chooseExecutable', sessionId),
    saveImages: (images) => ipcRenderer.invoke('host:saveImages', images, sessionId),
    chooseComposerFiles: (options) => ipcRenderer.invoke('host:chooseComposerFiles', options, sessionId),
    getPathForFile: (file) => {
      try { return webUtils.getPathForFile(file); }
      catch { return ''; }
    },
    readClipboardFiles: (options) => ipcRenderer.invoke('host:readClipboardFiles', options, sessionId),
    readAttachment: (path) => ipcRenderer.invoke('host:readAttachment', path, sessionId),
    getSettings: () => ipcRenderer.invoke('host:getSettings', sessionId),
    setSettings: (settings) => ipcRenderer.invoke('host:setSettings', settings, sessionId),
    openTerminal: (options) => ipcRenderer.invoke('host:openTerminal', options, sessionId),
    getClaudeAuthStatus: () => ipcRenderer.invoke('host:getClaudeAuthStatus', sessionId),
    loginClaude: () => ipcRenderer.invoke('host:loginClaude', sessionId),
    getClaudeToken: () => ipcRenderer.invoke('host:getClaudeToken', sessionId),
    setClaudeToken: (token) => ipcRenderer.invoke('host:setClaudeToken', token, sessionId),
    clearClaudeToken: () => ipcRenderer.invoke('host:clearClaudeToken', sessionId),
    setupClaudeToken: () => ipcRenderer.invoke('host:setupClaudeToken', sessionId),
    getMcpConfig: () => ipcRenderer.invoke('host:getMcpConfig', sessionId),
    previewMcpImport: (text) => ipcRenderer.invoke('host:previewMcpImport', text, sessionId),
    saveMcpImport: (options) => ipcRenderer.invoke('host:saveMcpImport', options, sessionId),
    reloadMcp: () => ipcRenderer.invoke('host:reloadMcp', sessionId),
    checkMcp: () => ipcRenderer.invoke('host:checkMcp', sessionId),
    openPath: (path) => ipcRenderer.invoke('host:openPath', path, sessionId),
    showPathMenu: (path, options) => options === undefined
      ? ipcRenderer.invoke('host:showPathMenu', path, sessionId)
      : ipcRenderer.invoke('host:showPathMenu', path, options, sessionId),
    listFiles: (path, cursor) => ipcRenderer.invoke('host:listFiles', path, cursor, sessionId),
    searchProjectFiles: (options) => ipcRenderer.invoke('host:searchProjectFiles', options, sessionId),
    readProjectFile: (options) => ipcRenderer.invoke('host:readProjectFile', options, sessionId),
    getGitStatus: () => ipcRenderer.invoke('host:getGitStatus', sessionId),
    getGitDiff: (options) => ipcRenderer.invoke('host:getGitDiff', options, sessionId),
    previewGitRollback: (options) => ipcRenderer.invoke('host:previewGitRollback', options, sessionId),
    applyGitRollback: (options) => ipcRenderer.invoke('host:applyGitRollback', options, sessionId),
    listGitRollbacks: () => ipcRenderer.invoke('host:listGitRollbacks', sessionId),
    previewUndoGitRollback: (options) => ipcRenderer.invoke('host:previewUndoGitRollback', options, sessionId),
    undoGitRollback: (options) => ipcRenderer.invoke('host:undoGitRollback', options, sessionId),
    onEvent: (listener) => {
      const handler = (_event, data) => {
        if (sessionId === undefined ? data.defaultSession : data.sessionId === sessionId) listener(data);
      };
      ipcRenderer.on('codex:event', handler);
      return () => ipcRenderer.removeListener('codex:event', handler);
    },
  };
}

contextBridge.exposeInMainWorld('codex', {
  memoryRules: {
    preview: provider => ipcRenderer.invoke('memoryRules:preview', provider),
    apply: options => ipcRenderer.invoke('memoryRules:apply', options),
  },
  setup: {
    state: () => ipcRenderer.invoke('setup:state'),
    scan: () => ipcRenderer.invoke('setup:scan'),
    install: id => ipcRenderer.invoke('setup:install', id),
    chooseExecutable: id => ipcRenderer.invoke('setup:chooseExecutable', id),
    previewConfig: () => ipcRenderer.invoke('setup:previewConfig'),
    applyConfig: options => ipcRenderer.invoke('setup:applyConfig', options),
    authStatus: provider => ipcRenderer.invoke('setup:authStatus', provider),
    login: provider => ipcRenderer.invoke('setup:login', provider),
    openPortal: () => ipcRenderer.invoke('setup:openPortal'),
    openGitWebsite: () => ipcRenderer.invoke('setup:openGitWebsite'),
    complete: options => ipcRenderer.invoke('setup:complete', options),
    onProgress: listener => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on('setup:progress', handler);
      return () => ipcRenderer.removeListener('setup:progress', handler);
    },
  },
  ...forSession(),
  getBuildInfo: () => ipcRenderer.invoke('host:getBuildInfo'),
  getAppUpdateStatus: () => ipcRenderer.invoke('host:getAppUpdateStatus'),
  checkAppUpdates: () => ipcRenderer.invoke('host:checkAppUpdates'),
  setAppUpdatePreferences: (patch) => ipcRenderer.invoke('host:setAppUpdatePreferences', patch),
  openAppUpdateDownload: () => ipcRenderer.invoke('host:openAppUpdateDownload'),
  onAppUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('host:appUpdateStatus', handler);
    return () => ipcRenderer.removeListener('host:appUpdateStatus', handler);
  },
  searchHistory: (options) => ipcRenderer.invoke('host:searchHistory', options),
  resolveHistoryTarget: (options) => ipcRenderer.invoke('host:resolveHistoryTarget', options),
  listBookmarks: (options) => ipcRenderer.invoke('host:listBookmarks', options),
  saveBookmark: (bookmark) => ipcRenderer.invoke('host:saveBookmark', bookmark),
  exportConversation: (file) => ipcRenderer.invoke('host:exportConversation', file),
  removeBookmark: (id) => ipcRenderer.invoke('host:removeBookmark', id),
  getNotificationSettings: () => ipcRenderer.invoke('host:getNotificationSettings'),
  setNotificationSettings: (patch) => ipcRenderer.invoke('host:setNotificationSettings', patch),
  setNotificationContext: (context) => ipcRenderer.invoke('host:setNotificationContext', context),
  notifySession: (notification) => ipcRenderer.invoke('host:notifySession', notification),
  getWindowFocus: () => ipcRenderer.invoke('host:getWindowFocus'),
  onWindowFocus: (listener) => {
    const handler = (_event, focused) => listener(focused);
    ipcRenderer.on('host:windowFocus', handler);
    return () => ipcRenderer.removeListener('host:windowFocus', handler);
  },
  onNotificationActivated: (listener) => {
    const handler = (_event, notification) => listener(notification);
    ipcRenderer.on('host:notificationActivated', handler);
    return () => ipcRenderer.removeListener('host:notificationActivated', handler);
  },
  getDiagnosticsStatus: () => ipcRenderer.invoke('host:getDiagnosticsStatus'),
  exportDiagnostics: () => ipcRenderer.invoke('host:exportDiagnostics'),
  openDiagnosticsFolder: () => ipcRenderer.invoke('host:openDiagnosticsFolder'),
  reportRendererError: (report) => {
    if (!report || !['error', 'unhandledrejection', 'react'].includes(report.kind)) return;
    const payload = { kind: report.kind };
    for (const key of ['name', 'message', 'stack', 'componentStack']) if (typeof report[key] === 'string') payload[key] = report[key].slice(0, 3000);
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 8000) return;
    ipcRenderer.send('host:rendererError', payload);
  },
  getWorkspace: () => ipcRenderer.invoke('host:getWorkspace'),
  saveWorkspaceState: (snapshot) => ipcRenderer.invoke('host:saveWorkspaceState', snapshot),
  completeWorkspaceSave: (response) => ipcRenderer.invoke('host:completeWorkspaceSave', response),
  onWorkspaceSave: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('host:workspaceSave', handler);
    return () => ipcRenderer.removeListener('host:workspaceSave', handler);
  },
  onUpdatePrepare: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('host:updatePrepare', handler);
    return () => ipcRenderer.removeListener('host:updatePrepare', handler);
  },
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('host:updateStatus', handler);
    return () => ipcRenderer.removeListener('host:updateStatus', handler);
  },
  completeUpdatePrepare: (result) => ipcRenderer.invoke('host:completeUpdatePrepare', result),
  completeUpdateRestore: () => ipcRenderer.invoke('host:completeUpdateRestore'),
  getUpdateStatus: () => ipcRenderer.invoke('host:getUpdateStatus'),
  decideUpdate: (decision) => ipcRenderer.invoke('host:decideUpdate', decision),
  listProjectThreads: (cwd, cursor) => ipcRenderer.invoke('host:listProjectThreads', cwd, cursor),
  listArchivedThreads: (cursor) => ipcRenderer.invoke('host:listArchivedThreads', cursor),
  searchThreads: (options) => ipcRenderer.invoke('host:searchThreads', options),
  readArchivedThread: (options) => ipcRenderer.invoke('host:readArchivedThread', options),
  manageThread: (options) => ipcRenderer.invoke('host:manageThread', options),
  openArchivedPath: (options) => ipcRenderer.invoke('host:openArchivedPath', options),
  createSession: (options) => ipcRenderer.invoke('host:createSession', options),
  createWorktreeSession: (options) => ipcRenderer.invoke('host:createWorktreeSession', options),
  listWorktrees: (cwd) => ipcRenderer.invoke('host:listWorktrees', cwd),
  previewWorktreeMerge: (cwd) => ipcRenderer.invoke('host:previewWorktreeMerge', cwd),
  mergeWorktree: (cwd) => ipcRenderer.invoke('host:mergeWorktree', cwd),
  removeWorktree: (cwd, options) => ipcRenderer.invoke('host:removeWorktree', cwd, options),
  closeSession: (id) => ipcRenderer.invoke('host:closeSession', id),
  closeProject: (cwd, options) => ipcRenderer.invoke('host:closeProject', cwd, options),
  forSession,
});
