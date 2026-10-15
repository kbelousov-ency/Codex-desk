import type { TelegramContext, TelegramGlobal, TelegramWebApp } from './types';

/** Stable fixture data for local development. It is intentionally not a real Telegram signature. */
export const FIXTURE_INIT_DATA =
  'auth_date=1700000000&query_id=fixture-query&user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22Fixture%22%2C%22username%22%3A%22fixture_user%22%7D&hash=fixture-hash';

const fixtureWebApp: TelegramWebApp = {
  initData: FIXTURE_INIT_DATA,
  initDataUnsafe: {
    auth_date: 1700000000,
    query_id: 'fixture-query',
    user: { id: 424242, first_name: 'Fixture', username: 'fixture_user' }
  },
  version: '7.0-fixture',
  platform: 'browser',
  colorScheme: 'dark',
  ready: () => undefined,
  expand: () => undefined
};

export function fixtureRequested(): boolean {
  const query = new URLSearchParams(window.location.search);
  // A query string may enable fixtures only in a development build. A production
  // bundle must never switch identity/authentication mode from a public URL.
  return import.meta.env.DEV && (query.get('fixture') === '1' || import.meta.env.VITE_TELEGRAM_FIXTURE === '1');
}

/**
 * Reads only WebApp.initData. initDataUnsafe is exposed for Telegram UI hints but never sent
 * to the relay and is deliberately not used as an identity source.
 */
export function getTelegramContext(): TelegramContext {
  const global = window as typeof window & { Telegram?: TelegramGlobal };
  const webApp = global.Telegram?.WebApp;
  if (fixtureRequested()) {
    installTelegramFixture();
    return { initData: FIXTURE_INIT_DATA, startParam: readStartParam(FIXTURE_INIT_DATA), isFixture: true, webApp: fixtureWebApp };
  }
  if (webApp?.initData) {
    webApp.ready?.();
    webApp.expand?.();
    return { initData: webApp.initData, startParam: readStartParam(webApp.initData), isFixture: false, webApp };
  }
  // Keep the app renderable in a regular browser. The API will show an actionable error.
  return { initData: '', isFixture: false, webApp: { initData: '' } };
}

/** start_param is part of signed initData; initDataUnsafe is never used as identity. */
export function readStartParam(initData: string): string | undefined {
  const value = new URLSearchParams(initData).get('start_param');
  return value || undefined;
}

export function installTelegramFixture(): TelegramWebApp {
  const global = window as typeof window & { Telegram?: TelegramGlobal };
  global.Telegram = { ...(global.Telegram ?? {}), WebApp: fixtureWebApp };
  return fixtureWebApp;
}

/** Load Telegram's official SDK only for a Telegram launch; local fixture tests are offline. */
export async function loadTelegramSdk(): Promise<void> {
  if (fixtureRequested() || import.meta.env.VITE_LOCAL_RELAY === '1') return;
  if ((window as typeof window & { Telegram?: TelegramGlobal }).Telegram?.WebApp) return;
  if (!window.location.hash.includes('tgWebAppData=')) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Не удалось загрузить Telegram.'));
    document.head.append(script);
  });
}
