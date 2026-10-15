import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRelay } from './server.ts';
import { FIXTURE_BOT_TOKEN } from './fixtures.ts';

const fixtureMode = process.env.RELAY_DEV_FIXTURE === '1';
if (fixtureMode && process.env.TELEGRAM_BOT_TOKEN) throw new Error('Unset TELEGRAM_BOT_TOKEN before running local fixtures');
const database = resolve(process.env.RELAY_DATABASE ?? './data/relay.sqlite');
const commandPayloadKey = process.env.RELAY_COMMAND_PAYLOAD_KEY;
if (!commandPayloadKey) throw new Error('RELAY_COMMAND_PAYLOAD_KEY is required for a persistent relay database');
mkdirSync(dirname(database), { recursive: true });
const cert = process.env.RELAY_TLS_CERT, key = process.env.RELAY_TLS_KEY;
if (!!cert !== !!key) throw new Error('Both RELAY_TLS_CERT and RELAY_TLS_KEY are required');
const relay = createRelay({ database, fixtureMode,
  commandPayloadKey,
  botToken: fixtureMode ? FIXTURE_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN ?? '',
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS ?? 'http://localhost:4174,http://127.0.0.1:4174,http://localhost:5173,http://127.0.0.1:5173').split(',').filter(Boolean),
  trustLoopbackProxy: process.env.RELAY_TRUST_LOOPBACK_PROXY === '1',
  staticDirectory: process.env.RELAY_STATIC_DIR,
  tls: cert && key ? { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') } : undefined,
});
const port = await relay.listen(Number(process.env.RELAY_PORT ?? 8787), process.env.RELAY_HOST ?? '127.0.0.1');
console.info(`Relay listening on port ${port}; mode=${fixtureMode ? 'local-fixture' : 'production'}; protocol=2.3`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true; void relay.close().then(() => process.exit(0));
});
