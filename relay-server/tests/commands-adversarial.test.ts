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
import { FIXTURE_COMMAND_PAYLOAD_KEY } from '../src/fixtures.ts';

const PUBLIC_KEY = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const OWNER = '10001';
const tab = (tab_id = 't_allowed'): TabDto => ({ tab_id, title: 'Fixture tab', agent: 'codex', project: 'Fixture',
  status: 'idle', queueLength: 0, queuePaused: false, updatedAt: '2026-10-14T10:00:00.000Z' });
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
type Sent = { installationId: string; userRef: string; input: CommandInput };

class Transport implements CommandTransport {
  connected = true;
  sent: Sent[] = [];
  onDispatch?: (sent: Sent, completed: (known: boolean) => void) => void;
  ready(): boolean { return this.connected; }
  assertReady(): void { if (!this.connected) fail(409, 'not_connected'); }
  dispatch(installationId: string, userRef: string, input: CommandInput, completed: (known: boolean) => void): void {
    const sent = { installationId, userRef, input: { ...input } };
    this.sent.push(sent);
    if (this.onDispatch) this.onDispatch(sent, completed); else completed(true);
  }
}
function installation(store: Store, owner = OWNER) {
  const session = store.createSession({ telegram_id: owner, display_name: 'Fixture owner' });
  const nonce = opaqueToken(), pairing = randomUUID();
  store.beginWirePairing(pairing, createHash('sha256').update(nonce).digest('base64url'), 'Fixture PC', PUBLIC_KEY);
  store.claimNonce(nonce, owner);
  const id = store.completeWirePairing(pairing).installation_id;
  store.applyWireSnapshot(id, 1, 1, 'Fixture PC', [tab(), tab('t_other')]); store.presence(id, true);
  return { id, token: session.session_token };
}
function harness(store: Store, waitMs = 1000) {
  const transport = new Transport(), updates: CommandRow[] = [];
  const service = new CommandService(store, transport, row => updates.push({ ...row }), waitMs);
  return { transport, updates, service };
}
function result(commandId: string, fields: Partial<CommandResult> = {}): CommandResult {
  return { commandId, tabId: 't_allowed', status: 'executed', outcome: 'succeeded', detailCode: null,
    requiresComputer: false, ...fields };
}
function tempDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'kuzmich-command-review-'));
  return { directory, path: join(directory, 'relay.sqlite'), cleanup() {
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('kuzmich-command-review-'));
    rmSync(target, { recursive: true, force: true });
  } };
}

test('immutable command fingerprint rejects changes to text, action, tab and expected turn without dispatching twice', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport } = harness(store);
  try {
    const send = parseCommand({ commandId: 'same_send', tabId: 't_allowed', action: 'send', text: 'First line\nSecond line  ' });
    await service.submit(OWNER, device.token, device.id, send);
    assert.equal((await service.submit(OWNER, device.token, device.id, { ...send })).duplicate, true);
    for (const changed of [{ ...send, text: 'changed' }, { ...send, tabId: 't_other' },
      parseCommand({ commandId: 'same_send', tabId: 't_allowed', action: 'get_state' })]) {
      await assert.rejects(service.submit(OWNER, device.token, device.id, changed), hasCode('command_conflict'));
    }
    const stop = parseCommand({ commandId: 'same_stop', tabId: 't_allowed', action: 'stop', expectedTurnId: 'turn-original' });
    await service.submit(OWNER, device.token, device.id, stop);
    await assert.rejects(service.submit(OWNER, device.token, device.id, { ...stop, expectedTurnId: 'turn-new' }), hasCode('command_conflict'));
    assert.equal(transport.sent.length, 2);
    assert.equal(transport.sent[0].input.text, 'First line\nSecond line  ');
    assert.notEqual(transport.sent[0].userRef, OWNER);
    assert.equal(transport.sent[0].userRef, store.installationUserRef(device.id, OWNER));
  } finally { service.close(); store.close(); }
});

test('disconnected transport cannot accept a new command during the online presence grace period', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport } = harness(store);
  try {
    assert.equal(store.installation(device.id).online, 1); transport.connected = false;
    await assert.rejects(service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'offline_new', tabId: 't_allowed', action: 'send', text: 'Do not queue' })), hasCode('not_connected'));
    assert.equal(store.commands.get(device.id, 'offline_new'), undefined);
    assert.equal(transport.sent.length, 0);
  } finally { service.close(); store.close(); }
});

test('restart preserves request identity and unknown delivery; a phone duplicate does not dispatch or invent wire status', async () => {
  const temp = tempDatabase(); let store = new Store(temp.path, Date.now, FIXTURE_COMMAND_PAYLOAD_KEY); let current = harness(store);
  try {
    const device = installation(store), input = parseCommand({ commandId: 'restart_once', tabId: 't_allowed', action: 'send', text: 'Exactly once fixture' });
    const first = await current.service.submit(OWNER, device.token, device.id, input);
    assert.equal(first.command.status, null); assert.equal(current.transport.sent.length, 1);
    current.service.close(); store.close(); store = new Store(temp.path, Date.now, FIXTURE_COMMAND_PAYLOAD_KEY); current = harness(store);
    const duplicate = await current.service.submit(OWNER, device.token, device.id, input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.command.status, null);
    assert.equal(duplicate.command.dispatchState, 'delivery_unknown'); assert.equal(current.transport.sent.length, 0);
    await assert.rejects(current.service.submit(OWNER, device.token, device.id, { ...input, text: 'different' }), hasCode('command_conflict'));
    current.service.result(device.id, result(input.commandId));
    assert.equal(current.service.read(OWNER, device.id, input.commandId).status, 'executed');
    assert.equal(current.transport.sent.length, 0);
  } finally { current.service.close(); store.close(); temp.cleanup(); }
});

test('command_updated before the matching direct result cannot consume or replay the single read payload', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport, updates } = harness(store);
  try {
    const input = parseCommand({ commandId: 'read_order', tabId: 't_allowed', action: 'get_last_answer' });
    const payload = { answer: { answerId: 'a_fixture', turnId: 'turn_fixture', text: 'PRIVATE_READ_ORDER_MARKER', truncated: false, completedAt: null } };
    const pending = service.submit(OWNER, device.token, device.id, input);
    let settled = false; void pending.then(() => { settled = true; });
    service.result(device.id, result(input.commandId, { payload }), false);
    await Promise.resolve(); assert.equal(settled, false, 'an event has no payload slot');
    service.result(device.id, result(input.commandId, { payload }));
    assert.deepEqual((await pending).payload, payload);
    const duplicate = await service.submit(OWNER, device.token, device.id, input);
    assert.equal(duplicate.duplicate, true); assert.ok(!('payload' in duplicate));
    assert.ok(!('payload' in service.read(OWNER, device.id, input.commandId)));
    service.result(device.id, result(input.commandId, { payload: { answer: { text: 'LATE_PAYLOAD' } } }));
    assert.equal(transport.sent.length, 1);
    assert.ok(!JSON.stringify(updates).includes('PRIVATE_READ_ORDER_MARKER'));
    assert.ok(!JSON.stringify(store.commands.get(device.id, input.commandId)).includes('PRIVATE_READ_ORDER_MARKER'));
  } finally { service.close(); store.close(); }
});

test('a result arriving before the dispatch callback remains authoritative and delivers only once', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport } = harness(store);
  try {
    const payload = { answer: null };
    transport.onDispatch = (sent, completed) => {
      service.result(device.id, result(sent.input.commandId, { payload }));
      completed(false); // A late transport callback must not override bridge evidence.
    };
    const receipt = await service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'result_race', tabId: 't_allowed', action: 'get_last_answer' }));
    assert.deepEqual(receipt.payload, payload); assert.equal(receipt.command.status, 'executed');
    assert.equal(receipt.command.dispatchState, 'sent'); assert.equal(transport.sent.length, 1);
  } finally { service.close(); store.close(); }
});

test('raw command text, turn ID and read answer never enter SQLite files, WAL, metadata updates or read replay', async () => {
  const temp = tempDatabase(), store = new Store(temp.path, Date.now, FIXTURE_COMMAND_PAYLOAD_KEY), device = installation(store), { service, updates } = harness(store);
  const markers = ['PRIVATE_COMMAND_TEXT_8eb7c1', 'PRIVATE_STOP_TURN_35ab6a', 'PRIVATE_RESPONSE_TEXT_76fa32'];
  const assertNoDiskMarkers = () => {
    for (const name of readdirSync(temp.directory)) {
      const bytes = readFileSync(join(temp.directory, name));
      for (const marker of markers) {
        assert.equal(bytes.includes(Buffer.from(marker)), false, `${name} contains UTF-8 private material`);
        assert.equal(bytes.includes(Buffer.from(marker, 'utf16le')), false, `${name} contains UTF-16 private material`);
      }
    }
  };
  try {
    await service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'privacy_send', tabId: 't_allowed', action: 'send', text: markers[0] }));
    await service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'privacy_stop', tabId: 't_allowed', action: 'stop', expectedTurnId: markers[1] }));
    const read = parseCommand({ commandId: 'privacy_read', tabId: 't_allowed', action: 'get_last_answer' });
    const pending = service.submit(OWNER, device.token, device.id, read);
    assertNoDiskMarkers();
    service.result(device.id, result(read.commandId, { payload: { answer: { answerId: 'a', turnId: 'turn', text: markers[2], truncated: false, completedAt: null } } }));
    assert.ok(JSON.stringify((await pending).payload).includes(markers[2]));
    service.result(device.id, result('privacy_send')); service.result(device.id, result('privacy_stop', { outcome: 'interrupted' }));
    const replay = await service.submit(OWNER, device.token, device.id, read);
    const metadata = JSON.stringify({ updates, replay, command: service.read(OWNER, device.id, read.commandId),
      rows: store.db.prepare('SELECT * FROM command_ledger').all(), audit: store.db.prepare('SELECT * FROM audit').all() });
    for (const marker of markers) assert.equal(metadata.includes(marker), false);
    assertNoDiskMarkers();
    store.revoke(device.id, OWNER); service.invalidateUnavailable(); assertNoDiskMarkers();
  } finally { service.close(); store.close(); temp.cleanup(); }
});

test('foreign installation and mismatched result tab cannot resolve a pending read', async () => {
  const store = new Store(':memory:'), device = installation(store), other = installation(store, '10002');
  const { service } = harness(store);
  try {
    const input = parseCommand({ commandId: 'result_acl', tabId: 't_allowed', action: 'get_last_answer' });
    await assert.rejects(service.submit('10002', other.token, device.id, input), hasCode('installation_not_found'));
    const pending = service.submit(OWNER, device.token, device.id, input);
    const payload = { answer: null };
    service.result(other.id, result(input.commandId, { payload }));
    service.result(device.id, result(input.commandId, { tabId: 't_other', payload }));
    assert.equal(store.commands.get(device.id, input.commandId)?.status, null);
    service.result(device.id, result(input.commandId, { payload }));
    assert.deepEqual((await pending).payload, payload);
    assert.throws(() => service.read('10002', device.id, input.commandId), hasCode('installation_not_found'));
  } finally { service.close(); store.close(); }
});

test('full snapshot removal, installation revocation and session expiry each discard a pending answer', async () => {
  for (const condition of ['snapshot', 'revoke', 'expiry'] as const) {
    let now = 1_700_000_000_000;
    const store = new Store(':memory:', () => now), device = installation(store), { service } = harness(store);
    try {
      const input = parseCommand({ commandId: `deny_${condition}`, tabId: 't_allowed', action: 'get_last_answer' });
      const pending = service.submit(OWNER, device.token, device.id, input);
      if (condition === 'snapshot') store.applyWireSnapshot(device.id, 1, 2, 'Fixture PC', []);
      if (condition === 'revoke') store.revoke(device.id, OWNER);
      if (condition === 'expiry') now += 15 * 60_000;
      service.invalidateUnavailable();
      service.result(device.id, result(input.commandId, { payload: { answer: { text: 'MUST_NOT_BE_RELEASED' } } }));
      assert.ok(!('payload' in await pending), condition);
    } finally { service.close(); store.close(); }
  }
});

test('revocation between result arrival and HTTP continuation is checked again before returning payload', async () => {
  const store = new Store(':memory:'), device = installation(store), { service } = harness(store);
  try {
    const pending = service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'delivery_acl_race', tabId: 't_allowed', action: 'get_last_answer' }));
    const denied = assert.rejects(pending, hasCode('installation_not_found'));
    service.result(device.id, result('delivery_acl_race', { payload: { answer: { text: 'RACING_PRIVATE_PAYLOAD' } } }));
    store.revoke(device.id, OWNER); // Same stack, before the await continuation can return.
    await denied;
  } finally { service.close(); store.close(); }
});

test('cancellation or timeout cannot expose a late answer through duplicate replay', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport } = harness(store, 15);
  try {
    const abortedInput = parseCommand({ commandId: 'abort_read', tabId: 't_allowed', action: 'get_last_answer' });
    const abort = new AbortController(), aborted = service.submit(OWNER, device.token, device.id, abortedInput, abort.signal);
    abort.abort(); assert.ok(!('payload' in await aborted));
    service.result(device.id, result(abortedInput.commandId, { payload: { answer: { text: 'AFTER_ABORT' } } }));
    assert.ok(!('payload' in await service.submit(OWNER, device.token, device.id, abortedInput)));
    const timeoutInput = parseCommand({ commandId: 'timeout_read', tabId: 't_allowed', action: 'get_last_answer' });
    const pending = service.submit(OWNER, device.token, device.id, timeoutInput);
    await delay(30); const timedOut = await pending;
    assert.equal(timedOut.command.status, null); assert.ok(!('payload' in timedOut));
    service.result(device.id, result(timeoutInput.commandId, { payload: { answer: { text: 'AFTER_TIMEOUT' } } }));
    const duplicate = await service.submit(OWNER, device.token, device.id, timeoutInput);
    assert.equal(duplicate.duplicate, true); assert.ok(!('payload' in duplicate));
    assert.equal(transport.sent.length, 2);
  } finally { service.close(); store.close(); }
});

test('disconnection resolves pending reads without pretending a bridge status or redispatching a duplicate', async () => {
  const store = new Store(':memory:'), device = installation(store), { service, transport } = harness(store);
  try {
    const input = parseCommand({ commandId: 'read_disconnect', tabId: 't_allowed', action: 'get_last_answer' });
    const pending = service.submit(OWNER, device.token, device.id, input);
    transport.connected = false; service.disconnected(device.id);
    const receipt = await pending;
    assert.equal(receipt.command.status, null); assert.equal(receipt.command.dispatchState, 'delivery_unknown');
    assert.ok(!('payload' in receipt));
    const duplicate = await service.submit(OWNER, device.token, device.id, input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.command.status, null); assert.equal(transport.sent.length, 1);
  } finally { service.close(); store.close(); }
});

test('uncertain resolves only from later bridge evidence, including queued and accepted; terminal status cannot regress', async () => {
  const store = new Store(':memory:'), device = installation(store), { service } = harness(store);
  try {
    for (const next of ['queued', 'accepted'] as const) {
      const commandId = `late_${next}`;
      await service.submit(OWNER, device.token, device.id,
        parseCommand({ commandId, tabId: 't_allowed', action: 'send', text: 'Fixture prompt' }));
      service.result(device.id, result(commandId, { status: 'uncertain', outcome: null, detailCode: 'uncertain_delivery', requiresComputer: true }));
      await delay(5); assert.equal(service.read(OWNER, device.id, commandId).status, 'uncertain');
      service.result(device.id, result(commandId, { status: next, outcome: null }), false);
      assert.equal(service.read(OWNER, device.id, commandId).status, next);
      service.result(device.id, result(commandId, { status: 'executed', outcome: 'failed' }), false);
      service.result(device.id, result(commandId, { status: 'queued', outcome: null }), false);
      assert.equal(service.read(OWNER, device.id, commandId).status, 'executed');
      assert.equal(service.read(OWNER, device.id, commandId).outcome, 'failed');
    }
  } finally { service.close(); store.close(); }
});

test('nonterminal detail updates retain a changed requiresComputer flag without rewriting wire status', async () => {
  const store = new Store(':memory:'), device = installation(store), { service } = harness(store);
  try {
    await service.submit(OWNER, device.token, device.id,
      parseCommand({ commandId: 'detail_change', tabId: 't_allowed', action: 'send', text: 'Fixture prompt' }));
    service.result(device.id, result('detail_change', { status: 'uncertain', outcome: null, detailCode: 'uncertain_delivery', requiresComputer: true }));
    service.result(device.id, result('detail_change', { status: 'uncertain', outcome: null, detailCode: 'uncertain_delivery', requiresComputer: false }), false);
    assert.equal(service.read(OWNER, device.id, 'detail_change').status, 'uncertain');
    assert.equal(service.read(OWNER, device.id, 'detail_change').detail?.requiresComputer, false);
  } finally { service.close(); store.close(); }
});
