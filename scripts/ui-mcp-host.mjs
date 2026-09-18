import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import TOML from '@iarna/toml';
import { _electron as electron } from 'playwright';

// Real Electron/preload/IPC and JSONL processes with a disposable CODEX_HOME.
// All server endpoints/credentials are sentinel fixtures. No real MCP, provider,
// or user config is touched, including when testing the packaged application.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'artifacts', 'mcp-host-'));
const project = path.join(runDir, 'PROJECT_MCP');
const profile = path.join(runDir, 'profile');
const codexHome = path.join(runDir, 'fixture-codex-home');
await Promise.all([mkdir(project), mkdir(profile), mkdir(codexHome)]);
const configPath = path.join(codexHome, 'config.toml');
const initialConfig = '# Fixture comment preserved in the backup\nmodel = "fixture-model"\nmodel_reasoning_effort = "high"\n[model_providers.fixture]\nname = "Sentinel provider"\nbase_url = "http://127.0.0.1:1/never-contacted"\n[mcp_servers.existing]\ncommand = "fixture-server"\n[mcp_servers.existing.env]\nFIXTURE_TOKEN = "existing-fixture-secret"\n';
await writeFile(configPath, initialConfig);
const secret = 'import-fixture-secret-not-a-real-token';
const server = { type: 'http', url: 'http://127.0.0.1:9999/mcp?token=url-fixture-secret', headers: { Authorization: `Bearer ${secret}` } };
const block = JSON.stringify({ mcpServers: { company: server } }, null, 2);
const tomlBlock = `[mcp_servers.company]\nurl = "${server.url}"\n[mcp_servers.company.http_headers]\nAuthorization = "Bearer ${secret}"`;
await writeFile(path.join(project, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(project, 'app-server'), `import TOML from ${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@iarna/toml/toml.js')).href)};\n` + String.raw`
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const log = value => appendFileSync('server.jsonl', JSON.stringify({ pid: process.pid, ...value }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const config = () => TOML.parse(readFileSync(configPath, 'utf8'));
const version = () => createHash('sha256').update(readFileSync(configPath)).digest('hex');
const thread = { id: 'mcp-host-thread', cwd: process.cwd(), turns: [] };
let turns = 0;
log({ type: 'spawn' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params = {} } = message;
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'MCP test fixture' });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'fixture-model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
  if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
  if (method === 'config/read') return reply(id, { config: config(), ...(params.includeLayers ? { layers: [{ name: { type: 'user', file: configPath, profile: null }, version: version(), config: config(), disabledReason: null }] } : {}) });
  if (method === 'config/batchWrite') {
    if (params.filePath !== configPath || params.expectedVersion !== version()) return send({ id, error: { code: -32000, message: 'Fixture unexpected file/version' } });
    const next = config();
    for (const edit of params.edits) {
      if (edit.mergeStrategy !== 'replace' || !/^mcp_servers\.[a-zA-Z0-9_-]+$/.test(edit.keyPath)) return send({ id, error: { code: -32000, message: 'Fixture unexpected edit' } });
      next.mcp_servers ||= {};
      next.mcp_servers[edit.keyPath.slice('mcp_servers.'.length)] = edit.value;
    }
    writeFileSync(configPath, TOML.stringify(next));
    return reply(id, { status: 'ok', version: version(), filePath: configPath });
  }
  if (method === 'config/mcpServer/reload') return reply(id, {});
  if (method === 'mcpServerStatus/list') return reply(id, { data: Object.keys(config().mcp_servers || {}).map(name => ({ name, runtimeStatus: 'connected', authStatus: 'bearerToken', tools: { first: { name: 'first', description: 'tool-fixture-secret-should-not-render' }, second: { name: 'second' } }, resources: [], resourceTemplates: [] })), nextCursor: null });
  if (method === 'thread/list') return reply(id, { data: [], nextCursor: null });
  if (method === 'thread/start') return reply(id, { thread, model: 'fixture-model', reasoningEffort: 'high' });
  if (method === 'turn/start') {
    const turn = { id: 'task-' + ++turns, status: 'inProgress', items: [] };
    reply(id, { turn }); notify('turn/started', { threadId: thread.id, turn });
    const timer = setInterval(() => {
      if (turns > 1 && !existsSync('finish-turn')) return;
      clearInterval(timer);
      const item = { id: 'answer-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: 'Fixture task completed.' };
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
      notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'completed', items: [item], error: null } });
    }, 50);
    return;
  }
  send({ id, error: { code: -32601, message: 'Unexpected fixture method: ' + method } });
});
input.on('close', () => process.exit());
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture-model', effort: 'high', access: 'workspace-write' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile, CODEX_HOME: codexHome };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST;
let app, page;
const errors = [];
const log = async () => (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const count = async method => (await log()).filter(entry => entry.method === method).length;
const waitFor = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await delay(50); } };
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const view = () => page.locator('.session-view:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const settings = () => page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  const text = () => settings().getByRole('textbox', { name: 'Конфигурация MCP', exact: true });
  const button = name => settings().getByRole('button', { name, exact: true });
  const importPreview = async block => { await button('Добавить из текста').click(); await text().fill(block); await button('Проверить текст').click(); await button('Сохранить MCP').waitFor(); };
  const noSecret = async () => {
    for (const hidden of [secret, 'existing-fixture-secret', 'url-fixture-secret', 'tool-fixture-secret-should-not-render']) assert.ok(!(await page.locator('body').innerText()).includes(hidden), `Fixture value leaked: ${hidden}`);
  };
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'ready');
  await input().fill('Fixture task'); await input().press('Enter');
  await view().locator('.assistant-message').getByText('Fixture task completed.', { exact: true }).waitFor();
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'task complete');
  await input().fill('Черновик текущего диалога');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await settings().getByText('existing', { exact: true }).waitFor();
  assert.match(await settings().innerText(), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await noSecret();
  await button('Добавить из текста').click();
  assert.match(await settings().locator('.mcp-paste-label').innerText(), /JSON.*mcpServers.*TOML/);
  assert.match(await text().getAttribute('placeholder'), /mcpServers/);
  await text().fill(`{"mcpServers":{"company":{"url":"http://127.0.0.1:9999/mcp","headers":{"Authorization":"Bearer ${secret}"}}`);
  await button('Проверить текст').click();
  await settings().getByRole('alert').filter({ hasText: /Некорректный JSON/ }).waitFor();
  assert.equal(await text().inputValue(), '', 'Malformed JSON is cleared without showing the pasted secret');
  assert.equal(await count('config/batchWrite'), 0, 'Malformed JSON performs no write');
  assert.equal(await readFile(configPath, 'utf8'), initialConfig);
  await noSecret();
  await button('Отмена').click();
  await importPreview(block);
  await noSecret(); assert.equal(await count('config/batchWrite'), 0, 'Preview performs no write');
  await button('Сохранить MCP').click();
  await settings().locator('.mcp-backup code').waitFor();
  const backupPath = await settings().locator('.mcp-backup code').innerText();
  assert.equal(await readFile(backupPath, 'utf8'), initialConfig, 'Backup retains exact original bytes and comments');
  const actual = TOML.parse(await readFile(configPath, 'utf8'));
  assert.equal(actual.mcp_servers.company.http_headers.Authorization, `Bearer ${secret}`);
  assert.equal(actual.mcp_servers.company.type, undefined);
  assert.equal(actual.mcp_servers.company.headers, undefined);
  assert.deepEqual(actual.mcp_servers.existing, TOML.parse(initialConfig).mcp_servers.existing);
  assert.deepEqual(actual.model_providers, TOML.parse(initialConfig).model_providers);
  assert.equal(actual.model, 'fixture-model'); assert.equal(actual.model_reasoning_effort, 'high');
  const write = (await log()).find(entry => entry.method === 'config/batchWrite');
  assert.equal(write.params.filePath, configPath); assert.equal(write.params.reloadUserConfig, false);
  assert.deepEqual(write.params.edits.map(edit => ({ keyPath: edit.keyPath, mergeStrategy: edit.mergeStrategy })), [{ keyPath: 'mcp_servers.company', mergeStrategy: 'replace' }]);
  assert.deepEqual(write.params.edits[0].value, { url: server.url, http_headers: server.headers });
  await noSecret();
  await button('Применить в этой сессии').click();
  await settings().getByText(/Codex перечитал MCP/).waitFor();
  await button('Проверить подключение').click();
  await settings().getByRole('list', { name: 'Подключения MCP текущей сессии', exact: true }).waitFor();
  assert.match(await settings().getByRole('list', { name: 'Подключения MCP текущей сессии', exact: true }).innerText(), /Подключён · инструментов: 2/);
  const runtime = (await log()).find(entry => entry.method === 'mcpServerStatus/list');
  assert.equal(runtime.params.threadId, 'mcp-host-thread');
  assert.equal(runtime.params.detail, 'toolsAndAuthOnly');
  const threadPid = (await log()).find(entry => entry.method === 'thread/start').pid;
  assert.equal(runtime.pid, threadPid, 'Runtime check uses the existing thread App Server');
  assert.notEqual(write.pid, threadPid, 'Config operations use a separate private service');
  assert.equal(await count('turn/start'), 1); assert.equal(await count('thread/start'), 1);
  await noSecret();
  await page.screenshot({ path: path.join(runDir, 'mcp-host.png') });

  await importPreview(tomlBlock.replace('127.0.0.1:9999', '127.0.0.1:9998'));
  assert.equal(await button('Сохранить MCP').isDisabled(), true);
  await button('Отмена').click();
  assert.equal(await count('config/batchWrite'), 1, 'Cancelling duplicate import does not overwrite config');
  await importPreview(block);
  await settings().getByRole('checkbox', { name: 'Обновить существующие серверы', exact: true }).check();
  const externallyModified = `${await readFile(configPath, 'utf8')}\n# External change after preview\n`;
  await writeFile(configPath, externallyModified);
  await button('Сохранить MCP').click();
  await settings().getByRole('alert').filter({ hasText: /изменилась после проверки/ }).waitFor();
  assert.equal(await readFile(configPath, 'utf8'), externallyModified);
  assert.equal(await count('config/batchWrite'), 1, 'Stale preview fails before native write');
  await noSecret();
  await button('Закрыть настройки').click();
  assert.equal(await input().inputValue(), 'Черновик текущего диалога');
  await input().fill('Second fixture task, held busy'); await input().press('Enter');
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  const reloadsBeforeBusy = await count('config/mcpServer/reload');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await button('Применить в этой сессии').click();
  await settings().getByText(/Дождитесь завершения задачи и закройте терминал/).waitFor();
  assert.equal(await count('config/mcpServer/reload'), reloadsBeforeBusy, 'Busy task cannot be reconfigured');
  assert.equal(await count('turn/interrupt'), 0, 'MCP settings never interrupt user work');
  await writeFile(path.join(project, 'finish-turn'), 'done');
  await waitFor(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'held task completes');
  await button('Применить в этой сессии').click();
  await settings().getByText(/Codex перечитал MCP/).waitFor();
  assert.equal(await count('thread/start'), 1, 'Same conversation survives save/check/reload');
  assert.equal(await count('turn/start'), 2, 'Only explicit fixture tasks create model turns');
  assert.deepEqual(errors, []);
  console.log(`PASS: real Electron/preload/scoped IPC, private config service, JSON HTTP normalization and malformed input, TOML fallback, exact backup, native batchWrite, unchanged provider/model/other MCP, hidden secrets, stale-file detection, same-thread reload and busy deferral. Fixture-only. Artifacts: ${runDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
  console.error(`MCP host artifacts: ${runDir}`); throw error;
} finally {
  if (app) await app.close();
  const pids = await log().then(entries => entries.filter(entry => entry.type === 'spawn').map(entry => entry.pid)).catch(() => []);
  for (const pid of pids) await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, `fixture cleanup ${pid}`);
}
