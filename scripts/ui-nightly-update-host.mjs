import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, cp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { withReleaseLock } from './release-utils.mjs';
import { applyNightlyUpdate, queueNightlyUpdate, validateRegistration } from './nightly-update.mjs';

// Real replacement/relaunch under a disposable workspace. Never updates user's release slots.
const root=process.cwd();
await mkdir(path.join(root,'artifacts'),{recursive:true});
const run=await mkdtemp(path.join(root,'artifacts','nightly-update-host-'));
const releaseRoot=path.join(run,'release'), profile=path.join(run,'profile'), project=path.join(run,'project');
await Promise.all([mkdir(releaseRoot),mkdir(profile),mkdir(project)]);
const directory=path.join(releaseRoot,'nightly');
await cp(process.env.CODEX_DESK_PACKAGED ? path.dirname(path.resolve(process.env.CODEX_DESK_PACKAGED)) : path.join(root,'release/nightly'),directory,{recursive:true});
await writeFile(path.join(project,'package.json'),'{"type":"module"}');
await writeFile(path.join(project,'app-server'),String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
const thread={id:'11111111-1111-4111-8111-111111111111',name:'Saved task',cwd:process.cwd(),historyMode:'legacy',turns:[{id:'saved-turn',status:'completed',items:[{id:'saved-message',type:'agentMessage',text:'Saved response'}]}]};
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const {id,method,params}=JSON.parse(line);appendFileSync('requests.jsonl',JSON.stringify({method,params})+'\n');
 if(method==='initialized')return;
 const reply=result=>send({id,result});
 if(method==='initialize')return reply({userAgent:'codex_desk/0.154.0'});
 if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'fixture',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'}],inputModalities:['text','image']}],nextCursor:null});
 if(method==='account/read')return reply({account:null,requiresOpenaiAuth:false});
 if(method==='config/read')return reply({config:{model:'fixture',model_reasoning_effort:'high'}});
 if(method==='thread/list')return reply({data:[thread],nextCursor:null});
 if(method==='thread/resume'||method==='thread/read')return reply({thread,model:'fixture',reasoningEffort:'high'});
 if(method==='turn/start'){
  const turn={id:'active-turn',status:'inProgress',items:[]};reply({turn});send({method:'turn/started',params:{threadId:thread.id,turn}});
  const tick=setInterval(()=>{if(!existsSync('finish'))return;clearInterval(tick);send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'completed',error:null}}});},50);return;
 }
 send({id,error:{code:-32601,message:'Unexpected fixture method'}});
});
input.on('close',()=>process.exit());
`);
await writeFile(path.join(profile,'settings.json'),JSON.stringify({cwd:project,executable:process.execPath,model:'fixture',access:'auto'}));
const env={...process.env,CODEX_DESK_DATA_DIR:profile};
delete env.ELECTRON_RUN_AS_NODE;delete env.CODEX_DESK_TEST;delete env.CODEX_DESK_DEV_URL;
let app,worker,workerError,workerResult;
let allowLaunch=true;
const waitFor=async(check,label)=>{const until=Date.now()+45000;while(!await check()){assert.ok(Date.now()<until,label);await delay(100);}};
const registration=async()=>{try{return JSON.parse(await readFile(path.join(releaseRoot,'.nightly-instance.json'),'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const launch=async()=>{assert.ok(allowLaunch,'Test cleanup has started');app=await electron.launch({executablePath:path.join(directory,'Codex Desk.exe'),args:[],cwd:root,env});};
const startWorker=()=>{workerError=null;workerResult=null;worker=applyNightlyUpdate(run,{launch,maxWaitMs:90000}).then(result=>{workerResult=result;},error=>{workerError=error;});};
const finishWorker=async()=>{const until=Date.now()+90000;while(!workerResult&&!workerError){assert.ok(Date.now()<until,'Update helper timed out');await delay(100);}if(workerError)throw workerError;return workerResult;};
try {
 await launch();
 await (await app.firstWindow()).getByRole('button',{name:'Saved task',exact:true}).waitFor();
 await waitFor(async()=>Boolean(await registration()),'registration');
 const original=validateRegistration(run,await registration());
 assert.equal(original.updateProtocol,2,'Use CODEX_DESK_PACKAGED pointing to a build with update confirmation support');
 const queued=await withReleaseLock(run,()=>queueNightlyUpdate(run,directory,original));
 // Reproduce retry after the original host was closed and the same installed
 // Nightly/profile was opened again. Only our disposable Electron app closes.
 await app.close();app=null;
 await waitFor(()=>!alive(original.pid),'original fixture exits normally');
 await launch();
 let page=await app.firstWindow();
 await waitFor(async()=>{const current=await registration();return current&&current.pid!==original.pid;},'replacement host registration');
 const replacement=validateRegistration(run,await registration());
 assert.equal(replacement.executable,original.executable);
 assert.equal(replacement.userData,original.userData);
 assert.notEqual(replacement.pid,original.pid);
 await page.getByRole('button',{name:'Saved task',exact:true}).click();
 await page.getByText('Saved response',{exact:true}).waitFor();
 const view=()=>page.locator('.session-view:visible');
 const input=()=>view().getByRole('textbox',{name:'Сообщение Codex',exact:true});
 await input().fill('Fixture active task');await input().press('Enter');
 await view().getByRole('button',{name:'Остановить выполнение',exact:true}).waitFor();
 await input().fill('Draft survives confirmed update');
 await view().locator('input[type=file]').setInputFiles({name:'draft.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64')});
 await page.getByRole('button',{name:'Удалить draft.png',exact:true}).waitFor();
 startWorker();
 await waitFor(async()=>{
  if(workerError)throw workerError;
  const current=JSON.parse(await readFile(path.join(run,'artifacts/nightly-update/state.json'),'utf8'));
  if(current.instance.pid!==replacement.pid)return false;
  assert.equal(current.requestId,queued.requestId,'Retry preserves the queued update identity');
  assert.equal(current.buildId,queued.buildId,'Retry preserves the verified queued build');
  assert.equal(current.instance.userData,profile,'Retry remains in the same isolated profile');
  return (await readFile(path.join(run,'artifacts/nightly-update.log'),'utf8')).includes('host_awaiting');
 },'retry adopts the newly registered host and offers the update');
 const notice=()=>view().getByRole('status',{name:'Обновление Nightly',exact:true});
 await notice().getByRole('button',{name:'Закрыть',exact:true}).waitFor();
 await delay(2500);assert.ok(alive(replacement.pid),'An offered update never closes the app by itself');
 assert.equal(await input().inputValue(),'Draft survives confirmed update');
 await page.getByRole('button',{name:'Удалить draft.png',exact:true}).waitFor();
 await notice().getByRole('button',{name:'Закрыть',exact:true}).click();
 await notice().getByRole('button',{name:'Отмена',exact:true}).waitFor();
 await delay(2500);assert.ok(alive(replacement.pid),'Explicit close waits for the busy task');
 await writeFile(path.join(project,'finish'),'done');
 assert.equal((await finishWorker()).restarted,true);
 await waitFor(async()=>{const current=await registration();return current&&current.pid!==original.pid&&current.pid!==replacement.pid;},'updated app registration');
 const restarted=await registration();assert.ok(alive(restarted.pid));
 page=await app.firstWindow();
 await waitFor(async()=>{try{await stat(path.join(profile,'nightly-update-workspace.json'));return false;}catch(e){return e.code==='ENOENT';}},'checkpoint acknowledged');
 await waitFor(async()=>await input().inputValue()==='Draft survives confirmed update','restored draft in renderer');
 assert.equal(await page.locator('.session-tab').count(),2,'Both unsent and historical tabs survive');
 await view().getByRole('button',{name:'Удалить draft.png',exact:true}).waitFor();
 await view().getByText('Saved response',{exact:true}).waitFor();
 assert.equal(await view().getByRole('combobox',{name:'Режим доступа',exact:true}).getAttribute('data-value'),'auto');
 // A separate offer declined in the real renderer installs only after a normal
 // manual close, without automatically reopening the application.
 await withReleaseLock(run,()=>queueNightlyUpdate(run,directory,restarted));
 startWorker();
 await notice().getByRole('button',{name:'Отмена',exact:true}).click();
 await notice().getByText('Обновление будет применено, когда вы сами закроете приложение.',{exact:true}).waitFor();
 await delay(2500);assert.ok(alive(restarted.pid),'Later must keep the idle app open');
 assert.equal(workerResult,null,'Later waits for the actual manual exit');
 await app.close();app=null;
 assert.equal((await finishWorker()).restarted,false);
 assert.equal(await registration(),null,'Manual close does not relaunch');
 const requests=(await readFile(path.join(project,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(requests.filter(x=>x.method==='turn/start').length,1,'Only initial fixture task, no hidden continuation');
 assert.ok(requests.filter(x=>x.method==='thread/resume').length>=2);
 console.log(`PASS: queued retry adopts reopened host and only offers update; explicit Close waits for active task then restores exact tabs/thread/draft/image/access. Later keeps idle app open until manual close and installs without relaunch. One explicit fixture turn; no real model request. PIDs ${original.pid}/${replacement.pid}/${restarted.pid}. ${run}`);
} finally {
 allowLaunch=false;
 if(app)await app.close().catch(()=>{});
 if(worker)await worker;
 // Keep isolated artifacts for inspection; do not kill any user application.
}
