import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { assertNotRunning, verifyRelease } from './release-utils.mjs';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'release-host-'));
const project = path.join(run, 'project');
await mkdir(project);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await writeFile(path.join(project, 'app-server'), String.raw`
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const {id,method}=JSON.parse(line); if(method==='initialized')return;
 const result=method==='initialize'?{userAgent:'codex_desk/0.154.0'}
 :method==='model/list'?{data:[{id:'fixture',model:'fixture',displayName:'fixture',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}
 :method==='config/read'?{config:{model:'fixture'}}
 :method==='account/read'?{account:null,requiresOpenaiAuth:false}
 :{data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id,result})+'\n');
});
`);
const apps = [];
try {
  const infos = [];
  for (const channel of ['stable', 'nightly']) {
    const profile = path.join(run, channel);
    await mkdir(profile);
    await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ cwd: project, executable: process.execPath, model: 'fixture' }));
    const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
    delete env.CODEX_DESK_TEST; delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL;
    const directory = path.join(root, 'release', channel);
    const manifest = await verifyRelease(root, directory, channel);
    const app = await electron.launch({ executablePath: path.join(directory, 'Codex Desk.exe'), args: [], cwd: root, env });
    apps.push(app);
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.codex?.getBuildInfo));
    const info = await page.evaluate(() => window.codex.getBuildInfo());
    assert.equal(info.channel, channel); assert.equal(info.buildId, manifest.buildId);
    const windowTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    assert.ok(windowTitle.includes(channel === 'stable' ? 'Release' : 'Nightly'));
    await page.locator('.build-badge').filter({ hasText: channel === 'stable' ? 'RELEASE' : 'NIGHTLY' }).first().waitFor();
    await page.evaluate(() => window.codex.start());
    await page.evaluate(channel => window.codex.setSettings({ effort: channel === 'stable' ? 'high' : 'low' }), channel);
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), name: app.getName() }));
    assert.equal(paths.userData, profile);
    await assert.rejects(assertNotRunning(directory), /Закройте/, 'Running channel cannot be replaced');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path.join(run, `${channel}.json`));
    await page.evaluate(() => window.codex.exportDiagnostics());
    const report = JSON.parse(await readFile(path.join(run, `${channel}.json`), 'utf8'));
    assert.equal(report.environment.releaseChannel, channel);
    assert.equal(report.environment.buildId, info.buildId);
    infos.push({ ...info, paths });
    await page.screenshot({ path: path.join(run, `${channel}.png`) });
  }
  assert.equal(infos[0].buildId, infos[1].buildId, 'Promoted Release is the exact tested Nightly');
  assert.notEqual(infos[0].paths.userData, infos[1].paths.userData);
  assert.notEqual(infos[0].paths.sessionData, infos[1].paths.sessionData);
  assert.equal(JSON.parse(await readFile(path.join(run, 'stable/settings.json'), 'utf8')).effort, 'high');
  assert.equal(JSON.parse(await readFile(path.join(run, 'nightly/settings.json'), 'utf8')).effort, 'low');
  console.log(`PASS: both packaged channels run together, exact promotion, labels/build IDs/log channel, separate settings/Chromium profiles, running update guard. Fake Codex only. ${run}`);
} finally { for (const app of apps.reverse()) await app.close(); }
