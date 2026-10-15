import { describe, expect, it, vi } from 'vitest';
import { RelayApi, normalizeCommand, normalizeSnapshot } from '../api';

describe('relay API adapter', () => {
  it('preserves a recovery diagnostic without copying pending request or read payload', () => {
    const raw = { commandId: 'c-legacy', tabId: 't-1', action: 'send' as const, status: 'queued' as const,
      outcome: null, detail: null, createdAt: '', updatedAt: '', replayUnavailable: 'legacy_payload_missing',
      text: 'PRIVATE_REQUEST', payload: { answer: 'PRIVATE_RESPONSE' }, pending_ciphertext: 'PRIVATE_CIPHERTEXT' };
    const command = normalizeCommand(raw);
    expect(command.status).toBe('queued');
    expect(command.replayUnavailable).toBe('legacy_payload_missing');
    expect(JSON.stringify(command)).not.toContain('PRIVATE_');
  });

  it('maps server DTO to the allow-listed read-only fields', () => {
    const payload = { revision: 4, installations: [{
      installation_id: 'i-1', label: 'ПК', online: true, last_seen: '2026-10-14T10:00:00.000Z',
      tabs: [{ tab_id: 't-1', title: 'Вкладка', agent: 'codex', project: 'CodexDesk', status: 'blocked',
        queueLength: 3, queuePaused: true, updatedAt: '2026-10-14T09:58:00.000Z', transcript: 'private transcript', cwd: 'private path' }]
    }] };
    const snapshot = normalizeSnapshot(payload);
    expect(snapshot.installations[0].tabs[0]).toEqual({ tab_id: 't-1', name: 'Вкладка', agent: 'codex', project: 'CodexDesk', status: 'blocked',
      queueLength: 3, queuePaused: true, updatedAt: '2026-10-14T09:58:00.000Z' });
    expect(JSON.stringify(snapshot)).not.toContain('private transcript');
    expect(JSON.stringify(snapshot)).not.toContain('private path');
  });

  it('keeps PC-selected installation labels without a primary installation', () => {
    const snapshot = normalizeSnapshot({ revision: 2, installations: [
      { installation_id: 'i-1', label: 'Мастерская', online: true, tabs: [] },
      { installation_id: 'i-2', label: 'Домашний ПК', online: false, tabs: [] }
    ] });
    expect(snapshot.installations.map(item => item.label)).toEqual(['Мастерская', 'Домашний ПК']);
    expect(snapshot.installations.every(item => !('primary' in item) && !('isPrimary' in item))).toBe(true);
  });

  it('authenticates with initData and keeps session token out of URL', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init ?? {}]);
      if (String(input).endsWith('/auth')) return new Response(JSON.stringify({ session_token: 'session-secret', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
      return new Response(JSON.stringify({ revision: 1, installations: [] }), { status: 200 });
    });
    const api = new RelayApi({ baseUrl: 'https://relay.test/api', initData: 'signed-init-data', fetchImpl });
    await api.getSnapshot();
    expect(calls[0][0]).toBe('https://relay.test/api/auth');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ initData: 'signed-init-data' });
    expect(calls[1][0]).toBe('https://relay.test/api/installations');
    expect(calls[1][1].headers).toBeDefined();
    expect(String(new Headers(calls[1][1].headers).get('Authorization'))).toBe('Bearer session-secret');
    expect(calls.every(([url]) => !url.includes('session-secret'))).toBe(true);
  });

  it('keeps a fixture unbind after a refresh', async () => {
    const api = new RelayApi({ initData: 'fixture', fixture: true });
    expect((await api.getSnapshot()).installations).toHaveLength(1);
    await api.unbind('fixture-installation');
    expect((await api.getSnapshot()).installations).toHaveLength(0);
  });

  it('uses one client command id and does not replay a read payload on duplicate', async () => {
    const api = new RelayApi({ initData: 'fixture', fixture: true });
    const input = { commandId: 'cmd_read_1', tabId: 'fixture-tab-1', action: 'get_state' as const };
    const first = await api.sendCommand('fixture-installation', input);
    expect(first.command.commandId).toBe(input.commandId);
    expect(first.payload).toMatchObject({ state: { tabId: input.tabId, activeTurnId: 'fixture-turn-1', actions: { stop: true } } });
    const duplicate = await api.sendCommand('fixture-installation', input);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.command).toEqual(first.command);
    expect(duplicate).not.toHaveProperty('payload');
  });

  it('sends the exact command body and keeps status wire names', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init ?? {}]);
      if (String(input).endsWith('/auth')) return new Response(JSON.stringify({ session_token: 's', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
      return new Response(JSON.stringify({ command: { commandId: 'c-1', tabId: 't-1', action: 'send', status: 'uncertain', outcome: null, dispatchState: 'delivery_unknown', detail: { code: 'uncertain_delivery', message: 'Проверьте компьютер', requiresComputer: true }, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:01.000Z' } }), { status: 202 });
    });
    const api = new RelayApi({ baseUrl: 'https://relay.test/api', initData: 'signed', fetchImpl });
    const result = await api.sendCommand('i-1', { commandId: 'c-1', tabId: 't-1', action: 'send', text: 'hello' });
    expect(result.command.status).toBe('uncertain');
    expect(result.command.outcome).toBeNull();
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ commandId: 'c-1', tabId: 't-1', action: 'send', text: 'hello' });
  });
});
