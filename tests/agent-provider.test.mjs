import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, WindowSession } from '../electron/window-session.mjs';
import { buildTerminalLaunch } from '../electron/terminal-launcher.mjs';
import { captureUpdateCheckpoint, validateStoredCheckpoint } from '../electron/update-checkpoint.mjs';

test('provider defaults preserve legacy Codex and never leak model/executable/access into Claude', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'settings.json');
  await writeFile(filename, JSON.stringify({ cwd: directory, executable: 'codex.exe', model: 'codex-model', effort: 'ultra', access: 'auto' }));
  const store = new SettingsStore(filename);
  assert.deepEqual(await store.snapshotProvider('claude'), { cwd: directory, provider: 'claude' });
  await store.updateProvider('claude', { model: 'sonnet', effort: 'high', executable: 'claude.exe', access: 'workspace-write' });
  assert.equal((await store.snapshotProvider('codex')).model, 'codex-model');
  assert.equal((await store.snapshotProvider('codex')).executable, 'codex.exe');
  assert.equal((await store.snapshotProvider('claude')).model, 'sonnet');
  await store.updateProvider('codex', { effort: 'max' });
  assert.equal((await store.snapshotProvider('claude')).effort, 'high');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).model, 'codex-model');
});

test('a session cannot change provider or submit another providers thread', async () => {
  const session = new WindowSession({ settings: { provider: 'claude', cwd: path.resolve('.') } });
  assert.throws(() => session.setSettings({ provider: 'codex' }), /отдельный диалог/);
  await assert.rejects(session.request('thread/resume', { threadId: '12345678-1234-4234-9234-123456789abc' }), /другому агенту/);
  const codex = new WindowSession({ settings: { cwd: path.resolve('.') } });
  await assert.rejects(codex.request('thread/read', { threadId: 'claude:12345678-1234-4234-9234-123456789abc' }), /другому агенту/);
});

test('workspace snapshot keeps trusted provider and Claude history namespace through ordinary restart', () => {
  const cwd = path.resolve('.');
  const session = new WindowSession({ settings: { cwd, provider: 'claude', executable: 'claude.exe' } });
  const snapshot = captureUpdateCheckpoint({ version: 1, activeIndex: 0, tabs: [{ sessionId: 'a', draft: '', attachments: [], settings: { provider: 'codex', model: 'sonnet', access: 'danger-full-access' }, thread: { id: 'claude:12345678-1234-4234-9234-123456789abc', provider: 'claude' } }] }, new Map([['a', session]]));
  const restored = validateStoredCheckpoint(snapshot, { resetFullAccess: true });
  assert.equal(restored.tabs[0].settings.provider, 'claude');
  assert.equal(restored.tabs[0].settings.access, 'workspace-write');
  assert.equal(restored.tabs[0].thread.provider, 'claude');
});

test('Claude terminal uses native UUID and Claude flags without Codex configuration overrides', () => {
  const launch = buildTerminalLaunch({ provider: 'claude', executable: 'C:\\Claude\\claude.exe', cwd: 'C:\\Project', threadId: 'claude:12345678-1234-4234-9234-123456789abc', model: 'sonnet[1m]', effort: 'high', access: 'auto' });
  assert.deepEqual(launch.codexArgs, ['--resume', '12345678-1234-4234-9234-123456789abc', '--model', 'sonnet[1m]', '--effort', 'high', '--permission-mode', 'acceptEdits']);
  assert.ok(!launch.script.includes('model_reasoning_effort'));
  assert.ok(!launch.codexArgs.includes('--dangerously-skip-permissions'));
});
