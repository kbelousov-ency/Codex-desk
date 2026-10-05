import type { SessionSummary } from './App';

/**
 * A tab reports its state on every change of the conversation, so the comparison
 * decides how often the whole workspace re-renders. Equal reports must keep the
 * previous objects: a fresh identity on each streamed delta makes React commit
 * the workspace again and again and eventually throws «Maximum update depth».
 */
export function sameSessionSummary(previous: SessionSummary | undefined, next: SessionSummary): boolean {
  if (!previous) return false;
  if (previous === next) return true;
  if (previous.cwd !== next.cwd || previous.title !== next.title || previous.threadId !== next.threadId) return false;
  if (previous.initialized !== next.initialized || previous.terminalOpen !== next.terminalOpen) return false;
  if (previous.busy !== next.busy || previous.loading !== next.loading || previous.connection !== next.connection) return false;
  if (previous.pending !== next.pending || Boolean(previous.pendingDelivery) !== Boolean(next.pendingDelivery)) return false;
  const before = previous.changedFiles || [], after = next.changedFiles || [];
  if (before.length !== after.length || before.some((path, index) => path !== after[index])) return false;
  return previous.settings.provider === next.settings.provider && previous.settings.model === next.settings.model
    && previous.settings.effort === next.settings.effort && previous.settings.access === next.settings.access
    && previous.settings.cwd === next.settings.cwd && previous.settings.executable === next.settings.executable;
}
