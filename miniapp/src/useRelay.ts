import { useCallback, useEffect, useRef, useState } from 'react';
import { RelayApi, normalizeSnapshot, type ServerInstallationsResponse } from './api';
import type { RelaySnapshot } from './types';

export interface RelayState {
  snapshot: RelaySnapshot | null;
  loading: boolean;
  error: Error | null;
  live: boolean;
  refresh: () => Promise<void>;
  removeInstallation: (installationId: string) => Promise<void>;
}

/** A snapshot is always complete; outdated messages cannot undo a newer revision. */
export function acceptSnapshot(current: RelaySnapshot | null, incoming: RelaySnapshot): RelaySnapshot {
  if (current?.revision != null && incoming.revision != null && incoming.revision < current.revision) return current;
  return incoming;
}

export function useRelay(api: RelayApi, fixture = false): RelayState {
  const [snapshot, setSnapshot] = useState<RelaySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [live, setLive] = useState(fixture);
  const active = useRef(true);

  const applySnapshot = useCallback((incoming: RelaySnapshot) => {
    if (!active.current) return;
    setSnapshot((current) => acceptSnapshot(current, incoming));
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    try { applySnapshot(await api.getSnapshot()); }
    catch (cause) {
      if (!active.current) return;
      setError(cause instanceof Error ? cause : new Error('Не удалось подключиться к Кузьмичу.'));
      setLoading(false);
      setLive(false);
    }
  }, [api, applySnapshot]);

  useEffect(() => {
    active.current = true;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 1000;

    const connect = async () => {
      await refresh();
      if (stopped || fixture || !api.getSessionId()) return;
      socket = new WebSocket(api.streamUrl());
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'authenticate', session_token: api.getSessionId() }));
        // Reconnect never relies on a partial replay: request a complete view.
        socket?.send(JSON.stringify({ type: 'resync' }));
      };
      socket.onmessage = (event) => {
        try {
          const message: { type?: string; installationId?: string; command?: unknown } & ServerInstallationsResponse = JSON.parse(String(event.data));
          if (message.type === 'command_updated') {
            if (typeof message.installationId === 'string' && message.command && typeof message.command === 'object') {
              api.receiveCommandUpdate(message.installationId, message.command as Parameters<RelayApi['receiveCommandUpdate']>[1]);
            }
            return;
          }
          if (message.type !== 'snapshot' || !Array.isArray(message.installations)) return;
          const incoming = normalizeSnapshot(message);
          applySnapshot(incoming);
          setLive(true);
          delay = 1000;
        } catch {
          socket?.send(JSON.stringify({ type: 'resync' }));
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setLive(false);
        reconnect = setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };

    void connect();
    const polling = setInterval(() => { void refresh(); }, 30_000);
    const focus = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resync' }));
      }
    };
    document.addEventListener('visibilitychange', focus);
    return () => {
      stopped = true;
      active.current = false;
      clearInterval(polling);
      clearTimeout(reconnect);
      document.removeEventListener('visibilitychange', focus);
      socket?.close();
    };
  }, [api, fixture, refresh, applySnapshot]);

  const removeInstallation = useCallback(async (installationId: string) => {
    await api.unbind(installationId);
    if (fixture) {
      setSnapshot((current) => current ? {
        ...current,
        installations: current.installations.filter((item) => item.installation_id !== installationId),
        kuzmich: { status: current.installations.some((item) => item.installation_id !== installationId && item.status === 'online') ? 'online' : 'offline' }
      } : null);
    } else await refresh();
  }, [api, fixture, refresh]);

  return { snapshot, loading, error, live, refresh, removeInstallation };
}
