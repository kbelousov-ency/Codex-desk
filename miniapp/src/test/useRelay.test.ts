import { describe, expect, it } from 'vitest';
import { acceptSnapshot } from '../useRelay';
import type { RelaySnapshot } from '../types';

const snap = (revision: number, status: 'online' | 'offline'): RelaySnapshot => ({ revision, kuzmich: { status }, installations: [] });

describe('snapshot resync ordering', () => {
  it('drops an older response while accepting a newer full resync', () => {
    const current = snap(8, 'online');
    expect(acceptSnapshot(current, snap(7, 'offline'))).toBe(current);
    expect(acceptSnapshot(current, snap(9, 'offline')).kuzmich.status).toBe('offline');
  });
});

