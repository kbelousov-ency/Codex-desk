import { afterEach } from 'vitest';

afterEach(() => {
  window.history.replaceState({}, '', '/');
  delete (window as typeof window & { Telegram?: unknown }).Telegram;
});

