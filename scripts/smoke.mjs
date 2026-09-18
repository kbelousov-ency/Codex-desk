import { CodexClient } from '../electron/codex-client.mjs';
import { findCodex, publicConfig } from '../electron/host-utils.mjs';
const executable = await findCodex();
const client = new CodexClient({ executable, cwd: process.cwd(), requestTimeoutMs: 30_000 });
try {
  const initialize = await client.start();
  const [models, account, configuration, threads] = await Promise.all([
    client.request('model/list', { limit: 100 }),
    client.request('account/read', { refreshToken: false }),
    client.request('config/read', { cwd: process.cwd(), includeLayers: false }),
    client.request('thread/list', { cwd: process.cwd(), limit: 5, sourceKinds: ['appServer', 'cli', 'vscode'] }),
  ]);
  console.log(JSON.stringify({ executable, server: initialize.userAgent, modelCount: models.data.length, models: models.data.map(item => item.model), accountType: account.account?.type || null, requiresAuth: account.requiresOpenaiAuth, config: publicConfig(configuration.config), existingThreads: threads.data.length, result: 'PASS: real app-server initialized and read-only requests completed; no model turn started' }, null, 2));
} finally { client.stop(); }