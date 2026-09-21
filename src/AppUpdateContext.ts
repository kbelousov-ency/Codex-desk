import { createContext } from 'react';

export const OpenAppUpdatesContext = createContext<(() => void) | null>(null);