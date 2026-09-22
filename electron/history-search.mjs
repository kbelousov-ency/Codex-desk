import { randomUUID } from 'node:crypto';
import path from 'node:path';

const providers = new Set(['all', 'codex', 'claude']);
const directoryKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const cursorError = () => new Error('Поиск изменился или устарел. Начните его заново.');
const safeText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const boundedCursor = value => value == null ? null : typeof value === 'string' && value.length > 0 && value.length <= 16384 ? value : (() => { throw new Error('Некорректная страница истории.'); })();

/** Search only message bodies already exposed by the providers' public history APIs. */
export function historyMessageText(item) {
  if (item?.type === 'agentMessage') return typeof item.text === 'string' ? item.text : '';
  if (item?.type === 'userMessage' && Array.isArray(item.content)) {
    return item.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  }
  return '';
}

function snippet(text, index, length) {
  const start = Math.max(0, index - 90), end = Math.min(text.length, Math.max(index + length + 150, start + 280));
  return `${start ? '…' : ''}${text.slice(start, Math.min(end, start + 900)).replace(/\s+/gu, ' ')}${end < text.length ? '…' : ''}`;
}

function pageItems(page) {
  if (Array.isArray(page?.items)) return page.items;
  const turns = page?.thread?.turns ?? page?.turns;
  if (Array.isArray(turns)) return turns.flatMap(turn => (turn.items ?? []).map(item => ({ ...item, turnId: item.turnId ?? turn.id })));
  throw new Error('Источник не вернул сообщения диалога.');
}

/**
 * Progressive, read-only search. Each call bounds both native reads and results.
 * Continuations keep metadata/offsets, never copies of complete transcripts.
 * If a native page has more matches than fit, it is read again at its saved offset.
 */
export class HistorySearch {
  constructor({ listThreads, readThread, maxThreadsPerPage = 10, maxMatches = 40, maxReadPages = 12,
    cursorTtlMs = 15 * 60_000, maxCursors = 8, now = Date.now } = {}) {
    if (typeof listThreads !== 'function' || typeof readThread !== 'function') throw new Error('Нужны источники истории.');
    for (const limit of [maxThreadsPerPage, maxMatches, maxReadPages, maxCursors, cursorTtlMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Некорректное ограничение поиска.');
    }
    Object.assign(this, { listThreads, readThread, maxThreadsPerPage, maxMatches, maxReadPages, cursorTtlMs, maxCursors, now });
    this.states = new Map();
    this.disposed = false;
  }

  check() { if (this.disposed) throw new Error('Окно поиска уже закрыто.'); }
  dispose() { this.disposed = true; this.states.clear(); }
  clear() { this.states.clear(); }

  async search(options) {
    this.check();
    if (typeof options?.query !== 'string' || !options.query.trim() || options.query.length > 500 || /[\0\r\n]/u.test(options.query)) {
      throw new Error('Введите текст для поиска (до 500 символов в одной строке).');
    }
    if (typeof options.cwd !== 'string' || !options.cwd || options.cwd.length > 4096 || !path.isAbsolute(options.cwd) || options.cwd.includes('\0')) {
      throw new Error('Укажите папку проекта для поиска.');
    }
    const provider = options.provider ?? 'all';
    if (!providers.has(provider)) throw new Error('Неизвестный агент поиска.');
    const query = options.query.trim(), cwd = path.resolve(options.cwd);
    const scope = JSON.stringify([query.toLocaleLowerCase('ru'), directoryKey(cwd), provider]);
    for (const [token, record] of this.states) if (this.now() - record.usedAt > this.cursorTtlMs) this.states.delete(token);
    let state;
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || options.cursor.length > 100) throw cursorError();
      const record = this.states.get(options.cursor);
      if (!record || record.scope !== scope) throw cursorError();
      state = record.state;
      // A continuation is consumed once, including concurrent requests.
      this.states.delete(options.cursor);
    } else {
      state = { index: 0, scannedThreads: 0, scannedPages: 0, sources: (provider === 'all' ? ['codex', 'claude'] : [provider]).map(name => ({
        provider: name, cursor: null, ended: false, pending: [], current: null, cursors: new Set(), seenThreads: new Set(),
      })) };
    }
    const matches = [], warnings = [];
    let completed = 0, reads = 0, operations = 0;
    const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
    const available = source => source.current || source.pending.length || !source.ended;
    while (matches.length < this.maxMatches && completed < this.maxThreadsPerPage && reads < this.maxReadPages
      && operations < this.maxReadPages * 2 + 2 && state.sources.some(available)) {
      this.check();
      const source = state.sources[state.index++ % state.sources.length];
      if (!available(source)) continue;
      const name = source.provider === 'claude' ? 'Claude' : 'Codex';
      if (!source.current && !source.pending.length) {
        operations += 1;
        try {
          const page = await this.listThreads({ cwd, provider: source.provider, ...(source.cursor ? { cursor: source.cursor } : {}), limit: 10 });
          this.check();
          if (!Array.isArray(page?.data)) throw new Error('Invalid history page');
          for (const thread of page.data) {
            if (typeof thread?.id !== 'string' || !thread.id || thread.id.length > 512 || source.seenThreads.has(thread.id)) continue;
            if (thread.cwd && (typeof thread.cwd !== 'string' || directoryKey(thread.cwd) !== directoryKey(cwd))) continue;
            if (thread.provider && thread.provider !== source.provider) continue;
            source.seenThreads.add(thread.id);
            source.pending.push({ id: thread.id, name: safeText(thread.name, 500), preview: safeText(thread.preview, 1000),
              cwd, provider: source.provider, ...(thread.archived === true ? { archived: true } : {}),
              ...(thread.historyMode ? { historyMode: thread.historyMode } : {}) });
          }
          const next = boundedCursor(page.nextCursor);
          if (next && source.cursors.has(next)) { warn(`${name} повторил страницу списка. Поиск в этом источнике может быть неполным.`); source.ended = true; }
          else { source.ended = !next; source.cursor = next; if (next) source.cursors.add(next); }
        } catch (error) {
          this.check();
          source.ended = true;
          warn(`Не удалось прочитать список диалогов ${name}. Повторите поиск после восстановления подключения.`);
        }
        continue;
      }
      if (!source.current) source.current = { thread: source.pending.shift(), cursor: null, offset: 0, cursors: new Set(), seenItems: new Set() };
      const current = source.current;
      operations += 1; reads += 1;
      try {
        const page = await this.readThread({ cwd, provider: source.provider, thread: current.thread, ...(current.cursor ? { cursor: current.cursor } : {}) });
        this.check();
        if (page?.thread?.id && page.thread.id !== current.thread.id) throw new Error('Different thread');
        if (page?.thread?.cwd && directoryKey(page.thread.cwd) !== directoryKey(cwd)) throw new Error('Different project');
        const items = pageItems(page), next = boundedCursor(page.nextCursor);
        state.scannedPages += 1;
        for (; current.offset < items.length; current.offset += 1) {
          const item = items[current.offset];
          if (typeof item?.id !== 'string' || !item.id || current.seenItems.has(item.id)) continue;
          const text = historyMessageText(item);
          const at = text.toLocaleLowerCase('ru').indexOf(query.toLocaleLowerCase('ru'));
          if (at < 0) continue;
          current.seenItems.add(item.id);
          matches.push({ provider: source.provider, cwd, thread: { ...current.thread }, itemId: item.id,
            ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
            role: item.type === 'userMessage' ? 'user' : 'assistant', snippet: snippet(text, at, query.length) });
          if (matches.length === this.maxMatches) { current.offset += 1; break; }
        }
        if (current.offset >= items.length) {
          if (next && !current.cursors.has(next)) { current.cursors.add(next); current.cursor = next; current.offset = 0; }
          else {
            if (next) warn(`В одном диалоге ${name} повторилась страница сообщений. Его история может быть неполной.`);
            source.current = null; state.scannedThreads += 1; completed += 1;
          }
        }
      } catch (error) {
        this.check();
        source.current = null; completed += 1;
        warn(`Не удалось прочитать один из диалогов ${name}. Он мог быть удалён или стать недоступным.`);
      }
    }
    this.check();
    let nextCursor = null;
    if (state.sources.some(available)) {
      nextCursor = randomUUID();
      this.states.set(nextCursor, { state, scope, usedAt: this.now() });
      while (this.states.size > this.maxCursors) this.states.delete(this.states.keys().next().value);
    }
    return { matches, nextCursor, scannedThreads: state.scannedThreads, scannedPages: state.scannedPages, warnings };
  }
}
