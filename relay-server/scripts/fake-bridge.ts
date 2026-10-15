import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { WebSocket } from 'ws';
import { frame } from '../src/bridge.ts';
import { opaqueToken } from '../src/security.ts';
import { fixtureInitData } from '../src/fixtures.ts';

export class FakeBridge {
  readonly socket: WebSocket;
  readonly received: Record<string, unknown>[] = [];
  private waiters: { type: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  autoPong = true;
  constructor(url: string, path = '/bridge/v2') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Fake bridge only connects to loopback');
    this.socket = new WebSocket(url.replace(/^http/, 'ws') + path, 'kuzmich-bridge.v2');
    this.socket.on('message', raw => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type === 'ping' && this.autoPong) { this.send('pong', { nonce: value.nonce }); return; }
      const index = this.waiters.findIndex(waiter => waiter.type === value.type);
      if (index >= 0) { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(value); }
      else this.received.push(value);
    });
    this.socket.on('error', () => {});
  }
  wait(type: string, timeout = 3000): Promise<Record<string, unknown>> {
    const index = this.received.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(this.received.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter); reject(new Error(`Timed out waiting for ${type}`));
      }, timeout) };
      this.waiters.push(waiter);
    });
  }
  send(type: string, fields: Record<string, unknown> = {}): void { this.socket.send(JSON.stringify(frame(type, fields))); }
  async close(): Promise<void> {
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Fake bridge closed')); }
    this.waiters = [];
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.socket.once('close', () => resolve()); this.socket.close(); });
  }
}
export const fixtureClient = { app: 'kuzmich', appVersion: '0.11.0', channel: 'nightly', bridge: '2.2', features: [] };
export const fixtureTab = (overrides: Record<string, unknown> = {}) => ({ tabId: 't_fixture_readonly_1', title: 'Проверка локальной сборки', agent: 'codex',
  project: 'CodexDesk', status: 'idle', queueLength: 0, updatedAt: new Date().toISOString(), queuePaused: false, ...overrides });
export function generateFixtureKeys(): { publicKey: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ed25519');
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), privateKey: pair.privateKey };
}
export function signHello(privateKey: KeyObject, installationId: string, serverNonce: string): string {
  return sign(null, Buffer.from(`kuzmich-bridge-v2\n${installationId}\n${serverNonce}`, 'utf8'), privateKey).toString('base64url');
}
export async function login(url: string, user = 10001, now = Date.now()): Promise<string> {
  const response = await fetch(url + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: fixtureInitData(now, user) }) });
  if (!response.ok) throw new Error('Fixture login failed');
  return (await response.json() as { session_token: string }).session_token;
}
/** PC, Mini App and the two explicit confirmation actions, emulated only by fixtures. */
export async function pairFixture(url: string, session: string, user = 10001, label = 'Тестовый Кузьмич') {
  const pc = new FakeBridge(url), nonce = opaqueToken(), pairingId = randomUUID(), keys = generateFixtureKeys();
  await pc.wait('challenge');
  pc.send('pair_start', { pairingId, nonceHash: createHash('sha256').update(nonce).digest('base64url'), publicKey: keys.publicKey, client: fixtureClient, installation: { label } });
  const pending = await pc.wait('pair_pending');
  if (typeof pending.botUsername !== 'string' || !pending.botUsername) throw new Error('pair_pending requires botUsername');
  const response = await fetch(url + '/api/pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }, body: JSON.stringify({ nonce, confirm: true }) });
  if (!response.ok) throw new Error('Fixture claim failed');
  const claimant = await pc.wait('pair_claimed');
  if ((claimant.claimant as { telegramUserId: string }).telegramUserId !== String(user)) throw new Error('Unexpected fixture claimant');
  pc.send('pair_confirm', { pairingId, nonce, claimantUserId: String(user) });
  const complete = await pc.wait('pair_complete');
  await pc.close();
  if ('deviceSecret' in complete || 'privateKey' in complete) throw new Error('Relay must never return a device secret');
  return { installationId: String(complete.installationId), publicKey: keys.publicKey, privateKey: keys.privateKey };
}
export async function connectFixture(url: string, credential: { installationId: string; privateKey: KeyObject }, label = 'Тестовый Кузьмич'): Promise<FakeBridge> {
  const pc = new FakeBridge(url), challenge = await pc.wait('challenge');
  pc.send('hello', { installationId: credential.installationId,
    proof: signHello(credential.privateKey, credential.installationId, String(challenge.nonce)),
    client: fixtureClient, installation: { label }, resume: { epoch: 1, revision: 1 } });
  await pc.wait('welcome'); return pc;
}
