import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BoatswainSetupService } from '../electron/boatswain-setup.mjs';

test('Boatswain uses a valid settings portal origin and falls back for unsafe addresses', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-boatswain-origin-'));
  const env = { USERPROFILE: root, LOCALAPPDATA: root };
  await mkdir(path.join(root, 'Boatswain'), { recursive: true });
  for (const [portal, expected] of [
    ['https://portal.example.com/', 'https://portal.example.com'],
    ['http://portal.example.com', 'https://coder-portal.encycam.com'],
    ['https://portal.example.com/path', 'https://coder-portal.encycam.com'],
    ['https://user:password@portal.example.com', 'https://coder-portal.encycam.com'],
    ['not-a-url', 'https://coder-portal.encycam.com'],
  ]) {
    await context.test(portal, async () => {
      await writeFile(path.join(root, 'Boatswain', 'boatswain.json'), JSON.stringify({ portal, key: 'secret', machine: 'pc' }));
      const service = new BoatswainSetupService({ env, fetchImpl: async (url, options) => {
        assert.equal(url, expected + '/api/relay/boatswain/machines');
        assert.equal(options.credentials, 'omit');
        return { ok: true, status: 200, text: async () => JSON.stringify({ machines: [{ machine: 'pc' }] }) };
      } });
      assert.equal((await service.status()).online, true);
    });
  }
});

test('Boatswain status reports the machine and configured agents without exposing their keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-boatswain-'));
  const env = { USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local') };
  await mkdir(path.join(env.LOCALAPPDATA, 'Boatswain'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(env.LOCALAPPDATA, 'Boatswain', 'boatswain.json'), JSON.stringify({ portal: 'https://coder-portal.encycam.com', key: 'router-secret', machine: 'office-pc' }));
  await writeFile(path.join(root, '.codex', 'config.toml'), 'model_provider = "router"\n[model_providers.router]\nexperimental_bearer_token = "codex-secret"\n');
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://router.encycam.com',
    ANTHROPIC_AUTH_TOKEN: 'claude-secret',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'cc/claude-fable-5-1[1m]',
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable 5.1',
  } }));
  const client = {
    origin: 'https://coder-portal.encycam.com',
    machines: async key => { assert.equal(key, 'router-secret'); return [{ machine: 'office-pc' }]; },
  };
  const service = new BoatswainSetupService({ env, client });
  const status = await service.status();
  assert.equal(status.installed, true);
  assert.equal(status.online, true);
  assert.equal(status.machine, 'office-pc');
  assert.deepEqual(status.configuredProducts.sort(), ['claude', 'codex']);
  assert.doesNotMatch(JSON.stringify(status), /router-secret|codex-secret|claude-secret/);

  const connection = await service.readClaudeConnection();
  assert.equal(connection.apiKey, 'claude-secret');
  assert.equal(connection.baseUrl, 'https://router.encycam.com');
  assert.equal(connection.authScheme, 'bearer');
  assert.deepEqual(connection.modelAliases, { fable: 'cc/claude-fable-5-1[1m]' });
  assert.deepEqual(connection.modelNames, { fable: 'Fable 5.1' });
});

test('Boatswain status stays offline without settings or a reachable relay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-boatswain-'));
  const env = { USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local') };
  const absent = new BoatswainSetupService({ env, client: { machines: async () => { throw new Error('must not be called'); } } });
  assert.deepEqual(await absent.status(), { installed: false, online: false, configuredProducts: [], machine: undefined, portal: undefined });
  assert.equal(await absent.readClaudeConnection(), null);

  await mkdir(path.join(env.LOCALAPPDATA, 'Boatswain'), { recursive: true });
  await writeFile(path.join(env.LOCALAPPDATA, 'Boatswain', 'boatswain.json'), JSON.stringify({ portal: 'https://coder-portal.encycam.com', key: 'router-secret', machine: 'office-pc' }));
  const unreachable = new BoatswainSetupService({ env, client: { machines: async () => { throw new Error('portal down'); } } });
  const status = await unreachable.status();
  assert.equal(status.installed, true);
  assert.equal(status.online, false);
});
