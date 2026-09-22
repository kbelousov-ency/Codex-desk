import { createContext, useContext } from 'react';
import type { AgentProvider } from './types';

export const AgentContext = createContext<AgentProvider>('codex');
export const agentName = (provider: AgentProvider) => provider === 'claude' ? 'Claude Code' : 'Codex';
export const useAgentName = () => agentName(useContext(AgentContext));
