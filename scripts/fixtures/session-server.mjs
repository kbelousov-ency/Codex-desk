// Deterministic JSONL App Server for the session UI tests. Each session runs
// a separate Node child process and never contacts a model/provider.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cwd = process.cwd();
const marker = path.basename(cwd);
const logFile = path.join(cwd, 'server.jsonl');
const log = entry => appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, cwd, ...entry })}\n`);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
let threadId = 'shared-thread';
const approvalId = 'shared-approval';
let created = false;
let turnNumber = 0;
let active;
let stream;
let approvalPending = false;
let model = 'fixture-alpha';
let effort = 'high';
const models = ['fixture-alpha', 'fixture-beta'].map((name, index) => ({
  id: name, model: name, displayName: name, isDefault: index === 0,
  defaultReasoningEffort: 'high', inputModalities: ['text', 'image'],
  supportedReasoningEfforts: ['medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
}));
const thread = () => ({
  id: threadId, name: `${threadId === 'shared-history' ? 'История' : 'Сессия'} ${marker}`, preview: `Сессия ${marker}`, cwd,
  historyMode: 'legacy', status: { type: active ? 'active' : 'idle' },
  turns: active ? [active] : [], updatedAt: Math.floor(Date.now() / 1000),
});
const context = () => ({ threadId, turnId: active.id });

function finish(status) {
  if (!active) return;
  clearInterval(stream);
  notify('item/completed', { ...context(), item: { id: 'shared-answer', type: 'agentMessage', text: active.text } });
  if (approvalPending) notify('serverRequest/resolved', { requestId: approvalId });
  approvalPending = false;
  const completed = { id: active.id, status, items: [], error: null };
  active = undefined;
  notify('turn/completed', { threadId, turn: completed });
}

function startEvents(params, turn) {
  if (active !== turn) return;
  notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', items: [] } });
  notify('item/completed', { ...context(), item: { id: `shared-user-${turnNumber}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } });
  notify('item/started', { ...context(), item: { id: 'shared-answer', type: 'agentMessage', text: '', phase: 'commentary' } });
  let sequence = 0;
  const tick = () => {
    const delta = `${marker}: поток ${++sequence}.\n\n`;
    active.text += delta;
    notify('item/agentMessage/delta', { ...context(), itemId: 'shared-answer', delta });
  };
  tick();
  stream = setInterval(tick, 180);
  approvalPending = true;
  send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: {
    ...context(), itemId: 'shared-command', cwd,
    command: `echo ${marker}`, reason: `Разрешение только для ${marker}`,
  } });
}

log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { process.exitCode = 1; input.close(); return; }
  log({ type: 'input', ...message });
  const { id, method, params = {} } = message;
  if (!method) {
    if (id === approvalId && approvalPending) {
      approvalPending = false;
      notify('serverRequest/resolved', { requestId: id });
    }
    return;
  }
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Codex Desk session fixture', fixturePid: process.pid, fixtureCwd: cwd });
  if (method === 'model/list') return reply(id, { data: models, nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high', approval_policy: 'on-request', sandbox_mode: 'workspace-write' } });
  if (method === 'thread/list') {
    const historyCwd = params.cwd || cwd;
    const historyMarker = path.basename(historyCwd);
    return reply(id, { data: [
      { id: 'shared-history', name: `История ${historyMarker}`, preview: `История ${historyMarker}`, cwd: historyCwd, historyMode: 'legacy', updatedAt: 1789644000 },
      ...(created && historyCwd === cwd ? [thread()] : []),
    ], nextCursor: null });
  }
  if (method === 'thread/start') {
    threadId = 'shared-thread';
    created = true;
    model = params.model || model;
    return reply(id, { thread: thread(), model, reasoningEffort: effort });
  }
  if (method === 'thread/resume') {
    threadId = params.threadId;
    return reply(id, { thread: thread(), model, reasoningEffort: effort });
  }
  if (method === 'thread/read') return reply(id, { thread: thread() });
  if (method === 'turn/start') {
    if (active) return send({ id, error: { code: -32600, message: 'Fixture turn is already active' } });
    model = params.model || model;
    effort = params.effort || effort;
    active = { id: `shared-turn-${++turnNumber}`, status: 'inProgress', items: [], text: '' };
    reply(id, { turn: { id: active.id, status: 'inProgress', items: [] } });
    setTimeout(startEvents, 40, params, active);
    return;
  }
  if (method === 'turn/interrupt') {
    if (!active || params.turnId !== active.id || params.threadId !== threadId) return send({ id, error: { code: -32600, message: 'Wrong fixture turn interrupted' } });
    reply(id, {});
    finish('interrupted');
    return;
  }
  send({ id, error: { code: -32601, message: `Unexpected fixture method: ${method}` } });
});
input.on('close', () => { clearInterval(stream); process.exit(); });
