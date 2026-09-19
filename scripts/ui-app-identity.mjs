import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationIdentity } from '../electron/app-identity.mjs';

// Real Electron, disposable profiles and a fixture server. Reading the shell's
// notification preferences must not initialize Windows' production registration.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts', 'app-identity-'));
const project = path.join(run, 'project');
await mkdir(project);
await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
await copyFile(path.join(root, 'scripts', 'fixtures', 'session-server.mjs'), path.join(project, 'app-server'));

async function productionShortcuts() {
  if (process.platform !== 'win32') return {};
  const directories = [root, path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const result = {};
  for (const directory of directories) {
    const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const filename of files.filter(name => /^Codex Desk(?: Nightly| Development)?\.lnk$/i.test(name))) {
      const file = path.join(directory, filename);
      result[file] = (await readFile(file)).toString('base64');
    }
  }
  return result;
}

const before = await productionShortcuts();
const results = [];
for (const testFlag of [true, false]) {
  const profile = path.join(run, testFlag ? 'test-flag' : 'profile-only');
  await mkdir(profile);
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    executable: process.execPath, cwd: project, model: 'fixture-alpha', effort: 'high', access: 'workspace-write',
  }));
  const env = { ...process.env, CODEX_DESK_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEX_DESK_DEV_URL;
  if (testFlag) env.CODEX_DESK_TEST = '1'; else delete env.CODEX_DESK_TEST;
  let app;
  try {
    app = await electron.launch({
      ...(process.env.CODEX_DESK_PACKAGED ? { executablePath: process.env.CODEX_DESK_PACKAGED, args: [] } : { args: ['.'] }),
      cwd: root, env, timeout: 30_000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole('tablist', { name: 'Открытые диалоги', exact: true }).waitFor();
    const info = await page.evaluate(() => window.codex.getBuildInfo());
    const notificationSettings = await page.evaluate(() => window.codex.getNotificationSettings());
    assert.equal(notificationSettings.supported, false, 'Disposable profiles must never initialize the Windows notification presenter');
    const actual = await app.evaluate(({ app, BrowserWindow }) => ({
      name: app.getName(), pid: process.pid, userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length,
    }));
    assert.equal(actual.name, applicationIdentity(info.channel, actual.pid).name);
    assert.equal(actual.userData, profile);
    assert.equal(actual.windows, 1);
    assert.deepEqual(await productionShortcuts(), before, 'Disposable notification settings must not alter production shortcuts');
    results.push({ testFlag, ...actual, channel: info.channel });
  } finally {
    if (app) await app.close();
  }
  assert.deepEqual(await productionShortcuts(), before, 'Closing a disposable app must not alter production shortcuts');
}
const requests = (await readFile(path.join(project, 'server.jsonl'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.ok(requests.every(request => request.method !== 'turn/start'), 'No model turn is started');
await writeFile(path.join(run, 'result.json'), JSON.stringify(results, null, 2));
console.log(`PASS: isolated identity with and without TEST flag, real notification settings preserve production shortcuts, no model turns. ${run}`);
