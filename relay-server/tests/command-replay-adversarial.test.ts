import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandService, type CommandTransport } from '../src/command-service.ts';
import { parseCommand, type CommandInput, type CommandResult, type CommandRow } from '../src/commands.ts';
import { ApiError, fail, opaqueToken } from '../src/security.ts';
import { Store, type TabDto } from '../src/store.ts';
import { createRelay } from '../src/server.ts';
import { FIXTURE_BOT_TOKEN } from '../src/fixtures.ts';
import { connectFixture, FakeBridge, fixtureTab, login, pairFixture } from '../scripts/fake-bridge.ts';

// Public synthetic fixtures only, never production encryption or device credentials.
const PAYLOAD_KEY = Buffer.alloc(32, 0x45).toString('base64url');
const PUBLIC_KEY = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const OWNER = '10001';
const tab = (): TabDto => ({ tab_id: 't_allowed', title: 'Fixture tab', agent: 'codex', project: 'Fixture',
  status: 'idle', queueLength: 0, queuePaused: false, updatedAt: '2026-10-14T10:00:00.000Z' });
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const send = (commandId: string, text = 'Immutable fixture text'): CommandInput =>
  parseCommand({ commandId, tabId: 't_allowed', action: 'send', text });
const result = (commandId: string, fields: Partial<CommandResult> = {}): CommandResult => ({
  commandId, tabId: 't_allowed', status: 'executed', outcome: 'succeeded', detailCode: null, requiresComputer: false, ...fields
});

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'kuzmich-replay-review-'));
  return { directory, path: join(directory, 'relay.sqlite'), cleanup() {
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('kuzmich-replay-review-'));
    rmSync(target, { recursive: true, force: true });
  } };
}
function device(store: Store, owner = OWNER) {
  const session = store.createSession({ telegram_id: owner, display_name: 'Fixture owner' });
  const nonce = opaqueToken(), pairing = randomUUID();
  store.beginWirePairing(pairing, createHash('sha256').update(nonce).digest('base64url'), 'Fixture PC', PUBLIC_KEY);
  store.claimNonce(nonce, owner); const id = store.completeWirePairing(pairing).installation_id;
  store.applyWireSnapshot(id, 1, 1, 'Fixture PC', [tab()]); store.presence(id, true);
  return { id, token: session.session_token };
}
function assertScrubbed(row: CommandRow) {
  assert.equal(row.payload_ciphertext, null); assert.equal(row.payload_nonce, null); assert.equal(row.payload_tag, null);
}
function assertNoPlaintext(directory: string, values: string[]) {
  for (const name of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, name));
    for (const value of values) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `${name} contains UTF-8 private material`);
      assert.equal(bytes.includes(Buffer.from(value, 'utf16le')), false, `${name} contains UTF-16 private material`);
    }
  }
}

test('encrypted original text and expected turn survive relay restart without plaintext in SQLite/WAL', () => {
  const temp = temporary(); let store = new Store(temp.path, Date.now, PAYLOAD_KEY);
  try {
    const installation = device(store);
    const original = send('encrypted_send', 'REPLAY_PRIVATE_TEXT_6aa32c\n  exact whitespace  ');
    const stop = parseCommand({ commandId: 'encrypted_stop', tabId: 't_allowed', action: 'stop', expectedTurnId: 'REPLAY_PRIVATE_TURN_e4da09' });
    const first = store.commands.create(OWNER, installation.id, original);
    const second = store.commands.create(OWNER, installation.id, stop);
    assert.ok(first.payload_ciphertext); assert.ok(second.payload_ciphertext);
    assert.notEqual(first.payload_nonce, second.payload_nonce);
    assert.deepEqual(store.commands.restore(first), original);
    assertNoPlaintext(temp.directory, [original.text!, stop.expectedTurnId!, PAYLOAD_KEY]);
    store.close(); store = new Store(temp.path, Date.now, PAYLOAD_KEY);
    assert.deepEqual(store.commands.restore(store.commands.get(installation.id, original.commandId)!), original);
    assert.deepEqual(store.commands.restore(store.commands.get(installation.id, stop.commandId)!), stop);
    assertNoPlaintext(temp.directory, [original.text!, stop.expectedTurnId!, PAYLOAD_KEY]);
  } finally { store.close(); temp.cleanup(); }
});

test('wrong encryption key fails closed and a keyless persistent store cannot create or decrypt commands', () => {
  const temp = temporary(); let store: Store | undefined = new Store(temp.path, Date.now, PAYLOAD_KEY);
  try {
    const installation = device(store), input = send('configured_key');
    store.commands.create(OWNER, installation.id, input); store.close(); store = undefined;
    assert.throws(() => new Store(temp.path, Date.now, Buffer.alloc(32, 0x46).toString('base64url')), hasCode('command_payload_key_mismatch'));
    store = new Store(temp.path);
    assert.equal(store.commands.restore(store.commands.get(installation.id, input.commandId)!), undefined);
    assert.equal(store.commands.get(installation.id, input.commandId)?.replay_unavailable, 'command_payload_key_required');
    assert.throws(() => store!.commands.create(OWNER, installation.id, send('no_key_new')), hasCode('command_payload_key_required'));
    assert.equal(store.commands.get(installation.id, 'no_key_new'), undefined);
    store.close(); store = new Store(temp.path, Date.now, PAYLOAD_KEY);
    assert.deepEqual(store.commands.restore(store.commands.get(installation.id, input.commandId)!), input);
  } finally { store?.close(); temp.cleanup(); }
});

test('AAD binds ciphertext to command, installation, owner, userRef and fingerprint; malformed ciphertext cannot restore', () => {
  const store = new Store(':memory:');
  try {
    const installation = device(store), other = device(store, '10002');
    const original = store.commands.create(OWNER, installation.id, send('aad_original'));
    const sibling = store.commands.create(OWNER, installation.id, send('aad_sibling'));
    const foreign = store.commands.create('10002', other.id, send('aad_original'));
    const sealed = { payload_ciphertext: original.payload_ciphertext!, payload_nonce: original.payload_nonce!, payload_tag: original.payload_tag! };
    for (const context of [sibling, foreign, { ...original, telegram_id: '10002' },
      { ...original, user_ref: 'u_different' }, { ...original, fingerprint: '0'.repeat(64) }]) {
      assert.throws(() => store.commands.vault.open(context, sealed), hasCode('command_payload_corrupt'));
    }
    const swapped = { ...sibling, ...sealed };
    assert.equal(store.commands.restore(swapped), undefined);
    assert.equal(store.commands.get(installation.id, sibling.command_id)?.replay_unavailable, 'command_payload_corrupt');
    for (const changed of [{ ...original, payload_tag: 'A'.repeat(22) }, { ...original, payload_ciphertext: original.payload_ciphertext!.slice(1) },
      { ...original, tab_id: 't_changed' }, { ...original, action: 'stop' as const }]) {
      assert.equal(store.commands.restore(changed), undefined);
    }
    assert.deepEqual(store.commands.restore(store.commands.get(installation.id, original.command_id)!), send('aad_original'));
  } finally { store.close(); }
});

type Packet = { connection: string; installationId: string; userRef: string; input: CommandInput };
class Transport implements CommandTransport {
  connection = 'initial';
  online = true;
  sent: Packet[] = [];
  receive?: (packet: Packet, completed: (known: boolean) => void) => void;
  ready(): boolean { return this.online; }
  assertReady(): void { if (!this.online) fail(409, 'not_connected'); }
  dispatch(installationId: string, userRef: string, input: CommandInput, completed: (known: boolean) => void): void {
    const packet = { connection: this.connection, installationId, userRef, input: { ...input } };
    this.sent.push(packet);
    if (this.receive) this.receive(packet, completed); else completed(true);
  }
}
function harness(store: Store, interval = 1) {
  const transport = new Transport(), updates: unknown[] = [];
  const service = new CommandService(store, transport, row => updates.push(store.commands.dto(row)), 1000, interval);
  return { service, transport, updates };
}
async function keepAlive<T>(promise: Promise<T>): Promise<T> {
  const handle = setInterval(() => {}, 50);
  try { return await promise; } finally { clearInterval(handle); }
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Replay condition did not become true');
}

test('lost result plus relay restart retransmits the same request and fake desktop ledger executes it only once', async () => {
  const temp = temporary(); let store = new Store(temp.path, Date.now, PAYLOAD_KEY); let current = harness(store);
  const operations = new Map<string, { input: CommandInput; result: CommandResult }>(); let executions = 0;
  try {
    const installation = device(store), input = send('lost_result', 'RESTART_PRIVATE_ORIGINAL_8e359c\n exact body');
    const executeOrFind = (packet: Packet) => {
      const requestId = `ma:${packet.userRef}:${packet.installationId}:${packet.input.commandId}`;
      const existing = operations.get(requestId);
      if (existing) { assert.deepEqual(packet.input, existing.input); return existing.result; }
      executions++; const outcome = result(packet.input.commandId);
      operations.set(requestId, { input: { ...packet.input }, result: outcome }); return outcome;
    };
    current.transport.receive = (packet, completed) => { executeOrFind(packet); completed(true); }; // First result is lost.
    await current.service.submit(OWNER, installation.token, installation.id, input);
    assert.equal(executions, 1); assert.equal(store.commands.get(installation.id, input.commandId)?.status, null);
    current.service.disconnected(installation.id); current.service.close(); store.close();
    store = new Store(temp.path, Date.now, PAYLOAD_KEY); current = harness(store); current.transport.connection = 'reconnected';
    store.applyWireSnapshot(installation.id, 1, 2, 'Fixture PC', [tab()]); store.presence(installation.id, true);
    current.transport.receive = (packet, completed) => { current.service.result(installation.id, executeOrFind(packet)); completed(true); };
    await keepAlive(current.service.reconnected(installation.id, 'reconnected'));
    assert.equal(current.transport.sent.length, 1); assert.deepEqual(current.transport.sent[0].input, input);
    assert.equal(executions, 1); assert.equal(store.commands.get(installation.id, input.commandId)?.status, 'executed');
    assertScrubbed(store.commands.get(installation.id, input.commandId)!);
    assert.equal((await current.service.submit(OWNER, installation.token, installation.id, input)).duplicate, true);
    await keepAlive(current.service.reconnected(installation.id, 'later-connection'));
    assert.equal(current.transport.sent.length, 1); assert.equal(executions, 1);
  } finally { current.service.close(); store.close(); temp.cleanup(); }
});

test('every nonterminal status replays once per connection while terminal outcomes and phone duplicates never do', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store);
  try {
    const expected: CommandInput[] = [];
    for (const status of [null, 'queued', 'accepted', 'uncertain'] as const) {
      const input = status === 'uncertain' ? parseCommand({ commandId: 'pending_uncertain', tabId: 't_allowed', action: 'stop', expectedTurnId: 'original-turn' }) : send(`pending_${status}`);
      expected.push(input); store.commands.create(OWNER, installation.id, input);
      if (status) store.commands.applyResult(installation.id, result(input.commandId, { status, outcome: null }));
    }
    for (const status of ['executed', 'rejected'] as const) {
      const input = send(`terminal_${status}`); store.commands.create(OWNER, installation.id, input);
      store.commands.applyResult(installation.id, result(input.commandId, { status, outcome: status === 'executed' ? 'failed' : null }));
    }
    transport.connection = 'connection-A';
    await keepAlive(Promise.all([service.reconnected(installation.id, 'connection-A'), service.reconnected(installation.id, 'connection-A')]));
    assert.deepEqual(transport.sent.map(packet => packet.input), expected);
    await keepAlive(service.reconnected(installation.id, 'connection-A')); assert.equal(transport.sent.length, 4);
    for (const input of expected) assert.equal((await service.submit(OWNER, installation.token, installation.id, input)).duplicate, true);
    assert.equal(transport.sent.length, 4);
    transport.connection = 'connection-B'; await keepAlive(service.reconnected(installation.id, 'connection-B'));
    assert.deepEqual(transport.sent.slice(4).map(packet => packet.input), expected);
    for (const connection of ['connection-A', 'connection-B']) {
      const sent = transport.sent.filter(packet => packet.connection === connection);
      assert.equal(new Set(sent.map(packet => packet.input.commandId)).size, sent.length);
    }
  } finally { service.close(); store.close(); }
});

test('a replaced paced replay loop cannot dispatch its remaining commands onto the newer connection', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store, 25);
  try {
    for (let i = 0; i < 3; i++) store.commands.create(OWNER, installation.id, send(`paced_${i}`));
    let activeConnection = 'connection-A'; transport.connection = activeConnection;
    const old = service.reconnected(installation.id, 'connection-A', () => activeConnection === 'connection-A');
    await until(() => transport.sent.length === 1);
    activeConnection = 'connection-B'; transport.connection = activeConnection;
    const next = service.reconnected(installation.id, 'connection-B', () => activeConnection === 'connection-B');
    await keepAlive(Promise.all([old, next]));
    assert.equal(transport.sent.filter(packet => packet.connection === 'connection-A').length, 1);
    const delivered = transport.sent.filter(packet => packet.connection === 'connection-B').map(packet => packet.input.commandId);
    assert.deepEqual(delivered, ['paced_0', 'paced_1', 'paced_2']);
    assert.equal(new Set(delivered).size, delivered.length);
  } finally { service.close(); store.close(); }
});

test('a previously admitted command for a removed tab is replayed for authoritative rejection and then scrubbed', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store);
  try {
    const input = send('removed_tab_pending'); await service.submit(OWNER, installation.token, installation.id, input);
    store.applyWireSnapshot(installation.id, 1, 2, 'Fixture PC', []); service.invalidateUnavailable();
    assert.ok(store.commands.get(installation.id, input.commandId)?.payload_ciphertext);
    await assert.rejects(service.submit(OWNER, installation.token, installation.id, send('new_removed_tab')), hasCode('unknown_tab'));
    transport.connection = 'fresh-without-tab';
    transport.receive = (packet, completed) => {
      assert.deepEqual(packet.input, input); assert.deepEqual(store.tabs(installation.id), []);
      service.result(installation.id, result(input.commandId, { status: 'rejected', outcome: null, detailCode: 'unknown_tab' }));
      completed(true);
    };
    await keepAlive(service.reconnected(installation.id, 'fresh-without-tab'));
    assert.equal(transport.sent.length, 2);
    assert.equal(store.commands.get(installation.id, input.commandId)?.status, 'rejected');
    assertScrubbed(store.commands.get(installation.id, input.commandId)!);
    await service.submit(OWNER, installation.token, installation.id, input);
    assertScrubbed(store.commands.get(installation.id, input.commandId)!); assert.equal(transport.sent.length, 2);
  } finally { service.close(); store.close(); }
});

test('whole installation unlink during paced replay scrubs pending bodies and prevents subsequent delivery', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store, 10);
  try {
    for (let i = 0; i < 3; i++) store.commands.create(OWNER, installation.id, send(`unlink_${i}`));
    transport.receive = (_packet, completed) => { completed(true); store.revoke(installation.id, OWNER); service.invalidateUnavailable(); };
    await keepAlive(Promise.allSettled([service.reconnected(installation.id, 'unlink-during-loop')]));
    assert.equal(transport.sent.length, 1);
    for (let i = 0; i < 3; i++) {
      const row = store.commands.get(installation.id, `unlink_${i}`)!;
      assertScrubbed(row); assert.equal(row.status, null); assert.equal(row.replay_unavailable, 'installation_revoked');
    }
    await keepAlive(Promise.allSettled([service.reconnected(installation.id, 'after-unlink')]));
    assert.equal(transport.sent.length, 1);
  } finally { service.close(); store.close(); }
});

test('terminal duplicates cannot hydrate removed ciphertext and corrupt pending bodies never dispatch', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store);
  try {
    for (const status of ['executed', 'rejected'] as const) {
      const input = send(`finished_${status}`); store.commands.create(OWNER, installation.id, input);
      store.commands.applyResult(installation.id, result(input.commandId, { status, outcome: status === 'executed' ? 'failed' : null }));
      assertScrubbed(store.commands.get(installation.id, input.commandId)!);
      assert.equal((await service.submit(OWNER, installation.token, installation.id, input)).duplicate, true);
      assertScrubbed(store.commands.get(installation.id, input.commandId)!);
      assert.equal(store.commands.restore(store.commands.get(installation.id, input.commandId)!), undefined);
    }
    const bad = send('corrupt_pending'); store.commands.create(OWNER, installation.id, bad);
    store.db.prepare('UPDATE command_ledger SET payload_tag=? WHERE installation_id=? AND command_id=?').run('A'.repeat(22), installation.id, bad.commandId);
    await keepAlive(service.reconnected(installation.id, 'corrupt-body'));
    assert.equal(transport.sent.length, 0);
    const row = store.commands.get(installation.id, bad.commandId)!;
    assert.equal(row.status, null); assert.equal(row.replay_unavailable, 'command_payload_corrupt');
    const dto = store.commands.dto(row) as unknown as Record<string, unknown>;
    for (const field of ['payload_ciphertext', 'payload_nonce', 'payload_tag', 'user_ref', 'fingerprint', 'text']) assert.equal(field in dto, false);
  } finally { service.close(); store.close(); }
});

test('legacy hash-only reads are reconstructed, while a missing mutating body requires an exact duplicate to hydrate without sending', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport } = harness(store);
  try {
    const original = send('legacy_send', 'Known original body'), read = parseCommand({ commandId: 'legacy_read', tabId: 't_allowed', action: 'get_state' });
    store.commands.create(OWNER, installation.id, original); store.commands.create(OWNER, installation.id, read);
    store.db.prepare('UPDATE command_ledger SET payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL WHERE installation_id=?').run(installation.id);
    assert.equal(store.commands.restore(store.commands.get(installation.id, original.commandId)!), undefined);
    assert.equal(store.commands.get(installation.id, original.commandId)?.replay_unavailable, 'legacy_payload_missing');
    assert.deepEqual(store.commands.restore(store.commands.get(installation.id, read.commandId)!), read);
    await keepAlive(service.reconnected(installation.id, 'legacy-first'));
    assert.deepEqual(transport.sent.map(packet => packet.input.commandId), [read.commandId]);
    await assert.rejects(service.submit(OWNER, installation.token, installation.id, { ...original, text: 'not original' }), hasCode('command_conflict'));
    const duplicate = await service.submit(OWNER, installation.token, installation.id, original);
    assert.equal(duplicate.duplicate, true); assert.equal(transport.sent.length, 1);
    assert.ok(store.commands.get(installation.id, original.commandId)?.payload_ciphertext);
    await keepAlive(service.reconnected(installation.id, 'legacy-first')); assert.equal(transport.sent.length, 1);
    await keepAlive(service.reconnected(installation.id, 'legacy-next'));
    assert.deepEqual(transport.sent.slice(1).map(packet => packet.input), [original, read]);
  } finally { service.close(); store.close(); }
});

test('replayed read commands update status but cannot deliver payload without their original HTTP waiter', async () => {
  const store = new Store(':memory:'), installation = device(store), { service, transport, updates } = harness(store);
  try {
    const input = parseCommand({ commandId: 'read_replay', tabId: 't_allowed', action: 'get_last_answer' });
    const pending = service.submit(OWNER, installation.token, installation.id, input);
    service.disconnected(installation.id); assert.ok(!('payload' in await pending));
    transport.receive = (packet, completed) => {
      service.result(installation.id, result(packet.input.commandId, { payload: { answer: {
        answerId: 'a', turnId: 'turn', text: 'UNREQUESTED_REPLAY_RESPONSE_6e91a5', truncated: false, completedAt: null
      } } })); completed(true);
    };
    await keepAlive(service.reconnected(installation.id, 'read-reconnect'));
    assert.equal(transport.sent.length, 2);
    assert.equal(service.read(OWNER, installation.id, input.commandId).status, 'executed');
    const duplicate = await service.submit(OWNER, installation.token, installation.id, input);
    assert.ok(!('payload' in duplicate));
    assert.equal(JSON.stringify({ updates, duplicate, rows: store.db.prepare('SELECT * FROM command_ledger').all() }).includes('UNREQUESTED_REPLAY_RESPONSE_6e91a5'), false);
    assertScrubbed(store.commands.get(installation.id, input.commandId)!);
  } finally { service.close(); store.close(); }
});

test('real WebSocket retries only after a newer full snapshot and once per connection, preserving one fake core execution', async () => {
  const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, fixtureMode: true, replayIntervalMs: 1, offlineGraceMs: 0 });
  let pc: FakeBridge | undefined;
  try {
    const port = await relay.listen(0), url = `http://127.0.0.1:${port}`;
    const token = await login(url), credential = await pairFixture(url, token);
    const installation = { label: 'Fixture PC', appVersion: '0.11.0', channel: 'nightly' };
    const publish = (bridge: FakeBridge, revision: number) => bridge.send('snapshot', { epoch: 1, revision,
      installation, tabs: [fixtureTab()], truncated: false });
    const original = { commandId: 'wire_lost_ack', tabId: fixtureTab().tabId, action: 'send', text: 'ORIGINAL_WIRE_BODY_a81e5d\n exact' };
    const operations = new Map<string, unknown>(); let executions = 0;
    const fakeCore = (message: Record<string, unknown>) => {
      assert.equal(message.commandId, original.commandId); assert.equal(message.installationId, credential.installationId);
      assert.equal(message.tabId, original.tabId); assert.equal(message.action, 'send'); assert.equal(message.text, original.text);
      assert.equal(message.userRef, relay.store.installationUserRef(credential.installationId, OWNER));
      const requestId = `ma:${message.userRef}:${message.installationId}:${message.commandId}`;
      const immutable = { commandId: message.commandId, installationId: message.installationId, tabId: message.tabId,
        userRef: message.userRef, action: message.action, text: message.text, expectedTurnId: message.expectedTurnId };
      if (operations.has(requestId)) assert.deepEqual(immutable, operations.get(requestId));
      else { operations.set(requestId, immutable); executions++; }
    };
    pc = await connectFixture(url, credential); publish(pc, 1);
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    const accepted = await fetch(`${url}/api/installations/${credential.installationId}/commands`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(original)
    });
    assert.equal(accepted.status, 202); fakeCore(await pc.wait('command')); assert.equal(executions, 1);
    await pc.close(); pc = await connectFixture(url, credential);
    await delay(25); assert.equal(pc.received.some(message => message.type === 'command'), false, 'welcome alone cannot trigger replay');
    publish(pc, 1); // Equal sequence is stale, so it cannot authorize the reconnect replay.
    await delay(25); assert.equal(pc.received.some(message => message.type === 'command'), false, 'stale snapshot cannot trigger replay');
    publish(pc, 2); fakeCore(await pc.wait('command'));
    publish(pc, 3); await delay(25);
    assert.equal(pc.received.some(message => message.type === 'command'), false, 'a second full snapshot is not a new connection');
    await pc.close(); pc = await connectFixture(url, credential); publish(pc, 4); fakeCore(await pc.wait('command'));
    assert.equal(executions, 1);
    pc.send('command_result', { commandId: original.commandId, tabId: original.tabId, at: new Date().toISOString(),
      status: 'executed', outcome: 'succeeded', detail: null, payload: null });
    await until(() => relay.store.commands.get(credential.installationId, original.commandId)?.status === 'executed');
    assertScrubbed(relay.store.commands.get(credential.installationId, original.commandId)!);
    await pc.close(); pc = await connectFixture(url, credential); publish(pc, 5); await delay(25);
    assert.equal(pc.received.some(message => message.type === 'command'), false, 'terminal commands never replay');
    assert.equal(executions, 1);
  } finally { await pc?.close(); await relay.close(); }
});
