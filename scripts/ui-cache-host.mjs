import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real production Electron/preload/IPC with a deterministic JSONL child process.
// Uses an isolated profile and Node executable, never the user's Codex/provider.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'cache-host-'));
const project = path.join(runDir, 'PROJECT_CACHE');
const profile = path.join(runDir, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(project, 'app-server'), String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const cwd = process.cwd();
const log = entry => appendFileSync('server.jsonl', JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
let turns = 0;
const thread = { id: 'fixture-cache-thread', cwd, turns: [] };
const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Cache fixture', fixturePid: process.pid });
  if (method === 'model/list') return reply(id, { data: models, nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  if (method === 'thread/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start') return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  if (method === 'turn/start') {
    const turn = { id: 'fixture-turn-' + ++turns, status: 'inProgress', items: [] };
    const context = { threadId: thread.id, turnId: turn.id };
    reply(id, { turn });
    setTimeout(() => {
      notify('turn/started', { threadId: thread.id, turn });
      notify('item/completed', { ...context, item: { id: 'user-' + turn.id, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } });
      notify('item/agentMessage/delta', { ...context, itemId: 'answer-' + turn.id, delta: 'ОК' });
      notify('item/completed', { ...context, item: { id: 'answer-' + turn.id, type: 'agentMessage', text: 'ОК' } });
      const usage = { totalTokens: 10100, inputTokens: 10000, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
      notify('thread/tokenUsage/updated', { ...context, tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 } });
      notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'completed', error: null } });
    }, 20);
    return;
  }
  send({ id, error: { code: -32601, message: 'Unexpected fixture method: ' + method } });
});
input.on('close', () => process.exit());
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'auto' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
let app;
let page;
let fixturePid;
const errors = [];
const log = async () => (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const starts = async () => (await log()).filter(entry => entry.method === 'turn/start');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const waitFor = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(60); }
};
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const view = () => page.locator('.session-view:visible');
  await waitFor(async () => await view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  const initialLog = await log(); fixturePid = initialLog.find(entry => entry.type === 'spawn').pid;
  assert.equal(initialLog.filter(entry => entry.method === 'initialize').length, 1);
  await page.clock.install({ time: new Date() });
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  // Reload mounts the scheduler after installing the clock, while real IPC and
  // child-process time continue normally. No production clock override exists.
  await page.reload();
  await waitFor(async () => await view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready after clock install');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  await composer().fill('Задача для проверки кэша');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await waitFor(async () => await view().locator('.assistant-message').getByText('ОК', { exact: true }).count() === 1 && await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).count() === 0, 'first response');
  await composer().fill('Черновик остаётся в редакторе');
  await view().locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  await view().getByLabel('Настройки кэша', { exact: true }).click();
  assert.equal(await view().getByRole('spinbutton', { name: 'Срок кэша, минут', exact: true }).inputValue(), '60');
  const auto = view().getByRole('checkbox', { name: 'Автопинг кэша', exact: true });
  assert.equal(await auto.isChecked(), false); await auto.check();
  const pingText = await view().getByRole('textbox', { name: 'Текст пинга', exact: true }).inputValue();
  for (let expected = 2; expected <= 3; expected++) {
    await page.clock.fastForward(3541000);
    await waitFor(async () => (await starts()).length === expected, `ping ${expected - 1} delivered through IPC`);
    await waitFor(async () => await view().locator('.assistant-message').getByText('ОК', { exact: true }).count() === expected && await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).count() === 0, `ping ${expected - 1} completed`);
    await delay(100);
    assert.equal(await auto.isChecked(), true, 'Successful ping keeps scheduling enabled');
    assert.equal(await composer().inputValue(), 'Черновик остаётся в редакторе');
    assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
    assert.equal(await view().locator('.chat-scroll').getByText(pingText, { exact: true }).count(), expected - 1, 'Each server-echoed ping is visible exactly once');
  }
  const allStarts = await starts();
  for (const { params } of allStarts.slice(1)) {
    assert.equal(params.threadId, allStarts[0].params.threadId); assert.equal(params.cwd, project);
    assert.equal(params.model, 'fixture-alpha'); assert.equal(params.effort, 'high'); assert.equal(params.approvalsReviewer, 'auto_review');
    assert.deepEqual(params.input, [{ type: 'text', text: pingText, text_elements: [] }]);
    assert.deepEqual(params.sandboxPolicy.writableRoots, [project]);
  }
  const finalLog = await log();
  assert.equal(finalLog.filter(entry => entry.method === 'initialize').length, 1, 'Pings do not reconnect the child process');
  assert.equal(finalLog.filter(entry => entry.method === 'thread/start').length, 1, 'Pings continue the original conversation');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(runDir, 'cache-host.png') });
  console.log(`PASS: production Electron/preload/IPC and JSONL child, two automatic cache pings/rearm, unchanged thread/settings/child process, visible server echoes, preserved draft/image. No real model/provider. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Cache host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  if (fixturePid) await waitFor(() => !alive(fixturePid), 'fixture child cleanup');
}
