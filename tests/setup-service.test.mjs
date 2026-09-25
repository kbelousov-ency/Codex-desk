import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SetupService } from '../electron/setup-service.mjs';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await mkdir(home);
  const settings = { codex: {}, claude: {} };
  const installed = new Set();
  const calls = [];
  const finders = Object.fromEntries(['codex', 'claude', 'git'].map(id => [id, async preferred => {
    if (preferred) return preferred;
    if (!installed.has(id)) throw new Error('missing');
    return path.join(root, `${id}.exe`);
  }]));
  const service = new SetupService({ directory: path.join(root, 'profile'), home, env: { USERPROFILE: home, PATH: 'old-path' }, platform: 'win32',
    getSettings: async id => settings[id], saveSettings: async (id, patch) => { settings[id] = { ...settings[id], ...patch }; },
    finders, run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === '--version') {
        const id = path.basename(file).replace(/\.exe$/, '');
        return { stdout: { codex: 'codex-cli 0.100.0\n', claude: '2.1.1 (Claude Code)\n', git: 'git version 2.50.1.windows.1\n', winget: 'v1.12.0\n' }[id] || '' };
      }
      const script = args.includes('-EncodedCommand') ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : '';
      installed.add(script.includes('chatgpt.com') ? 'codex' : script.includes('claude.ai') ? 'claude' : 'git');
      return { stdout: '' };
    }, ...extra });
  t.after(() => service.dispose());
  return { root, home, settings, installed, calls, service, config: path.join(home, '.codex', 'config.toml') };
}

async function writeConfig(filename, contents = 'model = "configured-model"\r\n') {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
  return filename;
}

test('first launch shows setup; completion and deferral persist without changing agent settings', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.state(), { show: true, completed: false, deferred: false });
  assert.deepEqual(await f.service.complete({ provider: 'claude', deferred: true }), { show: false, completed: false, deferred: true });
  assert.deepEqual(f.settings, { codex: {}, claude: {} });
  assert.deepEqual(await f.service.complete({ provider: 'codex' }), { show: false, completed: true, deferred: false });
  assert.deepEqual(JSON.parse(await readFile(f.service.filename, 'utf8')).provider, 'codex');
  assert.equal((await readdir(path.dirname(f.service.filename))).length, 1);
});

test('existing user is not interrupted by the new wizard during update', async t => {
  const { service } = await fixture(t, { initialExisting: true });
  assert.deepEqual(await service.state(), { show: false, completed: false, deferred: false });
});

test('an interrupted first run resumes even after CLI installation has created settings', async t => {
  const f = await fixture(t);
  await f.service.state();
  await f.service.install('codex');
  const resumed = new SetupService({ directory: f.service.directory, initialExisting: true });
  t.after(() => resumed.dispose());
  assert.deepEqual(await resumed.state(), { show: true, completed: false, deferred: false });
  await resumed.complete({ deferred: true });
  assert.deepEqual(await resumed.state(), { show: false, completed: false, deferred: true });
});

test('scan distinguishes missing, working and broken executables without leaking process output', async t => {
  const f = await fixture(t);
  f.installed.add('codex');
  f.settings.claude.executable = path.join(f.root, 'broken.exe');
  f.service.run = async file => {
    if (file.endsWith('codex.exe')) return { stdout: 'codex-cli 0.100.0\n' };
    throw new Error('secret-token from stderr');
  };
  const result = await f.service.scan();
  assert.deepEqual(result.components.map(value => value.status), ['installed', 'error', 'missing']);
  assert.equal(result.config.exists, false);
  assert.equal(result.components[0].version, '0.100.0');
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('install is explicit, uses official URLs in a hidden no-shell process, and discovers binary with stale PATH', async t => {
  const f = await fixture(t);
  await f.service.scan();
  assert.equal(f.calls.length, 0);
  const progress = [];
  const scan = await f.service.install('codex', value => progress.push(value));
  const installer = f.calls.find(value => value.args.includes('-EncodedCommand'));
  const script = Buffer.from(installer.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /https:\/\/chatgpt\.com\/codex\/install\.ps1/);
  assert.equal(installer.options.windowsHide, true);
  assert.equal(installer.options.shell, false);
  assert.equal(installer.options.env.CODEX_NON_INTERACTIVE, '1');
  assert.equal(installer.options.timeout, 15 * 60_000);
  assert.deepEqual(progress.map(value => value.stage), ['installing', 'checking', 'done']);
  assert.equal(scan.components[0].status, 'installed');
  assert.equal(f.settings.codex.executable, path.join(f.root, 'codex.exe'));
  assert.ok(f.service.env.PATH.startsWith(f.root));
  await f.service.install('codex');
  assert.equal(f.calls.filter(value => value.args.includes('-EncodedCommand')).length, 1);
});

test('Codex update uses the native update command and preserves settings', async t => {
  const f = await fixture(t);
  const executable = path.join(f.root, 'codex.exe');
  f.installed.add('codex');
  f.settings.codex = { executable, model: 'preserved', effort: 'high' };
  const progress = [];
  const result = await f.service.update('codex', value => progress.push(value));
  const update = f.calls.find(value => value.args[0] === 'update');
  assert.equal(update.file, executable);
  assert.deepEqual(update.args, ['update']);
  assert.equal(update.options.shell, false);
  assert.equal(update.options.windowsHide, true);
  assert.equal(update.options.env.CODEX_NON_INTERACTIVE, '1');
  assert.equal(update.options.env.TERM, undefined);
  assert.equal(update.options.timeout, 15 * 60_000);
  assert.deepEqual(progress.map(value => value.stage), ['installing', 'checking', 'done']);
  assert.equal(result.components[0].status, 'installed');
  assert.deepEqual(f.settings.codex, { executable, model: 'preserved', effort: 'high' });
});
test('Claude native install uses its official script and preserves existing Codex preferences', async t => {
  const f = await fixture(t);
  f.settings.codex = { model: 'custom', effort: 'high' };
  await f.service.install('claude');
  const installer = f.calls.find(value => value.args.includes('-EncodedCommand'));
  assert.match(Buffer.from(installer.args.at(-1), 'base64').toString('utf16le'), /https:\/\/claude\.ai\/install\.ps1/);
  assert.deepEqual(f.settings.codex, { model: 'custom', effort: 'high' });
  assert.equal(f.settings.claude.executable, path.join(f.root, 'claude.exe'));
});

test('installer failures hide raw stderr, emit an error event and release the reservation', async t => {
  const f = await fixture(t, { run: async () => { throw new Error('secret bearer credential'); } });
  const progress = [];
  await assert.rejects(f.service.install('claude', value => progress.push(value)), error => !error.message.includes('credential') && /Не удалось/.test(error.message));
  assert.equal(progress.at(-1).stage, 'error');
  assert.equal(JSON.stringify(progress).includes('credential'), false);
  assert.equal(f.service.busy, false);
});

test('Git without winget gives a specific manual download action without attempting installation', async t => {
  const f = await fixture(t, { run: async () => { throw new Error('not found'); } });
  await assert.rejects(f.service.install('git'), /winget.*https:\/\/git-scm.com\/download\/win/);
});

test('install serializes mutations and exposes the active component until done', async t => {
  const f = await fixture(t);
  const originalRun = f.service.run;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.service.run = async (...args) => {
    if (args[1].includes('-EncodedCommand')) { started(); await new Promise(resolve => { release = resolve; }); }
    return originalRun(...args);
  };
  const installing = f.service.install('codex');
  await ready;
  assert.equal(f.service.busy, true);
  assert.equal(f.service.activeComponent, 'codex');
  await assert.rejects(f.service.install('claude'), /Дождитесь/);
  await assert.rejects(f.service.applyMemoryRules({ provider: 'claude', enabled: true, revision: 'unused' }), /Дождитесь/);
  await assert.rejects(f.service.complete(), /Дождитесь/);
  let idle = false;
  const waiting = f.service.waitForIdle().then(() => { idle = true; });
  assert.equal(idle, false);
  release();
  await installing; await waiting;
  assert.equal(idle, true);
  assert.equal(f.service.activeComponent, null);
});

test('busy user tasks reject setup mutations before spawning an installer', async t => {
  const f = await fixture(t, { assertMutable: () => { throw new Error('user task active'); } });
  await assert.rejects(f.service.install('codex'), /user task active/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.busy, false);
});

test('component IDs, executable arguments and non-executable paths are rejected', async t => {
  const f = await fixture(t);
  for (const id of ['constructor', '__proto__', 'powershell', 'codex --help']) await assert.rejects(f.service.install(id), /Неизвестный/);
  await assert.rejects(f.service.setExecutable('codex', 'codex.exe --evil'), /Выберите/);
  await assert.rejects(f.service.setExecutable('claude', path.join(f.root, 'claude.cmd')), /Выберите/);
  assert.equal(f.calls.length, 0);
});

test('choosing an executable verifies its launch before persisting just that provider path', async t => {
  const f = await fixture(t);
  const binary = path.join(f.root, 'codex.exe');
  await writeFile(binary, 'fixture');
  f.settings.codex = { model: 'preserved', access: 'prompt' };
  await f.service.setExecutable('codex', binary);
  assert.deepEqual(f.settings.codex, { model: 'preserved', access: 'prompt', executable: binary });
  assert.deepEqual(f.settings.claude, {});
  assert.equal(f.calls[0].args[0], '--version');
  const wrong = path.join(f.root, 'wrong.exe');
  await writeFile(wrong, 'fixture');
  await assert.rejects(f.service.setExecutable('codex', wrong), /проверить его запуск/);
  assert.equal(f.settings.codex.executable, binary);
});

test('a broken saved executable is repairable by choosing another file without reinstalling', async t => {
  const f = await fixture(t);
  f.settings.codex = { executable: path.join(f.root, 'removed.exe'), model: 'preserved' };
  assert.equal((await f.service.scan()).components[0].status, 'error');
  await assert.rejects(f.service.install('codex'), /проверьте путь/);
  assert.equal(f.calls.some(call => call.args.includes('-EncodedCommand')), false);
  const replacement = path.join(f.root, 'codex.exe');
  await writeFile(replacement, 'fixture');
  const repaired = await f.service.setExecutable('codex', replacement);
  assert.equal(repaired.components[0].status, 'installed');
  assert.deepEqual(f.settings.codex, { executable: replacement, model: 'preserved' });
  assert.equal(f.calls.some(call => call.args.includes('-EncodedCommand')), false);
});

test('Git installation uses the exact official winget package and adds only its binary directory to this process PATH', async t => {
  const f = await fixture(t);
  await f.service.install('git');
  const install = f.calls.find(value => value.args[0] === 'install');
  assert.equal(install.file, 'winget.exe');
  assert.deepEqual(install.args, ['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity', '--silent']);
  assert.equal(install.options.shell, false);
  assert.equal(f.service.env.PATH, `${f.root};old-path`);
  assert.deepEqual(f.settings, { codex: {}, claude: {} });
});

test('config preview exposes only metadata and imports exact source bytes with no backup for new config', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('\uFEFFmodel = "private-provider"\r\n[model_providers.work]\r\nexperimental_bearer_token = "private-secret"\r\n');
  const source = await writeConfig(path.join(f.root, 'download.toml'), bytes);
  const preview = await f.service.previewConfig(source);
  assert.equal(preview.filename, 'download.toml');
  assert.equal(preview.targetPath, f.config);
  assert.equal(preview.exists, false);
  assert.equal(JSON.stringify(preview).includes('private'), false);
  assert.equal(f.calls.length, 0);
  const saved = await f.service.applyConfig({ previewId: preview.previewId });
  assert.equal(saved.backupPath, null);
  assert.deepEqual(await readFile(f.config), bytes);
  assert.deepEqual(await readdir(path.dirname(f.config)), ['config.toml']);
  await assert.rejects(f.service.applyConfig({ previewId: preview.previewId }), /истекла|отменена/);
});

test('replacement requires confirmation, preserves exact original bytes and never changes unrelated files', async t => {
  const f = await fixture(t);
  const original = Buffer.from('# old config\r\nmodel = "old"\r\n');
  await writeConfig(f.config, original);
  const credentials = path.join(path.dirname(f.config), 'auth.json');
  await writeFile(credentials, 'do-not-touch');
  const source = await writeConfig(path.join(f.root, 'config.toml'), 'model = "new"\n');
  const preview = await f.service.previewConfig(source);
  await assert.rejects(f.service.applyConfig({ previewId: preview.previewId }), /Подтвердите/);
  assert.deepEqual(await readFile(f.config), original);
  const saved = await f.service.applyConfig({ previewId: preview.previewId, replaceExisting: true });
  assert.deepEqual(await readFile(saved.backupPath), original);
  assert.equal(await readFile(f.config, 'utf8'), 'model = "new"\n');
  assert.equal(await readFile(credentials, 'utf8'), 'do-not-touch');
});

test('invalid, empty, oversized and non-TOML files are rejected without parser excerpts', async t => {
  const f = await fixture(t);
  for (const text of ['api_key = "super-secret"\nmalformed = [', '# empty', 'model = "' + 'x'.repeat(2 * 1024 * 1024) + '"']) {
    const source = await writeConfig(path.join(f.root, 'invalid.toml'), text);
    await assert.rejects(f.service.previewConfig(source), error => !error.message.includes('super-secret'));
  }
  await assert.rejects(f.service.previewConfig(path.join(f.root, 'config.json')), /\.toml/);
  assert.equal(await f.service._exists(f.config), false);
});

test('custom CODEX_HOME is shown and used, leaving the standard config unchanged', async t => {
  const f = await fixture(t);
  const custom = path.join(f.root, 'custom-codex');
  f.service.env.CODEX_HOME = custom;
  await writeConfig(f.config, 'model = "standard"');
  const source = await writeConfig(path.join(f.root, 'import.toml'), 'model = "custom"');
  const preview = await f.service.previewConfig(source);
  assert.equal(preview.customHome, true);
  assert.equal(preview.defaultPath, f.config);
  assert.equal(preview.targetPath, path.join(custom, 'config.toml'));
  const saved = await f.service.applyConfig({ previewId: preview.previewId });
  assert.equal(saved.configPath, preview.targetPath);
  assert.equal(await readFile(f.config, 'utf8'), 'model = "standard"');
  assert.equal(await readFile(saved.configPath, 'utf8'), 'model = "custom"');
});

test('stale source, target, CODEX_HOME and expired previews cannot overwrite configuration', async t => {
  for (const change of ['source', 'target', 'home', 'expiry']) {
    const f = await fixture(t);
    await writeConfig(f.config, 'model = "old"');
    const source = await writeConfig(path.join(f.root, 'new.toml'));
    const preview = await f.service.previewConfig(source);
    if (change === 'source') await writeFile(source, 'model = "changed"');
    if (change === 'target') await writeFile(f.config, 'model = "external"');
    if (change === 'home') f.service.env.CODEX_HOME = path.join(f.root, 'new-home');
    if (change === 'expiry') f.service.now = () => Date.now() + 11 * 60_000;
    await assert.rejects(f.service.applyConfig({ previewId: preview.previewId, replaceExisting: true }), /изменились|истекла/);
    assert.equal(await readFile(f.config, 'utf8'), change === 'target' ? 'model = "external"' : 'model = "old"');
  }
});

test('external write during staging is detected before atomic commit; backup survives and tmp is removed', async t => {
  const f = await fixture(t);
  await writeConfig(f.config, 'model = "original"');
  const source = await writeConfig(path.join(f.root, 'new.toml'));
  const preview = await f.service.previewConfig(source);
  f.service.beforeConfigCommit = () => writeFile(f.config, 'model = "external"');
  await assert.rejects(f.service.applyConfig({ previewId: preview.previewId, replaceExisting: true }), /изменились/);
  assert.equal(await readFile(f.config, 'utf8'), 'model = "external"');
  const files = await readdir(path.dirname(f.config));
  assert.equal(files.some(value => value.endsWith('.tmp')), false);
  const backup = files.find(value => value.startsWith('config.toml.backup-'));
  assert.equal(await readFile(path.join(path.dirname(f.config), backup), 'utf8'), 'model = "original"');
});

test('a new config created while staging is preserved', async t => {
  const f = await fixture(t);
  const source = await writeConfig(path.join(f.root, 'new.toml'));
  const preview = await f.service.previewConfig(source);
  f.service.beforeConfigCommit = () => writeFile(f.config, 'model = "external"');
  await assert.rejects(f.service.applyConfig({ previewId: preview.previewId }), /изменились/);
  assert.equal(await readFile(f.config, 'utf8'), 'model = "external"');
});

test('backup write failure prevents replacement and removes no existing files', async t => {
  const f = await fixture(t, { writeBackup: async () => { throw new Error('disk full with private file content'); } });
  await writeConfig(f.config, 'model = "original"');
  const source = await writeConfig(path.join(f.root, 'new.toml'));
  const preview = await f.service.previewConfig(source);
  await assert.rejects(f.service.applyConfig({ previewId: preview.previewId, replaceExisting: true }), /Не удалось создать резервную/);
  assert.equal(await readFile(f.config, 'utf8'), 'model = "original"');
  assert.deepEqual(await readdir(path.dirname(f.config)), ['config.toml']);
});

test('a later config preview wins even when an earlier read finishes last', async t => {
  const f = await fixture(t);
  const first = await writeConfig(path.join(f.root, 'first.toml'), 'model = "first"');
  const second = await writeConfig(path.join(f.root, 'second.toml'), 'model = "second"');
  const snapshot = f.service._snapshot.bind(f.service);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.service._snapshot = async (...args) => {
    if (args[0] === first) { started(); await new Promise(resolve => { release = resolve; }); }
    return snapshot(...args);
  };
  const firstPreview = f.service.previewConfig(first);
  await ready;
  const secondPreview = await f.service.previewConfig(second);
  release();
  await assert.rejects(firstPreview, /Выбор файла изменился/);
  await f.service.applyConfig({ previewId: secondPreview.previewId });
  assert.equal(await readFile(f.config, 'utf8'), 'model = "second"');
});

test('preview disposal cannot resurrect a pending import after an asynchronous read', async t => {
  const f = await fixture(t);
  const source = await writeConfig(path.join(f.root, 'source.toml'));
  const snapshot = f.service._snapshot.bind(f.service);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.service._snapshot = async (...args) => {
    if (args[0] === source) { started(); await new Promise(resolve => { release = resolve; }); }
    return snapshot(...args);
  };
  const preview = f.service.previewConfig(source);
  await ready;
  f.service.dispose();
  release();
  await assert.rejects(preview, /закрывается/);
  assert.equal(f.service._pending, null);
});


test('memory rules are never applied by setup startup, scan, completion or disposal', async t => {
  const calls = [];
  const memoryRules = {
    preview: async provider => { calls.push(['preview', provider]); return { provider, enabled: false, revision: 'fixture' }; },
    apply: async options => { calls.push(['apply', options]); },
  };
  const f = await fixture(t, { memoryRules });
  await f.service.state();
  await f.service.scan();
  await f.service.complete({ provider: 'codex' });
  assert.deepEqual(calls, []);
  assert.deepEqual(await f.service.previewMemoryRules('claude'), { provider: 'claude', enabled: false, revision: 'fixture' });
  assert.deepEqual(calls, [['preview', 'claude']]);
  f.service.dispose();
  assert.throws(() => f.service.previewMemoryRules('codex'), /закрывается/);
  await assert.rejects(f.service.applyMemoryRules({ provider: 'codex', enabled: true, revision: 'fixture' }), /закрывается/);
  assert.deepEqual(calls, [['preview', 'claude']]);
  assert.equal(f.calls.length, 0, 'Local instruction lifecycle must not launch a CLI');
});

test('memory changes reserve the shared setup mutation and shutdown waits for their completion', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const options = { provider: 'claude', enabled: true, revision: 'fixture' };
  const result = { provider: 'claude', enabled: true, changed: true, backupPaths: ['fixture-backup'] };
  const applied = [];
  const f = await fixture(t, { memoryRules: {
    preview: async provider => ({ provider, enabled: false }),
    apply: async value => { applied.push(value); started(); await new Promise(resolve => { release = resolve; }); return result; },
  } });
  const changing = f.service.applyMemoryRules(options);
  await ready;
  assert.equal(f.service.busy, true);
  assert.equal(f.service.activeComponent, 'claude');
  await assert.rejects(f.service.install('codex'), /Дождитесь/);
  await assert.rejects(f.service.complete(), /Дождитесь/);
  await assert.rejects(f.service.applyMemoryRules({ provider: 'codex', enabled: true, revision: 'fixture' }), /Дождитесь/);
  assert.deepEqual(await f.service.previewMemoryRules('codex'), { provider: 'codex', enabled: false });
  let idle = false;
  const waiting = f.service.waitForIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release();
  assert.deepEqual(await changing, result);
  await waiting;
  assert.equal(idle, true);
  assert.equal(f.service.busy, false);
  assert.equal(f.service.activeComponent, null);
  assert.deepEqual(applied, [options]);
  assert.equal(f.calls.length, 0);
});

test('active tasks and invalid providers reject memory mutations before the filesystem service runs', async t => {
  const guarded = [], applied = [];
  const f = await fixture(t, { assertMutable: provider => { guarded.push(provider); throw new Error('user task active'); }, memoryRules: {
    preview: async provider => ({ provider, enabled: false }),
    apply: async options => applied.push(options),
  } });
  assert.deepEqual(await f.service.previewMemoryRules('claude'), { provider: 'claude', enabled: false });
  assert.deepEqual(guarded, [], 'Reading instructions stays available while a task runs');
  for (const options of [undefined, {}, { provider: 'git' }, { provider: '__proto__' }]) {
    await assert.rejects(f.service.applyMemoryRules(options), /Неизвестный агент/);
  }
  assert.deepEqual(guarded, []);
  for (const provider of ['codex', 'claude']) {
    await assert.rejects(f.service.applyMemoryRules({ provider, enabled: true, revision: 'fixture' }), /user task active/);
  }
  assert.deepEqual(guarded, ['codex', 'claude']);
  assert.deepEqual(applied, []);
  assert.equal(f.service.busy, false);
  assert.equal(f.calls.length, 0);
});

test('failed memory changes release the shared reservation and allow a later retry', async t => {
  let attempts = 0;
  const f = await fixture(t, { memoryRules: { apply: async () => {
    if (++attempts === 1) throw new Error('fixture write failure');
    return { enabled: true, changed: true, backupPaths: [] };
  } } });
  const options = { provider: 'codex', enabled: true, revision: 'fixture' };
  await assert.rejects(f.service.applyMemoryRules(options), /fixture write failure/);
  await f.service.waitForIdle();
  assert.equal(f.service.busy, false);
  assert.equal(f.service.activeComponent, null);
  assert.equal((await f.service.applyMemoryRules(options)).enabled, true);
  assert.equal(attempts, 2);
  assert.equal(f.calls.length, 0);
});
