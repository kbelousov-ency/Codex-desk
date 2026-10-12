import { DEFAULT_BASE_URL } from './router-usage.mjs';
import { childSourceKinds } from './thread-children.mjs';
import { readRouterCreditSummary } from './router-credit-summary.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = reason => ({ available: false, reason });
const isRouter = value => { try { return new URL(value).origin === DEFAULT_BASE_URL; } catch { return false; } };
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
const nativeParent = thread => {
  if (UUID.test(thread?.parentThreadId || '')) return thread.parentThreadId;
  const source = thread?.source?.subAgent ?? thread?.source?.subagent;
  const spawn = source?.thread_spawn ?? source?.threadSpawn;
  const parent = spawn?.parent_thread_id ?? spawn?.parentThreadId;
  return UUID.test(parent || '') ? parent : null;
};

/** Discover native descendants, including archived agents. Reading history never changes the active thread. */
export async function collectCreditThreadIds({ provider, threadId, cwd, request, maxPages = 20, maxThreads = 200, timeoutMs = 5000 }) {
  if (threadId == null) return { threadIds: [], partial: false };
  const nativeId = provider === 'claude' ? threadId.replace(/^claude:/, '') : threadId;
  if (!UUID.test(nativeId) || (provider === 'claude') !== threadId.startsWith('claude:')) throw new Error('Некорректный диалог для статистики.');
  if (provider === 'claude') return { threadIds: [nativeId], partial: false };
  const edges = new Map();
  let partial = false;
  const deadline = Date.now() + timeoutMs;
  await Promise.all([false, true].map(async archived => {
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < maxPages; page++) {
      let timer;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { partial = true; break; }
        const result = await Promise.race([
          request('thread/list', { cwd, sourceKinds: childSourceKinds, archived, limit: 100, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('History timeout')), remaining); }),
        ]);
        if (!Array.isArray(result?.data)) { partial = true; break; }
        for (const thread of result.data) {
          const parent = nativeParent(thread);
          if (!UUID.test(thread?.id || '') || !parent) continue;
          const children = edges.get(parent) || new Set();
          children.add(thread.id); edges.set(parent, children);
        }
        if (!result.nextCursor) break;
        if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor) || page === maxPages - 1) { partial = true; break; }
        cursor = result.nextCursor; cursors.add(cursor);
      } catch { partial = true; break; }
      finally { clearTimeout(timer); }
    }
  }));
  const found = new Set([nativeId]);
  for (const parent of found) {
    for (const child of edges.get(parent) || []) {
      if (found.has(child)) continue;
      if (found.size >= maxThreads) { partial = true; continue; }
      found.add(child);
    }
  }
  return { threadIds: [...found], partial };
}

/** One tab's existing credentials, provider and explicitly displayed dialog, never a saved replacement key. */
export async function readSessionRouterUsage({ session, options, routerClient, portalClient, routerOnly = false, summary = readRouterCreditSummary, collectThreads = collectCreditThreadIds }) {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) throw new Error('Некорректный запрос статистики.');
  const provider = session.settings.provider === 'claude' ? 'claude' : 'codex';
  const source = session.settings.connectionSource || 'inherited';
  const profile = session.connectionProfile;
  const generation = session.generation;
  const current = () => !session.disposed && !session.switchingSource && session.generation === generation && session.connectionProfile === profile;
  if (!current()) return unavailable('Подключение изменилось. Обновите статистику.');
  if (source === 'account' && !routerOnly) return unavailable('В этой вкладке выбран личный источник.');
  const threadId = options && Object.hasOwn(options, 'threadId') ? options.threadId : session.currentThreadId;
  if (threadId != null && (typeof threadId !== 'string' || threadId.length > 100)) throw new Error('Некорректный диалог для статистики.');
  let apiKey;
  if (provider === 'claude') {
    const inherited = source === 'inherited' && !routerOnly ? profile?.inheritedRouter : null;
    const baseUrl = inherited?.baseUrl || profile?.env?.ANTHROPIC_BASE_URL;
    if (!isRouter(baseUrl)) return unavailable('Статистика этого подключения недоступна. Переподключите вкладку.');
    apiKey = inherited?.apiKey || profile?.env?.ANTHROPIC_AUTH_TOKEN || profile?.env?.ANTHROPIC_API_KEY;
  } else if (source === 'router' || routerOnly) {
    if (!isRouter(profile?.expectedConnection?.baseUrl)) return unavailable('Статистика этого подключения недоступна. Переподключите вкладку.');
    apiKey = profile?.expectedConnection?.apiKey;
  } else {
    // Preserve the existing inherited Codex lookup. It verifies the provider's origin before returning a token.
    apiKey = await routerClient.token();
  }
  if (!current()) return unavailable('Подключение изменилось. Обновите статистику.');
  if (!validKey(apiKey)) return unavailable('Ключ статистики роутера недоступен.');
  const threads = await collectThreads({ provider, threadId, cwd: session.currentCwd, request: (method, params) => session.request(method, params) });
  if (!current()) return unavailable('Подключение изменилось. Обновите статистику.');
  const snapshot = await summary({ routerClient, portalClient, apiKey, provider, threadIds: threads.threadIds });
  if (!current()) return unavailable('Подключение изменилось. Обновите статистику.');
  if (threads.partial && snapshot.spend?.session) {
    snapshot.spend.session.partial = true;
    snapshot.spend.session.reason = 'Не удалось учесть всех подагентов диалога.';
    if (snapshot.spend.session.credits === 0) snapshot.spend.session.credits = null;
  }
  return snapshot;
}
