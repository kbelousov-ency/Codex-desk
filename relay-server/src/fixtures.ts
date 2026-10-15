import { createHmac } from 'node:crypto';

/** Public synthetic fixture, never a Telegram credential. */
export const FIXTURE_BOT_TOKEN = '100000:LOCAL_ONLY_NOT_A_TELEGRAM_BOT_TOKEN';
/** Public synthetic test key. Production deployments must generate their own persistent 32-byte key. */
export const FIXTURE_COMMAND_PAYLOAD_KEY = Buffer.alloc(32, 0x5a).toString('base64url');
export function fixtureInitData(now = Date.now(), user = 10001, startParam?: string): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)),
    query_id: 'LOCAL_FIXTURE', user: JSON.stringify({ id: user, first_name: 'Локальный тест', username: 'fixture_user' }) });
  if (startParam) params.set('start_param', startParam);
  const canonical = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(FIXTURE_BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(canonical).digest('hex'));
  return params.toString();
}
