import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

const DEFAULT_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FILES = 5;
const MAX_LINE_BYTES = 8 * 1024;
const LOG_NAME = /^desk-(\d{13})-(\d+)-([a-f0-9]{16})\.(\d{6})\.jsonl$/;
const ID = /^[a-f0-9]{16}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){0,4})?$/;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const EVENTS = new Set([
  'app.start', 'app.ready', 'app.quit', 'app.fatal', 'app.unhandled', 'app.childGone', 'app.profile',
  'window.created', 'window.closed', 'window.loadFailed', 'window.unresponsive',
  'window.rendererGone', 'window.preloadError', 'window.openFailed',
  'session.created', 'session.disposed', 'ipc.start', 'ipc.complete', 'ipc.failed',
  'renderer.error', 'diagnostics.run', 'diagnostics.exported', 'diagnostics.exportFailed', 'update.failed',
  'notification.failed',
  'transport.start', 'transport.ready', 'transport.end', 'transport.exit', 'transport.diagnostic',
  'rpc.start', 'rpc.complete', 'rpc.failed', 'rpc.respond', 'rpc.serverRequest', 'rpc.notification',
  'codex.notification', 'codex.serverRequest', 'codex.version', 'claude.version',
  'claude.token.saved', 'claude.token.cleared',
  'terminal.opened', 'terminal.closed', 'terminal.failed', 'unknown',
]);
const CHANNELS = new Set([
  'host:getSettings', 'host:setSettings', 'host:openTerminal', 'host:getMcpConfig',
  'host:previewMcpImport', 'host:saveMcpImport', 'host:reloadMcp', 'host:checkMcp',
  'host:getWorkspace', 'host:listArchivedThreads', 'host:searchThreads',
  'host:saveWorkspaceState', 'host:completeWorkspaceSave',
  'host:getNotificationSettings', 'host:setNotificationSettings', 'host:setNotificationContext', 'host:notifySession', 'host:getWindowFocus',
  'host:readArchivedThread', 'host:manageThread', 'host:openArchivedPath',
  'host:listProjectThreads', 'host:createSession', 'host:closeSession', 'host:closeProject',
  'host:chooseDirectory', 'host:chooseExecutable', 'host:saveImages',
  'host:chooseComposerFiles',
  'host:readAttachment', 'host:openPath', 'host:listFiles', 'host:showPathMenu',
  'host:getGitStatus', 'host:getGitDiff',
  'host:searchProjectFiles', 'host:readProjectFile', 'host:searchHistory', 'host:resolveHistoryTarget', 'host:listBookmarks', 'host:saveBookmark', 'host:removeBookmark',
  'host:previewGitRollback', 'host:applyGitRollback', 'host:listGitRollbacks', 'host:previewUndoGitRollback', 'host:undoGitRollback',
  'host:getDiagnosticsStatus', 'host:exportDiagnostics', 'host:reportRendererError',
  'host:openDiagnosticsFolder', 'host:rendererError', 'host:getBuildInfo', 'host:completeUpdatePrepare', 'host:completeUpdateRestore', 'host:getUpdateStatus', 'host:decideUpdate',
  'host:getClaudeAuthStatus', 'host:loginClaude', 'host:getClaudeToken', 'host:setClaudeToken', 'host:clearClaudeToken', 'host:setupClaudeToken',
  'codex:start', 'codex:request', 'codex:respond', 'unknown',
  'setup:state', 'setup:scan', 'setup:install', 'setup:chooseExecutable', 'setup:previewConfig', 'setup:applyConfig',
  'setup:authStatus', 'setup:login', 'setup:openPortal', 'setup:openGitWebsite', 'setup:complete',
]);
const METHODS = new Set([
  'initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/read', 'thread/list',
  'thread/items/list', 'thread/turns/list', 'thread/name/set', 'thread/compact/start',
  'thread/archive', 'thread/delete', 'thread/unarchive', 'turn/start', 'turn/interrupt',
  'turn/steer', 'model/list', 'account/read', 'config/read', 'config/batchWrite',
  'config/mcpServer/reload', 'mcpServerStatus/list', 'turn/started', 'turn/completed',
  'error', 'thread/started', 'thread/compacted', 'serverRequest/resolved',
  'thread/status/changed', 'mcpServer/startupStatus/updated',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'item/tool/call',
  'mcpServer/elicitation/request', 'account/chatgptAuthTokens/refresh',
  'attestation/generate', 'applyPatchApproval', 'execCommandApproval', 'unknown',
]);
const STATES = new Set([
  'ready', 'starting', 'stopped', 'error', 'opened', 'closed', 'inProgress',
  'completed', 'failed', 'interrupted', 'notLoaded', 'idle', 'systemError', 'active',
  'cancelled', 'canceled', 'connected', 'disconnected', 'unknown',
]);
const REASONS = new Set([
  'crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit', 'clean-exit',
  'stderr', 'stream', 'spawn', 'protocol', 'stop', 'exit', 'malformed_frame',
  'duplicate_request', 'oversized_diagnostic', 'stderr_read', 'throttled', 'unknown',
]);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'AbortError']);
const ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EMFILE', 'ENFILE',
  'EIO', 'EROFS', 'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'ECONNABORTED', 'ERR_ABORTED', 'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE', 'ERR_STREAM_DESTROYED', 'ERR_IPC_CHANNEL_CLOSED',
]);
const CATEGORIES = new Set([
  'unknown', 'sandbox_permission', 'writer_conflict', 'timeout', 'not_found',
  'permission_denied', 'disk_full', 'connection_closed', 'connection_failed',
  'authentication', 'rate_limit', 'context_limit', 'cancelled', 'invalid_json',
  'invalid_request', 'unsupported_method', 'protocol', 'thread_not_found',
  'config_conflict', 'sandbox', 'server_error',
]);
const CODEX_ERRORS = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
  'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'internalServerError', 'unauthorized', 'badRequest',
  'threadRollbackFailed', 'sandboxError', 'responseStreamDisconnected',
  'responseTooManyFailedAttempts', 'activeTurnNotSteerable', 'other',
]);
const NUMBERS = new Set([
  'windowId', 'requestId', 'durationMs', 'generation', 'count', 'exitCode', 'code',
  'suppressedCount', 'httpStatusCode', 'bytes', 'files', 'entries', 'line', 'column',
]);
const BOOLEANS = new Set(['success', 'canceled', 'retry', 'packaged', 'available']);
const IDS = new Set(['sessionId', 'clientId', 'threadId', 'turnId', 'projectId', 'fingerprint']);
const VERSION_KEYS = new Set(['appVersion', 'electronVersion', 'chromeVersion', 'nodeVersion', 'codexVersion', 'claudeVersion']);
const APP_FILES = new Set([
  'main.mjs', 'preload.cjs', 'diagnostics.mjs', 'codex-client.mjs', 'window-session.mjs',
  'notification-service.mjs', 'NotificationSettings.tsx',
  'host-utils.mjs', 'mcp-config.mjs', 'mcp-service.mjs', 'file-links.mjs', 'attachments.mjs',
  'project-files.mjs', 'project-history.mjs', 'thread-management.mjs', 'terminal-launcher.mjs',
  'App.tsx', 'Workspace.tsx', 'Conversation.tsx', 'useCodex.ts', 'main.tsx',
  'Diagnostics.tsx', 'renderer-diagnostics.ts', 'Markdown.tsx', 'Approval.tsx', 'Panels.tsx',
  'ArchiveView.tsx', 'ChatSearch.tsx', 'McpSettings.tsx', 'ProjectSidebar.tsx', 'ProjectTree.tsx',
  'FileBrowser.tsx', 'WorkLog.tsx', 'useCacheKeepAlive.ts', 'TokenUsage.tsx', 'ThreadMenu.tsx',
]);
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
// Only actual shipped asset names may occur in stack frames. An arbitrary
// basename from an error is not trusted, even if it looks like a bundle name.
try {
  for (const name of fs.readdirSync(new URL('../dist/assets/', import.meta.url))) {
    if (/^index-[A-Za-z0-9_-]{6,20}\.js$/.test(name)) APP_FILES.add(name);
  }
} catch { /* Development can start before dist exists. */ }

function field(object, key) {
  // Accessor properties and proxies supplied by renderer/foreign errors must
  // not run arbitrary getters while attempting to report another failure.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object ?? {}, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value;
    // V8 in Node 24 implements Error.stack with its native lazy accessor, even
    // after assignment. Permit only that exact built-in getter, never a foreign
    // object's getter. Older V8 versions expose stack as an ordinary value.
    if (key === 'stack' && nativeStackGetter && descriptor?.get === nativeStackGetter) return nativeStackGetter.call(object);
    return undefined;
  } catch { return undefined; }
}

function safeMetadata(value) {
  const result = {};
  for (const key of VERSION_KEYS) {
    const candidate = field(value, key);
    if (typeof candidate === 'string' && (key === 'chromeVersion'
      ? /^\d{1,5}(?:\.\d{1,5}){3}$/.test(candidate) : VERSION.test(candidate))) result[key] = candidate;
  }
  const platform = field(value, 'platform');
  const arch = field(value, 'arch');
  const osRelease = field(value, 'osRelease');
  const buildId = field(value, 'buildId');
  const builtAt = field(value, 'builtAt');
  if (['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'aix', 'sunos'].includes(platform)) result.platform = platform;
  if (['x64', 'arm64', 'ia32', 'arm', 'ppc64', 's390x', 'riscv64'].includes(arch)) result.arch = arch;
  if (typeof osRelease === 'string' && /^\d{1,6}(?:\.\d{1,6}){0,5}$/.test(osRelease)) result.osRelease = osRelease;
  if (typeof buildId === 'string' && /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(buildId)) result.buildId = buildId;
  if (typeof builtAt === 'string' && DATE.test(builtAt)) result.builtAt = builtAt;
  if (typeof field(value, 'packaged') === 'boolean') result.packaged = field(value, 'packaged');
  const releaseChannel = field(value, 'releaseChannel');
  if (['stable', 'nightly', 'development'].includes(releaseChannel)) result.releaseChannel = releaseChannel;
  return result;
}

function safeFrames(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  // Ignore the first line (the message). Function names, paths, URLs, and source
  // text are never recorded. At most 8 app locations are useful for diagnosis.
  for (const line of stack.slice(0, 32_768).split(/\r?\n/).slice(1, 40)) {
    const match = line.match(/(?:[\\/]|\s|\()([^\\/\s():]+):(\d{1,8}):(\d{1,8})\)?\s*$/);
    if (!match || !APP_FILES.has(match[1])) continue;
    frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
    if (frames.length === 8) break;
  }
  return frames;
}

function safeError(value) {
  const result = {};
  const category = field(value, 'category'), name = field(value, 'name'), code = field(value, 'code');
  result.category = CATEGORIES.has(category) ? category : 'unknown';
  if (ERROR_NAMES.has(name)) result.name = name;
  if ((typeof code === 'number' && Number.isSafeInteger(code)) || ERROR_CODES.has(code)) result.code = code;
  const fingerprint = field(value, 'fingerprint');
  if (typeof fingerprint === 'string' && ID.test(fingerprint)) result.fingerprint = fingerprint;
  const codexErrorInfo = field(value, 'codexErrorInfo');
  if (CODEX_ERRORS.has(codexErrorInfo)) result.codexErrorInfo = codexErrorInfo;
  const httpStatusCode = field(value, 'httpStatusCode');
  if (Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599) result.httpStatusCode = httpStatusCode;
  const frames = field(value, 'frames');
  if (Array.isArray(frames)) {
    result.frames = frames.slice(0, 8).flatMap(frame => {
      const originalFile = field(frame, 'file'), line = field(frame, 'line'), column = field(frame, 'column');
      // The previous build's bundle may no longer exist. Retain its useful
      // location under a fixed name; the adjacent run header identifies build.
      const file = APP_FILES.has(originalFile) ? originalFile
        : typeof originalFile === 'string' && (/^index-[A-Za-z0-9_-]{6,20}\.js$/.test(originalFile) || originalFile === 'renderer.js') ? 'renderer.js' : null;
      return file && Number.isInteger(line) && line >= 0 && line <= 99_999_999
        && Number.isInteger(column) && column >= 0 && column <= 99_999_999 ? [{ file, line, column }] : [];
    });
  }
  return result;
}

function safeData(data) {
  const result = safeMetadata(data);
  for (const key of NUMBERS) {
    const value = field(data, key);
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) result[key] = value;
  }
  for (const key of BOOLEANS) if (typeof field(data, key) === 'boolean') result[key] = field(data, key);
  for (const key of IDS) if (typeof field(data, key) === 'string' && ID.test(field(data, key))) result[key] = field(data, key);
  for (const [key, allowed] of [['method', METHODS], ['channel', CHANNELS], ['state', STATES], ['status', STATES], ['reason', REASONS]]) {
    const value = field(data, key);
    if (typeof value === 'string') result[key] = allowed.has(value) ? value : 'unknown';
  }
  const signal = field(data, 'signal');
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGBREAK', 'SIGQUIT'].includes(signal)) result.signal = signal;
  const kind = field(data, 'kind');
  if (['error', 'unhandledrejection', 'react'].includes(kind)) result.kind = kind;
  const error = field(data, 'error');
  if (error && typeof error === 'object') result.error = safeError(error);
  return result;
}

function classify(error, hash) {
  const rawMessage = typeof error === 'string' ? error : field(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 65_536) : '';
  const code = field(error, 'code');
  let category = 'unknown';
  if (/helper_sandbox_lock_failed|SetNamedSecurityInfoW/i.test(message)) category = 'sandbox_permission';
  else if (/already has an active writer|writer.{0,30}(?:conflict|lock|already active)|занят.*(?:диалог|терминал)/i.test(message)) category = 'writer_conflict';
  else if (/thread.{0,60}not found|диалог не найден/i.test(message)) category = 'thread_not_found';
  else if (code === 'ETIMEDOUT' || /timed?\s*out|timeout|истекло время/i.test(message)) category = 'timeout';
  else if (code === 'ENOENT' || /Codex не найден|Файл или папка не найдены/i.test(message)) category = 'not_found';
  else if (code === 'EACCES' || code === 'EPERM' || /access denied|permission denied|отказано в доступе/i.test(message)) category = 'permission_denied';
  else if (code === 'ENOSPC') category = 'disk_full';
  else if (/unauthorized|authentication|invalid api key|not authenticated|401\b/i.test(message)) category = 'authentication';
  else if (/rate.limit|too many requests|429\b/i.test(message)) category = 'rate_limit';
  else if (/context.window|context.length|maximum context/i.test(message)) category = 'context_limit';
  else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') category = 'connection_failed';
  else if (code === 'EPIPE' || code === 'ECONNRESET' || /connection is closed|output stream closed|app-server exited|is not running/i.test(message)) category = 'connection_closed';
  else if (/invalid json|unexpected token.*json|malformed.*protocol/i.test(message) || error instanceof SyntaxError) category = 'invalid_json';
  else if (code === -32601 || /not supported yet|unknown method|method not found/i.test(message)) category = 'unsupported_method';
  else if (/configuration.*changed|config.*(?:conflict|version)|конфиг.*измен/i.test(message)) category = 'config_conflict';
  else if (/cancelled|canceled|was stopped|was interrupted|AbortError/i.test(message)) category = 'cancelled';
  else if (code === -32600 || code === -32602) category = 'invalid_request';
  else if (/oversized protocol|without a result/i.test(message)) category = 'protocol';
  const inheritedName = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
    : error instanceof ReferenceError ? 'ReferenceError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
  const result = { category, name: ERROR_NAMES.has(field(error, 'name')) ? field(error, 'name') : inheritedName, fingerprint: hash(message), frames: safeFrames(field(error, 'stack')) };
  if ((typeof code === 'number' && Number.isSafeInteger(code)) || ERROR_CODES.has(code)) result.code = code;
  const info = field(error, 'codexErrorInfo');
  const infoType = typeof info === 'string' && CODEX_ERRORS.has(info) ? info
    : [...CODEX_ERRORS].find(key => field(info, key) !== undefined);
  if (infoType) {
    result.codexErrorInfo = infoType;
    const httpStatusCode = field(field(info, infoType), 'httpStatusCode');
    if (Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599) result.httpStatusCode = httpStatusCode;
    if (category === 'unknown') {
      result.category = ({ unauthorized: 'authentication', rateLimitExceeded: 'rate_limit', usageLimitExceeded: 'rate_limit',
        contextWindowExceeded: 'context_limit', sandboxError: 'sandbox', badRequest: 'invalid_request',
        httpConnectionFailed: 'connection_failed', responseStreamConnectionFailed: 'connection_failed',
        responseStreamDisconnected: 'connection_closed', internalServerError: 'server_error', serverOverloaded: 'server_error' })[infoType] ?? 'unknown';
    }
  }
  return result;
}

function safeEntry(value) {
  const time = field(value, 'time'), runId = field(value, 'runId'), sequence = field(value, 'sequence');
  if (typeof time !== 'string' || !DATE.test(time) || typeof runId !== 'string' || !ID.test(runId)
      || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  return {
    time, runId, sequence,
    level: LEVELS.has(field(value, 'level')) ? field(value, 'level') : 'info',
    event: EVENTS.has(field(value, 'event')) ? field(value, 'event') : 'unknown',
    data: safeData(field(value, 'data')),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Local, content-free diagnostics. Never pass messages/configs to record().
 * Writes are synchronous and bounded so fatal errors survive without a flush.
 * Only exportReport() may reject; all background logging is best effort.
 */
export function createDiagnostics({ directory, metadata = {}, limits = {} } = {}) {
  const salt = randomBytes(32);
  const runId = randomBytes(8).toString('hex');
  const prefix = `desk-${Date.now()}-${process.pid}-${runId}`;
  const maxFileBytes = Number.isInteger(limits.maxFileBytes) && limits.maxFileBytes >= 1024 ? Math.min(limits.maxFileBytes, DEFAULT_FILE_BYTES) : DEFAULT_FILE_BYTES;
  const maxFiles = Number.isInteger(limits.maxFiles) && limits.maxFiles >= 1 ? Math.min(limits.maxFiles, DEFAULT_FILES) : DEFAULT_FILES;
  const totalBytes = maxFileBytes * maxFiles;
  const environment = safeMetadata(metadata);
  let available = false, writeErrors = 0, sequence = 0, part = 0, filename = null, currentBytes = 0;
  let root;
  const hash = value => createHmac('sha256', salt).update(String(value).slice(0, 65_536)).digest('hex').slice(0, 16);
  const fail = () => { available = false; writeErrors++; };
  function rootSafe() {
    if (!root) return false;
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink();
  }
  function files() {
    if (!rootSafe()) return [];
    return fs.readdirSync(root).flatMap(name => {
      const match = LOG_NAME.exec(name);
      if (!match) return [];
      try {
        const stat = fs.lstatSync(path.join(root, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return [];
        return [{ name, bytes: stat.size, modified: stat.mtimeMs, pid: Number(match[2]), runId: match[3], part: Number(match[4]) }];
      } catch { return []; }
    }).sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  }
  function trim() {
    const all = files();
    const ours = all.filter(file => file.runId === runId).sort((a, b) => b.part - a.part);
    const remove = file => { try { fs.unlinkSync(path.join(root, file.name)); } catch { /* Another instance may already have pruned an old log. */ } };
    for (const file of ours.slice(maxFiles)) remove(file);
    let keptBytes = ours.slice(0, maxFiles).reduce((sum, file) => sum + file.bytes, 0);
    let keptFiles = Math.min(ours.length, maxFiles);
    for (const file of all) {
      if (file.runId === runId || alive(file.pid)) continue;
      if (keptFiles >= maxFiles || keptBytes + file.bytes > totalBytes || file.bytes > maxFileBytes) remove(file);
      else { keptFiles++; keptBytes += file.bytes; }
    }
  }
  function nextFile() {
    if (!rootSafe()) throw new Error('Unsafe diagnostics directory.');
    const next = path.join(root, `${prefix}.${String(part++).padStart(6, '0')}.jsonl`);
    const header = `${JSON.stringify({ time: new Date().toISOString(), runId, sequence: ++sequence,
      level: 'info', event: 'diagnostics.run', data: environment })}\n`;
    const fd = fs.openSync(next, 'wx', 0o600);
    try { fs.writeFileSync(fd, header, 'utf8'); } finally { fs.closeSync(fd); }
    filename = next;
    currentBytes = Buffer.byteLength(header);
    trim();
  }
  try {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Diagnostics directory is required.');
    root = path.resolve(directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    nextFile();
    available = true;
  } catch { fail(); }

  function record(level, event, data = {}) {
    try {
      if (!filename && root) {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        nextFile();
      }
      if (!filename || !rootSafe()) { fail(); return; }
      const entry = { time: new Date().toISOString(), runId, sequence: ++sequence,
        level: LEVELS.has(level) ? level : 'info', event: EVENTS.has(event) ? event : 'unknown',
        data: event === 'app.start' ? { ...safeData(data), ...environment } : safeData(data) };
      if (event === 'codex.version' && entry.data.codexVersion) environment.codexVersion = entry.data.codexVersion;
      if (event === 'claude.version' && entry.data.claudeVersion) environment.claudeVersion = entry.data.claudeVersion;
      let line = `${JSON.stringify(entry)}\n`;
      let bytes = Buffer.byteLength(line);
      if (bytes > Math.min(MAX_LINE_BYTES, maxFileBytes)) { fail(); return; }
      if (currentBytes + bytes > maxFileBytes) {
        nextFile();
        entry.sequence = ++sequence;
        line = `${JSON.stringify(entry)}\n`;
        bytes = Buffer.byteLength(line);
      }
      if (currentBytes + bytes > maxFileBytes) { fail(); return; }
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Unsafe diagnostics file.');
      const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink > 1 || opened.ino !== stat.ino) throw new Error('Diagnostics file changed.');
        fs.writeFileSync(fd, line, 'utf8');
      } finally { fs.closeSync(fd); }
      currentBytes += bytes;
      available = true;
    } catch { fail(); }
  }
  function status() {
    try {
      const all = files();
      return { available, writeErrors, files: all.length, bytes: all.reduce((sum, file) => sum + file.bytes, 0), runId };
    } catch { return { available: false, writeErrors, files: 0, bytes: 0, runId }; }
  }
  async function exportReport(target, extraMetadata = {}) {
    // User-selected export is the only operation that reports an I/O failure.
    // Read only own bounded JSONL files; never scan config/history/attachments.
    if (typeof target !== 'string' || !target) throw new TypeError('Diagnostics export path is required.');
    const destination = path.resolve(target);
    const comparable = value => process.platform === 'win32' ? value?.toLowerCase() : value;
    if (comparable(path.dirname(destination)) === comparable(root) && LOG_NAME.test(path.basename(destination).toLowerCase())) throw new Error('Cannot overwrite a diagnostic log.');
    const logs = [];
    let bytesRead = 0, selectedFiles = 0;
    let candidates = [];
    try { candidates = files(); } catch { /* Storage failure still permits an environment-only export. */ }
    for (const file of candidates) {
      if (selectedFiles >= maxFiles || bytesRead >= totalBytes) break;
      if (file.bytes > maxFileBytes) continue;
      let text;
      try {
        const source = path.join(root, file.name);
        const before = fs.lstatSync(source);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) continue;
        const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.nlink > 1 || opened.ino !== before.ino || opened.size > maxFileBytes) continue;
          // A concurrent active run can append after fstat; read the bounded
          // snapshot, never readFile() a file that might keep growing.
          const buffer = Buffer.alloc(Math.min(opened.size, totalBytes - bytesRead));
          const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, count).toString('utf8');
          bytesRead += count;
          selectedFiles++;
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
        try {
          const entry = safeEntry(JSON.parse(line));
          if (entry) logs.push(entry);
        } catch { /* Truncated final records and foreign content are omitted. */ }
      }
    }
    logs.sort((a, b) => a.time.localeCompare(b.time) || a.runId.localeCompare(b.runId) || a.sequence - b.sequence);
    const report = {
      format: 'codex-desk-diagnostics', schemaVersion: 1, createdAt: new Date().toISOString(),
      environment: { ...environment, ...safeMetadata(extraMetadata) },
      privacy: { contentIncluded: false, pathsIncluded: false, identifiers: 'salted-per-run' },
      limits: { maxFileBytes, maxFiles, maxLogBytes: totalBytes },
      storage: { ...status(), exportedFiles: selectedFiles, exportedEntries: logs.length },
      logs,
    };
    const output = `${JSON.stringify(report)}\n`;
    const temporary = path.join(path.dirname(destination), `.codex-diagnostics-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, destination);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
    return { path: destination, bytes: Buffer.byteLength(output), entries: logs.length, files: selectedFiles };
  }
  return Object.freeze({
    record,
    error(event, error, data = {}, level = 'error') {
      try { record(level, event, { ...safeData(data), error: classify(error, hash) }); } catch { fail(); }
    },
    id(value) {
      try { return value == null ? undefined : hash(value); } catch { return undefined; }
    },
    flush() { /* Writes already completed; retained for graceful shutdown API. */ },
    status,
    exportReport,
  });
}
