import { CodexClient } from '../electron/codex-client.mjs';
import { findCodex } from '../electron/host-utils.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const cwd = path.resolve('artifacts/live-test');
await mkdir(cwd, {recursive:true});
const client = new CodexClient({executable:await findCodex(),cwd,requestTimeoutMs:30000});
let done;
const finished = new Promise((resolve,reject) => { done={resolve,reject}; });
let summaryChars=0;
let answer='';
const methods=new Set();
client.on('notification', ({method,params:p}) => {
  methods.add(method);
  if(method==='item/reasoning/summaryTextDelta') summaryChars+=(p.delta||'').length;
  if(method==='item/agentMessage/delta') answer+=p.delta||'';
  if(method==='item/completed' && p.item?.type==='agentMessage') answer=p.item.text;
  if(method==='error') console.log('Codex error:',p.error?.message);
  if(method==='turn/completed') p.turn.status==='completed' ? done.resolve() : done.reject(new Error(p.turn.error?.message || p.turn.status));
});
client.on('serverRequest', async r => {
  const result = r.method==='item/permissions/requestApproval' ? {permissions:{}} : r.method==='item/tool/requestUserInput' ? {answers:{}} : r.method==='mcpServer/elicitation/request' ? {action:'decline',content:null} : {decision:'decline'};
  await client.respond(r.id,result);
});
const timeout=setTimeout(()=>done.reject(new Error('Live test timed out')),60000);
try {
  await client.start();
  const {config}=await client.request('config/read',{cwd,includeLayers:false});
  const {thread,...effective}=await client.request('thread/start',{cwd,ephemeral:true,sandbox:'read-only',approvalPolicy:'never'});
  console.log('Effective CLI defaults:',JSON.stringify({model:effective.model,effort:effective.reasoningEffort,sandbox:effective.sandbox}));
  const request=client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'This is a connection smoke test. Do not use tools or edit any files. What is 17 multiplied by 23? Reply in one short sentence.',text_elements:[]}],summary:config.model_reasoning_summary||'auto'});
  await Promise.all([request,finished]);
  console.log(JSON.stringify({result:'PASS',answer,reasoningSummaryChars:summaryChars,receivedEvents:[...methods]},null,2));
} finally {clearTimeout(timeout);client.stop();}