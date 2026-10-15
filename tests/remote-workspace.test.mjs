import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureWorkspaceState, createWorkspaceState } from '../electron/workspace-state.mjs';
import { captureUpdateCheckpoint } from '../electron/update-checkpoint.mjs';

const cwd = path.resolve('fixture-remote-project');
const target = provider => ({ grantId: 'grant-one', generation: 7, provider, threadId: 'thread-one', projectKey: 'opaque-project',
  sessionId: 'old-session', runtimeId: 'old-runtime' });
const context = (provider, kind, id) => ({ operationId: `operation-${id}`, target: target(provider), kind, clientUserMessageId: id,
  ...(kind === 'steer' ? { expectedTurnId: 'turn-old' } : {}) });
const snapshot = (provider = 'codex', kind = 'send') => ({ version: 1, activeIndex: 0, tabs: [{ sessionId: 'old-session',
  thread: { id: 'thread-one', cwd }, settings: { provider, model: 'live-model', effort: 'high', access: 'rules' },
  draft: 'Local draft stays local', attachments: [],
  pendingMessage: { threadId: 'thread-one', clientUserMessageId: 'message-pending', kind: kind === 'steer' ? 'steer' : 'start',
    text: 'Unconfirmed remote text', attachments: [], origin: 'remote', remote: context(provider, kind, 'message-pending') },
  queue: { paused: false, threadId: 'thread-one', cwd, items: [
    { id: 'message-local', text: 'Local queue head', attachments: [], state: 'waiting' },
    { id: 'message-remote', text: 'Remote queue tail', attachments: [], state: 'uncertain', remote: context(provider, 'enqueue', 'message-remote') },
  ] },
}] });
const sessions = (provider = 'codex') => new Map([['old-session', { currentCwd: cwd,
  getSettings: () => ({ provider, executable: 'trusted-cli', model: 'live-model', effort: 'high', access: 'rules' }) }]]);

test('remote pending and FIFO origin survive durable workspace roundtrip for Codex and Claude without rebinding or draft loss', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-remote-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceState(directory);
  for (const provider of ['codex', 'claude']) for (const kind of ['send', 'enqueue', 'steer']) {
    const input = snapshot(provider, kind), captured = captureWorkspaceState(input, sessions(provider));
    await store.save(captured);
    const restored = (await store.read()).tabs[0], source = input.tabs[0];
    assert.deepEqual(restored.pendingMessage, source.pendingMessage);
    assert.equal(restored.pendingMessage.remote.target.sessionId, 'old-session');
    assert.equal(restored.pendingMessage.remote.target.runtimeId, 'old-runtime');
    assert.equal(restored.pendingMessage.remote.target.generation, 7);
    assert.equal(restored.draft, source.draft);
    assert.deepEqual(restored.queue.items, source.queue.items);
    assert.equal(restored.queue.paused, true, 'no implicit replay on restoration');
    assert.equal(restored.settings.access, 'rules');
    assert.deepEqual(captureUpdateCheckpoint(input, sessions(provider)).tabs[0].pendingMessage, restored.pendingMessage);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'workspace-state.json'), 'utf8')).tabs[0].pendingMessage.origin, 'remote');
  }
});

test('remote pending origin cannot be silently discarded or redirected to another thread/message', () => {
  const invalid = [
    tab => { delete tab.pendingMessage.remote; },
    tab => { tab.pendingMessage.remote.target.threadId = 'other-thread'; },
    tab => { tab.pendingMessage.remote.clientUserMessageId = 'other-message'; },
    tab => { tab.pendingMessage.remote.operationId = ''; },
    tab => { tab.pendingMessage.remote.target.generation = -1; },
    tab => { tab.pendingMessage.remote.target.path = 'must-not-be-a-path'; },
    tab => { tab.pendingMessage.remote.kind = 'stop'; },
    tab => { tab.queue.items[1].remote.clientUserMessageId = 'different-head'; },
    tab => { tab.queue.items[1].remote.target.threadId = 'different-thread'; },
  ];
  for (const mutate of invalid) {
    const input = snapshot(); mutate(input.tabs[0]);
    assert.throws(() => captureWorkspaceState(input, sessions()));
  }
});

test('durable remote metadata must match provider, pending kind, queue kind and text-only scope', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
  const invalid = [
    ['pending provider', tab => { tab.pendingMessage.remote.target.provider = 'claude'; }],
    ['queue provider', tab => { tab.queue.items[1].remote.target.provider = 'claude'; }],
    ['pending start with steer', tab => { tab.pendingMessage.remote.kind = 'steer'; tab.pendingMessage.remote.expectedTurnId = 'turn-old'; }],
    ['pending steer with send', tab => { tab.pendingMessage.kind = 'steer'; }],
    ['queue send', tab => { tab.queue.items[1].remote.kind = 'send'; }],
    ['pending file', tab => { tab.pendingMessage.attachments = [{ name: 'image.png', dataUrl: png }]; }],
    ['queue file', tab => { tab.queue.items[1].attachments = [{ name: 'image.png', dataUrl: png }]; }],
  ];
  for (const [name, mutate] of invalid) {
    const input = snapshot(); mutate(input.tabs[0]);
    assert.throws(() => captureWorkspaceState(input, sessions()), name);
  }
});

test('remote context validation strips extraneous metadata and cannot smuggle settings or secrets to disk', () => {
  const input = snapshot('claude', 'steer');
  input.tabs[0].pendingMessage.remote.secret = 'private-secret';
  input.tabs[0].pendingMessage.remote.model = 'remote-model-override';
  input.tabs[0].queue.items[1].remote.access = 'danger-full-access';
  const captured = captureWorkspaceState(input, sessions('claude'));
  const encoded = JSON.stringify(captured);
  assert.equal(encoded.includes('private-secret'), false);
  assert.equal(encoded.includes('remote-model-override'), false);
  assert.equal(encoded.includes('danger-full-access'), false);
  assert.deepEqual(captured.tabs[0].pendingMessage.remote, context('claude', 'steer', 'message-pending'));
});
