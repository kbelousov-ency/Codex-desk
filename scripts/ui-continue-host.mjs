import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC against a local JSONL child fixture. No provider,
// real Codex, user history or user configuration is involved.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'continue-host-'));
const project = path.join(runDir, 'PROJECT_CONTINUE');
const profile = path.join(runDir, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(project, 'app-server'), String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const log = entry => appendFileSync('server.jsonl', JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const thread = { id: 'continue-thread', cwd: process.cwd(), turns: [] };
let turns = 0;
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Continue fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  if (method === 'thread/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start' || method === 'thread/read') return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  if (method === 'turn/start') {
    const turn = { id: 'task-' + ++turns, status: 'inProgress', items: [] };
    const context = { threadId: thread.id, turnId: turn.id };
    thread.turns.push(turn); reply(id, { turn });
    setTimeout(() => {
      notify('turn/started', { threadId: thread.id, turn });
      const item = { id: 'user-' + turn.id, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
      turn.items.push(item); notify('item/completed', { ...context, item });
      if (turn.id !== 'task-1') {
        const answer = { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: 'Продолжение принято подставным сервером.' };
        turn.items.push(answer); notify('item/completed', { ...context, item: answer });
        turn.status = 'completed'; notify('turn/completed', { threadId: thread.id, turn: { ...turn, error: null } });
      }
    }, 120);
    return;
  }
  if (method === 'turn/interrupt') {
    const turn = thread.turns.find(turn => turn.id === params.turnId);
    reply(id, {});
    setTimeout(() => { turn.status = 'interrupted'; notify('turn/completed', { threadId: thread.id, turn: { ...turn, error: null } }); }, 150);
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
const waitFor = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const action = () => view().getByRole('button', { name: 'Продолжить выполнение', exact: true });
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  fixturePid = (await log()).find(entry => entry.type === 'spawn').pid;
  assert.equal(await action().count(), 0);
  await input().fill('Задача подставному серверу'); await input().press('Enter');
  await view().locator('.user-message').getByText('Задача подставному серверу', { exact: true }).waitFor();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).click();
  await action().waitFor(); assert.equal(await action().isEnabled(), true);
  assert.ok(await view().locator('.user-avatar .pixel-avatar').count() > 0);
  await input().fill('Черновик останется после продолжения');
  await view().locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  await page.screenshot({ path: path.join(runDir, 'stopped.png') });
  await action().evaluate(button => { button.click(); button.click(); });
  await view().locator('.assistant-message').getByText('Продолжение принято подставным сервером.', { exact: true }).waitFor();
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'continuation completed');
  assert.equal(await action().count(), 0);
  assert.equal(await view().locator('.user-message').getByText('Продолжай', { exact: true }).count(), 1);
  assert.equal(await input().inputValue(), 'Черновик останется после продолжения');
  assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
  const finalLog = await log();
  const turnRequests = finalLog.filter(entry => entry.method === 'turn/start');
  assert.equal(turnRequests.length, 2, 'Only original task and one explicit continuation reach App Server');
  assert.deepEqual(turnRequests[1].params.input, [{ type: 'text', text: 'Продолжай', text_elements: [] }]);
  assert.equal(turnRequests[1].params.threadId, 'continue-thread');
  for (const key of ['model', 'effort', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) assert.deepEqual(turnRequests[1].params[key], turnRequests[0].params[key], `Continuation preserves ${key}`);
  assert.equal(finalLog.filter(entry => entry.method === 'thread/start').length, 1);
  assert.deepEqual(finalLog.find(entry => entry.method === 'turn/interrupt').params, { threadId: 'continue-thread', turnId: 'task-1' });
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(runDir, 'continued.png') });
  console.log(`PASS: Electron/preload/scoped IPC, confirmed stop, pixel avatar, duplicate-click guard, one visible continuation in same thread with same model/effort/access and untouched draft/image. Fake JSONL child only. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Continue host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  if (fixturePid) await waitFor(() => !alive(fixturePid), 'fixture child cleanup');
}
