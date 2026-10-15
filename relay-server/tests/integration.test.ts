import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelay, type RelayOptions } from '../src/server.ts';
import { FIXTURE_BOT_TOKEN, fixtureInitData } from '../src/fixtures.ts';
import { opaqueToken } from '../src/security.ts';
import { FakeBridge, connectFixture, fixtureClient, fixtureTab, generateFixtureKeys, signHello, login, pairFixture } from '../scripts/fake-bridge.ts';

async function start(options: Partial<RelayOptions> = {}) {
  const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, botUsername: 'kuzmich_fixture_bot', fixtureMode: true, offlineGraceMs: 0, ...options });
  const port = await relay.listen(0); return { relay, url: `http://127.0.0.1:${port}` };
}
async function api(url: string, path: string, token: string, method = 'GET', body?: unknown) {
  return fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Condition did not become true');
}
const installation = { label: 'Тестовый ПК', appVersion: '0.11.0', channel: 'nightly' };

test('unsolicited command_result payload and command_updated content are discarded without persistence or Mini App forwarding', async () => {
  const { relay, url } = await start({ fixtureMode: false }); let pc: FakeBridge | undefined; let socket: WebSocket | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token); pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events'); await once(socket, 'open');
    const initial = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', session_token: token })); await initial;
    const pushed = once(socket, 'message');
    pc.send('command_result', { commandId: 'future_cmd', status: 'executed', payload: { text: 'PRIVATE_TRANSIENT_ANSWER' }, detail: { message: 'PRIVATE_COMMAND_DETAIL' } });
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'command_updated', commandId: 'future_cmd', payload: 'PRIVATE_EVENT_PAYLOAD' } });
    pc.send('snapshot', { epoch: 1, revision: 3, installation, tabs: [fixtureTab()], truncated: false });
    const message = String((await pushed)[0]); assert.equal(JSON.parse(message).type, 'snapshot'); assert.equal(message.includes('PRIVATE_'), false);
    assert.equal(relay.store.db.prepare('SELECT count(*) AS n FROM command_ledger').get()?.n, 0);
    const tables = relay.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const saved = JSON.stringify(tables.map(table => relay.store.db.prepare(`SELECT * FROM ${table.name}`).all()));
    assert.equal(saved.includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(await (await api(url, '/api/installations', token)).json()).includes('PRIVATE_'), false);
  } finally { socket?.terminate(); await pc?.close(); await relay.close(); }
});

test('unknown bridge event kinds are ignored without tearing down the connection', async () => {
  const { relay, url } = await start(); let pc: FakeBridge | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token); pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'future_event_kind', secret: 'ignored' } });
    pc.send('snapshot', { epoch: 1, revision: 2, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 2);
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'notice', tabId: fixtureTab().tabId, noticeKind: 'future_notice', occurredAt: new Date().toISOString(), turnId: null } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pc.socket.readyState, WebSocket.OPEN);
  } finally { await pc?.close(); await relay.close(); }
});

test('payload-wrapped notice is ignored without disconnecting or notifying', async () => {
  const sent: string[] = [];
  const { relay, url } = await start({ fetchImpl: async (_input, init) => {
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }}); let pc: FakeBridge | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token); pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    const notice = { tabId: fixtureTab().tabId, noticeKind: 'action_required', turnId: null, occurredAt: new Date().toISOString() };
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'notice', payload: notice } });
    await until(() => relay.store.installation(credential.installationId).revision === 2);
    assert.equal(pc.socket.readyState, WebSocket.OPEN);
    assert.equal(sent.length, 0);
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'notice', ...notice } });
    await until(() => sent.length === 1);
    assert.equal(relay.store.installation(credential.installationId).revision, 3);
    assert.equal(pc.socket.readyState, WebSocket.OPEN);
    assert.match(sent[0], /Требуется действие на компьютере/);
  } finally { await pc?.close(); await relay.close(); }
});

test('notification settings default on and notice delivery is metadata-only and deduplicated', async () => {
  const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
  const { relay, url } = await start({ fetchImpl: async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }}); let pc: FakeBridge | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token); pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    assert.deepEqual(await (await api(url, '/api/notifications', token)).json(), { turnCompleted: true, actionRequired: true, commandFailed: true, presence: true });
    assert.equal((await api(url, '/api/notifications', token, 'PUT', { turnCompleted: false })).status, 200);
    const occurredAt = new Date().toISOString();
    pc.send('event', { epoch: 1, revision: 2, event: { kind: 'notice', tabId: fixtureTab().tabId, noticeKind: 'action_required', turnId: null, occurredAt } });
    await until(() => sent.length === 1);
    assert.match(sent[0].url, /api\.telegram\.org\/bot/);
    assert.equal(sent[0].body.chat_id, '10001');
    assert.match(sent[0].body.text, /Тестовый ПК/); assert.match(sent[0].body.text, /Проверка локальной сборки/);
    assert.equal(sent[0].body.text.includes('ignored'), false);
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'notice', tabId: fixtureTab().tabId, noticeKind: 'action_required', turnId: null, occurredAt } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sent.length, 1);
    assert.equal((await api(url, '/api/notifications', token, 'PUT', { turnCompleted: true })).status, 200);
    pc.send('event', { epoch: 1, revision: 4, event: { kind: 'notice', tabId: fixtureTab().tabId, noticeKind: 'turn_completed', turnId: null, occurredAt: new Date().toISOString() } });
    await until(() => sent.length === 2);
    assert.match(sent[1].body.text, /Задача завершена/);
  } finally { await pc?.close(); await relay.close(); }
});

test('production hello rejects replay, wrong key, cross-installation proof and second attempt on one challenge', async () => {
  const { relay, url } = await start({ fixtureMode: false }); let pc: FakeBridge | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token), other = await pairFixture(url, token);
    pc = new FakeBridge(url); const first = await pc.wait('challenge');
    const oldProof = signHello(credential.privateKey, credential.installationId, String(first.nonce));
    pc.send('hello', { installationId: credential.installationId, proof: oldProof, client: fixtureClient, installation });
    assert.equal((await pc.wait('welcome')).serverProtocol, '2.3'); await pc.close();
    for (const attack of ['replay', 'wrong_key', 'other_installation', 'retry'] as const) {
      pc = new FakeBridge(url); const challenge = await pc.wait('challenge');
      assert.notEqual(challenge.nonce, first.nonce);
      const id = attack === 'other_installation' ? other.installationId : credential.installationId;
      const proof = attack === 'replay' ? oldProof : signHello(attack === 'wrong_key' || attack === 'retry' ? generateFixtureKeys().privateKey : credential.privateKey, id, String(challenge.nonce));
      pc.send('hello', { installationId: id, proof, client: fixtureClient, installation });
      if (attack === 'retry') pc.send('hello', { installationId: id, proof: signHello(credential.privateKey, id, String(challenge.nonce)), client: fixtureClient, installation });
      assert.equal((await pc.wait('error')).code, 'device_unauthorized'); await pc.close();
      assert.equal(pc.received.some(value => value.type === 'welcome'), false);
    }
    await api(url, `/api/installations/${credential.installationId}`, token, 'DELETE');
    pc = new FakeBridge(url); const challenge = await pc.wait('challenge');
    pc.send('hello', { installationId: credential.installationId, proof: signHello(credential.privateKey, credential.installationId, String(challenge.nonce)), client: fixtureClient, installation });
    assert.equal((await pc.wait('error')).code, 'device_unauthorized');
  } finally { await pc?.close(); await relay.close(); }
});

test('challenge expiry is checked before proof verification even if its timeout callback has not fired', async () => {
  let now = Date.now(); const { relay, url } = await start({ fixtureMode: false, now: () => now }); let pc: FakeBridge | undefined;
  try {
    const token = await login(url, 10001, now), credential = await pairFixture(url, token); pc = new FakeBridge(url);
    const challenge = await pc.wait('challenge'); now += 30000;
    pc.send('hello', { installationId: credential.installationId, proof: signHello(credential.privateKey, credential.installationId, String(challenge.nonce)), client: fixtureClient, installation });
    assert.equal((await pc.wait('error')).code, 'authentication_timeout');
    assert.equal(relay.store.installations('10001')[0].online, false);
  } finally { await pc?.close(); await relay.close(); }
});
function cleanup(directory: string): void {
  const target = realpathSync(directory);
  assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('relay-restart-'));
  rmSync(target, { recursive: true, force: true });
}

test('static Telegram launch query loads while authenticated API query credentials remain forbidden', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-restart-static-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Fixture Mini App</title>');
  const { relay, url } = await start({ staticDirectory: directory });
  try {
    const response = await fetch(url + '/?tgWebAppStartParam=fixture_nonce');
    assert.equal(response.status, 200); assert.match(await response.text(), /Fixture Mini App/);
    const token = await login(url);
    assert.equal((await api(url, '/api/installations?token=secret', token)).status, 400);
  } finally { await relay.close(); cleanup(directory); }
});

test('evicted session cannot receive pushed state before its nominal expiry', async () => {
  let now = Date.now(); const { relay, url } = await start({ now: () => now }); let socket: WebSocket | undefined;
  try {
    const token = await login(url, 10001, now);
    socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events'); await once(socket, 'open');
    const initial = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', session_token: token })); await initial;
    for (let index = 0; index < 10; index++) {
      now += 1; relay.store.createSession({ telegram_id: '10001', display_name: 'Fixture' });
    }
    const closed = once(socket, 'close'); const unexpected: unknown[] = []; socket.on('message', data => unexpected.push(data));
    relay.bridge.changed('10001');
    assert.equal((await closed)[0], 4001); assert.deepEqual(unexpected, []);
  } finally { socket?.terminate(); await relay.close(); }
});

test('production Ed25519 pairing and public-key authentication survive relay restart with durable view revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-restart-'));
  let state = await start({ database: join(directory, 'relay.sqlite'), fixtureMode: false }); let pc: FakeBridge | undefined;
  try {
    const token = await login(state.url), credential = await pairFixture(state.url, token); pc = await connectFixture(state.url, credential);
    pc.send('snapshot', { epoch: 4, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => state.relay.store.installation(credential.installationId).revision === 1);
    const previous = state.relay.snapshot('10001');
    await pc.close(); await state.relay.close();
    state = await start({ database: join(directory, 'relay.sqlite'), fixtureMode: false });
    const next = await (await api(state.url, '/api/installations', token)).json();
    assert.ok(next.revision > previous.revision); assert.equal(next.installations[0].online, false);
    assert.equal(next.installations[0].tabs.length, 1);
    pc = await connectFixture(state.url, credential);
    assert.equal(state.relay.store.installation(credential.installationId).public_key, credential.publicKey);
    pc.send('snapshot', { epoch: 4, revision: 2, installation, tabs: [fixtureTab({ queueLength: 4, queuePaused: true })], truncated: false });
    await until(() => state.relay.store.installation(credential.installationId).revision === 2);
    assert.equal(state.relay.store.tabs(credential.installationId)[0].queueLength, 4);
    assert.equal(state.relay.store.tabs(credential.installationId)[0].queuePaused, true);
    await pairFixture(state.url, token);
    assert.equal(state.relay.store.installations('10001').length, 2);
    assert.equal((await fetch(state.url + '/api/dev/init-data')).status, 404);
  } finally { await pc?.close(); await state.relay.close(); cleanup(directory); }
});

test('Mini App WS authenticates, resyncs full owned state and expires', async () => {
  const { relay, url } = await start({ sessionTtlMs: 200 }); let socket: WebSocket | undefined;
  try {
    const token = await login(url);
    socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events'); await once(socket, 'open');
    const initial = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', session_token: token }));
    assert.deepEqual(JSON.parse(String((await initial)[0])), { type: 'snapshot', revision: 0, installations: [] });
    const next = once(socket, 'message'); socket.send(JSON.stringify({ type: 'resync' }));
    assert.equal(JSON.parse(String((await next)[0])).type, 'snapshot');
    assert.equal((await once(socket, 'close'))[0], 4001);
    assert.equal((await api(url, '/api/installations', token)).status, 401);
  } finally { socket?.terminate(); await relay.close(); }
});

test('pairing unknown minor frame is ignored; confirmation must bind the shown claimant and does not issue early', async () => {
  const { relay, url } = await start(); const pc = new FakeBridge(url);
  try {
    const token = await login(url), nonce = opaqueToken(), pairingId = randomUUID();
    await pc.wait('challenge');
    pc.send('pair_start', { pairingId, nonceHash: createHash('sha256').update(nonce).digest('base64url'), publicKey: generateFixtureKeys().publicKey, client: fixtureClient, installation });
    await pc.wait('pair_pending'); pc.send('future_minor_frame', { harmless: true });
    assert.equal((await api(url, '/api/pairings/claim', token, 'POST', { nonce, confirm: false })).status, 400);
    assert.equal((await api(url, '/api/pairings/claim', token, 'POST', { nonce, confirm: true })).status, 200);
    await pc.wait('pair_claimed');
    assert.deepEqual(relay.store.installations('10001'), []);
    pc.send('pair_confirm', { pairingId, nonce, claimantUserId: '10002' });
    assert.equal((await pc.wait('error')).code, 'pairing_confirmation_invalid');
    assert.deepEqual(relay.store.installations('10001'), []);
  } finally { await pc.close(); await relay.close(); }
});

test('desktop pairing confirmation rejects a nonce different from the original PC hash', async () => {
  const { relay, url } = await start(); const pc = new FakeBridge(url);
  try {
    const token = await login(url), nonce = opaqueToken(), pairingId = randomUUID();
    await pc.wait('challenge');
    pc.send('pair_start', { pairingId, nonceHash: createHash('sha256').update(nonce).digest('base64url'), publicKey: generateFixtureKeys().publicKey, client: fixtureClient, installation });
    assert.equal((await pc.wait('pair_pending')).botUsername, 'kuzmich_fixture_bot');
    assert.equal((await api(url, '/api/pairings/claim', token, 'POST', { nonce, confirm: true })).status, 200);
    await pc.wait('pair_claimed');
    pc.send('pair_confirm', { pairingId, nonce: opaqueToken(), claimantUserId: '10001' });
    assert.equal((await pc.wait('error')).code, 'pairing_confirmation_invalid');
    assert.deepEqual(relay.store.installations('10001'), []);
  } finally { await pc.close(); await relay.close(); }
});

test('heartbeat timeout makes an installation offline after grace without changing tab state', async () => {
  let now = Date.now(); const { relay, url } = await start({ now: () => now, heartbeatMs: 30, offlineGraceMs: 10 });
  let pc: FakeBridge | undefined;
  try {
    const token = await login(url, 10001, now), credential = await pairFixture(url, token); pc = await connectFixture(url, credential); pc.autoPong = false;
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    now += 31; await pc.wait('ping'); const closed = once(pc.socket, 'close'); now += 10001;
    assert.equal((await closed)[0], 4003);
    await until(() => !relay.store.installations('10001')[0].online);
    assert.equal(relay.store.tabs(credential.installationId).length, 1);
  } finally { await pc?.close(); await relay.close(); }
});

test('HTTP auth never trusts unsafe identity, fixture routes reject tunnels and cross-origin calls', async () => {
  const { relay, url } = await start();
  try {
    const response = await fetch(url + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: fixtureInitData(), initDataUnsafe: { user: { id: 999 } } }) });
    assert.equal(response.status, 400);
    assert.equal((await fetch(url + '/api/dev/init-data', { headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Forwarded-Proto': 'https' } })).status, 400);
    assert.equal((await fetch(url + '/api/dev/init-data', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })).status, 400);
    assert.equal((await fetch(url + '/api/dev/init-data', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    const token = await login(url);
    assert.equal((await api(url, '/api/installations?session_token=secret', token)).status, 400);
    assert.equal((await api(url, '/api/installations', token, 'POST', { grant: true })).status, 404);
  } finally { await relay.close(); }
});

test('full contract pairing and bridge snapshot expose only owned installations and eight tab fields', async () => {
  const { relay, url } = await start(); let pc: FakeBridge | undefined;
  try {
    const first = await login(url), other = await login(url, 10002);
    const credential = await pairFixture(url, first);
    pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab({ cwd: 'SECRET_PATH', text: 'SECRET_CHAT', model: 'SECRET_MODEL', approvals: 'SECRET_APPROVAL' })], truncated: false, extra: 'SECRET_FRAME' });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    const snapshot = await (await api(url, '/api/installations', first)).json();
    assert.equal(snapshot.installations[0].online, true);
    assert.match(snapshot.installations[0].last_seen, /Z$/);
    assert.deepEqual(Object.keys(snapshot.installations[0].tabs[0]).sort(), ['agent', 'project', 'queueLength', 'queuePaused', 'status', 'tab_id', 'title', 'updatedAt']);
    assert.equal(JSON.stringify(snapshot).includes('SECRET_'), false);
    const database = JSON.stringify(['tabs', 'installations', 'pairings', 'audit', 'sessions'].flatMap(table => relay.store.db.prepare(`SELECT * FROM ${table}`).all()));
    for (const forbidden of ['SECRET_', credential.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), first]) assert.equal(database.includes(forbidden), false);
    assert.deepEqual((await (await api(url, '/api/installations', other)).json()).installations, []);
    assert.equal((await api(url, `/api/installations/${credential.installationId}`, other)).status, 404);
    assert.equal((await api(url, `/api/installations/${credential.installationId}`, other, 'DELETE')).status, 404);
    assert.equal((await api(url, '/api/commands', first, 'POST', { text: 'do not execute' })).status, 404);
    await pairFixture(url, first, 10001, 'Второй ПК');
    assert.equal((await (await api(url, '/api/installations', first)).json()).installations.length, 2);
    const revoked = pc.wait('revoked');
    assert.equal((await api(url, `/api/installations/${credential.installationId}`, first, 'DELETE')).status, 200);
    await revoked;
    assert.equal(relay.store.db.prepare('SELECT count(*) AS n FROM tabs').get()?.n, 0);
  } finally { await pc?.close(); await relay.close(); }
});

test('gaps request resync; stale sequence is ignored; full snapshots remove stale tabs and new connections require snapshot', async () => {
  const { relay, url } = await start(); let pc: FakeBridge | undefined; let second: FakeBridge | undefined;
  try {
    const token = await login(url), credential = await pairFixture(url, token); pc = await connectFixture(url, credential);
    pc.send('snapshot', { epoch: 1, revision: 1, installation, tabs: [fixtureTab()], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 1);
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'tab_removed', tabId: fixtureTab().tabId } });
    assert.equal((await pc.wait('resync_request')).reason, 'gap');
    assert.equal(relay.store.tabs(credential.installationId).length, 1);
    pc.send('snapshot', { epoch: 1, revision: 4, installation, tabs: [], truncated: false });
    await until(() => relay.store.installation(credential.installationId).revision === 4);
    pc.send('event', { epoch: 1, revision: 3, event: { kind: 'tab_updated', tab: fixtureTab() } });
    pc.send('event', { epoch: 1, revision: 5, event: { kind: 'tab_updated', tab: fixtureTab({ status: 'running' }) } });
    await until(() => relay.store.installation(credential.installationId).revision === 5);
    const oldClosed = once(pc.socket, 'close'); second = await connectFixture(url, credential);
    assert.equal((await oldClosed)[0], 4005);
    second.send('event', { epoch: 1, revision: 6, event: { kind: 'tab_removed', tabId: fixtureTab().tabId } });
    await second.wait('resync_request');
    assert.equal(relay.store.tabs(credential.installationId).length, 1);
    second.send('snapshot', { epoch: 2, revision: 1, installation, tabs: [], truncated: false });
    await until(() => relay.store.installation(credential.installationId).epoch === 2);
    second.send('event', { epoch: 1, revision: 100, event: { kind: 'tab_updated', tab: fixtureTab() } });
    assert.equal(relay.store.tabs(credential.installationId).length, 0);
  } finally { await pc?.close(); await second?.close(); await relay.close(); }
});
