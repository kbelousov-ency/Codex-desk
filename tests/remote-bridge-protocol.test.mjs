import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomUUID, verify } from 'node:crypto';

import {
  BACKOFF_MS, BRIDGE_PROTOCOL, CLOSE, LIMITS, NOTICE_KINDS, PROTOCOL, ProtocolError, SUBPROTOCOL,
  backoffDelay, buildRequestId, cleanLabel, commandAnswer, commandDetail, commandState, compareSequence,
  createInstallationKeys, createNonce, createTabSalt,
  deviceProof, encodeFrame, endpointFor, events, isTerminalPhase, livenessDeadlineMs, nonceHash, outgoing, parseFrame, readCommand,
  readPairClaimed, readPairComplete, readPairPending, readWelcome, sameTab, statusForPhase,
  tabIdFor, tabSummary, validateRelayUrl, verifyDeviceProof,
} from '../electron/remote-bridge/protocol.mjs';
import { diffNotices, diffTabs, resolveTab, turnSignal } from '../electron/remote-bridge/publisher.mjs';

const KEYS = createInstallationKeys();
const SALT = Buffer.alloc(32, 9).toString('base64url');
const INSTALLATION = '11111111-2222-4333-8444-555555555555';

test('relay address accepts wss, allows ws only on this computer and refuses secrets in the URL', () => {
  assert.equal(validateRelayUrl(' wss://relay.example.com/ '), 'https://relay.example.com'.replace('https', 'wss'));
  assert.equal(validateRelayUrl('ws://localhost:8080'), 'ws://localhost:8080');

  assert.throws(() => validateRelayUrl('ws://relay.example.com'), /только для этого же компьютера/);
  assert.throws(() => validateRelayUrl('https://relay.example.com'), /wss:\/\//);
  assert.throws(() => validateRelayUrl('wss://user:pass@relay.example.com'), /Логин и пароль/);
  assert.throws(() => validateRelayUrl('wss://relay.example.com?token=abc'), /не должен содержать параметров/);
  assert.throws(() => validateRelayUrl('wss://relay.example.com#secret'), /не должен содержать параметров/);
  assert.throws(() => validateRelayUrl(''), /Укажите адрес/);
  assert.throws(() => validateRelayUrl('не ссылка'), /не похож на ссылку/);

  assert.equal(endpointFor('wss://relay.example.com'), 'wss://relay.example.com/bridge/v2');
});

/**
 * The live run of 2026-10-14: the owner pasted the address exactly as the instructions print it,
 * the path was kept, and `endpointFor` then dialled `/bridge/v2/bridge/v2`. Both spellings have to
 * work, and anything else has to say so out loud instead of being silently glued together.
 */
test('the address of the server is an origin: the known endpoint is trimmed, any other path is refused', () => {
  for (const typed of [
    'wss://relay.example.com/bridge/v2',
    'wss://relay.example.com/bridge/v2/',
    ' wss://relay.example.com/bridge/v2  ',
    'wss://relay.example.com//bridge/v2',
  ]) {
    assert.equal(validateRelayUrl(typed), 'wss://relay.example.com', `«${typed}» — это тот же сервер`);
    assert.equal(endpointFor(validateRelayUrl(typed)), 'wss://relay.example.com/bridge/v2', 'путь не удваивается');
  }

  assert.equal(validateRelayUrl('ws://127.0.0.1:9/bridge/v2'), 'ws://127.0.0.1:9');
  for (const wrong of ['wss://relay.example.com/base', 'wss://relay.example.com/base/', 'wss://relay.example.com/relay/bridge/v2']) {
    assert.throws(() => validateRelayUrl(wrong), /без пути/, `«${wrong}» нельзя принять молча`);
  }
});

test('the installation key pair is Ed25519, and only the public half is in a shareable form', () => {
  const keys = createInstallationKeys();
  assert.equal(createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' }).asymmetricKeyType, 'ed25519');
  const spki = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(spki.length, 44, 'Ed25519 SPKI DER is 44 bytes');
  assert.equal(createPublicKey({ key: spki, format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
  assert.notEqual(keys.privateKey, createInstallationKeys().privateKey, 'every installation gets its own key');
  assert.ok(!keys.publicKey.includes(keys.privateKey));
});

test('device proof is an Ed25519 signature over the domain, installation and nonce', () => {
  const nonce = createNonce(16);
  const proof = deviceProof({ privateKey: KEYS.privateKey, installationId: INSTALLATION, nonce });
  assert.equal(Buffer.from(proof, 'base64url').length, 64, 'an Ed25519 signature');
  assert.ok(!proof.includes(KEYS.privateKey), 'the private key is not derivable from the proof it produced');

  // The exact message the relay has to reconstruct, spelled out independently of the module.
  const message = Buffer.from(`kuzmich-bridge-v2\n${INSTALLATION}\n${nonce}`, 'utf8');
  const key = createPublicKey({ key: Buffer.from(KEYS.publicKey, 'base64url'), format: 'der', type: 'spki' });
  assert.ok(verify(null, message, key, Buffer.from(proof, 'base64url')));

  // This is the whole point of 2.1: a relay holding only the public key can check it.
  assert.ok(verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: INSTALLATION, nonce, proof }));

  // A replay against another challenge, another installation or another key is refused.
  assert.ok(!verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: INSTALLATION, nonce: createNonce(16), proof }));
  assert.ok(!verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: randomUUID(), nonce, proof }));
  assert.ok(!verifyDeviceProof({ publicKey: createInstallationKeys().publicKey, installationId: INSTALLATION, nonce, proof }));
  assert.ok(!verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: INSTALLATION, nonce, proof: deviceProof({ privateKey: createInstallationKeys().privateKey, installationId: INSTALLATION, nonce }) }));
  assert.ok(!verifyDeviceProof({ publicKey: KEYS.publicKey, installationId: INSTALLATION, nonce, proof: '' }));
  assert.ok(!verifyDeviceProof({ publicKey: 'мусор', installationId: INSTALLATION, nonce, proof }));

  assert.throws(() => deviceProof({ privateKey: '', installationId: INSTALLATION, nonce }), /Недостаточно данных/);
  assert.throws(() => deviceProof({ privateKey: 'bm90LWEta2V5', installationId: INSTALLATION, nonce }), /повреждён/);
});

test('pairing nonce is at least 128 bits and the server only ever learns its hash', () => {
  const nonce = createNonce(32);
  assert.ok(Buffer.from(nonce, 'base64url').length >= 16, 'nonce carries at least 128 bits');
  assert.equal(Buffer.from(nonce, 'base64url').length, 32);
  assert.equal(nonceHash(nonce), createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest().toString('base64url'));
  assert.ok(!nonceHash(nonce).includes(nonce));
  assert.notEqual(createNonce(32), createNonce(32));
});

test('tabId is a stable salted digest of grantId, not grantId itself', () => {
  const grantId = randomUUID();
  const first = tabIdFor(SALT, grantId);
  assert.equal(first, tabIdFor(SALT, grantId), 'the same grant always maps to the same address');
  assert.match(first, /^t_[A-Za-z0-9_-]{22}$/);
  assert.ok(!first.includes(grantId), 'the core identifier does not reach the server');
  assert.notEqual(first, tabIdFor(SALT, randomUUID()), 'different conversations get different addresses');
  assert.notEqual(first, tabIdFor(createTabSalt(), grantId), 'another installation derives another address');
  assert.throws(() => tabIdFor(SALT, ''), /Недостаточно данных/);
});

test('command ids map into the core requestId namespace and stay inside its 200-character limit', () => {
  const requestId = buildRequestId({ userRef: 'u_7f3a', installationId: INSTALLATION, commandId: '01JBX7Q' });
  assert.equal(requestId, `ma:u_7f3a:${INSTALLATION}:01JBX7Q`);
  assert.equal(requestId.split(':').length, 4, 'no component contains a colon, so the namespace parses back');

  const longest = buildRequestId({ userRef: 'u'.repeat(64), installationId: INSTALLATION, commandId: 'c'.repeat(64) });
  assert.equal(longest.length, 169);
  assert.ok(longest.length <= LIMITS.requestId);

  assert.throws(() => buildRequestId({ userRef: 'u:1', installationId: INSTALLATION, commandId: 'a' }), ProtocolError);
  assert.throws(() => buildRequestId({ userRef: 'u'.repeat(65), installationId: INSTALLATION, commandId: 'a' }), ProtocolError);
  assert.throws(() => buildRequestId({ userRef: 'u', installationId: 'not-a-uuid', commandId: 'a' }), ProtocolError);
  assert.throws(() => buildRequestId({ userRef: 'u', installationId: INSTALLATION, commandId: 'c'.repeat(65) }), ProtocolError);
});

test('a tab summary carries exactly the eight approved fields and no trace of a path or blocker', () => {
  const thread = {
    grantId: 'grant-1', title: 'Сборка\nрелиза', provider: 'claude',
    projectLabel: 'CodexDesk', availability: 'available',
    target: { grantId: 'grant-1', threadId: 'claude:abc', projectKey: 'p', sessionId: 's', runtimeId: 'r', generation: 3, provider: 'claude' },
    cwd: 'E:\\My projects\\CodexDesk',
  };
  const state = {
    phase: 'blocked', activeTurnId: 'turn-A', queue: { count: 3, limit: 50, paused: true },
    blockers: ['approval'], actions: { send: false, enqueue: true, steer: false, stop: true },
    requiresComputer: true, updatedAt: '2026-10-14T10:00:00.000Z', revision: 12,
  };
  const summary = tabSummary({ thread, state, tabId: 't_abc', at: '2026-10-14T11:00:00.000Z' });

  assert.deepEqual(Object.keys(summary).sort(), ['agent', 'project', 'queueLength', 'queuePaused', 'status', 'tabId', 'title', 'updatedAt']);
  assert.deepEqual(summary, {
    tabId: 't_abc', title: 'Сборка релиза', agent: 'claude', project: 'CodexDesk',
    status: 'blocked', queueLength: 3, queuePaused: true, updatedAt: '2026-10-14T10:00:00.000Z',
  });
  const serialized = JSON.stringify(summary);
  // `queuePaused` says that the queue is paused, never why: the blockers stay on this computer.
  for (const forbidden of ['My projects', 'claude:abc', 'approval', 'turn-A', 'grant-1', 'runtimeId']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach the server`);
  }
  assert.equal(tabSummary({ thread, state: { ...state, queue: { count: 0, limit: 50, paused: false } }, tabId: 't', at: 'A' }).queuePaused, false);
});

test('availability and a missing state collapse into a status without leaking why', () => {
  const base = { grantId: 'g', title: 'Беседа', provider: 'codex', projectLabel: 'Проект', target: null };
  assert.equal(tabSummary({ thread: { ...base, availability: 'ambiguous' }, state: null, tabId: 't', at: 'A' }).status, 'ambiguous');
  assert.equal(tabSummary({ thread: { ...base, availability: 'unavailable' }, state: null, tabId: 't', at: 'A' }).status, 'unavailable');
  assert.equal(tabSummary({ thread: { ...base, availability: 'available' }, state: null, tabId: 't', at: 'A' }).status, 'unavailable');
  // A queue length reported for an unreachable tab would be a guess, so it is zero.
  assert.equal(tabSummary({ thread: { ...base, availability: 'unavailable' }, state: { phase: 'idle', queue: { count: 9, paused: true } }, tabId: 't', at: 'A' }).queueLength, 0);
  assert.equal(tabSummary({ thread: { ...base, availability: 'unavailable' }, state: { phase: 'idle', queue: { count: 9, paused: true } }, tabId: 't', at: 'A' }).queuePaused, false);
  // The core caps the queue at 50; a larger number would be a bug, not a bigger queue.
  assert.equal(tabSummary({ thread: { ...base, availability: 'available' }, state: { phase: 'idle', queue: { count: 900 } }, tabId: 't', at: 'A' }).queueLength, 50);
  assert.equal(tabSummary({ thread: { ...base, provider: 'something' }, state: null, tabId: 't', at: 'A' }).agent, 'codex');
  assert.equal(tabSummary({ thread: { ...base, title: '' }, state: null, tabId: 't', at: 'A' }).title, 'Беседа');
  assert.equal(tabSummary({ thread: { ...base, title: 'я'.repeat(300) }, state: null, tabId: 't', at: 'A' }).title.length, LIMITS.title);
});

test('every outgoing frame is built from a whitelist, so nothing extra can ride along', () => {
  const at = Date.parse('2026-10-14T10:00:00.000Z');
  const hello = outgoing.hello({
    now: at, installationId: INSTALLATION, proof: 'PROOF', label: 'Рабочий ПК',
    appVersion: '0.11.0', channel: 'nightly', resume: { epoch: 7, revision: 184, extra: 'x' },
  });
  assert.deepEqual(Object.keys(hello).sort(), ['client', 'frameId', 'installation', 'installationId', 'proof', 'protocol', 'resume', 'sentAt', 'type']);
  assert.equal(hello.protocol, PROTOCOL);
  assert.equal(hello.sentAt, '2026-10-14T10:00:00.000Z');
  assert.deepEqual(Object.keys(hello.resume).sort(), ['epoch', 'revision'], 'an unknown field of resume is dropped');
  assert.deepEqual(Object.keys(hello.installation), ['label']);
  assert.deepEqual(hello.client, { app: 'kuzmich', appVersion: '0.11.0', channel: 'nightly', bridge: BRIDGE_PROTOCOL, features: [] });

  const start = outgoing.pair_start({ now: at, pairingId: 'p1', hash: 'H', publicKey: KEYS.publicKey, label: 'ПК', appVersion: '0.11.0', channel: 'nightly' });
  assert.deepEqual(Object.keys(start).sort(), ['client', 'frameId', 'installation', 'nonceHash', 'pairingId', 'protocol', 'publicKey', 'sentAt', 'type']);

  const snapshot = outgoing.snapshot({
    now: at, epoch: 7, revision: 1, label: 'ПК', appVersion: '0.11.0', channel: 'nightly',
    tabs: [{ tabId: 't_a', title: 'Б', agent: 'codex', project: 'P', status: 'idle', queueLength: 0, queuePaused: false, updatedAt: 'A' }],
    truncated: false,
  });
  assert.deepEqual(Object.keys(snapshot).sort(), ['epoch', 'frameId', 'installation', 'protocol', 'revision', 'sentAt', 'tabs', 'truncated', 'type']);
  assert.deepEqual(Object.keys(snapshot.installation).sort(), ['appVersion', 'channel', 'label']);

  const result = outgoing.command_result({ now: at, commandId: 'c1', tabId: 't_a', status: 'rejected', detail: { code: 'blocked', message: 'Действие сейчас недоступно.', requiresComputer: true, raw: 'stack' } });
  assert.deepEqual(Object.keys(result.detail).sort(), ['code', 'message', 'requiresComputer'], 'a raw error cannot be attached');
  assert.equal(result.payload, null);

  assert.deepEqual(events.tab_removed('t_a'), { kind: 'tab_removed', tabId: 't_a' });
  assert.equal(outgoing.pair_cancel({ now: at, pairingId: 'p', reason: 'что-то' }).reason, 'local');
  assert.equal(outgoing.unpair({ now: at, reason: 'что-то' }).reason, 'owner');
  assert.equal(cleanLabel(''), 'Кузьмич');
  assert.equal(cleanLabel('я'.repeat(200)).length, LIMITS.label);
});

test('the payload of a reading action carries exactly the fields the contract names', () => {
  const thread = { grantId: 'g', title: 'Беседа', provider: 'claude', projectLabel: 'CodexDesk', availability: 'available' };
  const state = {
    phase: 'blocked', activeTurnId: 'turn-A', queue: { count: 3, limit: 50, paused: true },
    blockers: ['approval', 'busy'], actions: { send: false, enqueue: true, steer: true, stop: true },
    requiresComputer: true, updatedAt: '2026-10-14T10:00:00.000Z',
  };
  const payload = commandState({ thread, state, tabId: 't_a', at: 'A' });
  assert.deepEqual(Object.keys(payload).sort(),
    ['actions', 'activeTurnId', 'agent', 'project', 'queueLength', 'queuePaused', 'status', 'tabId', 'title', 'updatedAt']);
  assert.deepEqual(payload.actions, { send: false, stop: true }, 'only the two actions this wire has, enqueue and steer are not offered');
  assert.equal(payload.activeTurnId, 'turn-A', 'the phone can name the turn it wants stopped');
  assert.ok(!JSON.stringify(payload).includes('approval'), 'why it is blocked never leaves the computer');

  // An unavailable conversation is a state, not a failure: nothing is invented for it.
  const closed = commandState({ thread: { ...thread, availability: 'unavailable', target: null }, state: null, tabId: 't_a', at: 'A' });
  assert.deepEqual([closed.status, closed.activeTurnId, closed.actions], ['unavailable', null, { send: false, stop: false }]);

  const answer = commandAnswer({ answerId: 'a1', turnId: 't1', text: 'Готово', completedAt: '2026-10-14T10:02:00.000Z', truncated: false, raw: 'x' });
  assert.deepEqual(Object.keys(answer).sort(), ['answerId', 'completedAt', 'text', 'truncated', 'turnId']);
  assert.equal(commandAnswer(null), null, 'a conversation with no finished answer yet says so plainly');

  const long = commandAnswer({ answerId: 'a2', turnId: 't1', text: 'я'.repeat(LIMITS.answer + 10), completedAt: null, truncated: false });
  assert.deepEqual([long.text.length, long.truncated, long.completedAt], [LIMITS.answer, true, null]);
});

test('a notice names the event and has room for nothing else', () => {
  const at = Date.parse('2026-10-15T10:00:00.000Z');
  const done = events.notice({ tabId: 't_a', noticeKind: 'turn_completed', turnId: 'turn-A', occurredAt: at });
  assert.deepEqual(Object.keys(done).sort(), ['kind', 'noticeKind', 'occurredAt', 'tabId', 'turnId']);
  assert.deepEqual(done, { kind: 'notice', tabId: 't_a', noticeKind: 'turn_completed', turnId: 'turn-A', occurredAt: '2026-10-15T10:00:00.000Z' });

  // The key is always there, so the shape never varies — it is `null` when the turn is unknown.
  assert.equal(events.notice({ tabId: 't_a', noticeKind: 'action_required', occurredAt: at }).turnId, null);
  assert.deepEqual(NOTICE_KINDS, ['turn_completed', 'action_required'], 'two kinds in 2.3 and no third');

  // The builder is the whitelist: a kind the contract does not name cannot be sent at all.
  assert.throws(() => events.notice({ tabId: 't_a', noticeKind: 'answer_ready', occurredAt: at }), ProtocolError);
  assert.throws(() => events.notice({ tabId: 't_a', noticeKind: 'disconnected', occurredAt: at }), /Неизвестный вид уведомления/);
});

test('notices are edges of an allowed conversation, never a description of its state', () => {
  const at = '2026-10-15T10:00:00.000Z';
  const signals = (turnId, rest = {}) => new Map([['t_a', { turnId, running: turnId !== null, actionRequired: false, ...rest }]]);
  const running = signals('turn-A');
  const idle = new Map([['t_a', { turnId: null, running: false, actionRequired: false }]]);

  // First sight is a baseline: nothing happened that this computer saw happen.
  assert.deepEqual(diffNotices(new Map(), running, at), []);
  assert.deepEqual(diffNotices(running, running, at), [], 'a turn that is still running is not news');

  assert.deepEqual(diffNotices(running, idle, at),
    [{ kind: 'notice', tabId: 't_a', noticeKind: 'turn_completed', turnId: 'turn-A', occurredAt: at }]);
  // A turn replaced by the next one also ended, and the one that ended is the one named.
  assert.deepEqual(diffNotices(running, signals('turn-B'), at).map(notice => notice.turnId), ['turn-A']);

  // Still running, but the start is not acknowledged yet, so there is no id to report. The v1
  // contract allows exactly this, and calling it a finished turn would be a push about nothing.
  assert.deepEqual(diffNotices(running, new Map([['t_a', { turnId: null, running: true, actionRequired: false }]]), at), []);

  const blocked = signals('turn-A', { running: false, actionRequired: true });
  assert.deepEqual(diffNotices(running, blocked, at),
    [{ kind: 'notice', tabId: 't_a', noticeKind: 'action_required', turnId: 'turn-A', occurredAt: at }]);
  assert.deepEqual(diffNotices(blocked, blocked, at), [], 'staying blocked does not buzz the phone again');

  // A conversation whose state cannot be read says nothing at all — it neither completes a turn
  // nor silences one, because guessing either way would be a lie.
  assert.deepEqual(diffNotices(running, new Map(), at), []);
  assert.equal(turnSignal({ phase: 'unavailable', activeTurnId: 'turn-A' }), null);
  assert.equal(turnSignal(null), null);
  assert.deepEqual(turnSignal({ phase: 'blocked', activeTurnId: 'turn-A', requiresComputer: true }), { turnId: 'turn-A', running: false, actionRequired: true });
  // Busy is a block the computer does not have to resolve, and it is not an `action_required`.
  assert.deepEqual(turnSignal({ phase: 'blocked', activeTurnId: null, requiresComputer: false }), { turnId: null, running: false, actionRequired: false });
});

test('the reconnect ladder keeps its rungs and spreads them by a fifth', () => {
  assert.deepEqual(BACKOFF_MS.slice(), [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000]);
  // The rung itself is the contract's; the spread only decides where inside ±20 % it lands.
  assert.equal(backoffDelay(0, { random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(0, { random: () => 0 }), 800);
  assert.equal(backoffDelay(0, { random: () => 1 }), 1200);
  assert.equal(backoffDelay(99, { random: () => 0.5 }), 60_000, 'a long outage waits a minute, not longer and not less');
  assert.equal(backoffDelay(-5, { random: () => 0.5 }), 1000);

  const spread = new Set(Array.from({ length: 200 }, () => backoffDelay(2)));
  assert.ok(spread.size > 50, 'two installations losing the same relay do not come back in the same millisecond');
  for (const value of spread) assert.ok(value >= 4000 && value <= 6000, `${value} вне ±20 % от 5000`);

  // Silence allowed before the socket is declared dead: two heartbeats plus the contract's slack.
  assert.equal(livenessDeadlineMs(25_000), 60_000);
  assert.equal(livenessDeadlineMs(5_000), 20_000);
});

test('a command update is announced without any slot for the text of an answer', () => {
  const at = Date.parse('2026-10-14T10:00:00.000Z');
  const event = events.command_updated({
    commandId: 'c1', tabId: 't_a', at, status: 'executed', outcome: 'succeeded',
    detail: { code: 'blocked', message: 'Недоступно.', requiresComputer: true, stack: 'secret' },
  });
  assert.deepEqual(Object.keys(event).sort(), ['at', 'commandId', 'detail', 'kind', 'outcome', 'status', 'tabId']);
  assert.deepEqual(Object.keys(event.detail).sort(), ['code', 'message', 'requiresComputer']);
  assert.equal(event.at, '2026-10-14T10:00:00.000Z');
  assert.equal(events.command_updated({ commandId: 'c1', tabId: null, at, status: 'queued' }).detail, null);

  assert.deepEqual(commandDetail({ code: 'stale_turn', message: 'Ход закончился.', requiresComputer: false, reason: 'busy' }),
    { code: 'stale_turn', message: 'Ход закончился.', requiresComputer: false }, 'the block reason is not part of a safe detail');
  assert.equal(commandDetail(null), null);

  // Everything that can still move stays watched; `uncertain` above all, because a late
  // acknowledgement may yet turn it into a real result.
  for (const phase of ['completed', 'blocked', 'stale', 'rejected', 'cancelled']) assert.equal(isTerminalPhase(phase), true, phase);
  for (const phase of ['received', 'queued', 'accepted', 'uncertain']) assert.equal(isTerminalPhase(phase), false, phase);
});

test('an address is resolved against the live list, so a revoked one simply has no match', async () => {
  const threads = [{ grantId: 'grant-a' }, { grantId: 'grant-b' }];
  const remote = { listThreads: async () => ({ ok: true, value: threads }) };
  assert.equal((await resolveTab({ remote, tabSalt: SALT, tabId: tabIdFor(SALT, 'grant-b') })).grantId, 'grant-b');
  assert.equal(await resolveTab({ remote, tabSalt: SALT, tabId: 't_nothing' }), null);

  threads.splice(1, 1);   // the owner switched that conversation off a moment ago
  assert.equal(await resolveTab({ remote, tabSalt: SALT, tabId: tabIdFor(SALT, 'grant-b') }), null);

  // A different installation's salt gives a different address for the same grant.
  assert.notEqual(tabIdFor(createTabSalt(), 'grant-a'), tabIdFor(SALT, 'grant-a'));
  assert.equal(await resolveTab({ remote: { listThreads: async () => ({ ok: false, error: {} }) }, tabSalt: SALT, tabId: tabIdFor(SALT, 'grant-a') }), null,
    'a core that cannot answer resolves nothing rather than guessing');
});

test('an oversized outgoing frame is refused rather than sent', () => {
  const tabs = Array.from({ length: 200 }, (_, index) => ({
    tabId: `t_${index}`, title: 'я'.repeat(120), agent: 'codex', project: 'п'.repeat(80),
    status: 'idle', queueLength: 0, updatedAt: '2026-10-14T10:00:00.000Z',
  }));
  assert.ok(encodeFrame(outgoing.snapshot({ now: 0, epoch: 1, revision: 1, label: 'ПК', appVersion: '1', channel: 'c', tabs, truncated: true })).length > 0);
  assert.throws(() => encodeFrame({ protocol: 2, type: 'snapshot', blob: 'x'.repeat(LIMITS.outgoingFrame + 1) }), ProtocolError);
});

test('incoming frames are checked for envelope only, with a hard limit and a version refusal', () => {
  const frame = parseFrame(JSON.stringify({ protocol: 2, type: 'welcome', frameId: 'f', sentAt: 'A', unknownField: 1 }));
  assert.equal(frame.type, 'welcome');
  assert.equal(frame.unknownField, 1, 'unknown fields survive parsing and are ignored by the readers');

  assert.throws(() => parseFrame('{'), /не является JSON/);
  assert.throws(() => parseFrame(JSON.stringify([1, 2])), /не является объектом/);
  assert.throws(() => parseFrame(JSON.stringify({ protocol: 2 })), /без вида/);
  assert.throws(() => parseFrame(Buffer.alloc(0)), /текстовый фрейм/);
  assert.throws(() => parseFrame(JSON.stringify({ protocol: 3, type: 'welcome' })), error => {
    assert.equal(error.close, CLOSE.version, 'a future major closes the socket instead of guessing');
    return true;
  });
  assert.throws(() => parseFrame(JSON.stringify({ protocol: 2, type: 'x', blob: 'y'.repeat(LIMITS.incomingFrame) })), /превышает предел/);
});

test('readers take only known fields and refuse a server that omits what matters', () => {
  assert.equal(readWelcome({ heartbeatIntervalMs: 1 }).heartbeatIntervalMs, LIMITS.heartbeatMs, 'an absurd interval falls back to the default');
  assert.equal(readWelcome({ heartbeatIntervalMs: 30_000 }).heartbeatIntervalMs, 30_000);

  assert.equal(readPairPending({ pairingId: 'p', botUsername: 'kuzmich_bot' }).botUsername, 'kuzmich_bot');
  assert.throws(() => readPairPending({}), /не подтвердил начало привязки/);

  const claimed = readPairClaimed({ pairingId: 'p', claimant: { telegramUserId: '12345678', displayName: 'Иван\n', username: 'ivan', extra: 1 } });
  assert.deepEqual(claimed.claimant, { telegramUserId: '12345678', displayName: 'Иван', username: 'ivan' });
  assert.throws(() => readPairClaimed({ pairingId: 'p', claimant: { telegramUserId: 'не число' } }), /без пользователя/);

  assert.throws(() => readPairComplete({ installationId: 'nope', owner: { telegramUserId: '1' } }), /идентификатор установки/);
  assert.throws(() => readPairComplete({ installationId: INSTALLATION, owner: {} }), /не назвал владельца/);
  // Since 2.1 the completion carries no secret at all; one offered anyway is simply ignored.
  const complete = readPairComplete({ installationId: INSTALLATION, deviceSecret: 'x'.repeat(64), owner: { telegramUserId: '12345678', displayName: 'Иван' } });
  assert.equal(complete.owner.displayName, 'Иван');
  assert.deepEqual(Object.keys(complete).sort(), ['installationId', 'issuedAt', 'owner']);
});

test('the command envelope is fixed now even though stage 3 executes it', () => {
  const base = { commandId: 'c1', tabId: 't_a', userRef: 'u_1' };
  assert.equal(readCommand({ ...base, action: 'send', text: 'Проверь сборку' }).invalid, false);
  assert.equal(readCommand({ ...base, action: 'stop', expectedTurnId: 'turn-A' }).invalid, false);
  assert.equal(readCommand({ ...base, action: 'get_state' }).invalid, false);

  assert.equal(readCommand({ ...base, action: 'send', text: '   ' }).invalid, true, 'empty text is not a command');
  assert.equal(readCommand({ ...base, action: 'send', text: '/compact' }).invalid, true, 'slash commands are not passed to the CLI');
  assert.equal(readCommand({ ...base, action: 'send', text: 'я'.repeat(LIMITS.text + 1) }).invalid, true);
  assert.equal(readCommand({ ...base, action: 'stop' }).invalid, true, 'a stop without the exact turn is refused');
  assert.equal(readCommand({ ...base, action: 'enqueue', text: 'x' }).invalid, true, 'an action outside the contract is refused');
  assert.equal(readCommand({ ...base, action: 'send', text: 'x', cwd: 'E:\\', model: 'gpt' }).text, 'x');
  assert.deepEqual(Object.keys(readCommand({ ...base, action: 'send', text: 'x', cwd: 'E:\\' })).sort(),
    ['action', 'commandId', 'deadline', 'expectedTurnId', 'invalid', 'tabId', 'text', 'userRef'], 'cwd and model have no slot at all');
  assert.throws(() => readCommand({ tabId: 't', userRef: 'u', action: 'send' }), ProtocolError);
});

test('core phases map onto wire statuses, with uncertain kept apart from failure', () => {
  assert.equal(statusForPhase('received'), 'queued');
  assert.equal(statusForPhase('queued'), 'queued');
  assert.equal(statusForPhase('accepted'), 'accepted');
  assert.equal(statusForPhase('completed'), 'executed');
  assert.equal(statusForPhase('uncertain'), 'uncertain');
  for (const phase of ['blocked', 'stale', 'rejected', 'cancelled']) assert.equal(statusForPhase(phase), 'rejected');
});

test('ordering is lexicographic over epoch and revision', () => {
  assert.equal(compareSequence({ epoch: 7, revision: 2 }, { epoch: 7, revision: 3 }), -1);
  assert.equal(compareSequence({ epoch: 8, revision: 1 }, { epoch: 7, revision: 900 }), 1, 'a restarted desktop outranks the old session');
  assert.equal(compareSequence({ epoch: 7, revision: 3 }, { epoch: 7, revision: 3 }), 0);
});

test('a diff reports only real changes, and a removed tab is announced', () => {
  const tab = { tabId: 't_a', title: 'Б', agent: 'codex', project: 'P', status: 'idle', queueLength: 0, updatedAt: 'A' };
  assert.deepEqual(diffTabs([tab], [{ ...tab, updatedAt: 'B' }]), [], 'a refreshed timestamp alone is not news');
  assert.deepEqual(diffTabs([tab], [{ ...tab, status: 'running' }]), [{ kind: 'tab_updated', tab: { ...tab, status: 'running' } }]);
  assert.deepEqual(diffTabs([tab], []), [{ kind: 'tab_removed', tabId: 't_a' }]);
  assert.deepEqual(diffTabs([], [tab]), [{ kind: 'tab_updated', tab }]);
  assert.ok(sameTab(tab, { ...tab, updatedAt: 'Z' }));
  assert.ok(!sameTab(tab, { ...tab, queueLength: 1 }));
});

test('the subprotocol and endpoint are the ones the contract names', () => {
  assert.equal(SUBPROTOCOL, 'kuzmich-bridge.v2');
  assert.equal(PROTOCOL, 2, 'the major is unchanged: 2.3 is a minor over the same wire');
  assert.equal(BRIDGE_PROTOCOL, '2.3');
});
