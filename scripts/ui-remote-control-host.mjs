import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Real production renderer, preload, main and controller; only the CLI is a fixture.
// The main-process facade is invoked by this harness as the trusted relay bridge would be.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'remote-control-host-'));
const project = path.join(run, 'PROJECT'), profile = path.join(run, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await writeFile(path.join(project, 'app-server'), String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
const reply = (id,result) => send({id,result});
const event = (method,params) => send({method,params:{threadId:thread.id,...params}});
const log = x => appendFileSync('server.jsonl',JSON.stringify(x)+'\n');
const thread={id:'remote-fixture-thread',cwd:process.cwd(),name:'Беседа пульта',historyMode:'legacy',turns:[]};
let n=0,active;
const echo = p => {const item={id:p.clientUserMessageId,clientId:p.clientUserMessageId,type:'userMessage',content:p.input};active.items.push(item);event('item/completed',{turnId:active.id,item});};
const finish = status => {if(!active)return;const item={id:'answer-'+active.id,type:'agentMessage',phase:'final_answer',text:'Готово: '+active.id};active.items.push(item);event('item/completed',{turnId:active.id,item});active.status=status;event('turn/completed',{turn:active});active=null;};
readline.createInterface({input:process.stdin}).on('line',line=>{
const {id,method,params:p={}}=JSON.parse(line);log({method,params:p});
if(method==='initialized')return;
if(method==='initialize')return reply(id,{userAgent:'Remote fixture'});
if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'fixture',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});
if(method==='account/read')return reply(id,{account:null});
if(method==='config/read')return reply(id,{config:{model:'fixture',model_reasoning_effort:'high'}});
if(method==='thread/list')return reply(id,{data:[thread],nextCursor:null});
if(method==='thread/start'||method==='thread/resume'||method==='thread/read')return reply(id,{thread,model:'fixture',reasoningEffort:'high'});
if(method==='turn/start'){
if(active)return send({id,error:{code:-32600,message:'already active'}});
if(p.input[0].text!=='seed'){
const snapshot=JSON.parse(readFileSync(path.join(process.env.CODEX_DESK_DATA_DIR,'workspace-state.json'),'utf8'));
const ledger=JSON.parse(readFileSync(path.join(process.env.CODEX_DESK_DATA_DIR,'remote-control.json'),'utf8'));
log({before:{snapshot,ledger}});
}
active={id:'turn-'+(++n),status:'inProgress',items:[]};thread.turns.push(active);reply(id,{turn:active});event('turn/started',{turn:active});echo(p);
if(!p.input[0].text.includes('hold'))setTimeout(()=>finish('completed'),120);return;
}
if(method==='turn/steer'){if(p.expectedTurnId!==active?.id)return send({id,error:{code:-32600,message:'stale'}});echo(p);reply(id,{turnId:active.id});return;}
if(method==='turn/interrupt'){if(p.turnId!==active?.id)return send({id,error:{code:-32600,message:'stale'}});reply(id,{});finish('interrupted');return;}
send({id,error:{code:-32601,message:'Unexpected '+method}});
});
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ executable: process.execPath, cwd: project, model: 'fixture', effort: 'high', access: 'auto' }));
const env = { ...process.env, CODEX_DESK_DATA_DIR: profile, CODEX_DESK_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
let app;
const errors = [];
const until = async (test, label) => { const end = Date.now() + 20000; while (!await test()) { assert.ok(Date.now() < end, label); await delay(60); } };
let moduleUrl = pathToFileURL(path.join(root, 'electron/main.mjs')).href;
try {
  app = await electron.launch({ ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }), cwd: root, env, timeout: 30000 });
  moduleUrl = await app.evaluate(({ app }) => process.getBuiltinModule('url').pathToFileURL(process.getBuiltinModule('path').join(app.getAppPath(), 'electron/main.mjs')).href);
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const call = (method, arg) => app.evaluate(async (_electron, { url, method, arg }) => {
    const load = process.getBuiltinModule('module').createRequire(url);
    const { remoteControl } = load(process.getBuiltinModule('url').fileURLToPath(url));
    return remoteControl.remote[method](arg);
  }, { url: moduleUrl, method, arg });
  const view = () => page.locator('.session-view:visible');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  await until(() => view().getByRole('combobox', { name: 'Модель', exact: true }).isEnabled(), 'CLI bootstrap');
  assert.deepEqual((await call('listThreads')).value, []);
  await composer().fill('seed'); await composer().press('Enter');
  await until(() => view().locator('.assistant-message').getByText('Готово: turn-1', { exact: true }).isVisible(), 'seed completed');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  const toggle = page.getByRole('switch', { name: /Разрешить доступ из Telegram/ });
  await until(() => toggle.isEnabled(), 'grant available'); await toggle.click();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  let target;
  await until(async () => { target = (await call('listThreads')).value?.[0]?.target; return Boolean(target); }, 'grant bound');
  await composer().fill('Локальный черновик');
  await until(async () => (await call('getThreadState', target)).value?.actions.send, 'remote send ready');
  const command = { requestId: 'fixture-send-1', target, kind: 'send', text: 'phone hold' };
  const first = await call('execute', command);
  assert.equal(first.ok, true); assert.equal(first.value.phase, 'accepted');
  assert.equal((await call('execute', command)).value.operationId, first.value.operationId);
  assert.equal(await composer().inputValue(), 'Локальный черновик');
  let state = (await call('getThreadState', target)).value;
  assert.equal(state.activeTurnId, 'turn-2');
  const steer = await call('execute', { requestId: 'fixture-steer', target, kind: 'steer', expectedTurnId: 'turn-2', text: 'same text' });
  assert.equal(steer.value.phase, 'accepted');
  const stale = await call('execute', { requestId: 'stale-stop', target, kind: 'stop', expectedTurnId: 'turn-1' });
  assert.equal(stale.value.phase, 'stale');
  const queued = await call('execute', { requestId: 'fixture-queue', target, kind: 'enqueue', text: 'same text' });
  assert.equal(queued.value.phase, 'queued');
  await call('execute', { requestId: 'fixture-stop', target, kind: 'stop', expectedTurnId: 'turn-2' });
  await until(async () => (await call('getThreadState', target)).value?.queue.paused, 'stop pauses common queue');
  assert.equal(await composer().inputValue(), 'Локальный черновик');
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await toggle.click();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  assert.deepEqual((await call('listThreads')).value, []);
  assert.equal((await call('getLastAnswer', target)).ok, false);
  const lines = (await readFile(path.join(project, 'server.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = lines.filter(value => value.method === 'turn/start');
  assert.equal(starts.length, 2, 'No duplicate/revoked queued prompt');
  const delivered = starts[1].params;
  assert.equal(delivered.model, 'fixture'); assert.equal(delivered.effort, 'high');
  assert.equal(delivered.approvalsReviewer, 'auto_review'); assert.equal(delivered._remote, undefined);
  const before = lines.find(value => value.before)?.before;
  assert.equal(before.snapshot.tabs[0].pendingMessage.origin, 'remote');
  assert.equal(before.snapshot.tabs[0].pendingMessage.clientUserMessageId, delivered.clientUserMessageId);
  assert.equal(before.snapshot.tabs[0].draft, 'Локальный черновик');
  assert.equal(before.ledger.operations[0].stage, 'dispatching');

  // Stage 5: the personal bot is out of the build. Nothing may expose it to the renderer any more,
  // and its own storage must be gone from a profile that is otherwise untouched.
  assert.equal(await page.evaluate(() => Boolean(window.codex.phoneAccess)), false, 'the bot bridge is gone from preload');
  assert.equal(await page.evaluate(() => Boolean(window.codex.relayBridge)), true, 'the relay bridge is the remaining phone path');
  await assert.rejects(readFile(path.join(profile, 'telegram', 'service.json'), 'utf8'), /ENOENT/, 'no bot record in a fresh profile');

  // The same permission, now also reachable from the «Телефон» topic, re-grants this conversation.
  await view().getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('tab', { name: 'Телефон', exact: true }).click();
  const listed = page.getByRole('switch', { name: 'Доступ из Telegram: Беседа пульта', exact: true });
  await until(() => listed.isEnabled(), 'the conversation is listed in «Доступ бесед»');
  assert.equal(await listed.getAttribute('aria-checked'), 'false', 'the list shows the revoked state');
  await listed.click();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await until(async () => Boolean((await call('listThreads')).value?.[0]?.target), 'granted from the phone topic');
  const freshTarget = (await call('listThreads')).value[0].target;
  await until(async () => (await call('getThreadState', freshTarget)).value?.actions.send, 'idle before FIFO');
  const idleQueue = await call('execute', { requestId: 'idle-fifo', target: freshTarget, kind: 'enqueue', text: 'FIFO idle' });
  assert.equal(idleQueue.ok, true);
  assert.equal((await call('getThreadState', freshTarget)).value.queue.paused, true, 'The earlier explicit Stop remains a queue pause');
  await view().getByRole('button', { name: 'Продолжить очередь', exact: true }).click();
  await until(async () => (await call('getOperation', { target: freshTarget, requestId: 'idle-fifo' })).value?.phase === 'completed', 'idle remote FIFO durably admitted and completed');
  assert.equal(await composer().inputValue(), 'Локальный черновик');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(run, 'remote-control.png'), fullPage: true });
  console.log(JSON.stringify({ result: 'PASS', profile: run, modelCalls: 0, telegramNetwork: false }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error('Relay bridge state:', await page.evaluate(() => window.codex.relayBridge?.getState()).catch(() => null));
  }
  throw error;
} finally { await app?.close(); }
