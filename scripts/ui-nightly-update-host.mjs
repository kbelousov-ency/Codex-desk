import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { withReleaseLock, removeChecked } from './release-utils.mjs';
import { queueNightlyUpdate, validateRegistration } from './nightly-update.mjs';

// Real replacement/relaunch under a disposable workspace. Never updates user's release slots.
const root=process.cwd();
await mkdir(path.join(root,'artifacts'),{recursive:true});
const run=await mkdtemp(path.join(root,'artifacts','nightly-update-host-'));
const releaseRoot=path.join(run,'release'), profile=path.join(run,'profile'), project=path.join(run,'project');
await Promise.all([mkdir(releaseRoot),mkdir(profile),mkdir(project)]);
const directory=path.join(releaseRoot,'nightly');
await cp(path.join(root,'release/nightly'),directory,{recursive:true});
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
let app,worker;
const waitFor=async(check,label)=>{const until=Date.now()+45000;while(!await check()){assert.ok(Date.now()<until,label);await delay(100);}};
const registration=async()=>{try{return JSON.parse(await readFile(path.join(releaseRoot,'.nightly-instance.json'),'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try {
 app=await electron.launch({executablePath:path.join(directory,'Codex Desk.exe'),args:[],cwd:root,env});
 const page=await app.firstWindow();
 await page.getByRole('button',{name:'Saved task',exact:true}).click();
 await page.getByText('Saved response',{exact:true}).waitFor();
 const view=()=>page.locator('.session-view:visible');
 const input=()=>view().getByRole('textbox',{name:'Сообщение Codex',exact:true});
 await input().fill('Fixture active task');await input().press('Enter');
 await view().getByRole('button',{name:'Остановить выполнение',exact:true}).waitFor();
 await input().fill('Draft survives automatic update');
 await view().locator('input[type=file]').setInputFiles({name:'draft.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64')});
 await page.getByRole('button',{name:'Удалить draft.png',exact:true}).waitFor();
 await waitFor(async()=>Boolean(await registration()),'registration');
 const original=validateRegistration(run,await registration());
 await withReleaseLock(run,()=>queueNightlyUpdate(run,directory,original));
 worker=spawn(process.execPath,[path.join(root,'scripts/apply-nightly-update.mjs')],{cwd:run,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';worker.stdout.on('data',x=>output+=x);worker.stderr.on('data',x=>output+=x);
 const exited=new Promise(resolve=>worker.once('exit',resolve));
 await delay(2500);assert.ok(alive(original.pid),'Updater must wait for busy task');
 await writeFile(path.join(project,'finish'),'done');
 let updateTimeout;
 let code;
 try { code=await Promise.race([exited,new Promise((_,reject)=>{updateTimeout=setTimeout(()=>reject(new Error('Update helper timed out: '+output)),90000);})]); }
 finally {clearTimeout(updateTimeout);}
 assert.equal(code,0,output);
 await waitFor(async()=>{const current=await registration();return current&&current.pid!==original.pid;},'restarted app registration');
 const restarted=await registration();assert.ok(alive(restarted.pid));
 await waitFor(async()=>{try{await stat(path.join(profile,'nightly-update-workspace.json'));return false;}catch(e){return e.code==='ENOENT';}},'checkpoint acknowledged');
 // Capture a second restart checkpoint through the actual restored renderer,
 // then close via its normal lifecycle. This proves draft/image restored in UI.
 const {requestInstance}=await import('./nightly-update.mjs');
 const request={requestId:'22222222-2222-4222-8222-222222222222',buildId:original.buildId};
 await waitFor(async()=>{const reply=await requestInstance(restarted,'prepare',request);return reply.state==='ready';},'second renderer snapshot');
 const snapshot=JSON.parse(await readFile(path.join(profile,'nightly-update-workspace.json'),'utf8'));
 const restoredTab=snapshot.tabs[snapshot.activeIndex];
 assert.equal(snapshot.tabs.length,2,'Both unsent and historical tabs survive');
 assert.equal(restoredTab.draft,'Draft survives automatic update');
 assert.equal(restoredTab.attachments[0].name,'draft.png');
 assert.equal(restoredTab.thread.id,'11111111-1111-4111-8111-111111111111');
 assert.equal(restoredTab.settings.access,'auto');
 await waitFor(()=>!alive(restarted.pid),'test restart window closes');
 const requests=(await readFile(path.join(project,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(requests.filter(x=>x.method==='turn/start').length,1,'Only initial fixture task, no hidden continuation');
 assert.ok(requests.filter(x=>x.method==='thread/resume').length>=2);
 console.log(`PASS: real queued replacement + automatic relaunch, busy wait, restored exact thread/draft/image/settings, no hidden prompt. ${run}`);
} finally {
 if(app)await app.close().catch(()=>{});
 const remaining=await registration();
 if(remaining&&alive(remaining.pid)) {
  await writeFile(path.join(project,'finish'),'done');
  const {requestInstance}=await import('./nightly-update.mjs');
  const cleanup={requestId:'33333333-3333-4333-8333-333333333333',buildId:remaining.buildId};
  await waitFor(async()=>!alive(remaining.pid)||(await requestInstance(remaining,'prepare',cleanup)).state==='ready','close test fixture').catch(()=>{});
 }
 if(worker&&worker.exitCode===null)worker.kill();
 // Keep isolated artifacts for inspection; do not kill any user application.
}
