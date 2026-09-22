import type { AgentProvider } from './types';

/** CLI versions the protocol adapters were last verified against on this machine (see docs/AI_CONTEXT.md and docs/CLAUDE.md). */
export const VERIFIED_CLI_VERSIONS: Record<AgentProvider, string> = { codex: '0.154.0', claude: '2.1.278' };

/** A short hint when the installed CLI differs from the verified version. Empty when unknown or equal. */
export function cliVersionNote(provider: AgentProvider, version: string | undefined): string {
  const verified = VERIFIED_CLI_VERSIONS[provider];
  if (!version || !verified || version === verified) return '';
  return `Интеграция проверялась с версией ${verified}. При отличиях в протоколе сравнивайте поведение с установленной версией.`;
}
