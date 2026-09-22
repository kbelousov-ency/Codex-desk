import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function verifyShellIcon(app, profile, identity) {
  if (process.platform !== 'win32') return { skipped: 'Windows shell only' };
  const source = await readFile(path.join(root, 'electron', 'icon.ico'));
  const digest = createHash('sha256').update(source).digest('hex');
  const icon = path.join(profile, 'shell-icons', `icon-${digest}.ico`);
  assert.deepEqual(await readFile(icon), source, 'Startup must persist the complete ICO outside the replaceable app directory');
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  const modulePath = path.join(appPath, 'electron', 'windows-shell-icon.mjs');
  const shortcut = path.join(profile, 'fixture-icon.lnk');
  const fixture = { modulePath, shortcut, icon, appId: identity.appId, cwd: project };
  const repaired = await app.evaluate(async ({ shell }, fixture) => {
    const { repairShellShortcutIcon } = process.getBuiltinModule('module').createRequire(fixture.modulePath)(fixture.modulePath);
    const details = {
      target: process.execPath, cwd: fixture.cwd,
      args: '--fixture="Сохранить аргументы"', description: 'Disposable shell icon fixture',
      appUserModelId: fixture.appId, toastActivatorClsid: '{A85F6D6F-1345-46AD-B10C-E263D1631191}',
      icon: process.execPath, iconIndex: 7,
    };
    if (!shell.writeShortcutLink(fixture.shortcut, 'create', details)) throw new Error('Cannot create fixture shortcut');
    const before = shell.readShortcutLink(fixture.shortcut);
    // Windows targets are case-insensitive; the stored target itself must remain intact.
    const changed = await repairShellShortcutIcon({
      shell, shortcut: fixture.shortcut, executable: process.execPath.toUpperCase(),
      appId: fixture.appId, icon: fixture.icon,
    });
    return { changed, before, after: shell.readShortcutLink(fixture.shortcut) };
  }, fixture);
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.after, { ...repaired.before, icon, iconIndex: 0 }, 'Repair must preserve target, args, cwd, AppID, description and toast activator');

  const once = await readFile(shortcut);
  const repeated = await app.evaluate(async ({ shell }, fixture) => {
    const { repairShellShortcutIcon } = process.getBuiltinModule('module').createRequire(fixture.modulePath)(fixture.modulePath);
    return repairShellShortcutIcon({ shell, shortcut: fixture.shortcut, executable: process.execPath, appId: fixture.appId, icon: fixture.icon });
  }, fixture);
  assert.equal(repeated, false, 'An already-correct shortcut must be a no-op');
  assert.deepEqual(await readFile(shortcut), once, 'No-op repair must not rewrite the shortcut');

  for (const foreign of ['target', 'appId']) {
    const rejected = await app.evaluate(async ({ shell }, { fixture, foreign }) => {
      const { repairShellShortcutIcon } = process.getBuiltinModule('module').createRequire(fixture.modulePath)(fixture.modulePath);
      return repairShellShortcutIcon({
        shell, shortcut: fixture.shortcut,
        executable: foreign === 'target' ? `${process.execPath}.other.exe` : process.execPath,
        appId: foreign === 'appId' ? `${fixture.appId}.other` : fixture.appId,
        icon: `${fixture.icon}.different.ico`,
      });
    }, { fixture, foreign });
    assert.equal(rejected, false, `A foreign ${foreign} must not be repaired`);
    assert.deepEqual(await readFile(shortcut), once, `Foreign ${foreign} rejection must preserve the shortcut bytes`);
  }
  const missing = await app.evaluate(async ({ shell }, fixture) => {
    const { repairShellShortcutIcon } = process.getBuiltinModule('module').createRequire(fixture.modulePath)(fixture.modulePath);
    return repairShellShortcutIcon({ shell, shortcut: `${fixture.shortcut}.missing.lnk`, executable: process.execPath, appId: fixture.appId, icon: fixture.icon });
  }, fixture);
  assert.equal(missing, false, 'Repair must not register a missing shortcut');
  assert.equal((await readdir(profile)).includes('fixture-icon.lnk.missing.lnk'), false);
  const watched = await app.evaluate(async ({ shell }, fixture) => {
    const { watchShellShortcutIcon } = process.getBuiltinModule('module').createRequire(fixture.modulePath)(fixture.modulePath);
    const errors = [];
    const clearIcon = () => {
      if (!shell.writeShortcutLink(fixture.shortcut, 'update', { icon: '', iconIndex: 0 })) throw new Error('Cannot reset fixture icon');
    };
    const waitForRepair = async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const current = shell.readShortcutLink(fixture.shortcut);
        if (current.icon === fixture.icon && current.iconIndex === 0) return current;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('The real Windows directory watcher did not restore the fixture icon');
    };
    clearIcon();
    const stop = watchShellShortcutIcon({
      shell, shortcut: fixture.shortcut, executable: process.execPath, appId: fixture.appId, icon: fixture.icon,
    }, { onError: error => errors.push(error.message) });
    try {
      const initial = await waitForRepair();
      clearIcon();
      const rewritten = await waitForRepair();
      return { initial, rewritten, errors };
    } finally {
      stop();
    }
  }, fixture);
  assert.deepEqual(watched.initial, repaired.after, 'Starting the watcher must fix an existing blank icon');
  assert.deepEqual(watched.rewritten, repaired.after, 'The real Windows watcher must restore an asynchronously cleared icon');
  assert.deepEqual(watched.errors, []);
  return { icon, shortcut, preserved: repaired.after, repeated, foreignGuards: true, missing, watcher: watched };
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
    const shellIcon = await verifyShellIcon(app, profile, applicationIdentity(info.channel, actual.pid));
    assert.deepEqual(await productionShortcuts(), before, 'Disposable notification settings must not alter production shortcuts');
    results.push({ testFlag, ...actual, channel: info.channel, shellIcon });
  } finally {
    if (app) await app.close();
  }
  assert.deepEqual(await productionShortcuts(), before, 'Closing a disposable app must not alter production shortcuts');
}
const requests = (await readFile(path.join(project, 'server.jsonl'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.ok(requests.every(request => request.method !== 'turn/start'), 'No model turn is started');
await writeFile(path.join(run, 'result.json'), JSON.stringify(results, null, 2));
console.log(`PASS: isolated identity and persistent shell icons with and without TEST flag, real shortcut repair preserves metadata and rejects foreign targets, production shortcuts unchanged, no model turns. ${run}`);
