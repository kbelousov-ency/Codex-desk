import { createHash } from 'node:crypto';
import path from 'node:path';
import { directoryPath } from './host-utils.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_MESSAGES = 100_000;
const MAX_IMAGE_CHARS = 28 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const directoryKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value / 1000) : undefined;

/** The namespace never reaches the CLI; only a validated native UUID does. */
export function claudeSessionId(value) {
  const id = typeof value === 'string' ? value.replace(/^claude:/, '') : '';
  if (!UUID.test(id)) throw new Error('Некорректный идентификатор диалога Claude.');
  return id.toLowerCase();
}

export const claudeThreadId = value => `claude:${claudeSessionId(value)}`;

function scopeKey(cwd) { return createHash('sha256').update(directoryKey(cwd)).digest('hex').slice(0, 24); }
function cursorOffset(cursor, cwd) {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== 'string' || cursor.length > 200) throw new Error('Некорректная страница истории Claude.');
  const match = /^claude-history:([a-f0-9]{24}):([0-9]+)$/.exec(cursor);
  const offset = match ? Number(match[2]) : NaN;
  if (!match || match[1] !== scopeKey(cwd) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new Error('Эта страница истории Claude относится к другой папке или устарела.');
  }
  return offset;
}

function threadMetadata(info, cwd) {
  return {
    id: claudeThreadId(info.sessionId), provider: 'claude', historyMode: 'legacy', cwd,
    name: text(info.customTitle || info.summary).slice(0, 500),
    preview: text(info.firstPrompt || info.summary).slice(0, 1000),
    ...(seconds(info.lastModified) !== undefined ? { updatedAt: seconds(info.lastModified) } : {}),
    ...(seconds(info.createdAt) !== undefined ? { createdAt: seconds(info.createdAt) } : {}),
  };
}

function imageContent(block) {
  const source = block?.source;
  if (!object(source)) return undefined;
  if (source.type === 'base64' && IMAGE_TYPES.has(source.media_type) && typeof source.data === 'string'
    && source.data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
    return { type: 'image', url: `data:${source.media_type};base64,${source.data}` };
  }
  // Remote image references are retained as text, never fetched by the renderer.
  if (source.type === 'url' && typeof source.url === 'string' && /^https?:\/\//i.test(source.url)) {
    return { type: 'text', text: source.url, text_elements: [] };
  }
  return undefined;
}

function userContent(blocks) {
  return blocks.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text, text_elements: [] }];
    if (block?.type === 'image') return [imageContent(block)].filter(Boolean);
    if (block?.type === 'document') {
      const label = text(block.title) || 'Документ';
      const content = block.source?.type === 'text' ? text(block.source.data) : '';
      return [{ type: 'text', text: content ? `${label}\n${content}` : label, text_elements: [] }];
    }
    return [];
  });
}

function outputText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.type === 'text' ? text(block.text) : '').filter(Boolean).join('\n');
}

function publicValue(value, depth = 0) {
  if (depth > 30) return '[Слишком глубокая структура]';
  if (Array.isArray(value)) return value.map(part => publicValue(part, depth + 1));
  if (!object(value)) return value;
  if (['redacted_thinking', 'encrypted_content'].includes(value.type)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['signature', 'encrypted_content', 'redacted_thinking'].includes(key))
    .map(([key, part]) => [key, publicValue(part, depth + 1)]));
}

function toolItem(block, cwd) {
  const input = object(block.input) ? publicValue(block.input) : {};
  const base = { id: block.id, type: 'dynamicToolCall', tool: text(block.name), arguments: input, status: 'completed', complete: true };
  if (block.name === 'Bash') return { ...base, type: 'commandExecution', command: text(input.command), cwd };
  // Only an explicit edit can supply a patch. Read-only history does not infer
  // a file's old contents from its current state or claim a successful write.
  if (block.name === 'Edit' && typeof input.file_path === 'string' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const before = input.old_string.split('\n').map(line => `-${line}`).join('\n');
    const after = input.new_string.split('\n').map(line => `+${line}`).join('\n');
    return { ...base, type: 'fileChange', changes: [{ path: input.file_path, kind: { type: 'update' }, diff: `${before}\n${after}` }] };
  }
  if (['Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
    return { ...base, type: 'fileChange', changes: [{ path: text(input.file_path || input.notebook_path), kind: { type: 'update' }, diff: '' }] };
  }
  if (typeof input.file_path === 'string') base.path = input.file_path;
  return base;
}

/** Adapt only the public user/assistant messages returned by the official SDK. */
export function claudeHistoryTurns(messages, { cwd, sessionId } = {}) {
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw new Error('История Claude слишком велика для просмотра. Откройте её в терминале.');
  const turns = [];
  const tools = new Map();
  const ids = new Set();
  const messageTools = new Set(messages.filter(frame => frame?.type === 'assistant'
    && Array.isArray(frame.message?.content) && frame.message.content.some(block => block?.type === 'tool_use'))
    .map(frame => text(frame.message?.id) || text(frame.uuid)));
  let current;
  const ensureTurn = id => {
    if (!current) { current = { id, status: 'completed', items: [] }; turns.push(current); }
    return current;
  };
  const addItem = item => {
    const turn = ensureTurn(`claude-history-${item.id}`);
    if (ids.has(item.id)) return;
    ids.add(item.id);
    turn.items.push({ ...item, turnId: turn.id, complete: true });
    return turn.items.at(-1);
  };
  for (const [messageIndex, frame] of messages.entries()) {
    if (!object(frame) || !['user', 'assistant'].includes(frame.type) || frame.is_meta || frame.isMeta || frame.isSidechain || frame.parent_tool_use_id) continue;
    if (sessionId && frame.session_id && frame.session_id !== sessionId) continue;
    const message = frame.message;
    if (!object(message)) continue;
    const frameId = text(frame.uuid) || `claude-history-message-${messageIndex}`;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    if (frame.type === 'user') {
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        let tool = tools.get(block.tool_use_id);
        if (!tool) {
          tool = addItem({ id: block.tool_use_id, type: 'dynamicToolCall', tool: 'Результат инструмента' });
          if (tool) tools.set(block.tool_use_id, tool);
        }
        if (tool) {
          tool.status = block.is_error ? 'failed' : 'completed';
          tool.success = !block.is_error;
          tool.aggregatedOutput = outputText(block.content);
          if (Array.isArray(block.content)) tool.result = block.content.flatMap(part => {
            if (part?.type === 'text') return [{ type: 'text', text: text(part.text) }];
            if (part?.type === 'image') return [imageContent(part)].filter(Boolean);
            return [];
          });
        }
      }
      const content = userContent(blocks);
      if (content.length && !ids.has(frameId)) {
        current = { id: frameId, status: 'completed', items: [] };
        turns.push(current);
        addItem({ id: frameId, type: 'userMessage', content });
      }
      continue;
    }
    const messageId = text(message.id) || frameId;
    const hasTools = messageTools.has(messageId);
    for (const [index, block] of blocks.entries()) {
      if (!object(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const id = `${messageId}:text:${index}`;
        addItem({ id: ids.has(id) ? `${id}:${frameId}` : id, type: 'agentMessage', text: block.text, phase: hasTools ? 'commentary' : 'final_answer' });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const id = `${messageId}:thinking:${index}`;
        addItem({ id: ids.has(id) ? `${id}:${frameId}` : id, type: 'reasoning', summary: [block.thinking] });
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const item = addItem(toolItem(block, cwd));
        if (item) tools.set(block.id, item);
      }
    }
  }
  return turns;
}

/** Read-only native Claude history. Never starts the CLI or writes its store. */
export class ClaudeHistory {
  constructor({ sdk = () => import('@anthropic-ai/claude-agent-sdk'), resolveDirectory = directoryPath } = {}) {
    this.sdkFactory = sdk;
    this.resolveDirectory = resolveDirectory;
    this.sdkPromise = undefined;
  }

  async sdk() {
    this.sdkPromise ??= Promise.resolve().then(() => typeof this.sdkFactory === 'function' ? this.sdkFactory() : this.sdkFactory).catch(error => {
      this.sdkPromise = undefined;
      throw error;
    });
    return this.sdkPromise;
  }

  async cwd(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Укажите папку истории Claude.');
    return this.resolveDirectory(value);
  }

  async belongsTo(info, cwd) {
    if (!info || !UUID.test(text(info.sessionId))) return false;
    if (!info.cwd) return true; // SDK was explicitly scoped to this project.
    try { return directoryKey(await this.resolveDirectory(info.cwd)) === directoryKey(cwd); }
    catch { return false; }
  }

  async list({ cwd: requested, cursor, limit = 40 } = {}) {
    const cwd = await this.cwd(requested);
    const offset = cursorOffset(cursor, cwd);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Некорректный размер страницы истории Claude.');
    const sdk = await this.sdk();
    const sessions = await sdk.listSessions({ dir: cwd, limit: limit + 1, offset, includeWorktrees: false, includeProgrammatic: true });
    const page = sessions.slice(0, limit);
    const data = [];
    for (const info of page) if (await this.belongsTo(info, cwd)) data.push(threadMetadata(info, cwd));
    return { data, nextCursor: sessions.length > limit ? `claude-history:${scopeKey(cwd)}:${offset + limit}` : null };
  }

  async read({ cwd: requested, threadId, includeTurns = true } = {}) {
    const id = claudeSessionId(threadId);
    const cwd = await this.cwd(requested);
    const sdk = await this.sdk();
    const info = await sdk.getSessionInfo(id, { dir: cwd });
    if (!await this.belongsTo(info, cwd)) throw new Error('Диалог Claude не найден в выбранной папке.');
    const thread = threadMetadata(info, cwd);
    if (includeTurns) {
      if (typeof info.fileSize === 'number' && info.fileSize > MAX_TRANSCRIPT_BYTES) throw new Error('История Claude превышает 128 МиБ. Откройте этот диалог в терминале.');
      const messages = await sdk.getSessionMessages(id, { dir: cwd, includeSystemMessages: false, limit: MAX_MESSAGES + 1 });
      thread.turns = claudeHistoryTurns(messages, { cwd, sessionId: id });
    }
    return { thread };
  }
}
