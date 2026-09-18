import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveReleaseChannel, resolveChannelPaths, initializeChannelProfile } from '../electron/release-channel.mjs';

const buildInfo = { version: '0.1.0', buildId: 'a'.repeat(64), builtAt: '2026-09-18T12:34:56.000Z' };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-channels-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('packaged channels use an external bounded manifest and expose only public build fields', async t => {
  const resourcesPath = await temporary(t);
  for (const channel of ['nightly', 'stable']) {
    await writeFile(path.join(resourcesPath, 'channel.json'), JSON.stringify({ channel }));
    assert.deepEqual(resolveReleaseChannel({ isPackaged: true, resourcesPath, buildInfo: { ...buildInfo, secret: 'never-forward' } }), { channel, ...buildInfo });
  }
});

test('missing, malformed and ambiguous packaged channel markers fail closed', async t => {
  const resourcesPath = await temporary(t);
  const run = () => resolveReleaseChannel({ isPackaged: true, resourcesPath, buildInfo });
  assert.throws(run, /resources\/channel.json/);
  for (const content of ['bad-json', '{}', 'null', '[]', '{"channel":"development"}', '{"channel":"stable","unexpected":true}', JSON.stringify({ channel: 'nightly', padding: 'x'.repeat(1200) })]) {
    await writeFile(path.join(resourcesPath, 'channel.json'), content);
    assert.throws(run, /resources\/channel.json/);
  }
});

test('packaged build metadata must identify an exact valid build', async t => {
  const resourcesPath = await temporary(t);
  await writeFile(path.join(resourcesPath, 'channel.json'), '{"channel":"nightly"}');
  for (const invalid of [null, {}, { ...buildInfo, version: '' }, { ...buildInfo, version: 'x'.repeat(65) }, { ...buildInfo, buildId: '../file' }, { ...buildInfo, builtAt: '2026-02-31T12:34:56.000Z' }, { ...buildInfo, builtAt: 'arbitrary-text' }]) {
    assert.throws(() => resolveReleaseChannel({ isPackaged: true, resourcesPath, buildInfo: invalid }), /Метаданные/);
  }
});

test('development never reads the packaged marker and filters unsafe metadata', () => {
  assert.deepEqual(resolveReleaseChannel({ isPackaged: false, resourcesPath: 'does-not-exist', buildInfo: { version: 'bad version', buildId: 'secret', builtAt: 'secret', channel: 'stable' } }), {
    channel: 'development', version: 'development', buildId: null, builtAt: null,
  });
  assert.deepEqual(resolveReleaseChannel({ isPackaged: false, buildInfo }), { channel: 'development', ...buildInfo });
});

test('stable retains existing data and channels split settings while sharing historical images', async t => {
  const appData = await temporary(t);
  const stable = resolveChannelPaths({ appData, channel: 'stable' });
  const nightly = resolveChannelPaths({ appData, channel: 'nightly' });
  const development = resolveChannelPaths({ appData, channel: 'development' });
  assert.deepEqual(stable, { userData: path.join(appData, 'Codex Desk'), attachmentsDirectory: path.join(appData, 'Codex Desk', 'attachments') });
  assert.equal(nightly.userData, path.join(appData, 'Codex Desk Nightly'));
  assert.equal(nightly.legacyDataDirectory, stable.userData);
  assert.equal(development.userData, path.join(appData, 'Codex Desk Development'));
  assert.equal(development.legacyDataDirectory, undefined);
  assert.equal(nightly.attachmentsDirectory, stable.attachmentsDirectory);
  assert.equal(development.attachmentsDirectory, stable.attachmentsDirectory);
  assert.throws(() => resolveChannelPaths({ appData, channel: 'unknown' }), /Неизвестный/);
});

test('explicit test data override isolates settings and attachments without reading the real profile', async t => {
  const appData = await temporary(t);
  const override = path.join(appData, 'test-profile');
  const stable = path.join(appData, 'Codex Desk');
  await mkdir(stable);
  await writeFile(path.join(stable, 'settings.json'), '{"model":"real-model"}');
  for (const channel of ['stable', 'nightly', 'development']) {
    const paths = resolveChannelPaths({ appData, channel, dataDirOverride: override });
    assert.deepEqual(paths, { userData: override, attachmentsDirectory: path.join(override, 'attachments') });
    assert.deepEqual(await initializeChannelProfile(paths), { status: 'skipped', copied: [], issues: [] });
  }
  await assert.rejects(access(override));
  assert.equal(await readFile(path.join(stable, 'settings.json'), 'utf8'), '{"model":"real-model"}');
});

test('first Nightly launch copies only initial shell settings and folders without changing stable', async t => {
  const appData = await temporary(t);
  const paths = resolveChannelPaths({ appData, channel: 'nightly' });
  await mkdir(paths.legacyDataDirectory);
  const settings = JSON.stringify({ model: 'configured-model', effort: 'ultra', access: 'auto', executable: 'custom-codex', cwd: 'project', futureSetting: 3 }, null, 2);
  const workspace = JSON.stringify({ projects: ['project-a', 'project-b'] });
  for (const [name, value] of Object.entries({ 'settings.json': settings, 'workspace.json': workspace, 'auth.json': 'private', 'config.toml': 'private', 'Cookies': 'private' })) {
    await writeFile(path.join(paths.legacyDataDirectory, name), value);
  }
  assert.deepEqual(await initializeChannelProfile(paths), { status: 'initialized', copied: ['settings.json', 'workspace.json'], issues: [] });
  assert.equal(await readFile(path.join(paths.userData, 'settings.json'), 'utf8'), settings);
  assert.equal(await readFile(path.join(paths.userData, 'workspace.json'), 'utf8'), workspace);
  assert.deepEqual((await readdir(paths.userData)).sort(), ['.nightly-profile-initialized.json', 'settings.json', 'workspace.json']);
  assert.equal(await readFile(path.join(paths.legacyDataDirectory, 'settings.json'), 'utf8'), settings);
  await writeFile(path.join(paths.userData, 'settings.json'), '{"model":"nightly-model"}');
  await writeFile(path.join(paths.legacyDataDirectory, 'workspace.json'), '{"projects":["added-later"]}');
  assert.equal((await initializeChannelProfile(paths)).status, 'already-initialized');
  assert.equal(await readFile(path.join(paths.userData, 'settings.json'), 'utf8'), '{"model":"nightly-model"}');
  assert.equal(await readFile(path.join(paths.userData, 'workspace.json'), 'utf8'), workspace);
});

test('existing Nightly settings are never overwritten even before initialization marker', async t => {
  const appData = await temporary(t);
  const paths = resolveChannelPaths({ appData, channel: 'nightly' });
  await mkdir(paths.legacyDataDirectory);
  await mkdir(paths.userData);
  await writeFile(path.join(paths.legacyDataDirectory, 'settings.json'), '{"model":"stable-model"}');
  await writeFile(path.join(paths.userData, 'settings.json'), '{"model":"nightly-model"}');
  assert.deepEqual(await initializeChannelProfile(paths), { status: 'initialized', copied: [], issues: [] });
  assert.equal(await readFile(path.join(paths.userData, 'settings.json'), 'utf8'), '{"model":"nightly-model"}');
});

test('an empty initial stable profile is marked once and future stable settings are not imported', async t => {
  const appData = await temporary(t);
  const paths = resolveChannelPaths({ appData, channel: 'nightly' });
  assert.equal((await initializeChannelProfile(paths)).status, 'initialized');
  await mkdir(paths.legacyDataDirectory);
  await writeFile(path.join(paths.legacyDataDirectory, 'settings.json'), '{"model":"later-model"}');
  assert.equal((await initializeChannelProfile(paths)).status, 'already-initialized');
  await assert.rejects(access(path.join(paths.userData, 'settings.json')));
});

test('invalid or oversized source settings fail safely while valid independent workspace still imports', async t => {
  const appData = await temporary(t);
  for (const [index, invalid] of ['not-json', '[]', 'null', JSON.stringify({ oversized: 'x'.repeat(1024 * 1024) })].entries()) {
    const paths = resolveChannelPaths({ appData: path.join(appData, String(index)), channel: 'nightly' });
    await mkdir(paths.legacyDataDirectory, { recursive: true });
    await writeFile(path.join(paths.legacyDataDirectory, 'settings.json'), invalid);
    await writeFile(path.join(paths.legacyDataDirectory, 'workspace.json'), '{"projects":[]}');
    assert.deepEqual(await initializeChannelProfile(paths), { status: 'failed', copied: ['workspace.json'], issues: ['settings.json'] });
    await assert.rejects(access(path.join(paths.userData, 'settings.json')));
    assert.equal((await initializeChannelProfile(paths)).status, 'already-initialized');
  }
});

test('concurrent profile initialization publishes complete files without overwriting or leaving temporary files', async t => {
  const appData = await temporary(t);
  const paths = resolveChannelPaths({ appData, channel: 'nightly' });
  await mkdir(paths.legacyDataDirectory);
  const settings = JSON.stringify({ model: 'same-model', preserved: 'x'.repeat(40000) });
  await writeFile(path.join(paths.legacyDataDirectory, 'settings.json'), settings);
  const results = await Promise.all(Array.from({ length: 8 }, () => initializeChannelProfile(paths)));
  assert.ok(results.every(result => result.status !== 'failed'));
  assert.equal(await readFile(path.join(paths.userData, 'settings.json'), 'utf8'), settings);
  assert.deepEqual((await readdir(paths.userData)).sort(), ['.nightly-profile-initialized.json', 'settings.json']);
});

test('profile initialization rejects junction redirects for source and destination without touching their contents', async t => {
  const appData = await temporary(t);
  const outside = path.join(appData, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'settings.json'), '{"model":"private-model"}');
  for (const kind of ['source', 'destination', 'ancestor']) {
    const base = path.join(appData, kind);
    await mkdir(base);
    let paths = resolveChannelPaths({ appData: base, channel: 'nightly' });
    if (kind === 'source') await symlink(outside, paths.legacyDataDirectory, 'junction');
    if (kind === 'destination') await symlink(outside, paths.userData, 'junction');
    if (kind === 'ancestor') {
      const redirected = path.join(base, 'redirect');
      await symlink(outside, redirected, 'junction');
      paths = resolveChannelPaths({ appData: redirected, channel: 'nightly' });
    }
    assert.equal((await initializeChannelProfile(paths)).status, 'failed');
  }
  assert.deepEqual(await readdir(outside), ['settings.json']);
  assert.equal(await readFile(path.join(outside, 'settings.json'), 'utf8'), '{"model":"private-model"}');
});

test('source settings symlinks and destination symlinks are never followed', async t => {
  const appData = await temporary(t);
  const outside = path.join(appData, 'outside.json');
  await writeFile(outside, '{"model":"private-model"}');
  for (const kind of ['source', 'destination']) {
    const paths = resolveChannelPaths({ appData: path.join(appData, kind), channel: 'nightly' });
    await mkdir(paths.legacyDataDirectory, { recursive: true });
    await mkdir(paths.userData);
    try {
      await symlink(outside, path.join(kind === 'source' ? paths.legacyDataDirectory : paths.userData, 'settings.json'), 'file');
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('File symlinks require Windows Developer Mode; directory junction rejection is covered separately.'); return; }
      throw error;
    }
    assert.deepEqual(await initializeChannelProfile(paths), { status: 'failed', copied: [], issues: ['settings.json'] });
    if (kind === 'source') await assert.rejects(access(path.join(paths.userData, 'settings.json')));
  }
  assert.equal(await readFile(outside, 'utf8'), '{"model":"private-model"}');
});
