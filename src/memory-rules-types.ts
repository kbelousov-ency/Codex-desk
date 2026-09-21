import type { AgentProvider } from './types';

export type MemoryRulesPreview = {
  provider: AgentProvider;
  enabled: boolean;
  conflict: string | null;
  instructionPath: string;
  procedurePath: string;
  rulesText: string;
  procedureText: string;
  revision: string;
};

export type MemoryRulesResult = MemoryRulesPreview & { changed: boolean; backupPaths: string[] };

export interface MemoryRulesBridge {
  preview(provider: AgentProvider): Promise<MemoryRulesPreview>;
  apply(options: { provider: AgentProvider; enabled: boolean; revision: string }): Promise<MemoryRulesResult>;
}
