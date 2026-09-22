import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'cache-history-host-'));
const project = path.join(run, 'project'), profile = path.join(run, 'profile');
await Promise.all([mkdir(project), mkdir(profile)]);
const completedAt = Math.floor(Date.now() / 1000) - 20 * 60;
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await writeFile(path.join(project, 'app-server'), `const completedAt = ${completedAt};\n` + String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const thread = { id:'cache-history-host', name:'Saved history', cwd:process.cwd(), historyMode:'paginated', status:{type:'idle'}, turns:[] };
const turn = { id:'last-turn', status:'completed', completedAt, startedAt:completedAt-100, items:[], error:null };
const item = {id:'answer',type:'agentMessage',phase:'final_answer',text:'Stored response'};
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id,method}=JSON.parse(line); appendFileSync('methods.jsonl',JSON.stringify({method})+'\n');
 if(method==='initialized')return;
 const result=method==='initialize'?{userAgent:'codex_desk/0.154.0'}
 :method==='model/list'?{data:[{id:'fixture',model:'fixture',displayName:'fixture',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}
 :method==='config/read'?{config:{model:'fixture'}}
 :method==='account/read'?{account:null,requiresOpenaiAuth:false}
 :method==='thread/list'?{data:[thread],nextCursor:null}
 :method==='thread/resume'?{thread,model:'fixture',reasoningEffort:'high'}
 :method==='thread/turns/list'?{data:[turn],nextCursor:null}
 :method==='thread/items/list'?{data:[{turnId:turn.id,item}],nextCursor:null}:null;
 process.stdout.write(JSON.stringify(result===null?{id,error:{code:-32601,message:'Unexpected fixture method'}}:{id,result})+'\n');
});
`);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({cwd:project, executable:process.execPath}));
const env = {...process.env,CODEX_DESK_DATA_DIR:profile,CODEX_DESK_TEST:'1'};
delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
const app = await electron.launch({...(process.env.CODEX_DESK_PACKAGED?{executablePath:process.env.CODEX_DESK_PACKAGED,args:[]}:{args:['.']}),cwd:root,env});
try {
 const page=await app.firstWindow();
 await page.getByRole('button',{name:'Saved history',exact:true}).click();
 await page.getByText('Stored response',{exact:true}).waitFor();
 const view=page.locator('.session-view:visible');
 await view.getByLabel('Настройки кэша',{exact:true}).click();
 const time=view.locator('.cache-settings time');
 await time.waitFor();
 assert.equal(await time.getAttribute('datetime'),new Date(completedAt*1000).toISOString());
 assert.match(await view.locator('.cache-countdown').innerText(), /Кэш ≈ (?:39:[0-5]\d|40:00)/);
 assert.equal(await view.getByRole('checkbox',{name:'Автопинг кэша',exact:true}).isChecked(),false);
 await page.screenshot({path:path.join(run,'restored.png')});
 const methods=(await readFile(path.join(project,'methods.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(methods.some(x=>x.method==='thread/turns/list'));
 assert.ok(!methods.some(x=>['turn/start','turn/steer','thread/compact/start'].includes(x.method)));
 console.log(`PASS: packaged Electron/preload/IPC restored saved completion time and remaining cache age, no ping/model turn. ${run}`);
} finally {await app.close();}
