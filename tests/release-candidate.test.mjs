import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import asar from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';
import { prepareReleaseCandidate, verifyPreparedReleaseCandidate } from '../scripts/release-candidate.mjs';
import { assertNotRunning, createReleaseManifest, fileChecksums, promoteRelease, publishNightly, removeChecked, verifyRelease } from '../scripts/release-utils.mjs';
import { queueNightlyUpdate } from '../scripts/nightly-update.mjs';

const guard = async () => {};
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = path.resolve('artifacts');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'release-conversion-test-'));
  t.after(() => removeChecked(parent, root));
  return root;
}

async function binary(root, tag) {
  const source = path.join(root, `source-${tag}`);
  const app = path.join(root, `app-${tag}`);
  await mkdir(path.join(source, 'resources'), { recursive: true });
  await mkdir(path.join(app, 'electron'), { recursive: true });
  await mkdir(path.join(app, 'dist'), { recursive: true });
  await mkdir(path.join(app, 'node_modules', '@scope', 'dependency'), { recursive: true });
  await writeFile(path.join(app, 'node_modules', '@scope', 'dependency', 'package.json'), '{"name":"@scope/dependency"}');
  const iconData = await readFile(path.resolve('electron/kuzmich.ico'));
  await writeFile(path.join(app, 'electron', 'kuzmich.ico'), iconData);
  await writeFile(path.join(app, 'electron', 'main.mjs'), `export const fixture = '${tag}';`);
  await writeFile(path.join(app, 'dist', 'index.html'), '<h1>Привет</h1>');
  await writeFile(path.join(app, 'dist', 'empty.bin'), Buffer.alloc(0));
  await writeFile(path.join(app, 'electron', 'dependency.node'), Buffer.from([0, 1, 255, 42]));
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ version: '0.11.0' }));
  await writeFile(path.join(app, 'electron', 'build-info.json'), JSON.stringify({ buildId: tag.repeat(64), builtAt: '2026-10-12T00:00:00.000Z', version: '0.11.0', productName: 'Кузьмич Nightly', iconName: 'kuzmich.ico' }));
  const archive = path.join(source, 'resources', 'app.asar');
  await asar.createPackageWithOptions(app, archive, { unpack: '**/*.node' });
  const executable = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(executable);
  const version = Resource.VersionInfo.createEmpty();
  version.setFileVersion('0.11.0'); version.setProductVersion('0.11.0');
  version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Кузьмич Nightly', FileDescription: 'Кузьмич Nightly', InternalName: 'Kuzmich' });
  version.outputToResourceEntries(resources.entries);
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, Data.IconFile.from(iconData).icons.map(item => item.data));
  resources.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', lang: 1033, codepage: 1200,
    bin: Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash(asar.getRawHeader(archive).headerString) }])) });
  resources.outputResource(executable);
  await writeFile(path.join(source, 'Kuzmich.exe'), Buffer.from(executable.generate()));
  await writeFile(path.join(source, 'resources', 'untouched.bin'), Buffer.from([1, 2, 3]));
  return source;
}

test('explicit candidate converts real PE/ASAR metadata and preserves all application payload before separate promotion', async t => {
  const root = await fixture(t);
  await publishNightly(root, await binary(root, 'a'), { guard });
  const nightly = path.join(root, 'release', 'nightly');
  const before = await fileChecksums(root, nightly, new Set());
  const candidate = await prepareReleaseCandidate(root, { guard });
  assert.equal(candidate.manifest.releaseSource.buildId, 'a'.repeat(64));
  assert.notEqual(candidate.manifest.buildId, 'a'.repeat(64));
  assert.deepEqual(await fileChecksums(root, nightly, new Set()), before);
  await assert.rejects(readFile(path.join(root, 'release', 'stable', 'release-manifest.json')), { code: 'ENOENT' });
  const archive = path.join(candidate.source, 'resources', 'app.asar');
  const resources = NtExecutableResource.from(NtExecutable.from(await readFile(path.join(candidate.source, 'Codex Desk.exe'))));
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0];
  assert.equal(version.getStringValues(version.getAllLanguagesForStringValues()[0]).ProductName, 'Кузьмич');
  const integrity = JSON.parse(Buffer.from(resources.entries.find(entry => entry.type === 'INTEGRITY').bin).toString());
  assert.equal(integrity[0].value, hash(asar.getRawHeader(archive).headerString));
  assert.equal(asar.extractFile(archive, 'electron/main.mjs').toString(), "export const fixture = 'a';");
  assert.equal(asar.statFile(archive, 'electron/dependency.node').unpacked, true);
  assert.deepEqual(asar.extractFile(archive, 'electron/dependency.node'), Buffer.from([0, 1, 255, 42]));
  assert.equal(asar.extractFile(archive, 'dist/empty.bin').length, 0);
  assert.equal(asar.extractFile(archive, path.join('node_modules', '@scope', 'dependency', 'package.json')).toString(), '{"name":"@scope/dependency"}');
  const promoted = await promoteRelease(root, { guard, preparedCandidate: true });
  assert.equal(promoted.buildId, candidate.manifest.buildId);
  assert.deepEqual(await fileChecksums(root, path.join(root, 'release', 'stable'), new Set()), await fileChecksums(root, candidate.source, new Set()));
  await assert.rejects(promoteRelease(root, { guard }), /Бренд сборки несовместим/);
});

test('candidate from queue preserves installed Nightly and every queue byte; a replaced source invalidates it', async t => {
  const root = await fixture(t);
  await publishNightly(root, await binary(root, 'a'), { guard });
  await queueNightlyUpdate(root, await binary(root, 'b'), {
    version: 1, updateProtocol: 2, pid: 987654321, pipe: `\\\\.\\pipe\\codex-desk-nightly-987654321-${'a'.repeat(32)}`, token: 'b'.repeat(64), buildId: 'a'.repeat(64),
    executable: path.join(root, 'release', 'nightly', 'Kuzmich.exe'), userData: path.join(root, 'profile'), cwd: root,
  });
  const queue = path.join(root, 'artifacts', 'nightly-update');
  const nightly = path.join(root, 'release', 'nightly');
  const beforeQueue = await fileChecksums(root, queue, new Set());
  const beforeNightly = await fileChecksums(root, nightly, new Set());
  const candidate = await prepareReleaseCandidate(root, { guard });
  assert.equal(candidate.manifest.releaseSource.buildId, 'b'.repeat(64));
  await promoteRelease(root, { guard, preparedCandidate: true });
  assert.deepEqual(await fileChecksums(root, queue, new Set()), beforeQueue);
  assert.deepEqual(await fileChecksums(root, nightly, new Set()), beforeNightly);
  await removeChecked(root, queue);
  await assert.rejects(verifyPreparedReleaseCandidate(root), /currently verified Nightly/);
});

test('forged candidate manifest cannot authorize unrelated payload or metadata-only PE conversion', async t => {
  const root = await fixture(t);
  await publishNightly(root, await binary(root, 'a'), { guard });
  let candidate = await prepareReleaseCandidate(root, { guard });
  await writeFile(path.join(candidate.source, 'resources', 'untouched.bin'), 'tampered');
  await createReleaseManifest(root, candidate.source, 'stable');
  await assert.rejects(promoteRelease(root, { guard, preparedCandidate: true }), /outside PE\/ASAR/);
  candidate = await prepareReleaseCandidate(root, { guard });
  await copyFile(path.join(root, 'release', 'nightly', 'Kuzmich.exe'), path.join(candidate.source, 'Codex Desk.exe'));
  await createReleaseManifest(root, candidate.source, 'stable');
  await assert.rejects(promoteRelease(root, { guard, preparedCandidate: true }), /bounded resource conversion/);
  await assert.rejects(readFile(path.join(root, 'release', 'stable', 'release-manifest.json')), { code: 'ENOENT' });
});

test('running renamed Kuzmich.exe is detected by the default channel replacement guard', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const executable = path.join(root, 'Kuzmich.exe');
  await copyFile(process.execPath, executable);
  const child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  try { await assert.rejects(assertNotRunning(root), /Закройте/); }
  finally { const exited = once(child, 'exit'); child.kill(); await exited; }
  await assertNotRunning(root);
});
