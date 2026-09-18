import { createContext, useContext } from 'react';
import type { CodexBridge } from './types';

export const BridgeContext = createContext<CodexBridge | null>(null);
export const useBridge = () => useContext(BridgeContext) || window.codex;
