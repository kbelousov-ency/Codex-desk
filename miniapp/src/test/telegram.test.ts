import { describe, expect, it } from 'vitest';
import { FIXTURE_INIT_DATA, getTelegramContext, installTelegramFixture, readStartParam } from '../telegram';

describe('Telegram adapter', () => {
  it('uses fixture WebApp in an ordinary browser and sends the signed initData string', () => {
    window.history.replaceState({}, '', '/?fixture=1');
    const context = getTelegramContext();
    expect(context.isFixture).toBe(true);
    expect(context.initData).toBe(FIXTURE_INIT_DATA);
    expect(context.webApp.initDataUnsafe?.user).toEqual({ id: 424242, first_name: 'Fixture', username: 'fixture_user' });
  });

  it('prefers initData over initDataUnsafe as identity', () => {
    (window as typeof window & { Telegram?: unknown }).Telegram = { WebApp: { initData: 'auth_date=1&hash=signed', initDataUnsafe: { user: { id: 999 } } } };
    const context = getTelegramContext();
    expect(context.initData).toBe('auth_date=1&hash=signed');
    expect(context.isFixture).toBe(false);
  });

  it('extracts only signed start_param for pairing', () => {
    expect(readStartParam('start_param=nonce-123&hash=x')).toBe('nonce-123');
    installTelegramFixture();
    window.history.replaceState({}, '', '/?fixture=1');
    expect(getTelegramContext().startParam).toBeUndefined();
  });
});
