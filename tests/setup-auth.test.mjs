import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SetupAuth } from '../electron/setup-auth.mjs';
import { buildCodexAuthLaunch } from '../electron/terminal-launcher.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const auth = new SetupAuth({
    getSettings: async provider => ({ executable: `C:\\CLI\\${provider}.exe` }),
    getClaudeEnvironment: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-private-token' }),
    loginClaude: async () => ({ started: true }), assertMutable: () => {},
    resolveCodex: async executable => executable, resolveClaude: async executable => executable,
    createCodex: () => ({ start: async () => calls.push('start'), request: async (method, params) => {
      calls.push([method, params]); return { account: null, requiresOpenaiAuth: false };
    }, stop: () => calls.push('stop') }),
    ...overrides,
  });
  return { auth, calls };
}

test('setup accepts custom Codex provider without requiring ChatGPT or a model request', async () => {
  const { auth, calls } = fixture();
  assert.equal((await auth.status('codex')).state, 'provider');
  assert.deepEqual(calls, ['start', ['account/read', { refreshToken: false }], 'stop']);
  await assert.rejects(auth.login('codex'), /не требуется/);
  assert.equal(auth.activeProvider, null);
});

test('Claude setup status uses application environment and exposes public account fields only', async () => {
  const { auth } = fixture({ readClaude: async ({ env }) => {
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-private-token');
    return { loggedIn: true, email: 'fixture@example.test', authMethod: 'oauth_token', secret: 'never returned' };
  } });
  const result = await auth.status('claude');
  assert.equal(result.state, 'signed-in');
  assert.equal(result.email, 'fixture@example.test');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|never returned/);
});

test('setup preserves unknown auth errors instead of treating them as signed out or exposing output', async () => {
  const { auth } = fixture({ readClaude: async () => { throw new Error('secret-key-fixture'); } });
  const result = await auth.status('claude');
  assert.equal(result.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /secret-key-fixture/);
  await assert.rejects(auth.status('arbitrary'), /Неизвестный/);
});

test('Codex setup login reserves lifecycle until visible console closes and allows retry', async () => {
  const child = new EventEmitter();
  const states = [];
  const { auth } = fixture({
    createCodex: () => ({ start: async () => {}, request: async () => ({ requiresOpenaiAuth: true }), stop() {} }),
    launchCodex: () => { setImmediate(() => child.emit('spawn')); return child; },
    onCodexState: state => states.push(state.state),
  });
  assert.deepEqual(await auth.login('codex'), { started: true });
  await assert.rejects(auth.login('codex'), /Завершите вход/);
  assert.equal(auth.activeProvider, 'codex');
  child.emit('close', 0);
  assert.equal(auth.activeProvider, null);
  assert.deepEqual(states, ['opened', 'closed']);
});

test('Codex browser login uses literal paths and interactive handles without passing a prompt', () => {
  const launch = buildCodexAuthLaunch({ executable: "C:\\CLI's\\codex.exe", cwd: 'C:\\Project $(secret)' });
  assert.deepEqual(launch.codexArgs, ['login']);
  assert.match(launch.script, /CLI''s/);
  assert.match(launch.script, /Set-Location -LiteralPath 'C:\\Project \$\(secret\)'/);
  assert.match(launch.helperScript, /-WindowStyle Normal/);
  assert.equal(launch.options.windowsHide, true);
});
