import { LIMITS, events, sameTab, tabIdFor, tabSummary } from './protocol.mjs';

/**
 * Turns the core's view of allowed conversations into the eight fields the server is allowed to
 * see, and resolves an incoming address back to a conversation.
 *
 * Only `listThreads()` is used as the source of truth about *which* tabs exist: the core already
 * returns enabled grants only, so a conversation the owner never allowed has no address at all.
 */
export async function collectTabs({ remote, tabSalt, now }) {
  const listed = await remote.listThreads();
  if (!listed?.ok || !Array.isArray(listed.value)) return { ok: false, tabs: [], truncated: false, signals: new Map() };

  const at = new Date(now()).toISOString();
  const visible = listed.value.slice(0, LIMITS.tabs);
  const tabs = [];
  const signals = new Map();
  for (const thread of visible) {
    if (!thread?.grantId) continue;
    let state = null;
    if (thread.target) {
      // A grant revoked between the two calls simply reads as unavailable and disappears from
      // the next collection; it is never reported with stale content.
      const read = await remote.getThreadState(thread.target).catch(() => null);
      state = read?.ok ? read.value : null;
    }
    const tabId = tabIdFor(tabSalt, thread.grantId);
    tabs.push(tabSummary({ thread, state, tabId, at }));
    const signal = turnSignal(state);
    if (signal) signals.set(tabId, signal);
  }
  tabs.sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
  return { ok: true, tabs, truncated: listed.value.length > visible.length, signals };
}

/**
 * What a notice is derived from, kept **beside** the published summary and never sent as such.
 *
 * `requiresComputer` is the core's own verdict on whether a block needs a person at this machine;
 * it is used here to tell "waiting for an approval" from "simply busy", and the `blockers` that
 * explain which of the two it is stay on this computer, as they always have.
 */
export function turnSignal(state) {
  if (!state || !['idle', 'running', 'blocked'].includes(state.phase)) return null;
  return {
    turnId: typeof state.activeTurnId === 'string' && state.activeTurnId ? state.activeTurnId : null,
    running: state.phase === 'running',
    actionRequired: state.phase === 'blocked' && state.requiresComputer === true,
  };
}

/**
 * Resolves an incoming address by re-deriving it over the conversations the core allows **right
 * now**. No reverse table is kept and the last snapshot is not trusted: a permission revoked a
 * moment ago simply has no match here, so the permission check is fresh on every single command
 * rather than as fresh as the last publication.
 */
export async function resolveTab({ remote, tabSalt, tabId }) {
  if (!tabSalt || !tabId) return null;
  const listed = await remote.listThreads();
  if (!listed?.ok || !Array.isArray(listed.value)) return null;
  for (const thread of listed.value.slice(0, LIMITS.tabs)) {
    if (thread?.grantId && tabIdFor(tabSalt, thread.grantId) === tabId) return thread;
  }
  return null;
}

/**
 * Incremental events. `updatedAt` alone is not a change: publishing on it would turn every
 * harmless state refresh into traffic without telling the phone anything new.
 */
export function diffTabs(previous, next) {
  const before = new Map((previous ?? []).map(tab => [tab.tabId, tab]));
  const changes = [];
  for (const tab of next) {
    const old = before.get(tab.tabId);
    if (!old || !sameTab(old, tab)) changes.push(events.tab_updated(tab));
    before.delete(tab.tabId);
  }
  for (const tabId of before.keys()) changes.push(events.tab_removed(tabId));
  return changes;
}

/**
 * Notices (2.3): one per event, derived from the same collection that moves the tabs.
 *
 * Both rules are deliberately conservative, because a false notice is worse than a missing one —
 * a phone buzzing about a turn that is still running teaches its owner to ignore it.
 *
 * - `turn_completed` needs a turn that **was** running and a readable state that no longer names
 *   it. Whether it succeeded, failed or was stopped is not said: the outcome lives on the computer.
 *   A conversation that is still `running` but has no turn id yet does **not** count as an ending:
 *   the v1 contract says `activeTurnId` is also null while a start is not yet acknowledged, and
 *   announcing a completed turn there would be a push about something that did not happen.
 * - `action_required` fires on the edge into "blocked and a person is needed here", never on every
 *   collection while it stays that way.
 *
 * A tab that is unreadable or unavailable produces no signal at all, so it can neither raise nor
 * silence a notice — and a tab seen for the first time (including right after a reconnect) only
 * seeds the baseline. That is what keeps a reconnect from replaying yesterday's news.
 */
export function diffNotices(previous, next, at) {
  const before = previous ?? new Map();
  const notices = [];
  for (const [tabId, signal] of next) {
    const old = before.get(tabId);
    if (!old) continue;
    const stillStarting = signal.turnId === null && signal.running;
    if (old.turnId && signal.turnId !== old.turnId && !stillStarting) {
      notices.push(events.notice({ tabId, noticeKind: 'turn_completed', turnId: old.turnId, occurredAt: at }));
    }
    if (signal.actionRequired && !old.actionRequired) {
      notices.push(events.notice({ tabId, noticeKind: 'action_required', turnId: signal.turnId, occurredAt: at }));
    }
  }
  return notices;
}
