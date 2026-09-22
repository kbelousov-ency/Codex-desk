import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC against an isolated JSONL fixture, never a provider.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'commands-host-'));
const project = path.join(runDir, 'PROJECT_COMMANDS');
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
const thread = { id: 'commands-thread', cwd: process.cwd(), turns: [] };
let turns = 0, compactions = 0;
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'Commands fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } });
  if (method === 'thread/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start') return reply(id, { thread, model: 'fixture-alpha', reasoningEffort: 'high' });
  if (method === 'turn/start') {
    const turn = { id: 'task-' + ++turns, status: 'inProgress', items: [] };
    const context = { threadId: thread.id, turnId: turn.id };
    reply(id, { turn });
    setTimeout(() => {
      notify('turn/started', { threadId: thread.id, turn });
      notify('item/completed', { ...context, item: { id: 'user-' + turn.id, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } });
      notify('item/completed', { ...context, item: { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: 'Ответ подставного сервера.' } });
      const usage = { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 100, totalTokens: 10100 };
      notify('thread/tokenUsage/updated', { ...context, tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 } });
      notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'completed', error: null } });
    }, 30);
    return;
  }
  if (method === 'thread/compact/start') {
    const turn = { id: 'compact-' + ++compactions, status: 'inProgress', items: [] };
    reply(id, {});
    setTimeout(() => notify('turn/started', { threadId: thread.id, turn }), 60);
    setTimeout(() => {
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item: { id: 'item-' + turn.id, type: 'contextCompaction' } });
      notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'completed', error: null } });
    }, 500);
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
  const trigger = () => view().getByRole('button', { name: 'Подробности токенов', exact: true });
  const popup = () => page.getByRole('dialog', { name: 'Использование токенов', exact: true });
  const compact = () => popup().getByRole('button', { name: 'Сжать контекст', exact: true });
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  fixturePid = (await log()).find(entry => entry.type === 'spawn').pid;
  await input().fill('Задача подставному серверу'); await input().press('Enter');
  await view().locator('.assistant-message').getByText('Ответ подставного сервера.', { exact: true }).waitFor();
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'fixture task completed');
  await input().fill('/Compact'); await input().press('Enter');
  await waitFor(async () => (await log()).filter(entry => entry.method === 'thread/compact/start').length === 1, 'slash compact through IPC');
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  await waitFor(async () => await input().inputValue() === '', 'slash draft cleared after RPC acknowledgment');
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'compact lifecycle completed');
  assert.match(await view().innerText(), /Контекст сжат/);
  assert.equal(await view().locator('.chat-scroll').getByText('/Compact', { exact: true }).count(), 0);
  await input().fill('Черновик сохранён после кнопки compact');
  await view().locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64') });
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  await trigger().hover(); await popup().waitFor(); await delay(250);
  assert.equal((await log()).filter(entry => entry.method === 'thread/compact/start').length, 1, 'Hover never executes compact');
  await trigger().click(); await popup().waitFor();
  await compact().click();
  await waitFor(async () => (await log()).filter(entry => entry.method === 'thread/compact/start').length === 2, 'token action through IPC');
  assert.equal(await compact().isDisabled(), true, 'Accepted operation waits for server lifecycle');
  await waitFor(() => compact().isEnabled(), 'second compact completed');
  assert.equal(await input().inputValue(), 'Черновик сохранён после кнопки compact');
  assert.equal(await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).count(), 1);
  assert.match(await trigger().innerText(), /нет данных/, 'Unreported post-compact usage stays unknown');
  const finalLog = await log();
  for (const request of finalLog.filter(entry => entry.method === 'thread/compact/start')) assert.deepEqual(request.params, { threadId: 'commands-thread' });
  assert.equal(finalLog.filter(entry => entry.method === 'turn/start').length, 1, 'Only the explicit fixture task creates a turn/start');
  assert.equal(finalLog.filter(entry => entry.method === 'initialize').length, 1, 'Compaction does not restart App Server');
  assert.equal(finalLog.filter(entry => entry.method === 'thread/start').length, 1, 'Compaction keeps its original thread');
  assert.equal(await view().getByRole('combobox', { name: 'Модель', exact: true }).getAttribute('data-value'), 'fixture-alpha');
  assert.equal(await view().getByRole('combobox', { name: 'Глубина размышлений', exact: true }).getAttribute('data-value'), 'high');
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(runDir, 'commands-host.png') });
  console.log(`PASS: production Electron/preload/scoped IPC and JSONL child, /Compact and token action call native compact only, lifecycle busy/completion, preserved thread/model/effort/draft/image, no fake counters or slash messages. No real Codex/provider. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  console.error(`Commands host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  if (fixturePid) await waitFor(() => !alive(fixturePid), 'fixture child cleanup');
}
