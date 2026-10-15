import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPublicKey, randomUUID } from 'node:crypto';

import { startRelay } from './fixtures/relay-server.mjs';
import { createRemoteBridgeService } from '../electron/remote-bridge/service.mjs';
import { CLOSE, SUBPROTOCOL, createInstallationKeys, verifyDeviceProof, tabIdFor } from '../electron/remote-bridge/protocol.mjs';

/**
 * The production bridge against a real WebSocket server over a real socket. No relay, no Telegram,
 * no model: the fixture relay speaks the contract and nothing else.
 *
 * Authentication is checked the way a correct hash-only relay has to do it: the fixture keeps only
 * the public key it was given during pairing and verifies the Ed25519 signature of its challenge.
 */

const KEYS = createInstallationKeys();
const SALT = Buffer.alloc(32, 9).toString('base64url');
const INSTALLATION = '11111111-2222-4333-8444-555555555555';
const OWNER = { telegramUserId: '12345678', displayName: 'Иван' };
const ANSWER = 'Секретный ответ модели, который не должен покинуть компьютер.';
const CWD = 'E:\\My projects\\CodexDesk';

function fixtureSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) { return Buffer.concat([Buffer.from('enc:'), Buffer.from(value, 'utf8').reverse()]); },
    decryptString(bytes) {
      const buffer = Buffer.from(bytes);
      if (buffer.subarray(0, 4).toString() !== 'enc:') throw new Error('bad blob');
      return Buffer.from(buffer.subarray(4)).reverse().toString('utf8');
    },
  };
}

/**
 * A stand-in for the core facade with a small durable-ish ledger: `execute` admits an operation
 * under its immutable `requestId`, `getOperation` reads it back, and every call is recorded so a
 * test can prove the bridge sent a command exactly once.
 */
function fixtureRemote(threads = []) {
  const listeners = new Set();
  const remote = {
    threads,
    states: new Map(),
    calls: [],
    operations: new Map(),   // requestId → RemoteOperation
    executeCalls: [],
    executeResult: null,     // a hook for refusals and for a core that throws
    answer: { answerId: 'ans-1', turnId: 'turn-A', text: ANSWER, completedAt: '2026-10-14T10:02:00.000Z', truncated: false },
    // Set to a promise to hold the core mid-answer; that is how a socket is cut *during* a read.
    hold: null,
    listThreads: async () => {
      remote.calls.push('listThreads');
      if (remote.hold) await remote.hold;
      return { ok: true, value: remote.threads.map(thread => ({ ...thread })) };
    },
    getThreadState: async target => {
      remote.calls.push('getThreadState');
      const state = remote.states.get(target.grantId);
      return state ? { ok: true, value: { ...state, target } } : { ok: false, error: { code: 'access_denied', message: 'Доступ к беседе не разрешён.', requiresComputer: false } };
    },
    getLastAnswer: async target => {
      remote.calls.push('getLastAnswer');
      if (!remote.states.has(target.grantId)) return { ok: false, error: { code: 'access_denied', message: 'Доступ к беседе не разрешён.', requiresComputer: false } };
      return { ok: true, value: remote.answer ? { ...remote.answer } : null };
    },
    execute: async command => {
      remote.calls.push('execute');
      remote.executeCalls.push({
        requestId: command.requestId, kind: command.kind, text: command.text ?? null,
        expectedTurnId: command.expectedTurnId ?? null, grantId: command.target?.grantId ?? null,
      });
      if (remote.executeResult) return remote.executeResult(command);
      return { ok: true, value: remote.admit(command, 'queued') };
    },
    getOperation: async ({ requestId }) => {
      remote.calls.push('getOperation');
      const operation = remote.operations.get(requestId);
      return operation
        ? { ok: true, value: { ...operation } }
        : { ok: false, error: { code: 'not_found', message: 'Такой команды нет.', requiresComputer: false } };
    },
    /** Mirrors the core reserving an immutable record before it dispatches. */
    admit(command, phase) {
      const operation = {
        operationId: randomUUID(), requestId: command.requestId, target: command.target, kind: command.kind,
        phase, revision: 1, clientUserMessageId: randomUUID(), expectedTurnId: command.expectedTurnId ?? null,
        executionTurnId: null, queuePosition: null, outcome: null, error: null,
        createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
      };
      remote.operations.set(command.requestId, operation);
      return operation;
    },
    advance(requestId, patch) {
      const operation = remote.operations.get(requestId);
      Object.assign(operation, patch, { revision: operation.revision + 1 });
      remote.notify();
    },
    // Present on the real facade; the bridge must never call it — it can hand over answer text.
    readEvent: async () => { remote.calls.push('readEvent'); return { ok: true, value: { kind: 'answer_ready', answer: { text: ANSWER } } }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener({ eventId: randomUUID() }); },
  };
  return remote;
}

const sendCommand = (socket, fields) => socket.send({
  protocol: 2, type: 'command', frameId: randomUUID(), sentAt: new Date().toISOString(), userRef: 'u_7f3a', ...fields,
});

function allowedThread({ grantId, title, provider = 'codex', projectLabel = 'CodexDesk', availability = 'available' }) {
  return {
    grantId, title, provider, projectLabel, availability,
    target: availability === 'available'
      ? { grantId, generation: 2, provider, threadId: provider === 'claude' ? `claude:${grantId}` : `thread-${grantId}`, projectKey: 'pk', sessionId: 'sess', runtimeId: 'rt' }
      : null,
  };
}

const idleState = (overrides = {}) => ({
  revision: 1, phase: 'idle', activeTurnId: null, queue: { count: 0, limit: 50, paused: false },
  blockers: [], actions: { send: true, enqueue: true, steer: false, stop: false },
  requiresComputer: false, updatedAt: '2026-10-14T10:00:00.000Z', ...overrides,
});

async function makeHarness({ relayUrl, credential = true, enabled = true, available = true, record = null } = {}) {
  const userData = await mkdtemp(path.join(tmpdir(), 'bridge-svc-'));
  const directory = path.join(userData, 'remote-bridge');
  await mkdir(directory, { recursive: true });
  const safeStorage = fixtureSafeStorage({ available });

  if (record !== null) {
    await writeFile(path.join(directory, 'bridge.json'), record, 'utf8');
  } else {
    await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ version: 1, enabled, relayUrl: relayUrl ?? '', label: 'Рабочий ПК', epoch: 4, commands: [] }), 'utf8');
  }
  if (credential) {
    const payload = JSON.stringify({
      installationId: INSTALLATION, privateKey: KEYS.privateKey, publicKey: KEYS.publicKey, tabSalt: SALT,
      relayUrl: relayUrl ?? '', owner: OWNER, issuedAt: '2026-10-14T10:00:00.000Z',
    });
    await writeFile(path.join(directory, 'credential.json'), JSON.stringify({
      version: 1, payload: Buffer.from(safeStorage.encryptString(payload)).toString('base64'), savedAt: '2026-10-14T10:00:00.000Z',
    }), 'utf8');
  }
  return { userData, directory, safeStorage };
}

function makeService({ userData, safeStorage, remote, ...rest }) {
  return createRemoteBridgeService({
    userData, safeStorage, remote, appVersion: '0.11.0', channel: 'nightly',
    WebSocketImpl: globalThis.WebSocket, safetyPollMs: 60_000, ...rest,
  });
}

/**
 * Drives the relay side of the handshake and returns `hello` once the bridge is `ready`.
 * The signature is verified against the stored public key, exactly as a real relay must.
 */
async function accept(socket, { nonce = 'challenge-nonce-abcdefgh', publicKey = KEYS.publicKey } = {}) {
  socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce, serverProtocol: '2.1' });
  const hello = await socket.next('hello');
  assert.ok(verifyDeviceProof({ publicKey, installationId: hello.installationId, nonce, proof: hello.proof }),
    'the relay verifies the Ed25519 signature of its own challenge using only the public key');
  socket.send({ protocol: 2, type: 'welcome', frameId: randomUUID(), sentAt: new Date().toISOString(), sessionId: 's1', heartbeatIntervalMs: 25_000, serverProtocol: '2.1', features: [] });
  return hello;
}

/** A promise a test opens by hand, so it can stop the core in the middle of a call. */
function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

const waitFor = async (predicate, { timeoutMs = 5000, label = 'условие' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Не дождались: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

// ----------------------------------------------------------------------------------

test('the bridge connects, signs the challenge without sending any key and publishes a snapshot', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Сборка релиза' })]);
  remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-A', queue: { count: 2, limit: 50, paused: true }, blockers: ['busy'] }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    assert.equal(socket.protocol, SUBPROTOCOL, 'the agreed subprotocol is offered');
    assert.equal(socket.url, '/bridge/v2', 'the contract endpoint is used');
    assert.ok(!JSON.stringify(socket.requestHeaders).includes(KEYS.privateKey), 'no key rides in the handshake headers');

    const hello = await accept(socket, { nonce: 'nonce-one' });
    assert.equal(hello.installationId, INSTALLATION);
    assert.equal(hello.client.bridge, '2.3');
    assert.ok(!JSON.stringify(hello).includes(KEYS.privateKey), 'the private key never crosses the wire');
    // A signature over a different challenge must not be accepted: the nonce is one-time.
    assert.ok(!verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: INSTALLATION, nonce: 'another-nonce', proof: hello.proof }));
    assert.deepEqual(hello.resume, { epoch: 5, revision: 0 }, 'the stored epoch is advanced once at startup');
    assert.deepEqual(hello.installation, { label: 'Рабочий ПК' });

    const snapshot = await socket.next('snapshot');
    assert.deepEqual(snapshot, {
      protocol: 2, type: 'snapshot', frameId: snapshot.frameId, sentAt: snapshot.sentAt,
      epoch: 5, revision: 1,
      installation: { label: 'Рабочий ПК', appVersion: '0.11.0', channel: 'nightly' },
      truncated: false,
      tabs: [{
        tabId: tabIdFor(SALT, 'grant-a'), title: 'Сборка релиза', agent: 'codex', project: 'CodexDesk',
        status: 'running', queueLength: 2, queuePaused: true, updatedAt: '2026-10-14T10:00:00.000Z',
      }],
    });
    assert.ok(!JSON.stringify(snapshot).includes('busy'), 'the reason for the state stays on this computer');

    await waitFor(async () => (await service.local.getState()).connection === 'online', { label: 'состояние «на связи»' });
    const state = await service.local.getState();
    assert.deepEqual({ linked: state.linked, publishedTabs: state.publishedTabs, owner: state.owner }, { linked: true, publishedTabs: 1, owner: OWNER });
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('only conversations the computer allowed are published, and a revoked one is removed', async () => {
  const relay = await startRelay();
  const allowed = allowedThread({ grantId: 'grant-a', title: 'Разрешённая' });
  const remote = fixtureRemote([allowed]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    const snapshot = await socket.next('snapshot');
    assert.deepEqual(snapshot.tabs.map(tab => tab.title), ['Разрешённая']);

    // The core stops listing a conversation the moment its permission is revoked on the computer.
    remote.threads = [];
    service.refresh();
    const removed = await socket.next('event');
    assert.deepEqual(removed.event, { kind: 'tab_removed', tabId: tabIdFor(SALT, 'grant-a') });
    assert.equal(removed.revision, 2, 'the revision keeps rising');

    // And nothing about it is ever published again.
    remote.notify();
    service.refresh();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(socket.sent('event').length, 1, 'a removed tab produces no further updates');
    assert.ok(!socket.frames.some(entry => entry.raw.includes('Разрешённая') && entry.frame?.type === 'event'));
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('incremental events carry a strictly growing revision and skip no-op refreshes', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    // A changed timestamp alone is not a change worth a frame.
    remote.states.set('grant-a', idleState({ updatedAt: '2026-10-14T10:05:00.000Z' }));
    remote.notify();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(socket.sent('event').length, 0);

    remote.states.set('grant-a', idleState({ phase: 'running', updatedAt: '2026-10-14T10:06:00.000Z' }));
    remote.notify();
    const first = await socket.next('event');
    assert.equal(first.event.tab.status, 'running');

    remote.states.set('grant-a', idleState({ phase: 'blocked', queue: { count: 4, limit: 50, paused: false } }));
    remote.notify();
    const second = await socket.next('event');
    assert.equal(second.event.tab.status, 'blocked');
    assert.equal(second.event.tab.queueLength, 4);
    assert.ok(second.revision > first.revision, 'revisions are strictly increasing');
    assert.equal(second.epoch, first.epoch);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a resync request produces a fresh full snapshot and is throttled against a storm', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    const first = await socket.next('snapshot');

    socket.send({ protocol: 2, type: 'resync_request', frameId: randomUUID(), sentAt: new Date().toISOString(), reason: 'gap' });
    const second = await socket.next('snapshot');
    assert.equal(second.epoch, first.epoch);
    assert.ok(second.revision > first.revision, 'a resync is a new revision, not a replay of the old one');

    for (let index = 0; index < 5; index++) socket.send({ protocol: 2, type: 'resync_request', frameId: randomUUID(), sentAt: new Date().toISOString(), reason: 'gap' });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(socket.sent('snapshot').length, 2, 'a burst of resync requests is not answered one by one');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a dropped connection reconnects and resyncs with a revision above the last one applied', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    const before = await first.next('snapshot');

    remote.states.set('grant-a', idleState({ phase: 'running' }));
    remote.notify();
    const event = await first.next('event');

    first.destroy();   // a lost network, with no close frame
    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    const hello = await accept(second);
    assert.equal(hello.resume.epoch, before.epoch, 'the same run keeps its epoch');

    const after = await second.next('snapshot');
    assert.equal(after.epoch, before.epoch);
    assert.ok(after.revision > event.revision, 'the resync snapshot outranks everything already applied');
    assert.deepEqual(after.tabs.map(tab => tab.status), ['running'], 'the snapshot carries the current state, not the old one');
    assert.equal(second.sent('event').length, 0, 'no event precedes the snapshot on a fresh connection');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a revoking server wipes the credential locally and stops reconnecting', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([]);
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    socket.send({ protocol: 2, type: 'revoked', frameId: randomUUID(), sentAt: new Date().toISOString(), reason: 'owner' });
    await waitFor(async () => !(await service.local.getState()).linked, { label: 'сброс credential' });

    const state = await service.local.getState();
    assert.equal(state.connection, 'error');
    assert.match(state.error, /отозвано/);
    assert.ok(!(await readdir(harness.directory)).includes('credential.json'), 'the credential file is gone');

    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(relay.sockets.length, 1, 'a revoked bridge does not knock on the door again');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a rejected credential stops the loop instead of looking like brute force', async () => {
  const relay = await startRelay({ onSocket(socket) {
    socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'n' });
    socket.on('frame', frame => { if (frame?.type === 'hello') socket.close(CLOSE.unauthorized, 'bad credential'); });
  } });
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await relay.waitForSocket(1);
    await waitFor(async () => (await service.local.getState()).connection === 'error', { label: 'ошибка авторизации' });
    assert.match((await service.local.getState()).error, /не принял эту установку/);
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(relay.sockets.length, 1, 'no retry ladder after a refused credential');
    assert.equal((await service.local.getState()).linked, true, 'the credential is kept so the owner can decide');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('an unreachable server is retried, and the backoff starts over after a success', async () => {
  const relay = await startRelay();
  const port = relay.port;
  await relay.stop();                      // nothing is listening yet
  const harness = await makeHarness({ relayUrl: `ws://127.0.0.1:${port}` });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await waitFor(async () => (await service.local.getState()).connection === 'connecting', { label: 'попытка подключения' });
    const revived = await startRelay();    // a different port, so just assert the state stayed sane
    assert.equal((await service.local.getState()).connection, 'connecting');
    assert.equal((await service.local.getState()).error, null, 'a server that is simply down is not an error to act on');
    await revived.stop();
  } finally {
    await service.stop();
  }
});

test('damaged settings fail closed: no connection at all, and a message for the computer', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, record: '{ это не json' });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(relay.sockets.length, 0, 'nothing is published while storage is unusable');
    const state = await service.local.getState();
    assert.equal(state.connection, 'error');
    assert.match(state.error, /повреждены|не читается/);
    await assert.rejects(() => service.local.setEnabled(true), /Не удалось сохранить|повреждены/);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('without working encryption nothing connects and pairing is refused up front', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, credential: true, available: false });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(relay.sockets.length, 0);
    const state = await service.local.getState();
    assert.equal(state.linked, false, 'an unreadable credential is not treated as a working one');
    assert.match(state.error, /Шифрование недоступно/);
    await assert.rejects(() => service.local.startPairing(), /Шифрование недоступно/);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('pairing issues no credential until the owner sees the Telegram name and confirms', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, credential: false });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(relay.sockets.length, 0, 'without a credential nothing is attempted on its own');

    await service.local.startPairing();
    const socket = await relay.waitForSocket(1);
    socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'n' });
    const start = await socket.next('pair_start');

    const pairingState = await waitFor(async () => {
      const value = await service.local.getState();
      return value.pairing ? value : null;
    }, { label: 'состояние привязки' });
    const code = pairingState.pairing.code;
    assert.ok(Buffer.from(code, 'base64url').length >= 16, 'the code carries at least 128 bits');
    assert.ok(!start.nonceHash.includes(code), 'the server is given the hash, never the code');
    assert.ok(!socket.frames.some(entry => entry.raw.includes(code)), 'the code itself has not been sent anywhere yet');

    // The installation's identity is born on this computer: only the public half is offered.
    assert.ok(start.publicKey, 'pair_start carries the public key');
    const offered = Buffer.from(start.publicKey, 'base64url');
    assert.equal(offered.length, 44, 'an Ed25519 SPKI DER public key');
    assert.equal(createPublicKey({ key: offered, format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');

    socket.send({ protocol: 2, type: 'pair_pending', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, expiresAt: new Date(Date.now() + 600_000).toISOString(), attemptLimit: 5, botUsername: 'kuzmich_bot' });
    await waitFor(async () => (await service.local.getState()).pairing?.link, { label: 'ссылка для QR' });
    assert.equal((await service.local.getState()).pairing.link, `https://t.me/kuzmich_bot?startapp=${code}`);

    // A credential offered before the owner confirmed must not be accepted.
    socket.send({ protocol: 2, type: 'pair_complete', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, installationId: INSTALLATION, owner: OWNER });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await service.local.getState()).linked, false, 'an unconfirmed credential is rejected');

    const second = await relay.waitForSocket(2, { timeoutMs: 1500 }).catch(() => null);
    assert.equal(second, null, 'the unconfirmed attempt does not silently continue');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a confirmed pairing names the exact claimant, saves the credential and connects', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, credential: false });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await service.local.startPairing();
    const socket = await relay.waitForSocket(1);
    socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'n' });
    const start = await socket.next('pair_start');
    socket.send({ protocol: 2, type: 'pair_pending', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, botUsername: 'kuzmich_bot' });
    await waitFor(async () => (await service.local.getState()).pairing?.link, { label: 'ожидание заявки' });

    await assert.rejects(() => service.local.confirmPairing(), /Пока никто не запросил/);

    socket.send({ protocol: 2, type: 'pair_claimed', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, claimant: { telegramUserId: '12345678', displayName: 'Иван', username: 'ivan' }, confirmExpiresAt: new Date(Date.now() + 300_000).toISOString() });
    const claimed = await waitFor(async () => (await service.local.getState()).pairing?.claimant, { label: 'имя заявителя' });
    assert.deepEqual(claimed, { telegramUserId: '12345678', displayName: 'Иван', username: 'ivan' });

    await service.local.confirmPairing();
    const confirm = await socket.next('pair_confirm');
    assert.equal(confirm.claimantUserId, '12345678', 'the confirmation names the user the owner actually saw');
    assert.equal(confirm.nonce, (await service.local.getState()).pairing.code);

    // Since 2.1 the server hands back no secret at all — it already has the public key.
    socket.send({ protocol: 2, type: 'pair_complete', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, installationId: INSTALLATION, owner: OWNER, issuedAt: new Date().toISOString() });

    // The decisive check: the next connection is verified with exactly the key the relay was
    // given during pairing. A hash-only server can do this; it could not do the old HMAC.
    const working = await relay.waitForSocket(2, { timeoutMs: 8000 });
    const hello = await accept(working, { nonce: 'n2', publicKey: start.publicKey });
    assert.equal(hello.installationId, INSTALLATION);
    assert.ok(hello.resume.epoch > 5, 'a new credential starts a new epoch');
    assert.equal(hello.resume.revision, 0);

    const state = await service.local.getState();
    assert.equal(state.linked, true);
    assert.deepEqual(state.owner, OWNER);
    assert.equal(state.pairing, null);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('the name typed during pairing is what the server is told and what is stored', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, credential: false });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await service.local.startPairing('  Кабинет\nдома  ');
    const socket = await relay.waitForSocket(1);
    socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'n' });
    const start = await socket.next('pair_start');
    assert.deepEqual(start.installation, { label: 'Кабинет дома' }, 'control characters are stripped, the name is the owner\'s');

    socket.send({ protocol: 2, type: 'pair_pending', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, botUsername: 'kuzmich_bot' });
    await waitFor(async () => (await service.local.getState()).pairing?.link, { label: 'ожидание заявки' });
    socket.send({ protocol: 2, type: 'pair_claimed', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, claimant: { telegramUserId: '12345678', displayName: 'Иван' } });
    await waitFor(async () => (await service.local.getState()).pairing?.claimant, { label: 'имя заявителя' });
    await service.local.confirmPairing();
    await socket.next('pair_confirm');
    socket.send({ protocol: 2, type: 'pair_complete', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, installationId: INSTALLATION, owner: OWNER });

    const working = await relay.waitForSocket(2, { timeoutMs: 8000 });
    const hello = await accept(working, { nonce: 'n2', publicKey: start.publicKey });
    assert.deepEqual(hello.installation, { label: 'Кабинет дома' }, 'the chosen name survives into the working connection');
    assert.equal((await service.local.getState()).label, 'Кабинет дома');

    // An empty name falls back to the default rather than publishing the computer's own name.
    assert.equal((await service.local.unlink()).label, 'Кабинет дома', 'unlinking does not rename anything');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a credential that cannot be stored is handed back to the server instead of being lost', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url, credential: false });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await service.local.startPairing();
    const socket = await relay.waitForSocket(1);
    socket.send({ protocol: 2, type: 'challenge', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'n' });
    const start = await socket.next('pair_start');
    socket.send({ protocol: 2, type: 'pair_pending', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, botUsername: 'kuzmich_bot' });
    await waitFor(async () => (await service.local.getState()).pairing?.link, { label: 'ожидание заявки' });
    socket.send({ protocol: 2, type: 'pair_claimed', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, claimant: { telegramUserId: '12345678', displayName: 'Иван' } });
    await waitFor(async () => (await service.local.getState()).pairing?.claimant, { label: 'имя заявителя' });
    await service.local.confirmPairing();
    await socket.next('pair_confirm');

    harness.safeStorage.available = false;   // encryption disappears right before the write
    socket.send({ protocol: 2, type: 'pair_complete', frameId: randomUUID(), sentAt: new Date().toISOString(), pairingId: start.pairingId, installationId: INSTALLATION, owner: OWNER });

    const unpair = await socket.next('unpair');
    assert.equal(unpair.reason, 'storage_failed', 'the server is told to drop what the computer cannot keep');
    assert.equal((await service.local.getState()).linked, false);
    assert.ok(!(await readdir(harness.directory)).includes('credential.json'));
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('unlinking works without the server and does not wait for its answer', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    const state = await service.local.unlink();
    assert.equal(state.linked, false);
    assert.equal(state.connection, 'unconfigured');
    assert.ok(!(await readdir(harness.directory)).includes('credential.json'));
    assert.deepEqual(socket.sent('unpair').map(frame => frame.reason), ['owner'], 'the server is told, but the answer is not awaited');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(relay.sockets.length, 1, 'an unlinked bridge does not reconnect');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('turning the connection off stops it, and the stored credential and settings survive', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    const off = await service.local.setEnabled(false);
    assert.equal(off.connection, 'disabled');
    assert.equal(off.linked, true, 'switching off is not unlinking');
    await waitFor(() => socket.closed || socket.closeCode !== null, { label: 'закрытие сокета' });

    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(relay.sockets.length, 1);

    const on = await service.local.setEnabled(true);
    assert.equal(on.enabled, true);
    const again = await relay.waitForSocket(2, { timeoutMs: 8000 });
    await accept(again, { nonce: 'n3' });
    await again.next('snapshot');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('nothing secret, no path and no answer text ever reaches the wire', async () => {
  const relay = await startRelay();
  const thread = allowedThread({ grantId: 'grant-a', title: 'Беседа', provider: 'claude' });
  const remote = fixtureRemote([thread]);
  remote.states.set('grant-a', idleState({ phase: 'blocked', blockers: ['approval'], activeTurnId: 'turn-A', requiresComputer: true }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    remote.states.set('grant-a', idleState({ phase: 'running' }));
    remote.notify();
    await socket.next('event');

    const wire = socket.frames.map(entry => entry.raw).join('\n');
    for (const forbidden of [KEYS.privateKey, SALT, ANSWER, CWD, 'claude:grant-a', 'approval', 'turn-A', 'grant-a', 'runtimeId', 'projectKey', 'sessionId']) {
      assert.ok(!wire.includes(forbidden), `«${forbidden}» не должно уходить на сервер`);
    }
    assert.ok(wire.includes(tabIdFor(SALT, 'grant-a')), 'only the derived address is used');

    // The bridge must never pull an answer or an event body from the core.
    assert.ok(!remote.calls.includes('getLastAnswer'), 'the bridge does not read answers');
    assert.ok(!remote.calls.includes('readEvent'), 'a subscription notice is a signal, never content');
    assert.ok(!remote.calls.includes('execute'));

    // Every outgoing frame is one of the kinds the contract allows.
    const kinds = new Set(socket.frames.map(entry => entry.frame?.type));
    for (const kind of kinds) assert.ok(['hello', 'snapshot', 'event', 'pong', 'command_result', 'unpair', 'pair_start', 'pair_confirm', 'pair_cancel'].includes(kind), `неизвестный исходящий фрейм ${kind}`);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('the heartbeat is answered, and an unknown frame is ignored instead of breaking the link', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([]);
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    socket.send({ protocol: 2, type: 'ping', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'beat-1' });
    const pong = await socket.next('pong');
    assert.equal(pong.nonce, 'beat-1');

    // A server that ships ahead of the desktop must not take the connection down.
    socket.send({ protocol: 2, type: 'something_new_in_2_1', frameId: randomUUID(), sentAt: new Date().toISOString(), payload: { a: 1 } });
    socket.send({ protocol: 2, type: 'ping', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'beat-2' });
    assert.equal((await socket.next('pong')).nonce, 'beat-2');
    assert.equal(socket.closed, false);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a binary frame is a protocol error, and another major version stops the bridge', async () => {
  const relay = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    await first.next('snapshot');

    // The contract is JSON text frames only; anything else is not something to guess about.
    first.sendBinary();
    await waitFor(() => first.closeCode !== null, { label: 'закрытие при двоичном фрейме' });
    assert.equal(first.closeCode, CLOSE.protocol);

    // A protocol error is retried, unlike a version refusal.
    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    await accept(second, { nonce: 'n2' });
    await second.next('snapshot');

    second.send({ protocol: 3, type: 'welcome', frameId: randomUUID(), sentAt: new Date().toISOString() });
    await waitFor(() => second.closeCode !== null, { label: 'закрытие при чужой версии' });
    assert.equal(second.closeCode, CLOSE.version);
    await waitFor(async () => (await service.local.getState()).connection === 'error', { label: 'сообщение о версии' });
    assert.match((await service.local.getState()).error, /более новую версию протокола/);

    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(relay.sockets.length, 2, 'an unsupported major is not retried');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a malformed, unaddressable or expired command is refused without ever reaching the core', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    sendCommand(socket, { commandId: 'c1', tabId: 't_unknown', action: 'send', text: 'x' });
    assert.equal((await socket.next('command_result')).detail.code, 'unknown_tab');

    // Slash commands are the bot's business, never the agent's — the v1 rule, kept on this wire.
    sendCommand(socket, { commandId: 'c2', tabId, action: 'send', text: '/compact' });
    assert.equal((await socket.next('command_result')).detail.code, 'invalid_command');

    sendCommand(socket, { commandId: 'c3', tabId, action: 'stop' });
    assert.equal((await socket.next('command_result')).detail.code, 'invalid_command', 'a stop must name the turn it means');

    sendCommand(socket, { commandId: 'c4', tabId, action: 'send', text: 'x', deadline: new Date(Date.now() - 60_000).toISOString() });
    const expired = await socket.next('command_result');
    assert.equal(expired.detail.code, 'expired');
    assert.equal(expired.status, 'rejected');

    assert.deepEqual(remote.executeCalls, [], 'none of these reached the core');
    const record = JSON.parse(await readFile(path.join(harness.directory, 'bridge.json'), 'utf8'));
    assert.deepEqual(record.commands, [], 'a command that was never admitted leaves no journal entry');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('the same commandId twice is sent to the core once and answered from the ledger', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    sendCommand(socket, { commandId: 'cmd-1', tabId, action: 'send', text: 'Проверь сборку' });
    const first = await socket.next('command_result');
    assert.equal(first.status, 'queued');
    assert.equal(first.outcome, null);
    assert.equal(first.payload, null, 'a side-effecting command carries no payload');

    const requestId = `ma:u_7f3a:${INSTALLATION}:cmd-1`;
    assert.deepEqual(remote.executeCalls.map(call => call.requestId), [requestId], 'the namespace the plan fixed');

    // The relay delivers at least once: the very same command may arrive again.
    sendCommand(socket, { commandId: 'cmd-1', tabId, action: 'send', text: 'Проверь сборку' });
    const second = await socket.next('command_result');
    assert.equal(second.status, 'queued', 'the answer comes from the existing operation');
    assert.equal(remote.executeCalls.length, 1, 'the core was asked to do it exactly once');
    assert.ok(remote.calls.includes('getOperation'), 'the repeat was reconciled read-only');

    // The same id reused for a different action is a conflict, not a second interpretation.
    sendCommand(socket, { commandId: 'cmd-1', tabId, action: 'stop', expectedTurnId: 'turn-A' });
    assert.equal((await socket.next('command_result')).detail.code, 'request_conflict');
    assert.equal(remote.executeCalls.length, 1);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a command admitted before the computer was interrupted is reconciled, then sent once', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const requestId = `ma:u_7f3a:${INSTALLATION}:cmd-9`;
  // Exactly the window the contract worries about: the journal entry landed, the call did not.
  const harness = await makeHarness({
    relayUrl: relay.url,
    record: JSON.stringify({
      version: 1, enabled: true, relayUrl: relay.url, label: 'Рабочий ПК', epoch: 4,
      commands: [{ commandId: 'cmd-9', requestId, tabId: tabIdFor(SALT, 'grant-a'), action: 'send', at: Date.now() }],
    }),
  });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');

    sendCommand(socket, { commandId: 'cmd-9', tabId: tabIdFor(SALT, 'grant-a'), action: 'send', text: 'Проверь сборку' });
    const answered = await socket.next('command_result');
    assert.equal(answered.status, 'queued');

    assert.equal(remote.executeCalls.length, 1, 'proven absence is the only reason to send');
    assert.ok(remote.calls.indexOf('getOperation') < remote.calls.indexOf('execute'), 'the core was asked before it was told');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a confident refusal is reported as one, an unknown outcome never is', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    // The core proved it did not admit the command: a refusal is honest here.
    remote.executeResult = () => ({ ok: false, error: { code: 'blocked', message: 'Беседа занята.', requiresComputer: false, reason: 'busy' } });
    sendCommand(socket, { commandId: 'r1', tabId, action: 'send', text: 'Первая' });
    const refused = await socket.next('command_result');
    assert.equal(refused.status, 'rejected');
    assert.deepEqual(refused.detail, { code: 'blocked', message: 'Беседа занята.', requiresComputer: false });
    assert.ok(!JSON.stringify(refused).includes('busy'), 'the blocker behind the refusal stays on this computer');

    // The call threw after it may already have reached the agent. Not a refusal, not a retry.
    remote.executeResult = () => { throw new Error('socket closed mid-call'); };
    sendCommand(socket, { commandId: 'r2', tabId, action: 'send', text: 'Вторая' });
    const unknown = await socket.next('command_result');
    assert.equal(unknown.status, 'uncertain');
    assert.equal(unknown.detail.code, 'uncertain_delivery');
    assert.equal(unknown.detail.requiresComputer, true);
    assert.ok(!JSON.stringify(unknown).includes('socket closed'), 'the raw failure is not forwarded');

    // And an operation the core itself calls uncertain keeps that name on the wire.
    remote.executeResult = command => ({ ok: true, value: remote.admit(command, 'uncertain') });
    sendCommand(socket, { commandId: 'r3', tabId, action: 'send', text: 'Третья' });
    assert.equal((await socket.next('command_result')).status, 'uncertain');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a stop names the turn the phone saw, and a stale one does not stop the newer turn', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-B', actions: { send: false, enqueue: true, steer: false, stop: true } }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    // The phone still believes turn-A is running; the core refuses to touch turn-B.
    remote.executeResult = command => ({
      ok: true,
      value: { ...remote.admit(command, 'stale'), error: { code: 'stale_turn', message: 'Этот ход уже закончился.', requiresComputer: false } },
    });
    sendCommand(socket, { commandId: 's1', tabId, action: 'stop', expectedTurnId: 'turn-A' });
    const stale = await socket.next('command_result');
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.detail.code, 'stale_turn');
    assert.deepEqual(remote.executeCalls.map(call => [call.kind, call.expectedTurnId]), [['stop', 'turn-A']],
      'the expected turn is passed through untouched, never replaced by the current one');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('reading actions answer with exactly the allowed fields and re-check the permission first', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-A', queue: { count: 3, limit: 50, paused: true }, blockers: ['busy', 'approval'], requiresComputer: true, actions: { send: false, enqueue: true, steer: true, stop: true } }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    sendCommand(socket, { commandId: 'q1', tabId, action: 'get_state' });
    const stateResult = await socket.next('command_result');
    assert.equal(stateResult.status, 'executed');
    assert.equal(stateResult.outcome, 'succeeded');
    assert.deepEqual(stateResult.payload.state, {
      tabId, title: 'Беседа', agent: 'codex', project: 'CodexDesk', status: 'running',
      queueLength: 3, queuePaused: true, updatedAt: '2026-10-14T10:00:00.000Z',
      activeTurnId: 'turn-A', actions: { send: false, stop: true },
    });
    assert.ok(!JSON.stringify(stateResult).includes('approval'), 'why it is blocked is not part of the answer');
    assert.ok(!JSON.stringify(stateResult).includes('steer'), 'only the two actions this wire has');

    sendCommand(socket, { commandId: 'q2', tabId, action: 'get_last_answer' });
    const answerResult = await socket.next('command_result');
    assert.deepEqual(answerResult.payload.answer, {
      answerId: 'ans-1', turnId: 'turn-A', text: ANSWER, truncated: false, completedAt: '2026-10-14T10:02:00.000Z',
    });

    // A very long answer is cut to the contract's limit and says so.
    remote.answer = { answerId: 'ans-2', turnId: 'turn-A', text: 'я'.repeat(100_010), completedAt: null, truncated: false };
    sendCommand(socket, { commandId: 'q3', tabId, action: 'get_last_answer' });
    const long = await socket.next('command_result');
    assert.equal(long.payload.answer.text.length, 100_000);
    assert.equal(long.payload.answer.truncated, true);

    // Neither read is an operation: nothing was admitted and nothing is journalled.
    assert.deepEqual(remote.executeCalls, []);
    const record = JSON.parse(await readFile(path.join(harness.directory, 'bridge.json'), 'utf8'));
    assert.deepEqual(record.commands, []);
    assert.equal(remote.calls.filter(call => call === 'listThreads').length >= 4, true, 'every command re-resolved the address against the core');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a permission revoked between the snapshot and the command stops it before the core', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Увольнение Петрова' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    // The owner switches the conversation off. The phone's address is now a few seconds old.
    remote.threads = [];
    sendCommand(socket, { commandId: 'late-1', tabId, action: 'send', text: 'Проверь сборку' });
    const refused = await socket.next('command_result');
    assert.equal(refused.detail.code, 'unknown_tab');
    assert.equal(refused.detail.requiresComputer, true);
    assert.ok(!JSON.stringify(refused).includes('Петров'), 'a refusal does not confirm the title of a conversation that is no longer allowed');

    assert.deepEqual(remote.executeCalls, [], 'the core was not asked');
    sendCommand(socket, { commandId: 'late-2', tabId, action: 'get_last_answer' });
    assert.equal((await socket.next('command_result')).detail.code, 'unknown_tab');
    assert.ok(!remote.calls.includes('getLastAnswer'), 'no content is read for a revoked conversation');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('the journal outlives a restart, so a redelivered command is not executed twice', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const tabId = tabIdFor(SALT, 'grant-a');

  const first = makeService({ ...harness, remote });
  try {
    await first.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    sendCommand(socket, { commandId: 'keep-1', tabId, action: 'send', text: 'Проверь сборку' });
    assert.equal((await socket.next('command_result')).status, 'queued');
  } finally { await first.stop(); }

  const record = JSON.parse(await readFile(path.join(harness.directory, 'bridge.json'), 'utf8'));
  assert.deepEqual(record.commands.map(entry => entry.commandId), ['keep-1']);
  assert.equal(record.commands[0].requestId, `ma:u_7f3a:${INSTALLATION}:keep-1`);

  const second = makeService({ ...harness, remote });
  try {
    await second.start();
    const socket = await relay.waitForSocket(2, { timeoutMs: 8000 });
    await accept(socket, { nonce: 'n2' });
    await socket.next('snapshot');

    sendCommand(socket, { commandId: 'keep-1', tabId, action: 'send', text: 'Проверь сборку' });
    assert.equal((await socket.next('command_result')).status, 'queued');
    assert.equal(remote.executeCalls.length, 1, 'the record from the previous run still protects the agent');
  } finally {
    await second.stop();
    await relay.stop();
  }
});

test('a command that moves on is announced, and the announcement can carry no text', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');
    const requestId = `ma:u_7f3a:${INSTALLATION}:live-1`;

    sendCommand(socket, { commandId: 'live-1', tabId, action: 'send', text: 'Проверь сборку' });
    assert.equal((await socket.next('command_result')).status, 'queued');

    remote.advance(requestId, { phase: 'accepted' });
    const accepted = await socket.next('event');
    assert.deepEqual(accepted.event, { kind: 'command_updated', commandId: 'live-1', tabId, at: accepted.event.at, status: 'accepted', outcome: null, detail: null });

    remote.advance(requestId, { phase: 'completed', outcome: 'succeeded' });
    const done = await socket.next('event');
    assert.equal(done.event.status, 'executed');
    assert.equal(done.event.outcome, 'succeeded');
    assert.ok(done.revision > accepted.revision, 'command updates share the one revision counter');
    assert.ok(!('payload' in done.event), 'an event has no slot for an answer at all');

    // A finished command stops being asked about, so nothing else is announced for it.
    const before = remote.calls.filter(call => call === 'getOperation').length;
    remote.notify();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(remote.calls.filter(call => call === 'getOperation').length, before, 'a terminal command is no longer watched');
    assert.ok(!remote.calls.includes('readEvent'), 'the follow-up never reads an event body, which could hold the answer');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('neither the command text nor the answer reaches storage or the state shown on the computer', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });
  const SECRET = 'Выложи ключи в открытый репозиторий';

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    sendCommand(socket, { commandId: 'p1', tabId, action: 'send', text: SECRET });
    await socket.next('command_result');
    sendCommand(socket, { commandId: 'p2', tabId, action: 'get_last_answer' });
    await socket.next('command_result');

    const record = await readFile(path.join(harness.directory, 'bridge.json'), 'utf8');
    assert.ok(record.includes('p1'), 'the identifier is remembered');
    assert.ok(!record.includes(SECRET), 'the command text is not');
    assert.ok(!record.includes(ANSWER), 'and neither is the answer');

    // `getState` is everything that leaves the main process for the window and the diagnostics.
    const shown = JSON.stringify(await service.local.getState());
    for (const forbidden of [SECRET, ANSWER, KEYS.privateKey, SALT, 'grant-a']) {
      assert.ok(!shown.includes(forbidden), `«${forbidden}» не должно попадать в состояние на ПК`);
    }

    // On the wire the answer exists once, in the reply the phone asked for, and nowhere else.
    const payloads = socket.frames.filter(entry => entry.raw.includes(ANSWER));
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].frame.type, 'command_result');
    assert.ok(!socket.frames.some(entry => entry.raw.includes(SECRET)), 'the command text is never echoed back');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

// ------------------------------------------------- stage 4: notices and real interruptions

/** Waits for an `event` frame of a given kind, including ones already received. */
async function nextEvent(socket, kind, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = socket.frames.find(entry => entry.frame?.type === 'event' && entry.frame.event?.kind === kind && !entry.takenEvent);
    if (found) { found.takenEvent = true; return found.frame; }
    if (Date.now() > deadline) throw new Error(`Событие ${kind} не пришло за ${timeoutMs} мс`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const notices = socket => socket.sent('event').filter(frame => frame.event?.kind === 'notice').map(frame => frame.event);

test('a finished turn and a turn waiting for this computer are each announced exactly once', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Сборка релиза' })]);
  remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-A' }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote });

  try {
    await service.start();
    const socket = await relay.waitForSocket(1);
    await accept(socket);
    await socket.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');
    assert.deepEqual(notices(socket), [], 'the snapshot is a baseline, not a burst of pushes');

    // The turn ends. The phone is told which turn, and nothing about how it went.
    remote.states.set('grant-a', idleState({ phase: 'idle' }));
    remote.notify();
    const done = await nextEvent(socket, 'notice');
    assert.deepEqual(done.event, { kind: 'notice', tabId, noticeKind: 'turn_completed', turnId: 'turn-A', occurredAt: done.event.occurredAt });
    assert.ok(done.revision > 1, 'notices share the one revision counter with the tab updates');

    // Repeating the same state is not a second event.
    remote.notify();
    service.refresh();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(notices(socket).length, 1, 'одно событие — одно уведомление');

    // A new turn starts and then stops for an approval: that needs a person at this computer.
    remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-B' }));
    remote.notify();
    await nextEvent(socket, 'tab_updated');
    remote.states.set('grant-a', idleState({ phase: 'blocked', activeTurnId: 'turn-B', blockers: ['approval'], requiresComputer: true }));
    remote.notify();
    const waiting = await nextEvent(socket, 'notice');
    assert.deepEqual(waiting.event.noticeKind, 'action_required');
    assert.equal(waiting.event.turnId, 'turn-B');

    // Still blocked is not news again, and the reason never leaves this computer.
    remote.notify();
    service.refresh();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(notices(socket).length, 2, 'состояние повторяется, событие — нет');
    const wire = socket.frames.map(entry => entry.raw).join('\n');
    assert.ok(!wire.includes('approval'), 'почему именно заблокировано — остаётся на ПК');
    assert.ok(!wire.includes('grant-a'), 'уведомление адресуется производным tabId');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a notice exists only for an allowed conversation, and a reconnect replays none of them', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState({ phase: 'running', activeTurnId: 'turn-A' }));
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote, backoffLadder: [100] });

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    const before = await first.next('snapshot');

    // The permission is revoked while a turn is running. The tab goes, and nothing is announced
    // about it afterwards — a conversation with no address cannot be the subject of a notice.
    remote.threads = [];
    remote.states.delete('grant-a');
    service.refresh();
    await nextEvent(first, 'tab_removed');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(notices(first), [], 'у отозванной беседы уведомлений нет');

    // The turn finishes while the link is down. After the reconnect the snapshot says what the
    // state is; it does not become a push about something the owner was never told about.
    remote.threads = [allowedThread({ grantId: 'grant-b', title: 'Другая' })];
    remote.states.set('grant-b', idleState({ phase: 'running', activeTurnId: 'turn-C' }));
    service.refresh();
    await nextEvent(first, 'tab_updated');

    first.destroy();
    remote.states.set('grant-b', idleState({ phase: 'idle' }));
    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    await accept(second, { nonce: 'n2' });
    const after = await second.next('snapshot');
    assert.ok(after.revision > before.revision, 'ревизия продолжается, а не начинается заново');
    assert.deepEqual(after.tabs.map(tab => tab.status), ['idle']);

    remote.notify();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(notices(second), [], 'после переподключения старое не перепосылается');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a socket cut in the middle of a snapshot delivers no half of it, and the resync outranks it', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const held = gate();
  remote.hold = held.promise;
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote, backoffLadder: [100] });

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    // The bridge is inside `collectTabs` now: the snapshot is being built and not yet sent.
    await waitFor(async () => remote.calls.includes('listThreads'), { label: 'сбор вкладок начался' });
    first.destroy();
    remote.hold = null;
    held.open();

    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    const hello = await accept(second, { nonce: 'n2' });
    const snapshot = await second.next('snapshot');

    assert.equal(first.sent('snapshot').length, 0, 'недособранный snapshot не ушёл половиной');
    // The frame may well have been handed to a socket that was already dead, and then its revision
    // is spent on nothing. That is allowed and the relay cannot even notice: the rule is "strictly
    // greater", not "the next one" — a hole in the numbering is not a lost frame.
    assert.ok(snapshot.revision > hello.resume.revision, 'snapshot после обрыва старше всего, что мост считал отправленным');
    assert.equal(snapshot.epoch, 5, 'обрыв — не перезапуск службы, epoch прежний');
    assert.deepEqual(snapshot.tabs.map(tab => tab.title), ['Беседа']);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a socket cut in the middle of an execution leaves one execution after the redelivery', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote, backoffLadder: [100] });
  const requestId = `ma:u_7f3a:${INSTALLATION}:cut-1`;

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    await first.next('snapshot');
    const tabId = tabIdFor(SALT, 'grant-a');

    // The core has the command and has not answered yet — the exact window the contract worries
    // about, because the relay delivers at least once and will deliver this one again.
    const held = gate();
    remote.executeResult = command => held.promise.then(() => ({ ok: true, value: remote.admit(command, 'queued') }));
    sendCommand(first, { commandId: 'cut-1', tabId, action: 'send', text: 'Проверь сборку' });
    await waitFor(async () => remote.executeCalls.length === 1, { label: 'вызов ядра' });

    first.destroy();
    held.open();
    await waitFor(async () => remote.operations.has(requestId), { label: 'операция в ядре' });
    assert.equal(first.sent('command_result').length, 0, 'ответ на оборванный сокет не ушёл');

    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    await accept(second, { nonce: 'n2' });
    await second.next('snapshot');

    const beforeRead = remote.calls.filter(call => call === 'getOperation').length;
    sendCommand(second, { commandId: 'cut-1', tabId, action: 'send', text: 'Проверь сборку' });
    const answered = await second.next('command_result');

    assert.equal(answered.status, 'queued', 'ответ собран из существующей операции');
    assert.equal(remote.executeCalls.length, 1, 'две доставки — одно исполнение');
    assert.ok(remote.calls.filter(call => call === 'getOperation').length > beforeRead, 'повтор сверен read-only, а не отправлен наудачу');
    assert.deepEqual(remote.executeCalls.map(call => call.requestId), [requestId]);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a relay that goes silent is declared dead and the bridge comes back on its own', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  // The contract's deadline is 2 × heartbeat + 10 s; the rule itself is checked in the protocol
  // test, and here the same code path runs against a real socket on a short leash.
  const service = makeService({ ...harness, remote, livenessMs: 500, backoffLadder: [100] });

  try {
    await service.start();
    const first = await relay.waitForSocket(1);
    await accept(first);
    const before = await first.next('snapshot');

    // A ping keeps it alive: the watchdog is reset by any frame, and the pong proves we answered.
    first.send({ protocol: 2, type: 'ping', frameId: randomUUID(), sentAt: new Date().toISOString(), nonce: 'beat' });
    assert.equal((await first.next('pong')).nonce, 'beat');

    // Then the relay says nothing at all. A half-open socket must not look alive forever.
    const second = await relay.waitForSocket(2, { timeoutMs: 8000 });
    assert.equal(first.closeCode, CLOSE.normal, 'молчащий сокет закрывает сам мост');
    const hello = await accept(second, { nonce: 'n2' });
    assert.equal(hello.resume.epoch, before.epoch, 'потеря heartbeat — не перезапуск службы');
    const after = await second.next('snapshot');
    assert.ok(after.revision > before.revision);
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a series of fast reconnects climbs the backoff ladder and never rewinds the revision', async () => {
  const relay = await startRelay();
  const remote = fixtureRemote([allowedThread({ grantId: 'grant-a', title: 'Беседа' })]);
  remote.states.set('grant-a', idleState());
  const harness = await makeHarness({ relayUrl: relay.url });
  const ladder = [200, 500, 900];
  const service = makeService({ ...harness, remote, backoffLadder: ladder });

  try {
    await service.start();
    const revisions = [];
    const gaps = [];
    let socket = await relay.waitForSocket(1);
    await accept(socket);
    revisions.push((await socket.next('snapshot')).revision);

    for (let attempt = 0; attempt < 3; attempt++) {
      const cutAt = Date.now();
      socket.destroy();
      socket = await relay.waitForSocket(attempt + 2, { timeoutMs: 10_000 });
      gaps.push(Date.now() - cutAt);
      const hello = await accept(socket, { nonce: `n${attempt}` });
      assert.equal(hello.resume.epoch, 5, 'epoch растёт только при перезапуске службы, не при обрыве');
      assert.equal(hello.resume.revision, revisions.at(-1), 'мост помнит, до чего досчитал');
      revisions.push((await socket.next('snapshot')).revision);
    }

    // The regression this guards: a reconnect used to restart the counter at 1, and the relay —
    // which applies only a strictly greater pair — would have dropped the very snapshot the
    // reconnect was for.
    for (let index = 1; index < revisions.length; index++) {
      assert.ok(revisions[index] > revisions[index - 1], `ревизия ${revisions[index]} не выше ${revisions[index - 1]}`);
    }

    // A successful `welcome` resets the ladder, so three quick drops each wait the first rung —
    // spread by its jitter and never skipped. Timer slack is one-sided, hence the generous ceiling.
    for (const gap of gaps) {
      assert.ok(gap >= ladder[0] * 0.8 - 60, `пауза ${gap} мс короче первой ступени ${ladder[0]} мс`);
      assert.ok(gap <= ladder[0] * 1.2 + 1500, `пауза ${gap} мс не похожа на первую ступень: лестница не сброшена успехом`);
    }

    // Now the relay drops every connection before it says a word. Nothing succeeds, nothing resets
    // the ladder, and it climbs instead of hammering a server that is already in trouble.
    const climbing = [];
    let index = relay.sockets.length;
    let from = Date.now();
    socket.destroy();
    for (const rung of ladder) {
      const refused = await relay.waitForSocket(++index, { timeoutMs: 10_000 });
      climbing.push({ rung, waited: Date.now() - from });
      refused.close(CLOSE.shutdown, 'сервер останавливается');
      from = Date.now();
    }
    for (const { rung, waited } of climbing) {
      assert.ok(waited >= rung * 0.8 - 60, `пауза ${waited} мс короче ступени ${rung} мс`);
    }
    assert.ok(climbing.at(-1).waited > climbing[0].waited, 'лестница растёт, а не долбит сервер с одной задержкой');
  } finally {
    await service.stop();
    await relay.stop();
  }
});

test('a credential issued for another server is not reused when the address changes', async () => {
  const relay = await startRelay();
  const other = await startRelay();
  const harness = await makeHarness({ relayUrl: relay.url });
  const service = makeService({ ...harness, remote: fixtureRemote([]) });

  try {
    await service.start();
    await accept(await relay.waitForSocket(1));
    await waitFor(async () => (await service.local.getState()).connection === 'online', { label: 'подключение' });

    await assert.rejects(() => service.local.setRelayUrl(other.url), /отвяжите установку от прежнего сервера/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(other.sockets.length, 0, 'the old identity is never offered to a new server');
  } finally {
    await service.stop();
    await relay.stop();
    await other.stop();
  }
});
