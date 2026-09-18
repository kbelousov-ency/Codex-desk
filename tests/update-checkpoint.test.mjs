import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureUpdateCheckpoint, createUpdateCheckpoint } from '../electron/update-checkpoint.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
const session = { currentCwd: path.resolve('fixture-project'), getSettings: () => ({ executable: 'trusted.exe', model: 'model-a', access: 'auto' }) };
const snapshot = () => ({ version: 1, activeIndex: 0, tabs: [{ sessionId: 'session', thread: { id: 'thread', historyMode: 'paginated', name: 'Example', turns: [{secret:'not a checkpoint'}] }, draft: 'Несохранённый текст', attachments: [{name:'draft.png',dataUrl:png,path:'untrusted-file'}],settings:{effort:'ultra',model:'model-b',access:'danger-full-access',cwd:'untrusted',executable:'untrusted.exe'} }] });

test('restart checkpoint retains draft/images/effective settings and uses trusted host folder/executable', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'desk-update-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const stored=captureUpdateCheckpoint(snapshot(),new Map([['session',session]]));
 assert.equal(stored.tabs[0].settings.executable,'trusted.exe');
 assert.equal(stored.tabs[0].settings.cwd,session.currentCwd);
 assert.equal(stored.tabs[0].settings.model,'model-b');
 assert.equal(stored.tabs[0].settings.access,'danger-full-access');
 assert.equal(stored.tabs[0].thread.turns,undefined);
 assert.equal(stored.tabs[0].attachments[0].path,undefined);
 const store=createUpdateCheckpoint(dir);
 await store.save(stored);
 assert.deepEqual(await store.read(),stored);
 await store.clear(); assert.equal(await store.read(),null);
});

test('checkpoint refuses stale/duplicate tabs and invalid payloads rather than losing user state', () => {
 const sessions=new Map([['session',session]]);
 const value=snapshot();value.tabs.push(value.tabs[0]);
 assert.throws(()=>captureUpdateCheckpoint(value,sessions));
 assert.throws(()=>captureUpdateCheckpoint(snapshot(),new Map()));
 assert.throws(()=>captureUpdateCheckpoint({version:1,activeIndex:0,tabs:[]},sessions));
 const broken=snapshot();broken.tabs[0].attachments=[{name:'bad',dataUrl:'data:text/plain,secret'}];
 assert.throws(()=>captureUpdateCheckpoint(broken,sessions));
 const noTab={version:1,activeIndex:0,tabs:[]};
 assert.deepEqual(captureUpdateCheckpoint(noTab,new Map()),noTab);
});
