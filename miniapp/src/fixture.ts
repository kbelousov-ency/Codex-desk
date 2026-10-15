import type { InstallationSummary, RelaySnapshot } from './types';

const tabs = [
  {
    tab_id: 'fixture-tab-1',
    name: 'Демо-проект',
    agent: 'Codex',
    project: 'CodexDesk',
    status: 'running' as const,
    queueLength: 2,
    queuePaused: false,
    updatedAt: '2026-10-14T10:00:00.000Z'
  },
  {
    tab_id: 'fixture-tab-2',
    name: 'Документация',
    agent: 'Claude Code',
    project: 'CodexDesk',
    status: 'idle' as const,
    queueLength: 3,
    queuePaused: true,
    updatedAt: '2026-10-14T09:58:00.000Z'
  }
];

export const FIXTURE_INSTALLATION: InstallationSummary = {
  installation_id: 'fixture-installation',
  label: 'Локальный Кузьмич',
  status: 'online',
  last_seen_at: '2026-10-14T10:02:00.000Z',
  tabs
};

export const FIXTURE_SNAPSHOT: RelaySnapshot = {
  kuzmich: { status: 'online', updated_at: '2026-10-14T10:02:00.000Z' },
  installations: [FIXTURE_INSTALLATION]
};
