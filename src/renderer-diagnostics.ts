import type { RendererErrorReport } from './types';

let installed = false;
let periodStarted = 0;
let sent = 0;

// Transport only bounded error metadata. The host classifies errors and removes
// free-form messages and paths before anything is written to the diagnostic log.
export function reportRendererError(kind: RendererErrorReport['kind'], error: unknown, componentStack?: string) {
  try {
    if (!window.codex?.reportRendererError) return;
    const now = Date.now();
    if (now - periodStarted > 60_000) { periodStarted = now; sent = 0; }
    if (sent >= 20) return;
    const report: RendererErrorReport = { kind };
    if (error instanceof Error) {
      if (typeof error.name === 'string') report.name = error.name.slice(0, 100);
      if (typeof error.message === 'string') report.message = error.message.slice(0, 1000);
      if (typeof error.stack === 'string') report.stack = error.stack.slice(0, 3000);
    } else if (typeof error === 'string') report.message = error.slice(0, 1000);
    if (componentStack) report.componentStack = componentStack.slice(0, 2000);
    const encoder = new TextEncoder();
    while (encoder.encode(JSON.stringify(report)).byteLength > 8000) {
      for (const key of ['message', 'stack', 'componentStack'] as const) if (report[key]) report[key] = report[key]!.slice(0, Math.floor(report[key]!.length / 2));
    }
    sent++;
    window.codex.reportRendererError(report);
  } catch { /* Reporting must never cause a second application failure. */ }
}

export function installRendererDiagnostics() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', event => reportRendererError('error', event.error || event.message));
  window.addEventListener('unhandledrejection', event => reportRendererError('unhandledrejection', event.reason));
}
