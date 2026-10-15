import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelay } from '../src/server.ts';
import { FIXTURE_BOT_TOKEN } from '../src/fixtures.ts';
import { normalizeCommandResult, normalizeReadPayload } from '../src/command-wire.ts';
import { FakeBridge, connectFixture, fixtureClient, fixtureTab, login, pairFixture, signHello } from '../scripts/fake-bridge.ts';

const installation = { label: 'Commands test', appVersion: '0.11.0', channel: 'nightly' };
const commandPath = (id: string) => `/api/installations/${id}/commands`;
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Condition did not become true');
}
async function setup(extra: Partial<Parameters<typeof createRelay>[0]> = {}) {
  const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, botUsername: 'kuzmich_fixture_bot', fixtureMode: false, readWaitMs: 200, offlineGraceMs: 45000, ...extra });
  const port = await relay.listen(0), url = `http://127.0.0.1:${port}`, token = await login(url), credential = await pairFixture(url, token);
  const pc = await connectFixture(url, credential);
  pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
  await until(() => relay.bridge.commandReady(credential.installationId));
  const request = (path: string, method = 'GET', body?: unknown, bearer = token) => fetch(url + path, { method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { relay, url, token, credential, pc, request, path: commandPath(credential.installationId), async close() { await pc.close(); await relay.close(); } };
}
const result = (commandId: string, status: string, outcome: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ commandId, tabId: fixtureTab().tabId, at: new Date().toISOString(), status, outcome, detail: null, payload: null, ...extra });

test('new-command rate limit has no side effects and idempotent status retrieval still works at the limit', async () => {
  const context = await setup(); const { relay, pc, request, path, credential } = context;
  try {
    const body = { commandId: 'quota_0', tabId: fixtureTab().tabId, action: 'send', text: 'Quota fixture' };
    for (let index = 0; index < 30; index++) {
      assert.equal((await request(path, 'POST', { ...body, commandId: `quota_${index}` })).status, 202);
      await pc.wait('command');
    }
    const blocked = await request(path, 'POST', { ...body, commandId: 'quota_blocked' });
    assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error.code, 'rate_limited');
    assert.equal(relay.store.commands.get(credential.installationId, 'quota_blocked'), undefined);
    const duplicate = await request(path, 'POST', body); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(pc.received.some(value => value.type === 'command'), false);
  } finally { await context.close(); }
});

test('read state/answer payloads are exact transient projections and stop preserves the explicitly chosen turn', async () => {
  const context = await setup(); const { relay, pc, request, path, credential, url, token } = context;
  let socket: WebSocket | undefined; const pushed: string[] = [];
  try {
    socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events'); await once(socket, 'open');
    const initial = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', session_token: token })); await initial;
    socket.on('message', raw => pushed.push(raw.toString()));
    const stateInput = { commandId: 'read_state', tabId: fixtureTab().tabId, action: 'get_state' };
    const statePending = request(path, 'POST', stateInput); await pc.wait('command');
    pc.send('command_result', result(stateInput.commandId, 'executed', 'succeeded', { payload: { state: {
      ...fixtureTab(), title: 'Transient read title', activeTurnId: 'turn-A', actions: { send: false, stop: true, enqueue: true }, blockers: ['PRIVATE_BLOCKER'],
    }, privateExtra: 'PRIVATE_EXTRA' } }));
    const stateResponse = await statePending; assert.equal(stateResponse.status, 200); const state = await stateResponse.json();
    assert.deepEqual(Object.keys(state.payload.state).sort(), ['actions', 'activeTurnId', 'agent', 'project', 'queueLength', 'queuePaused', 'status', 'tabId', 'title', 'updatedAt']);
    assert.deepEqual(state.payload.state.actions, { send: false, stop: true }); assert.equal(state.payload.state.activeTurnId, 'turn-A');
    assert.notEqual(relay.store.tabs(credential.installationId)[0].title, 'Transient read title');
    const stop = { commandId: 'stop_stale', tabId: fixtureTab().tabId, action: 'stop', expectedTurnId: 'turn-A' };
    assert.equal((await request(path, 'POST', stop)).status, 202);
    const wireStop = await pc.wait('command'); assert.equal(wireStop.expectedTurnId, 'turn-A');
    pc.send('command_result', result(stop.commandId, 'rejected', null, { detail: { code: 'stale_turn', message: 'PRIVATE_ERROR_MESSAGE', requiresComputer: false } }));
    await until(() => relay.store.commands.get(credential.installationId, stop.commandId)?.status === 'rejected');
    assert.equal((await (await request(`${path}/${stop.commandId}`)).json()).command.detail.code, 'stale_turn');
    const answerInput = { commandId: 'read_answer', tabId: fixtureTab().tabId, action: 'get_last_answer' };
    const answerPending = request(path, 'POST', answerInput); await pc.wait('command');
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'command_updated', ...result(answerInput.commandId, 'executed', 'succeeded') } });
    pc.send('command_result', result(answerInput.commandId, 'executed', 'succeeded', { payload: { answer: {
      answerId: 'answer-A', turnId: 'turn-A', text: 'PRIVATE_TRANSIENT_ANSWER [path](C:/private)', truncated: false, completedAt: null, cwd: 'PRIVATE_CWD',
    } } }));
    const answer = await (await answerPending).json(); assert.match(answer.payload.answer.text, /PRIVATE_TRANSIENT_ANSWER/);
    assert.deepEqual(Object.keys(answer.payload.answer).sort(), ['answerId', 'completedAt', 'text', 'truncated', 'turnId']);
    assert.equal('payload' in await (await request(path, 'POST', answerInput)).json(), false);
    assert.equal('payload' in await (await request(`${path}/${answerInput.commandId}`)).json(), false);
    assert.equal(pushed.join('\n').includes('PRIVATE_'), false);
    const tables = relay.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const saved = JSON.stringify(tables.map(table => relay.store.db.prepare(`SELECT * FROM ${table.name}`).all()));
    assert.equal(saved.includes('PRIVATE_'), false); assert.equal(saved.includes('Transient read title'), false);
  } finally { socket?.terminate(); await context.close(); }
});

test('2.1 bridge remains readable but commands fail before ledger insertion; malformed and oversized command bodies are rejected', async () => {
  const context = await setup(); const { relay, pc, url, credential, request, path } = context; let old: FakeBridge | undefined;
  try {
    await pc.close(); old = new FakeBridge(url); const challenge = await old.wait('challenge');
    old.send('hello', { installationId: credential.installationId, proof: signHello(credential.privateKey, credential.installationId, String(challenge.nonce)), client: { ...fixtureClient, bridge: '2.1' }, installation });
    await old.wait('welcome'); old.send('snapshot', { epoch: 1, revision: 2, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 2);
    const input = { commandId: 'old_bridge', tabId: fixtureTab().tabId, action: 'send', text: 'Hello' };
    const unsupported = await request(path, 'POST', input); assert.equal(unsupported.status, 409); assert.equal((await unsupported.json()).error.code, 'commands_unsupported');
    assert.equal(relay.store.commands.get(credential.installationId, input.commandId), undefined);
    for (const body of [{ ...input, text: '/danger' }, { ...input, text: 'x'.repeat(32001) }, { ...input, model: 'forbidden' },
      { ...input, action: 'stop', text: undefined }, { ...input, action: 'create_tab' }, { ...input, expectedTurnId: 'not-for-send' }]) {
      assert.equal((await request(path, 'POST', body)).status, 400);
    }
  } finally { await old?.close(); await context.close(); }
});

test('32000 UTF16 multiline send fits the bounded command HTTP body while reply payloads have strict types and allowlists', async () => {
  const context = await setup(); const { pc, request, path } = context;
  try {
    const text = '\n' + 'я'.repeat(31998) + '\n';
    assert.equal((await request(path, 'POST', { commandId: 'long_text', tabId: fixtureTab().tabId, action: 'send', text })).status, 202);
    assert.equal((await pc.wait('command')).text, text);
    assert.throws(() => normalizeCommandResult(result('bad', 'executed', ['succeeded'] as unknown as string)), { code: 'invalid_command_result' });
    const state = { ...fixtureTab(), activeTurnId: null, actions: { send: true, stop: false } };
    for (const changed of [{ agent: ['codex'] }, { status: ['running'] }, { actions: { send: true, stop: 'yes' } }]) {
      assert.throws(() => normalizeReadPayload('get_state', { state: { ...state, ...changed } }, fixtureTab().tabId), { code: 'invalid_read_payload' });
    }
    assert.deepEqual(normalizeReadPayload('get_last_answer', { answer: null }, fixtureTab().tabId), { answer: null });
    const safe = normalizeCommandResult(result('safe', 'rejected', null, { detail: { code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE', requiresComputer: false } }));
    assert.equal(safe.detailCode, 'unavailable'); assert.equal(JSON.stringify(safe).includes('PRIVATE_'), false);
  } finally { await context.close(); }
});

test('read payload is dropped after a full snapshot removes the tab, including a later successful response', async () => {
  const context = await setup(); const { relay, pc, request, path, credential } = context;
  try {
    const pending = request(path, 'POST', { commandId: 'revoked_read', tabId: fixtureTab().tabId, action: 'get_last_answer' }); await pc.wait('command');
    pc.send('snapshot', { epoch: 1, revision: 2, installation, tabs: [], truncated: false });
    pc.send('command_result', result('revoked_read', 'executed', 'succeeded', { payload: { answer: { answerId: 'a', turnId: 't', text: 'PRIVATE_AFTER_REVOKE', truncated: false, completedAt: null } } }));
    const response = await pending; assert.equal('payload' in await response.json(), false);
    await until(() => relay.store.installation(credential.installationId).revision === 2);
    assert.equal((await request(path, 'POST', { commandId: 'new_hidden', tabId: fixtureTab().tabId, action: 'send', text: 'not sent' })).status, 404);
    assert.equal(relay.store.commands.get(credential.installationId, 'new_hidden'), undefined);
  } finally { await context.close(); }
});

test('HTTP dispatch is immediate, duplicates never send twice and wire statuses/outcomes are preserved', async () => {
  const context = await setup(); const { relay, pc, request, path, credential } = context;
  const received: unknown[] = []; pc.socket.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'command') received.push(value); });
  try {
    const input = { commandId: 'send_one', tabId: fixtureTab().tabId, action: 'send', text: '  exact\nmultiline body  ' };
    const response = await request(path, 'POST', input); assert.equal(response.status, 202);
    const receipt = await response.json(); assert.equal(receipt.command.status, null); assert.equal(receipt.duplicate, false);
    const sent = await pc.wait('command'); assert.equal(sent.text, input.text); assert.equal(sent.userRef, relay.store.installationUserRef(credential.installationId, '10001'));
    assert.equal(sent.userRef === '10001', false);
    pc.send('command_result', result(input.commandId, 'queued'));
    await until(() => relay.store.commands.get(credential.installationId, input.commandId)?.status === 'queued');
    assert.equal((await (await request(path, 'POST', input)).json()).duplicate, true);
    assert.equal((await request(path, 'POST', { ...input, text: 'different' })).status, 409);
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'command_updated', ...result(input.commandId, 'accepted') } });
    await until(() => relay.store.commands.get(credential.installationId, input.commandId)?.status === 'accepted');
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'command_updated', ...result(input.commandId, 'executed', 'failed') } });
    await until(() => relay.store.commands.get(credential.installationId, input.commandId)?.status === 'executed');
    const status = await (await request(`${path}/${input.commandId}`)).json();
    assert.equal(status.command.status, 'executed'); assert.equal(status.command.outcome, 'failed');
    assert.equal(JSON.stringify(status).includes(input.text), false); assert.equal(received.length, 1);
    const sql = JSON.stringify(relay.store.db.prepare('SELECT * FROM command_ledger').all()); assert.equal(sql.includes('multiline body'), false);
  } finally { await context.close(); }
});

test('offline presence grace and a reconnected bridge without full snapshot cannot receive new commands', async () => {
  const context = await setup(); const { relay, pc, credential, url, request, path } = context; let next: FakeBridge | undefined;
  try {
    await pc.close(); await until(() => !relay.bridge.commandReady(credential.installationId));
    assert.equal(relay.store.installations('10001')[0].online, true);
    const input = { commandId: 'offline_one', tabId: fixtureTab().tabId, action: 'send', text: 'never queue' };
    assert.equal((await request(path, 'POST', input)).status, 409); assert.equal(relay.store.commands.get(credential.installationId, input.commandId), undefined);
    next = await connectFixture(url, credential);
    assert.equal((await request(path, 'POST', input)).status, 409);
    next.send('snapshot', { epoch: 1, revision: 2, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.bridge.commandReady(credential.installationId));
    assert.equal(next.received.some(frame => frame.type === 'command'), false);
  } finally { await next?.close(); await context.close(); }
});
