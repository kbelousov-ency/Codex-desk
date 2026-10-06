import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { CodexClient } from '../electron/codex-client.mjs';
import { findCodex } from '../electron/host-utils.mjs';
import { buildCodexConnectionProfile, validateCodexConnectionConfig } from '../electron/codex-connections.mjs';

// Native session metadata only: no turn/start, compaction, tools, or model input.
const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-source-resume-'));
const codexHome = path.join(directory, 'codex'), cwd = path.join(directory, 'project');
await mkdir(codexHome); await mkdir(cwd);
const configPath = path.join(codexHome, 'config.toml');
const originalConfig = 'model = "gpt-5.4"\nmodel_provider = "openai"\n[model_providers.router]\nname = "Fixture router"\nwire_api = "responses"\nrequires_openai_auth = false\nbase_url = "https://127.0.0.1:1/v1"\nexperimental_bearer_token = "synthetic-unusable-key"\n';
await writeFile(configPath, originalConfig);
const env = { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: '', CODEX_API_KEY: '', OPENAI_BASE_URL: '', OTEL_SDK_DISABLED: 'true' };
const profile = buildCodexConnectionProfile({ source: 'router', processEnv: env,
  router: { apiKey: 'synthetic-unusable-key', baseUrl: 'https://127.0.0.1:1/v1', authScheme: 'bearer' } });
const executable = await findCodex();
let first, plain;
try {
  first = new CodexClient({ executable, cwd, env: profile.env, configOverrides: profile.configOverrides, requestTimeoutMs: 15000 });
  const version = await first.start();
  validateCodexConnectionConfig((await first.request('config/read', { cwd, includeLayers: false })).config, profile);
  const created = await first.request('thread/start', { cwd, model: 'gpt-5.4', modelProvider: profile.modelProvider, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
  console.log(JSON.stringify({ phase: 'created', version: version.userAgent, threadId: created.thread.id, modelProvider: created.thread.modelProvider, path: created.thread.path }));
  await first.request('thread/inject_items', { threadId: created.thread.id, items: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic fixture history. No model is invoked.' }] },
  ] });
  await first.stopAndWait();
  first = null;
  plain = new CodexClient({ executable, cwd, env, requestTimeoutMs: 15000 });
  await plain.start();
  const resumed = await plain.request('thread/resume', { threadId: created.thread.id, cwd, sandbox: 'read-only', approvalPolicy: 'never' });
  assert.equal(resumed.thread.id, created.thread.id);
  assert.equal(resumed.thread.modelProvider, 'router');
  console.log(JSON.stringify({ phase: 'plain-resume', success: true, threadId: resumed.thread.id, modelProvider: resumed.thread.modelProvider }));
  if (created.thread.path) {
    try {
      const content = await readFile(created.thread.path, 'utf8');
      const metadata = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(value => value.type === 'session_meta');
      assert.equal(metadata[0]?.payload?.model_provider, 'router');
      console.log(JSON.stringify({ phase: 'metadata', rows: metadata.map(value => ({ modelProvider: value.payload?.model_provider })) }));
    } catch (error) { console.log(JSON.stringify({ phase: 'metadata', error: error.code })); }
  }
  await plain.stopAndWait(); plain = null;
  const account = buildCodexConnectionProfile({ source: 'account', processEnv: env });
  plain = new CodexClient({ executable, cwd, env: account.env, configOverrides: account.configOverrides, requestTimeoutMs: 15000 });
  await plain.start();
  validateCodexConnectionConfig((await plain.request('config/read', { cwd, includeLayers: false })).config, account);
  const personalResume = await plain.request('thread/resume', { threadId: created.thread.id, modelProvider: account.modelProvider, cwd, sandbox: 'read-only', approvalPolicy: 'never' });
  assert.equal(personalResume.thread.id, created.thread.id);
  assert.equal(personalResume.modelProvider, 'openai');
  assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  console.log(JSON.stringify({ phase: 'account-resume', success: true, modelProvider: personalResume.modelProvider, configUnchanged: true }));
} finally {
  if (first) await first.stopAndWait().catch(() => {});
  if (plain) await plain.stopAndWait().catch(() => {});
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Invalid cleanup path');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
