import { createRelay } from '../src/server.ts';
import { FIXTURE_BOT_TOKEN } from '../src/fixtures.ts';
import { connectFixture, fixtureTab, login, pairFixture } from './fake-bridge.ts';

if (process.env.TELEGRAM_BOT_TOKEN) throw new Error('Unset TELEGRAM_BOT_TOKEN before starting fixtures');
const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, fixtureMode: true });
const port = await relay.listen(Number(process.env.RELAY_PORT ?? 8787));
const url = `http://127.0.0.1:${port}`;
const token = await login(url);
const credential = await pairFixture(url, token);
const pc = await connectFixture(url, credential);
let revision = 1;
let activeTurnId: string | null = null, runningCommand: string | null = null, turn = 0;
let completion: ReturnType<typeof setTimeout> | undefined;
let answer: null | { answerId: string; turnId: string; text: string; truncated: boolean; completedAt: string } = null;
const currentTab = () => fixtureTab({ status: activeTurnId ? 'running' : 'idle', queuePaused: false });
const snapshot = () => pc.send('snapshot', { epoch: 1, revision: revision++, installation: { label: 'Локальный тест', appVersion: '0.11.0', channel: 'nightly' },
  tabs: [currentTab(), fixtureTab({ tabId: 't_fixture_readonly_2', title: 'Требуется действие на ПК', agent: 'claude', status: 'blocked' })], truncated: false });
const reply = (commandId: string, tabId: string, status: string, outcome: string | null = null, payload: unknown = null, code?: string) =>
  pc.send('command_result', { commandId, tabId, at: new Date().toISOString(), status, outcome,
    detail: code ? { code, message: code, requiresComputer: false } : null, payload });
const updated = (commandId: string, status: string, outcome: string | null = null) => pc.send('event', {
  epoch: 1, revision: revision++, event: { kind: 'command_updated', commandId, tabId: fixtureTab().tabId,
    at: new Date().toISOString(), status, outcome, detail: null },
});
pc.socket.on('message', raw => {
  const command = JSON.parse(raw.toString()); if (command.type !== 'command') return;
  const held = pc.received.findIndex(value => value.frameId === command.frameId); if (held >= 0) pc.received.splice(held, 1);
  const id = String(command.commandId), tabId = String(command.tabId);
  if (tabId !== fixtureTab().tabId) { reply(id, tabId, 'rejected', null, null, 'blocked'); return; }
  if (command.action === 'get_state') {
    reply(id, tabId, 'executed', 'succeeded', { state: { ...currentTab(), activeTurnId, actions: { send: !activeTurnId, stop: !!activeTurnId } } }); return;
  }
  if (command.action === 'get_last_answer') { reply(id, tabId, 'executed', 'succeeded', { answer }); return; }
  if (command.action === 'stop') {
    if (!activeTurnId || command.expectedTurnId !== activeTurnId) { reply(id, tabId, 'rejected', null, null, 'stale_turn'); return; }
    clearTimeout(completion); completion = undefined;
    if (runningCommand) updated(runningCommand, 'executed', 'interrupted');
    runningCommand = null; activeTurnId = null; reply(id, tabId, 'executed', 'interrupted'); snapshot(); return;
  }
  if (command.action === 'send') {
    if (activeTurnId) { reply(id, tabId, 'rejected', null, null, 'blocked'); return; }
    activeTurnId = `fixture-turn-${++turn}`; runningCommand = id;
    reply(id, tabId, 'queued'); updated(id, 'accepted'); snapshot();
    completion = setTimeout(() => {
      answer = { answerId: `fixture-answer-${turn}`, turnId: activeTurnId!, text: 'Фикстурный bridge завершил запрос. Реальная модель не вызывалась.', truncated: false, completedAt: new Date().toISOString() };
      updated(id, 'executed', 'succeeded'); activeTurnId = null; runningCommand = null; completion = undefined; snapshot();
    }, 2500);
    return;
  }
  reply(id, tabId, 'rejected', null, null, 'invalid_command');
});
snapshot();
const timer = setInterval(snapshot, 8000);
console.info(`Local fixture relay: ${url}. Open Mini App with its relay development mode. No Telegram requests are made.`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true; clearInterval(timer); clearTimeout(completion);
  void pc.close().then(() => relay.close()).then(() => process.exit(0));
});
