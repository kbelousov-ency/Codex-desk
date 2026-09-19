import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readAttachment } from './attachments.mjs';

const MAX_FRAME = 32 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
// steer: a user frame written mid-turn is folded into the running turn between tool
// rounds; the result lists every consumed uuid. compact: the documented `/compact`
// slash command runs as its own turn and emits a compact_boundary system frame.
// archive: native Claude history has no archive; rename/delete are handled by ClaudeThreadManagement.
export const CLAUDE_CAPABILITIES = Object.freeze({ steer: true, compact: true, terminal: true, mcp: false, archive: false });
const MAX_STEERS = 16;
const cleanTitle = value => {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 200 || /[\r\n\0]/.test(title)) throw new Error('Название должно содержать от 1 до 200 символов в одной строке.');
  return title;
};

function rawId(value) {
  if (typeof value !== 'string' || !value.startsWith('claude:') || !UUID.test(value.slice(7))) throw new Error('Некорректный идентификатор диалога Claude.');
  return value.slice(7);
}
function safeText(value, limit = 4_000) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]').slice(0, limit);
}
function textContent(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
}
function permissionMode(params, fallback) {
  if (params.access && params.access !== 'inherited') return ({ auto: 'acceptEdits', 'workspace-write': 'default', 'read-only': 'plan', 'danger-full-access': 'bypassPermissions' })[params.access] || fallback;
  const sandbox = params.sandbox || params.sandboxPolicy?.type;
  if (['danger-full-access', 'dangerFullAccess'].includes(sandbox)) return 'bypassPermissions';
  if (['read-only', 'readOnly'].includes(sandbox)) return 'plan';
  if (['workspace-write', 'workspaceWrite'].includes(sandbox)) return params.approvalsReviewer === 'auto_review' ? 'acceptEdits' : 'default';
  return fallback;
}
function usageBreakdown(usage, camel = false) {
  const count = key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : undefined;
  const ordinary = count(camel ? 'inputTokens' : 'input_tokens');
  const cached = count(camel ? 'cacheReadInputTokens' : 'cache_read_input_tokens');
  const writing = count(camel ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens');
  const output = count(camel ? 'outputTokens' : 'output_tokens');
  const input = ordinary === undefined ? undefined : ordinary + (cached || 0) + (writing || 0);
  return { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: writing, outputTokens: output,
    totalTokens: input === undefined || output === undefined ? undefined : input + output,
    ...(camel && count('thinkingTokens') !== undefined ? { reasoningOutputTokens: count('thinkingTokens') } : {}) };
}

/** Adapter for the installed Claude Code CLI's documented SDK stream/control protocol.
 * No SDK prompt replacement, credential reads, global config writes or model calls at startup.
 */
export class ClaudeClient extends EventEmitter {
  constructor({ executable = 'claude', cwd, settings = {}, history, attachmentsDirectory, spawnImpl = spawn, requestTimeoutMs = 120_000, diagnostics, diagnosticContext = {} } = {}) {
    super();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('requestTimeoutMs must be positive.');
    this.executable = executable; this.cwd = cwd; this.settings = { ...settings };
    this.history = history; this.attachmentsDirectory = attachmentsDirectory;
    this._spawn = spawnImpl; this._timeout = requestTimeoutMs; this._diagnostics = diagnostics; this._diagnosticContext = diagnosticContext;
    this._session = null; this._startPromise = null; this._active = null; this._thread = null; this._relaunch = null;
    this._mutation = false; this._generation = 0; this.state = 'stopped'; this.capabilities = CLAUDE_CAPABILITIES;
  }

  start() {
    if (this._startPromise) return this._startPromise;
    const promise = Promise.resolve().then(() => {
      if (this._startPromise !== promise) throw new Error('Запуск Claude остановлен.');
      this._thread = null;
      return this._launch({ id: randomUUID(), mode: permissionMode(this.settings), model: this.settings.model, effort: this.settings.effort });
    });
    this._startPromise = promise;
    promise.catch(() => { if (this._startPromise === promise) this._startPromise = null; });
    return promise;
  }

  async _launch({ id, resume = false, mode, model, effort }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host',
      resume ? '--resume' : '--session-id', id];
    if (mode) { if (!PERMISSION_MODES.has(mode)) throw new Error('Неизвестный режим доступа Claude.'); args.push('--permission-mode', mode); }
    if (mode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    if (model) { this._validModel(model); args.push('--model', model); }
    if (effort) { this._validEffort(effort); args.push('--effort', effort); }
    const session = { id, ended: false, pending: new Map(), requests: new Map(), writes: new Set(),
      decoder: new StringDecoder('utf8'), output: '', child: null, initialized: {}, applied: {}, model, effort,
      mode, bypassEnabled: mode === 'bypassPermissions', resumed: resume, sent: false, blocks: new Map(), messageId: null };
    this._session = session; this._status('starting');
    try {
      const child = this._spawn(this.executable, args, { cwd: this.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      session.child = child;
      child.on('error', error => this._end(session, new Error(safeText(error.message)), 'error'));
      child.on('exit', (code, signal) => this._end(session, new Error(`Claude CLI завершился (${signal || code || 0}).`), 'stopped'));
      child.stdin.on('error', () => this._end(session, new Error('Ошибка отправки в Claude CLI.'), 'error'));
      child.stdout.on('error', () => this._end(session, new Error('Ошибка чтения Claude CLI.'), 'error'));
      child.stdout.on('data', chunk => this._receive(session, session.decoder.write(chunk)));
      child.stdout.on('end', () => {
        this._receive(session, session.decoder.end());
        if (session.output.trim()) this._frame(session, session.output);
        this._end(session, new Error('Поток Claude CLI закрыт.'), 'stopped');
      });
      // Arbitrary stderr can contain user input, config and secrets. Surface only a generic diagnostic.
      let warned = false;
      child.stderr.on('data', () => { if (!warned && !session.ended) { warned = true; this.emit('diagnostic', 'Claude CLI передал диагностическое сообщение.'); } });
      child.stderr.on('error', () => {});
      session.initialized = await this._control(session, 'initialize');
      session.mode = session.initialized.current_permission_mode || mode;
      const effective = await this._control(session, 'get_settings');
      // Do not retain full settings: env and per-source config may carry credentials.
      session.applied = { model: effective?.applied?.model, effort: effective?.applied?.effort };
      // The version is informational: a CLI that cannot answer this request still boots.
      const binary = await this._control(session, 'get_binary_version', {}, 5_000).catch(() => null);
      this._ensureSession(session);
      this._version(session, binary?.version);
      this._status('ready');
      return { userAgent: 'claude-code', provider: 'claude', capabilities: this.capabilities, version: session.version };
    } catch (error) { this._end(session, error, 'error'); throw error; }
  }

  _validModel(model) { if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+\[\]-]{0,255}$/.test(model)) throw new Error('Некорректная модель Claude.'); }
  _validEffort(effort) { if (!EFFORTS.has(effort)) throw new Error('Неизвестный уровень рассуждений Claude.'); }
  _ensureSession(session = this._session) { if (!session || session.ended || session !== this._session) throw new Error('Нет подключения к Claude CLI.'); return session; }
  _ensureThread(id) { if (!this._thread || this._thread.id !== id) throw new Error('Откройте этот диалог Claude перед отправкой.'); }
  _config() {
    const s = this._ensureSession();
    return { model: s.applied.model || s.model || '', model_reasoning_effort: s.applied.effort || s.effort || null };
  }

  async request(method, params = {}) {
    if (params.cwd && path.resolve(params.cwd).toLowerCase() !== path.resolve(this.cwd).toLowerCase()) throw new Error('Диалог Claude находится в другой рабочей папке.');
    // Native history is read from files and must stay available while the CLI process is being replaced.
    if (method === 'thread/list') return this.history?.list({ ...params, cwd: this.cwd }) || { data: this._thread ? [this._thread] : [], nextCursor: null };
    if (method === 'thread/read' && this._thread?.id !== params.threadId) {
      rawId(params.threadId);
      if (!this.history) throw new Error('История Claude недоступна.');
      return this.history.read({ ...params, cwd: this.cwd });
    }
    // A resume/restart replaces the process; later requests wait for the new one instead of failing on the old.
    if (this._relaunch) await this._relaunch.catch(() => {});
    const session = this._ensureSession();
    if (method === 'model/list') {
      const rows = [...(session.initialized.models || [])], current = this._config().model;
      if (current && !rows.some(m => m.value === current)) {
        const matching = rows.find(m => m.resolvedModel === current);
        rows.unshift({ ...matching, value: current, displayName: matching?.displayName || current });
      }
      return { data: rows.map(m => ({
      id: m.value, model: m.value, displayName: m.displayName || m.value, description: m.description,
      isDefault: m.value === this._config().model, defaultReasoningEffort: this._config().model_reasoning_effort || '',
      supportedReasoningEfforts: (m.supportedEffortLevels || []).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
      inputModalities: ['text', 'image'],
      })), nextCursor: null };
    }
    if (method === 'account/read') {
      const account = session.initialized.account || {};
      return { account: { type: 'claude', email: account.email, planType: account.subscriptionType, apiProvider: account.apiProvider }, requiresOpenaiAuth: false };
    }
    if (method === 'config/read') return { config: this._config(), layers: null, origins: {} };
    if (method === 'thread/read') { rawId(params.threadId); return { thread: structuredClone(this._thread) }; }
    if (method === 'turn/steer') {
      this._ensureThread(params.threadId);
      const active = this._active;
      if (!active || (params.expectedTurnId && active.id !== params.expectedTurnId)) throw new Error('Текущая задача Claude уже завершилась. Отправьте сообщение обычным способом.');
      if (active.compaction) throw new Error('Дождитесь окончания сжатия контекста Claude.');
      if (active.interrupted) throw new Error('Задача Claude останавливается. Дождитесь завершения.');
      if (active.steers.size >= MAX_STEERS) throw new Error('Слишком много уточнений в одном запросе. Дождитесь завершения.');
      const content = await this._input(params.input);
      if (this._active !== active) throw new Error('Текущая задача Claude уже завершилась. Отправьте сообщение обычным способом.');
      const owned = this._ensureSession();
      const id = typeof params.clientUserMessageId === 'string' && UUID.test(params.clientUserMessageId) && !active.items.has(params.clientUserMessageId) && !active.steers.has(params.clientUserMessageId) ? params.clientUserMessageId : randomUUID();
      active.steers.set(id, structuredClone(params.input));
      try { await this._write(owned, { type: 'user', uuid: id, session_id: owned.id, parent_tool_use_id: null, message: { role: 'user', content } }); }
      catch (error) { active.steers.delete(id); throw error; }
      // The CLI echoes the frame with --replay-user-messages; show it now so the
      // acknowledged steer is visible even when the echo is delayed.
      if (this._active === active) this._userEcho({ uuid: id });
      return { turnId: active.id, userMessageId: id };
    }
    if (method === 'thread/name/set') {
      this._ensureThread(params.threadId);
      const title = cleanTitle(params.name);
      await this._control(session, 'rename_session', { title, source: 'host', session_id: session.id });
      if (this._thread?.id === params.threadId) { this._thread.name = title; this._notify('thread/name/updated', { threadId: params.threadId, name: title }); }
      return { thread: structuredClone(this._thread) };
    }
    if (method === 'thread/compact/start') {
      this._ensureThread(params.threadId);
      if (this._mutation || this._active) throw new Error('Дождитесь завершения текущей задачи Claude.');
      if (!session.sent && !session.resumed) throw new Error('Диалог Claude ещё пуст: сжимать нечего.');
      this._mutation = true;
      try {
        const owned = this._ensureSession();
        const turn = this._beginTurn({ sourceInput: [], compaction: true });
        try { await this._write(owned, { type: 'user', uuid: turn.id, session_id: owned.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } }); }
        catch (error) { this._finish('failed', error.message); throw error; }
        return {};
      } finally { this._mutation = false; }
    }
    if (method === 'turn/interrupt') {
      this._ensureThread(params.threadId);
      if (!this._active || (params.turnId && this._active.id !== params.turnId)) return {};
      const active = this._active;
      active.interrupted = true;
      try { await this._control(session, 'interrupt', { cancel_queued: true }); }
      catch (error) { if (this._active === active) active.interrupted = false; throw error; }
      return {};
    }
    if (!['thread/start', 'thread/resume', 'turn/start'].includes(method)) throw new Error(`Действие ${method} пока недоступно для Claude CLI.`);
    if (this._mutation || this._active) throw new Error('Дождитесь завершения текущей задачи Claude.');
    this._mutation = true;
    try {
      if (method === 'thread/start') {
        if (this._thread || session.sent || session.resumed) await this._restart({ id: randomUUID(), ...this._launchSettings(params) });
        await this._configure(params);
        const now = Math.floor(Date.now() / 1000);
        this._thread = { id: `claude:${this._session.id}`, provider: 'claude', cwd: this.cwd, createdAt: now, updatedAt: now,
          name: '', preview: '', historyMode: 'legacy', turns: [], status: { type: 'idle' } };
        this._notify('thread/started', { thread: this._thread });
        return this._threadResponse();
      }
      if (method === 'thread/resume') {
        const id = rawId(params.threadId);
        if (this._thread?.id !== params.threadId) {
          if (!this.history) throw new Error('История Claude недоступна.');
          const loaded = await this.history.read({ threadId: params.threadId, cwd: this.cwd, includeTurns: true });
          if (loaded?.thread?.id !== params.threadId) throw new Error('История вернула другой диалог Claude.');
          if (loaded.thread.cwd && path.resolve(loaded.thread.cwd).toLowerCase() !== path.resolve(this.cwd).toLowerCase()) throw new Error('Диалог Claude находится в другой рабочей папке.');
          await this._restart({ id, resume: true, ...this._launchSettings(params) });
          this._thread = loaded.thread;
        }
        await this._configure(params);
        return this._threadResponse();
      }
      this._ensureThread(params.threadId);
      // Resolve every input before changing or starting a turn. The host owns these image files.
      const content = await this._input(params.input);
      await this._configure(params);
      const owned = this._ensureSession();
      const turn = this._beginTurn({ sourceInput: structuredClone(params.input) });
      try {
        await this._write(owned, { type: 'user', uuid: turn.id, session_id: owned.id, parent_tool_use_id: null, message: { role: 'user', content } });
        owned.sent = true;
        this._userEcho({ uuid: turn.id });
      } catch (error) { this._finish('failed', error.message); throw error; }
      return { turn: { ...turn, items: [] } };
    } finally { this._mutation = false; }
  }

  /** Registers a new in-progress turn on the open thread and announces it. */
  _beginTurn({ id = randomUUID(), sourceInput, steers = new Map(), compaction = false }) {
    const turn = { id, status: 'inProgress', items: [], startedAt: Math.floor(Date.now() / 1000) };
    this._active = { ...turn, items: new Map(), sourceInput, steers, completedMessages: new Set(), latestText: null, compaction };
    this._thread.turns ||= []; this._thread.turns.push(turn); this._thread.status = { type: 'active' };
    this._notify('turn/started', { threadId: this._thread.id, turn });
    return turn;
  }

  _threadResponse() { const config = this._config(); return { thread: structuredClone(this._thread), model: config.model, reasoningEffort: config.model_reasoning_effort, cwd: this.cwd }; }
  _launchSettings(params) { const s = this._session; return { mode: permissionMode(params, s?.mode), model: params.model || s?.model, effort: params.effort || s?.effort }; }
  _restart(options) {
    // The whole replacement (waiting for the old exit, spawning the new process) is one window other requests wait on.
    const run = this._replaceProcess(options);
    this._relaunch = run;
    return run.finally(() => { if (this._relaunch === run) this._relaunch = null; });
  }
  async _replaceProcess(options) {
    const generation = this._generation;
    const old = this._session;
    if (old && !old.ended) {
      // Wait for the owned process to release its native session before resuming it.
      const exited = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { old.child?.off('exit', finish); reject(new Error('Claude CLI ещё завершает предыдущий процесс. Повторите подключение.')); }, 5_000);
        const finish = () => { clearTimeout(timer); resolve(); };
        old.child?.once('exit', finish);
      });
      this._end(old, new Error('Переподключение Claude.'), 'stopped', true);
      await exited;
    }
    if (generation !== this._generation) throw new Error('Переподключение Claude остановлено.');
    await this._launch(options);
  }
  async _configure(params) {
    let s = this._ensureSession();
    const mode = permissionMode(params, s.mode);
    if (mode === 'bypassPermissions' && !s.bypassEnabled) {
      await this._restart({ id: s.id, resume: s.sent || s.resumed, ...this._launchSettings(params) }); s = this._ensureSession();
    }
    if (params.model && params.model !== s.model) { this._validModel(params.model); await this._control(s, 'set_model', { model: params.model }); s.model = params.model; }
    if (params.effort && params.effort !== s.effort) { this._validEffort(params.effort); await this._control(s, 'apply_flag_settings', { settings: { effortLevel: params.effort } }); s.effort = params.effort; }
    if (mode && mode !== s.mode) { await this._control(s, 'set_permission_mode', { mode }); s.mode = mode; }
    if (params.model || params.effort) {
      const applied = (await this._control(s, 'get_settings'))?.applied || {};
      s.applied = { model: applied.model, effort: applied.effort };
    }
  }

  async _input(input) {
    if (!Array.isArray(input) || !input.length || input.length > 30) throw new Error('Пустое или слишком большое сообщение Claude.');
    let images = 0;
    const content = [];
    for (const part of input) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 2_000_000) content.push({ type: 'text', text: part.text });
      else if (part?.type === 'localImage') {
        if (++images > 10 || !this.attachmentsDirectory) throw new Error('Изображение Claude недоступно.');
        const data = await readAttachment(this.attachmentsDirectory, part.path);
        if (!data) throw new Error('Не удалось прочитать выбранное изображение.');
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(data);
        if (!match) throw new Error('Формат изображения не поддерживается.');
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      } else throw new Error('Тип вложения пока недоступен для Claude CLI.');
    }
    if (!content.some(b => b.type === 'image' || b.text.trim())) throw new Error('Введите сообщение.');
    if (JSON.stringify(content).length > MAX_FRAME - 4096) throw new Error('Сообщение слишком большое для Claude. Уменьшите число или размер изображений.');
    return content;
  }

  _record(level, event, data = {}) {
    try { this._diagnostics?.record(level, event, { ...this._diagnosticContext, ...data }); } catch { /* Logging must not affect Claude. */ }
  }
  _version(session, value) {
    if (session.version || typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+.][A-Za-z0-9.-]{1,32})?$/.test(value)) return;
    session.version = value;
    this._record('info', 'claude.version', { claudeVersion: value });
  }
  _control(session, subtype, fields = {}, timeoutMs = this._timeout) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (session.pending.delete(requestId)) reject(new Error(`Claude CLI не ответил: ${subtype}.`)); }, timeoutMs);
      session.pending.set(requestId, { resolve, reject, timer });
      this._write(session, { type: 'control_request', request_id: requestId, request: { subtype, ...fields } }).catch(error => {
        const pending = session.pending.get(requestId); if (!pending) return;
        session.pending.delete(requestId); clearTimeout(timer); reject(error);
      });
    });
  }

  _write(session, frame) {
    return new Promise((resolve, reject) => {
      if (session.ended || this._session !== session || !session.child?.stdin?.writable) { reject(new Error('Соединение Claude закрыто.')); return; }
      const done = error => { if (!session.writes.delete(done)) return; error ? reject(error) : resolve(); };
      session.writes.add(done);
      try { session.child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8', done); } catch (error) { done(error); }
    });
  }
  _receive(session, chunk) {
    if (session.ended) return;
    session.output += chunk;
    let index;
    while ((index = session.output.indexOf('\n')) >= 0) {
      if (index > MAX_FRAME) { this._end(session, new Error('Слишком большое сообщение протокола Claude.'), 'error'); return; }
      const line = session.output.slice(0, index); session.output = session.output.slice(index + 1);
      if (line.trim()) this._frame(session, line);
      if (session.ended) return;
    }
    if (session.output.length > MAX_FRAME) this._end(session, new Error('Слишком большое сообщение протокола Claude.'), 'error');
  }
  _frame(session, line) {
    if (session.ended || session !== this._session) return;
    let frame;
    try { frame = JSON.parse(line); if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error(); }
    catch { this.emit('diagnostic', 'Некорректное сообщение протокола Claude пропущено.'); return; }
    if (frame.type === 'control_response') {
      const response = frame.response; const pending = session.pending.get(response?.request_id);
      if (!pending) return;
      session.pending.delete(response.request_id); clearTimeout(pending.timer);
      if (response.subtype === 'error') pending.reject(new Error(safeText(response.error || 'Claude отклонил запрос.')));
      else if (response.subtype === 'success') pending.resolve(response.response || {});
      else pending.reject(new Error('Некорректный ответ протокола Claude.'));
      for (const prompt of response.pending_permission_requests || []) this._serverRequest(session, prompt);
      return;
    }
    if (frame.type === 'control_request') { this._serverRequest(session, frame); return; }
    if (frame.type === 'control_cancel_request') {
      session.requests.delete(frame.request_id); this._notify('serverRequest/resolved', { requestId: frame.request_id }); return;
    }
    // Resume replays are already read from native history. Never attach them to a new turn.
    if (!this._active) return;
    if (frame.session_id && frame.session_id !== session.id) return;
    if (frame.type === 'stream_event' && !frame.parent_tool_use_id) this._stream(session, frame.event);
    else if (frame.type === 'assistant' && !frame.parent_tool_use_id) this._assistant(frame);
    else if (frame.type === 'user' && !frame.parent_tool_use_id) {
      const content = frame.message?.content;
      if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_result') this._toolResult(block);
      if (frame.uuid === this._active?.id || this._active?.steers.has(frame.uuid)) this._userEcho(frame);
    } else if (frame.type === 'result') this._result(frame);
    else if (frame.type === 'system') this._system(session, frame);
  }

  _system(session, frame) {
    if (frame.subtype === 'init') { if (frame.model) session.applied.model = frame.model; this._version(session, frame.claude_code_version); return; }
    const a = this._active; if (!a) return;
    if (frame.subtype === 'compact_boundary') {
      const meta = frame.compact_metadata || {};
      this._item({ id: frame.uuid || `${a.id}:compaction`, type: 'contextCompaction', trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens }, true);
    } else if (frame.subtype === 'local_command_output' && typeof frame.content === 'string' && frame.content.trim()) {
      this._item({ id: frame.uuid || `${a.id}:command-output`, type: 'agentMessage', text: safeText(frame.content, 20_000), phase: 'commentary' }, true);
    }
  }

  _userEcho(frame) {
    const a = this._active; if (!a || a.compaction) return;
    const id = frame.uuid || a.id;
    if (a.items.has(id)) return;
    const content = id === a.id ? a.sourceInput : a.steers.get(id);
    if (!content) return;
    this._item({ id, type: 'userMessage', content }, true);
    const preview = content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!this._thread.preview) this._thread.preview = preview.slice(0, 180);
  }
  _item(item, complete = false) {
    if (!this._active) return;
    const previous = this._active.items.get(item.id);
    const merged = { ...previous, ...item, complete };
    this._active.items.set(item.id, merged);
    this._notify(complete ? 'item/completed' : 'item/started', { threadId: this._thread.id, turnId: this._active.id, item: merged });
  }
  _stream(session, event) {
    if (!event || !this._active) return;
    if (event.type === 'message_start') { session.messageId = event.message?.id || randomUUID(); session.blocks.clear(); return; }
    if (event.type === 'content_block_start') {
      const b = event.content_block || {}, index = event.index;
      const id = b.type === 'tool_use' ? b.id : `${session.messageId}:${b.type}:${index}`;
      session.blocks.set(index, { ...b, id, json: '' });
      if (b.type === 'text') this._item({ id, type: 'agentMessage', text: b.text || '', phase: 'commentary' });
      else if (b.type === 'thinking') this._item({ id, type: 'reasoning', summary: [], content: b.thinking ? [b.thinking] : [] });
      return;
    }
    if (event.type === 'content_block_delta') {
      const b = session.blocks.get(event.index); if (!b) return;
      const d = event.delta || {}, a = this._active;
      if (d.type === 'text_delta' && b.type === 'text') {
        const item = a.items.get(b.id); if (item) item.text += d.text || '';
        this._notify('item/agentMessage/delta', { threadId: this._thread.id, turnId: a.id, itemId: b.id, delta: d.text || '' });
      } else if (d.type === 'thinking_delta' && b.type === 'thinking') {
        const item = a.items.get(b.id); if (item) item.content = [(item.content?.[0] || '') + (d.thinking || '')];
        this._notify('item/reasoning/textDelta', { threadId: this._thread.id, turnId: a.id, itemId: b.id, contentIndex: 0, delta: d.thinking || '' });
      } else if (d.type === 'input_json_delta') b.json += d.partial_json || '';
    }
  }
  _assistant(frame) {
    const a = this._active, m = frame.message;
    if (!a || !m) return;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const messageId = m.id || frame.uuid;
    // Stream-json can deliver sibling assistant records with one API message id.
    // Deduplicate the actual record, not the message id shared by later tool calls.
    const recordKey = frame.uuid || `${messageId}:${JSON.stringify(blocks)}`;
    if (a.completedMessages.has(recordKey)) return;
    a.completedMessages.add(recordKey);
    const hasTools = blocks.some(b => b.type === 'tool_use');
    if (hasTools) for (const item of a.items.values()) {
      if (item.type === 'agentMessage' && item.id.startsWith(`${messageId}:text:`) && item.phase !== 'commentary') this._item({ ...item, phase: 'commentary' }, true);
    }
    const blockId = (block, index) => {
      const base = `${messageId}:${block.type}:${index}`;
      const existing = a.items.get(base);
      const content = block.type === 'text' ? block.text || '' : block.thinking || '';
      const existingText = existing?.type === 'agentMessage' ? existing.text : existing?.content?.[0];
      // A full sibling record may contain a single block whose array index is 0,
      // while stream_event used its index in the complete API message (e.g. 1).
      const streamed = [...a.items.values()].find(item => !item.complete && item.id.startsWith(`${messageId}:${block.type}:`)
        && (block.type === 'text' ? item.text : item.content?.[0]) === content);
      if (streamed) return streamed.id;
      if (!existing || !existing.complete || existingText === content || content.startsWith(existingText || '')) return base;
      return `${base}:${frame.uuid || randomUUID()}`;
    };
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        const item = { id: blockId(b, index), type: 'agentMessage', text: b.text || '', phase: hasTools ? 'commentary' : 'final_answer' };
        this._item(item, true); a.latestText = item.id;
      } else if (b.type === 'thinking') this._item({ id: blockId(b, index), type: 'reasoning', summary: [], content: b.thinking ? [b.thinking] : [] }, true);
      else if (b.type === 'tool_use') this._toolStart(b);
    });
  }
  _toolStart(block) {
    if (!this._active || this._active.items.has(block.id)) return;
    const input = block.input || {}, name = block.name || 'Инструмент Claude';
    if (name === 'Bash') this._item({ id: block.id, type: 'commandExecution', command: input.command || '', cwd: this.cwd, status: 'inProgress', aggregatedOutput: '' });
    else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
      let diff = '';
      if (name === 'Edit') diff = `${String(input.old_string || '').split('\n').map(l => `-${l}`).join('\n')}\n${String(input.new_string || '').split('\n').map(l => `+${l}`).join('\n')}`;
      this._item({ id: block.id, type: 'fileChange', status: 'inProgress', changes: [{ path: input.file_path || input.notebook_path || '', kind: { type: 'update' }, diff }] });
    } else this._item({ id: block.id, type: 'mcpToolCall', server: 'Claude', tool: name, arguments: input, status: 'inProgress' });
  }
  _toolResult(block) {
    const item = this._active?.items.get(block.tool_use_id); if (!item) return;
    const output = textContent(block.content);
    this._item({ ...item, status: block.is_error ? 'failed' : 'completed',
      ...(item.type === 'commandExecution' ? { aggregatedOutput: output }
        : item.type === 'mcpToolCall' ? { result: { content: [{ type: 'text', text: output }] }, error: block.is_error ? { message: output } : null } : {}) }, true);
  }
  _result(frame) {
    const a = this._active; if (!a) return;
    const consumed = new Set([frame.user_message_uuid, ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [])].filter(Boolean));
    if (consumed.size && !consumed.has(a.id) && ![...a.steers.keys()].some(id => consumed.has(id))) return;
    // A steer that reached the CLI after the final model round is not folded into
    // this turn; the CLI runs it as the next turn without further input.
    const pending = [...a.steers].filter(([id]) => consumed.size && !consumed.has(id));
    const followUp = pending.length && !a.interrupted && Number.isSafeInteger(frame.queued_turn_count) && frame.queued_turn_count > 0;
    for (const [id] of pending) a.items.delete(id);
    const totals = Object.values(frame.modelUsage || {}).map(u => usageBreakdown(u, true));
    let total;
    if (totals.length) total = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'totalTokens', 'reasoningOutputTokens']
      .map(k => [k, totals.every(t => t[k] !== undefined) ? totals.reduce((sum, t) => sum + t[k], 0) : undefined]));
    this._notify('thread/tokenUsage/updated', { threadId: this._thread.id, turnId: a.id,
      tokenUsage: { last: usageBreakdown(frame.usage), total, modelContextWindow: Object.values(frame.modelUsage || {}).find(u => u.contextWindow > 0)?.contextWindow } });
    if (!a.latestText && !frame.is_error && typeof frame.result === 'string' && frame.result) this._item({ id: `${a.id}:result`, type: 'agentMessage', text: frame.result, phase: 'final_answer' }, true);
    const failed = frame.is_error || frame.subtype !== 'success';
    this._finish(a.interrupted ? 'interrupted' : failed ? 'failed' : 'completed', failed ? safeText(frame.errors?.join('\n') || frame.result || 'Claude завершил запрос с ошибкой.') : undefined);
    if (!pending.length || a.interrupted || !this._thread || this._session?.ended) return;
    if (!followUp) {
      this._notify('error', { threadId: this._thread.id, willRetry: false, error: { message: 'Claude не учёл уточнение: задача уже завершилась. Отправьте его отдельным сообщением.' } });
      return;
    }
    // The queued messages coalesce into one turn whose echo/result reference their uuids.
    const [[firstId, firstInput], ...rest] = pending;
    this._beginTurn({ id: firstId, sourceInput: firstInput, steers: new Map(rest) });
    for (const [id] of pending) this._userEcho({ uuid: id });
  }
  _finish(status, message) {
    const a = this._active; if (!a || !this._thread) return;
    const finished = { id: a.id, status, startedAt: a.startedAt, completedAt: Math.floor(Date.now() / 1000),
      items: [...a.items.values()], ...(message ? { error: { message: safeText(message) } } : {}) };
    this._thread.turns = this._thread.turns.map(t => t.id === a.id ? finished : t);
    this._thread.updatedAt = finished.completedAt; this._thread.status = { type: 'idle' };
    this._active = null;
    if (this._session) for (const id of this._session.requests.keys()) {
      this._session.requests.delete(id); this._notify('serverRequest/resolved', { requestId: id });
    }
    this._notify('turn/completed', { threadId: this._thread.id, turn: finished });
  }

  _serverRequest(session, frame) {
    const id = frame.request_id, request = frame.request;
    if (typeof id !== 'string' || !request || session.requests.has(id)) return;
    if (request.subtype !== 'can_use_tool' || !this._active) {
      this._write(session, { type: 'control_response', response: { subtype: 'error', request_id: id, error: 'This Claude Desk operation is not supported.' } }).catch(() => {}); return;
    }
    const name = request.tool_name, input = request.input || {};
    // Some tool cards require a dedicated interaction, not a yes/no approval.
    if (request.requires_user_interaction && name !== 'AskUserQuestion') {
      this._write(session, { type: 'control_response', response: { subtype: 'success', request_id: id,
        response: { behavior: 'deny', message: 'This tool requires an interaction not supported by this desktop client. Use Claude CLI.', toolUseID: request.tool_use_id } } }).catch(() => {}); return;
    }
    session.requests.set(id, request);
    this._toolStart({ id: request.tool_use_id, name, input });
    const base = { threadId: this._thread.id, turnId: this._active.id, itemId: request.tool_use_id, cwd: this.cwd };
    if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
      this.emit('serverRequest', { id, method: 'item/tool/requestUserInput', params: { ...base, questions: input.questions.map((q, index) => ({
        id: `q${index}`, header: q.header, question: q.question, options: q.options, isOther: true,
      })) } });
    } else {
      const edit = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name);
      this.emit('serverRequest', { id, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        params: { ...base, reason: safeText(request.decision_reason || request.description || `Claude запрашивает разрешение: ${name}`),
          command: name === 'Bash' ? input.command : `${name}\n${JSON.stringify(input, null, 2)}` } });
    }
  }
  async respond(id, result) {
    const s = this._ensureSession(), request = s.requests.get(id);
    if (!request) throw new Error('Запрос Claude уже завершён.');
    let response;
    if (request.tool_name === 'AskUserQuestion') {
      const answers = {};
      for (const [index, question] of (request.input.questions || []).entries()) {
        const values = result?.answers?.[`q${index}`]?.answers;
        if (Array.isArray(values) && values.every(v => typeof v === 'string') && values.length) answers[question.question] = values.join(', ');
      }
      response = Object.keys(answers).length ? { behavior: 'allow', updatedInput: { ...request.input, answers }, toolUseID: request.tool_use_id }
        : { behavior: 'deny', message: 'User skipped this question.', toolUseID: request.tool_use_id };
    } else response = ['accept', 'approved'].includes(result?.decision)
      ? { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
      : { behavior: 'deny', message: 'User declined this action.', toolUseID: request.tool_use_id };
    s.requests.delete(id);
    await this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    this._notify('serverRequest/resolved', { requestId: id });
  }

  _notify(method, params) { this.emit('notification', { method, params }); }
  _status(state, message) { this.state = state; this.emit('status', { state, ...(message ? { message: safeText(message) } : {}) }); }
  _end(session, error, state, silent = false) {
    if (session.ended) return;
    session.ended = true;
    for (const p of session.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    session.pending.clear(); session.requests.clear();
    for (const done of session.writes) done(error);
    session.output = '';
    if (this._session === session && !silent) {
      this._finish('failed', error.message); this._startPromise = null; this._status(state, error.message);
    }
    try { session.child?.kill(); } catch { /* The process may already have exited. */ }
  }
  stop() {
    this._generation++;
    this._startPromise = null;
    if (this._session && !this._session.ended) this._end(this._session, new Error('Claude остановлен.'), 'stopped');
    else if (this.state !== 'stopped') this._status('stopped');
  }
}
