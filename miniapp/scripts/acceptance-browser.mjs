// Workspace acceptance test: uses the existing root Playwright and installed Edge.
// Node 24 runs the relay's erasable TypeScript directly. No Telegram requests are permitted.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';
import { createServer as createVite } from '../node_modules/vite/dist/node/index.js';
import { createRelay } from '../../relay-server/src/server.ts';
import { FIXTURE_BOT_TOKEN, fixtureInitData } from '../../relay-server/src/fixtures.ts';
import { FakeBridge, fixtureClient, fixtureTab, login } from '../../relay-server/scripts/fake-bridge.ts';

const output = new URL('../test-results/browser/', import.meta.url);
await mkdir(output, { recursive: true });
const label = 'Мастерская';
const deviceKeys = generateKeyPairSync('ed25519'); // Fake PC only; never sent to relay.
const publicKey = deviceKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const privateDer = deviceKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const nonce = randomBytes(32).toString('base64url'), pairingId = randomUUID();
const client = { ...fixtureClient, bridge: '2.2' };
const external = [], errors = [], httpErrors = [];
const forwarded = new Map();
let offlineProbe = false, revoking = false, expectedOfflineErrors = 0;
const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, botUsername: 'kuzmich_fixture_bot', fixtureMode: false });
let browser, vite, pairingPc, pc, page;
let revision = 0;
let phase = 'pairing', lastFrameAt = 0, sendTail = Promise.resolve();

function send(bridge, type, fields) {
  const serialized = JSON.stringify(fields);
  assert.ok(!serialized.includes(privateDer) && !serialized.includes('privateKey') && !serialized.includes('deviceSecret'));
  // The contract limits bridge traffic to 10 frames/s. The emulator observes that limit too.
  sendTail = sendTail.then(async () => {
    const delay = Math.max(0, 150 - (Date.now() - lastFrameAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    bridge.send(type, fields); lastFrameAt = Date.now();
  });
  return sendTail;
}

async function waitCommand(label) {
  phase = label;
  return pc.wait('command', 5000);
}

async function connect(url, installationId) {
  const bridge = new FakeBridge(url);
  const challenge = await bridge.wait('challenge');
  assert.equal(challenge.serverProtocol, '2.2');
  const proof = sign(null, Buffer.from(`kuzmich-bridge-v2\n${installationId}\n${challenge.nonce}`), deviceKeys.privateKey).toString('base64url');
  send(bridge, 'hello', { installationId, proof, client, installation: { label }, resume: { epoch: 1, revision: Math.max(1, revision) } });
  const welcome = await bridge.wait('welcome');
  assert.equal(welcome.serverProtocol, '2.2');
  bridge.socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'command') forwarded.set(message.commandId, (forwarded.get(message.commandId) ?? 0) + 1);
  });
  return bridge;
}

function commandResult(command, status, outcome = null, payload = null, code = null) {
  send(pc, 'command_result', { commandId: command.commandId, tabId: command.tabId, at: new Date().toISOString(), status, outcome,
    detail: code ? { code, message: code, requiresComputer: status === 'uncertain' } : null, payload });
}

function commandUpdate(command, status, outcome = null, code = null) {
  send(pc, 'event', { epoch: 1, revision: ++revision, event: { kind: 'command_updated',
    commandId: command.commandId, tabId: command.tabId, at: new Date().toISOString(), status, outcome,
    detail: code ? { code, message: code, requiresComputer: status === 'uncertain' } : null } });
}

try {
  const port = await relay.listen(0);
  const relayUrl = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${relayUrl}/health`)).json()).bridge_ready, true);
  pairingPc = new FakeBridge(relayUrl);
  await pairingPc.wait('challenge');
  send(pairingPc, 'pair_start', { pairingId, nonceHash: createHash('sha256').update(nonce).digest('base64url'), publicKey, client, installation: { label } });
  const pending = await pairingPc.wait('pair_pending');
  assert.equal(pending.botUsername, 'kuzmich_fixture_bot');

  process.env.VITE_LOCAL_RELAY = '0';
  process.env.VITE_TELEGRAM_FIXTURE = '0';
  process.env.VITE_RELAY_URL = `${relayUrl}/api`;
  vite = await createVite({ root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 5173, strictPort: true }, logLevel: 'error' });
  await vite.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.origin);
      socket.close();
    } else socket.connectToServer();
  });
  page = await context.newPage();
  await page.addInitScript(initData => {
    window.Telegram = { WebApp: { initData, ready() {}, expand() {} } };
  }, fixtureInitData(Date.now(), 10001, nonce));
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400) return;
    if (offlineProbe && response.status() === 409 && response.request().method() === 'POST' && response.url().endsWith('/commands')) {
      expectedOfflineErrors++; return;
    }
    if (revoking && response.status() === 404 && response.request().method() === 'GET' && response.url().includes('/commands/')) return;
    httpErrors.push(response.status());
  });
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Подтвердить привязку', exact: true }).waitFor();
  assert.equal(relay.store.installations('10001').length, 0);
  await page.getByRole('button', { name: 'Подтвердить привязку', exact: true }).click();
  const claimed = await pairingPc.wait('pair_claimed');
  assert.equal(claimed.claimant.telegramUserId, '10001');
  assert.equal(relay.store.installations('10001').length, 0, 'phone confirmation alone cannot create a device');
  send(pairingPc, 'pair_confirm', { pairingId, nonce, claimantUserId: '10001' });
  const complete = await pairingPc.wait('pair_complete');
  assert.ok(!('deviceSecret' in complete) && !('privateKey' in complete));
  await pairingPc.close();
  pc = await connect(relayUrl, complete.installationId);

  const firstTime = '2026-10-14T10:00:00.000Z', secondTime = '2026-10-14T09:58:00.000Z';
  let firstTab = fixtureTab({ status: 'idle', queueLength: 0, queuePaused: false, updatedAt: firstTime });
  const secondTab = fixtureTab({ tabId: 't_second', title: 'Документация', agent: 'claude', status: 'idle', queueLength: 3, queuePaused: true, updatedAt: secondTime });
  const publish = () => send(pc, 'snapshot', { epoch: 1, revision: ++revision,
    installation: { label, appVersion: '0.11.0', channel: 'nightly' }, tabs: [firstTab, secondTab], truncated: false });
  publish();
  await page.getByRole('heading', { name: label, exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Кузьмич на связи', exact: true }).waitFor();
  await page.getByText(/живые обновления/).waitFor();
  await page.getByText('В очереди: 3', { exact: true }).waitFor();
  await page.getByText('Очередь приостановлена', { exact: true }).waitFor();
  assert.equal(await page.locator('.tab-row').nth(1).locator('time').getAttribute('datetime'), secondTime);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), fullPage: true });

  const changedTime = '2026-10-14T10:02:00.000Z';
  firstTab = fixtureTab({ status: 'running', queueLength: 2, queuePaused: true, updatedAt: changedTime });
  send(pc, 'event', { epoch: 1, revision: ++revision, event: { kind: 'tab_updated', tab: firstTab } });
  await page.getByText('В очереди: 2', { exact: true }).waitFor();
  assert.equal(await page.locator('.tab-row').first().locator('time').getAttribute('datetime'), changedTime);
  assert.equal(await page.getByText('Очередь приостановлена', { exact: true }).count(), 2);

  await pc.close();
  pc = await connect(relayUrl, complete.installationId);
  firstTab = { ...firstTab, queueLength: 1, queuePaused: false, updatedAt: '2026-10-14T10:03:00.000Z' };
  publish(); // Same epoch, higher revision; authenticate against a fresh challenge.
  await page.getByText('В очереди: 1', { exact: true }).waitFor();
  assert.equal(await page.getByText('Очередь приостановлена', { exact: true }).count(), 1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), fullPage: true });

  // Stage 3: the fake PC drives each status explicitly. No timer invents a server status.
  const row = page.locator('.tab-row').first();
  const status = value => row.locator(`.command-status.status-${value}`);
  const apiToken = await login(relayUrl);
  const installationId = complete.installationId;
  const post = body => fetch(`${relayUrl}/api/installations/${installationId}/commands`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const query = commandId => fetch(`${relayUrl}/api/installations/${installationId}/commands/${commandId}`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  const publishTab = changes => {
    firstTab = { ...firstTab, ...changes };
    return send(pc, 'event', { epoch: 1, revision: ++revision, event: { kind: 'tab_updated', tab: firstTab } });
  };
  publishTab({ status: 'idle', queueLength: 0, queuePaused: false });
  await row.getByText('В очереди: 0', { exact: true }).waitFor();
  const commandText = 'COMMAND_BODY_FIXTURE_6c489c\nПроверь локальную фикстуру.';
  await row.getByLabel('Отправить текст', { exact: true }).fill(commandText);
  await row.getByRole('button', { name: 'Отправить', exact: true }).click();
  const sent = await waitCommand('first-send');
  assert.equal(sent.action, 'send'); assert.equal(sent.text, commandText);
  assert.equal(sent.tabId, firstTab.tabId);
  assert.match(sent.userRef, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(sent.userRef, '10001');
  const duplicate = await post({ commandId: sent.commandId, tabId: sent.tabId, action: 'send', text: commandText });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200); assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.command.status, null, 'a receipt is not a fabricated bridge ACK');
  commandResult(sent, 'queued');
  await status('queued').waitFor();
  commandUpdate(sent, 'accepted');
  await status('accepted').waitFor();
  commandUpdate(sent, 'executed', 'succeeded');
  await status('executed').waitFor();
  assert.equal(forwarded.get(sent.commandId), 1);
  const conflict = await post({ commandId: sent.commandId, tabId: sent.tabId, action: 'send', text: 'changed body' });
  assert.equal(conflict.status, 409);

  // The PC executes once, but its final result is lost. Its durable operation journal
  // answers the transport replay after reconnect without invoking execution again.
  const replayText = 'REPLAY_COMMAND_BODY_FIXTURE_6c489c';
  await row.getByLabel('Отправить текст', { exact: true }).fill(replayText);
  await row.getByRole('button', { name: 'Отправить', exact: true }).click();
  const lostResult = await waitCommand('send-with-lost-result');
  commandResult(lostResult, 'queued'); await status('queued').waitFor();
  const operationJournal = new Map();
  let replayExecutions = 0;
  const getOperation = command => {
    if (!operationJournal.has(command.commandId)) {
      replayExecutions++;
      operationJournal.set(command.commandId, { status: 'executed', outcome: 'succeeded' });
    }
    return operationJournal.get(command.commandId);
  };
  getOperation(lostResult); // Intentionally do not deliver this terminal result.
  await pc.close();
  pc = await connect(relayUrl, installationId);
  assert.equal((await (await query(lostResult.commandId)).json()).command.status, 'queued');
  assert.equal(forwarded.get(lostResult.commandId), 1, 'welcome alone cannot trigger replay');
  await publish();
  const redelivered = await waitCommand('replay-after-fresh-snapshot');
  for (const field of ['commandId', 'tabId', 'userRef', 'action', 'text', 'deadline']) {
    assert.equal(redelivered[field], lostResult[field], `replay must preserve ${field}`);
  }
  assert.equal(forwarded.get(lostResult.commandId), 2);
  const recovered = getOperation(redelivered);
  assert.equal(replayExecutions, 1);
  // Further full snapshots on the same connection are resync, not new delivery cycles.
  for (const time of ['2026-10-14T10:03:10.000Z', '2026-10-14T10:03:11.000Z']) {
    firstTab = { ...firstTab, updatedAt: time };
    await publish();
    await page.waitForFunction(expected => document.querySelector('.tab-row time')?.getAttribute('datetime') === expected, time);
  }
  assert.equal(forwarded.get(lostResult.commandId), 2, 'only one replay on this connection');
  commandResult(redelivered, recovered.status, recovered.outcome);
  await status('executed').waitFor();
  assert.equal((await (await query(lostResult.commandId)).json()).command.status, 'executed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: fileURLToPath(new URL('replay-mobile.png', output)), fullPage: true });
  await pc.close();
  pc = await connect(relayUrl, installationId);
  firstTab = { ...firstTab, updatedAt: '2026-10-14T10:03:12.000Z' };
  await publish();
  await page.waitForFunction(() => document.querySelector('.tab-row time')?.getAttribute('datetime') === '2026-10-14T10:03:12.000Z');
  assert.equal(forwarded.get(lostResult.commandId), 2, 'terminal commands must not replay');
  assert.equal(forwarded.get(sent.commandId), 1, 'earlier terminal command must not replay either');

  await row.getByLabel('Отправить текст', { exact: true }).fill('UNCERTAIN_BODY_FIXTURE_6c489c');
  await row.getByRole('button', { name: 'Отправить', exact: true }).click();
  const uncertain = await waitCommand('uncertain-send');
  commandResult(uncertain, 'uncertain', null, null, 'uncertain_delivery');
  await status('uncertain').getByText('Требуется проверка на компьютере', { exact: true }).waitFor();
  assert.equal(await status('uncertain').getByRole('button', { name: /повторить|отправить/i }).count(), 0);
  await status('uncertain').getByRole('button').click();
  assert.equal((await (await query(uncertain.commandId)).json()).command.status, 'uncertain');
  assert.equal(forwarded.get(uncertain.commandId), 1);
  commandUpdate(uncertain, 'accepted');
  await row.locator('.command-status').getByRole('button').click();
  await status('accepted').waitFor();
  commandUpdate(uncertain, 'executed', 'succeeded');
  await status('executed').waitFor();

  await row.getByRole('button', { name: 'Последний ответ', exact: true }).click();
  const reading = await waitCommand('read-last-answer');
  assert.equal(reading.action, 'get_last_answer');
  const answerText = 'ANSWER_TRANSIT_ONLY_6c489c\nГотово. https://invalid.example/never-fetch <img src="https://invalid.example/trap">';
  commandResult(reading, 'executed', 'succeeded', { answer: {
    answerId: 'answer-fixture', turnId: 'turn-finished', text: answerText, truncated: false, completedAt: changedTime
  } });
  await row.locator('.last-answer').getByText(answerText, { exact: true }).waitFor();
  assert.equal(await row.locator('.last-answer a, .last-answer img').count(), 0, 'read text cannot fetch links or interpret HTML');
  const duplicateRead = await (await post({ commandId: reading.commandId, tabId: reading.tabId, action: 'get_last_answer' })).json();
  assert.equal(duplicateRead.duplicate, true); assert.ok(!('payload' in duplicateRead));
  assert.ok(!('payload' in await (await query(reading.commandId)).json()));

  // The turn changes after the phone has seen the state. Confirmation must keep the old ID.
  publishTab({ status: 'running' });
  await row.getByRole('button', { name: 'Остановить', exact: true }).click();
  const stateRequest = await waitCommand('state-for-stale-stop'); assert.equal(stateRequest.action, 'get_state');
  commandResult(stateRequest, 'executed', 'succeeded', { state: {
    ...firstTab, activeTurnId: 'turn-before-confirmation', actions: { send: false, stop: true }
  } });
  await row.getByRole('dialog').getByText('turn-before-confirmation', { exact: true }).waitFor();
  let currentTurn = 'turn-after-confirmation', executedStops = 0;
  publishTab({ updatedAt: '2026-10-14T10:04:00.000Z' });
  await row.getByRole('button', { name: 'Подтвердить остановку', exact: true }).click();
  const staleStop = await waitCommand('stale-stop');
  assert.equal(staleStop.action, 'stop'); assert.equal(staleStop.expectedTurnId, 'turn-before-confirmation');
  assert.notEqual(staleStop.expectedTurnId, currentTurn);
  commandResult(staleStop, 'rejected', null, null, 'stale_turn');
  await status('rejected').waitFor();
  assert.match(await status('rejected').textContent(), /ход.*измен|состояние.*устар|заново/i);
  assert.equal(executedStops, 0);

  await row.getByRole('button', { name: 'Остановить', exact: true }).click();
  const freshState = await waitCommand('state-for-fresh-stop'); assert.equal(freshState.action, 'get_state');
  commandResult(freshState, 'executed', 'succeeded', { state: { ...firstTab, activeTurnId: currentTurn, actions: { send: false, stop: true } } });
  await row.getByRole('dialog').getByText(currentTurn, { exact: true }).waitFor();
  await row.getByRole('button', { name: 'Подтвердить остановку', exact: true }).click();
  const freshStop = await waitCommand('fresh-stop');
  assert.equal(freshStop.expectedTurnId, currentTurn); executedStops++;
  commandResult(freshStop, 'executed', 'interrupted');
  await status('executed').getByText('Остановлено', { exact: true }).waitFor();
  assert.equal(executedStops, 1);
  await publishTab({ status: 'idle', updatedAt: '2026-10-14T10:05:00.000Z' });
  await row.locator('.tab-state.idle').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: fileURLToPath(new URL('commands-mobile.png', output)), fullPage: true });

  // Presence still has its offline grace, but the actual bridge socket is gone.
  await pc.close(); offlineProbe = true;
  await row.getByLabel('Отправить текст', { exact: true }).fill('OFFLINE_COMMAND_FIXTURE');
  await row.getByRole('button', { name: 'Отправить', exact: true }).click();
  await row.getByRole('alert').filter({ hasText: /не подключ|не на связи|не отправлена/i }).waitFor();
  assert.equal(expectedOfflineErrors, 1); offlineProbe = false;
  pc = await connect(relayUrl, installationId);
  firstTab = { ...firstTab, updatedAt: '2026-10-14T10:06:00.000Z' };
  await publish();
  await page.waitForFunction(() => document.querySelector('.tab-row time')?.getAttribute('datetime') === '2026-10-14T10:06:00.000Z');

  await row.getByLabel('Отправить текст', { exact: true }).fill('REVOKED_PENDING_FIXTURE');
  await row.getByRole('button', { name: 'Отправить', exact: true }).click();
  const beforeRevoke = await waitCommand('revocation-during-send');
  commandResult(beforeRevoke, 'queued'); await status('queued').waitFor();
  revoking = true;

  await page.getByRole('button', { name: 'Отвязать устройство', exact: true }).click();
  await page.getByRole('button', { name: 'Отвязать', exact: true }).click();
  await page.getByRole('heading', { name: 'Пока нет подключённых устройств', exact: true }).waitFor();
  assert.equal(relay.store.commands.get(installationId, beforeRevoke.commandId).status, 'queued', 'revocation cannot fabricate a bridge status');
  const stored = JSON.stringify(relay.store.db.prepare('SELECT * FROM command_ledger').all()) + JSON.stringify(relay.store.db.prepare('SELECT * FROM audit').all());
  for (const marker of ['COMMAND_BODY_FIXTURE_6c489c', replayText, 'ANSWER_TRANSIT_ONLY_6c489c', 'UNCERTAIN_BODY_FIXTURE_6c489c', 'REVOKED_PENDING_FIXTURE']) assert.ok(!stored.includes(marker));
  assert.ok(!(await page.locator('body').textContent()).includes('ANSWER_TRANSIT_ONLY_6c489c'));
  for (const [id, count] of forwarded) assert.equal(count, id === lostResult.commandId ? 2 : 1, 'phone duplicates do not dispatch; transport replays once per reconnect');
  assert.equal(replayExecutions, 1);
  await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
  await page.getByRole('heading', { name: 'Пока нет подключённых устройств', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(httpErrors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ ok: true, protocol: '2.2', productionVerifier: true,
    checks: ['explicit phone + PC pairing', 'production Ed25519 hello', 'queue length/pause/tab activity',
      'live tab update', 'fresh-challenge reconnect + same-epoch resync', 'PC installation label',
      'send queued/accepted/executed lifecycle', 'duplicate ID and conflicting body',
      'lost result + reconnect replay + one execution + final status in Mini App',
      'one replay per connection; no terminal replay', 'uncertain + safe same-ID refresh + late ACK',
      'one-shot plain-text last answer', 'stale stop + fresh exact-turn stop', 'offline rejection despite presence grace',
      'revocation during queued command', 'no SQLite text/payload', 'revoke + refresh'],
    replayDeliveries: forwarded.get(lostResult.commandId), replayExecutions,
    externalRequests: 0, pageErrors: 0, unexpectedHttpErrors: 0, expectedOfflineErrors }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: fileURLToPath(new URL('commands-failure.png', output)), fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ phase, error: String(error), httpErrors, socketState: pc?.socket.readyState,
      alerts: await page.getByRole('alert').allTextContents().catch(() => []) }));
  }
  throw error;
} finally {
  await sendTail.catch(() => {});
  await browser?.close();
  await vite?.close();
  await pairingPc?.close();
  await pc?.close();
  await relay.close();
}
