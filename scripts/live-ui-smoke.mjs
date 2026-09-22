import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const cwd=path.join(root,'artifacts','live-test');
const dataDir=path.join(root,'artifacts','live-ui-profile');
await mkdir(cwd,{recursive:true});await mkdir(dataDir,{recursive:true});
await writeFile(path.join(dataDir,'settings.json'),JSON.stringify({cwd,access:'read-only'}));
const env={...process.env,CODEX_DESK_TEST:'1',CODEX_DESK_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
const errors=[];
let app;
const launch=async()=>{
 const instance=await electron.launch({args:['.'],cwd:root,env,timeout:30000});
 const page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>document.querySelector('[role="combobox"][aria-label="Модель"]')?.getAttribute('data-value')==='gpt-6-astra');
 await page.waitForFunction(()=>!document.querySelector('.history-label button')?.disabled);
 return {instance,page};
};
try {
 let launched=await launch();app=launched.instance;let page=launched.page;
 await page.locator('input[type=file]').setInputFiles(path.join(root,'artifacts','red-square.png'));
 await page.locator('.composer textarea').fill('Проверка изображения. Не используй инструменты и не меняй файлы. Назови основной цвет приложенного квадрата одним словом по-русски.');
 await page.getByRole('button',{name:'Отправить сообщение',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.assistant-message .markdown')?.textContent?.toLowerCase().includes('красн'),null,{timeout:60000});
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Остановить выполнение"]'),null,{timeout:30000});
 assert.equal(await page.locator('.user-message img').count(),1);
 const answer=await page.locator('.assistant-message .markdown').last().textContent();
 await page.screenshot({path:path.join(root,'artifacts','live-conversation.png'),fullPage:true});
 await app.close();app=null;
 launched=await launch();app=launched.instance;page=launched.page;
 await page.locator('.history-item').first().click();
 await page.waitForFunction(()=>document.querySelector('.assistant-message .markdown')?.textContent?.toLowerCase().includes('красн'));
 await page.locator('.user-message img').waitFor({state:'visible'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',answer,realImageModelInput:true,imagePreservedAfterServerEcho:true,historyResumedAfterApplicationRestart:true,imageRestoredFromLocalAttachment:true},null,2));
} finally {if(app) await app.close();}
