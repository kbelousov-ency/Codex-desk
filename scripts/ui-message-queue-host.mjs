import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Production Electron/preload/scoped IPC against a private Node JSONL fixture.
// No Codex executable, provider, user profile or user process is involved.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'message-queue-host-'));
const project = path.join(runDir, 'PROJECT_QUEUE');
const profile = path.join(runDir, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(project, 'app-server'), String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
const log = entry => appendFileSync('server.jsonl', JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const thread = { id: 'queue-host-thread', cwd: process.cwd(), turns: [] };
let turns = 0, active;
const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
const user = (params, prefix) => {
  const item = { id: prefix + params.clientUserMessageId, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
  active.items.push(item);
  const context = { threadId: thread.id, turnId: active.id, item };
  notify('item/started', context); notify('item/completed', context);
};
const complete = text => {
  const answer = { id: 'answer-' + active.id, type: 'agentMessage', phase: 'final_answer', text };
  active.items.push(answer); notify('item/completed', { threadId: thread.id, turnId: active.id, item: answer });
  active.status = 'completed'; notify('turn/completed', { threadId: thread.id, turn: { ...active, error: null } });
};
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Message queue fixture' });
  if (method === 'model/list') return reply(id, { data: models, nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  if (method === 'thread/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start') return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  if (method === 'turn/start') {
    turns++;
    if (turns > 1) {
      try { log({ type: 'checkpoint-before-start', snapshot: JSON.parse(readFileSync(join(process.env.CODEX_DESK_DATA_DIR, 'workspace-state.json'), 'utf8')) }); }
      catch (error) { log({ type: 'checkpoint-before-start', error: String(error) }); }
    }
    active = { id: 'task-' + turns, status: 'inProgress', items: [] };
    thread.turns.push(active); reply(id, { turn: active });
    notify('turn/started', { threadId: thread.id, turn: active }); user(params, 'user-');
    if (turns > 1) setTimeout(() => complete('Очередь обработана локальным fixture.'), 50);
    return;
  }
  if (method === 'turn/steer') {
    if (active?.status !== 'inProgress' || params.expectedTurnId !== active.id) return send({ id, error: { code: -32600, message: 'Unexpected expectedTurnId' } });
    reply(id, { turnId: active.id }); user(params, 'steer-');
    // Only the explicit second steer ends the fixture's first task.
    if (params.input.some(part => part.text === 'Заверши первую задачу fixture')) setTimeout(() => complete('Первая задача fixture завершена.'), 70);
    return;
  }
  send({ id, error: { code: -32601, message: 'Unexpected fixture method: ' + method } });
});
input.on('close', () => process.exit());
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'auto' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
let app, page, fixturePid;
const errors = [];
const log = async () => (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const waitFor = async (check, label) => { const deadline = Date.now() + 12000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const steer = () => view().getByRole('button', { name: 'Уточнить текущую задачу', exact: true });
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  fixturePid = (await log()).find(entry => entry.type === 'spawn').pid;
  await composer().fill('Начни задачу fixture'); await composer().press('Enter');
  await steer().waitFor();
  await waitFor(async () => await composer().inputValue() === '' && await view().getByRole('button', { name: 'Прикрепить изображения', exact: true }).isEnabled(), 'initial send acknowledgement');
  await view().locator('input[type="file"]').setInputFiles({ name: 'steer.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить steer.png', exact: true }).waitFor();
  await composer().fill('Учти изображение и старый формат'); await steer().click();
  await waitFor(async () => await composer().inputValue() === '', 'steer acknowledgement');
  await view().locator('.user-text').getByText('Учти изображение и старый формат', { exact: true }).waitFor();
  assert.equal(await view().locator('.user-text').getByText('Учти изображение и старый формат', { exact: true }).count(), 1);
  await composer().fill('Проверь результат после завершения');
  await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click();
  await view().getByRole('region', { name: 'Очередь сообщений', exact: true }).getByText('Проверь результат после завершения', { exact: true }).waitFor();
  assert.equal((await log()).filter(entry => entry.method === 'turn/start').length, 1, 'Queue waits for confirmed task completion');
  await composer().fill('Заверши первую задачу fixture'); await steer().click();
  await waitFor(async () => await composer().inputValue() === '', 'second steer acknowledgement');
  await composer().fill('Самостоятельный черновик после очереди');
  await view().locator('.assistant-message').getByText('Очередь обработана локальным fixture.', { exact: true }).waitFor();
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'queued task complete');
  const entries = await log();
  const starts = entries.filter(entry => entry.method === 'turn/start');
  const steers = entries.filter(entry => entry.method === 'turn/steer');
  assert.equal(starts.length, 2); assert.equal(steers.length, 2);
  assert.equal(steers[0].params.threadId, 'queue-host-thread'); assert.equal(steers[0].params.expectedTurnId, 'task-1');
  assert.deepEqual(Object.keys(steers[0].params).sort(), ['clientUserMessageId', 'expectedTurnId', 'input', 'threadId']);
  assert.deepEqual(steers[0].params.input[0], { type: 'text', text: 'Учти изображение и старый формат', text_elements: [] });
  assert.equal(steers[0].params.input[1].type, 'localImage');
  assert.ok((await readFile(steers[0].params.input[1].path)).length > 0, 'Real host saved the steer image');
  assert.deepEqual(starts[1].params.input, [{ type: 'text', text: 'Проверь результат после завершения', text_elements: [] }]);
  for (const key of ['threadId', 'model', 'effort', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) assert.deepEqual(starts[1].params[key], starts[0].params[key], `Queue preserves ${key}`);
  const checkpoint = entries.find(entry => entry.type === 'checkpoint-before-start');
  assert.ok(checkpoint?.snapshot, `Missing checkpoint at server receipt: ${checkpoint?.error}`);
  const saved = checkpoint.snapshot.tabs.find(tab => tab.thread?.id === 'queue-host-thread');
  assert.equal(saved.queue.items[0].state, 'uncertain'); assert.equal(saved.queue.items[0].text, 'Проверь результат после завершения');
  assert.equal(await composer().inputValue(), 'Самостоятельный черновик после очереди');
  assert.equal(await view().getByRole('region', { name: 'Очередь сообщений', exact: true }).count(), 0);
  assert.equal(entries.filter(entry => entry.method === 'thread/start').length, 1);
  assert.equal(entries.filter(entry => entry.method === 'initialize').length, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(runDir, 'message-queue-host.png') });
  console.log(`PASS: real Electron/preload/scoped IPC permits steer with expectedTurnId and saved image, reconciles echo once; queue waits completion and preserves settings/thread/draft; uncertain workspace checkpoint existed before server received queued start. Private JSONL fixture, no model/provider. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Message queue host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  if (fixturePid) await waitFor(() => !alive(fixturePid), 'fixture child cleanup');
}
