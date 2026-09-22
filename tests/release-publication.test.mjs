import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import asar from '@electron/asar';
import { createReleaseManifest, removeChecked } from '../scripts/release-utils.mjs';
import { assertReleaseVersion, installerFilename } from '../scripts/release-version.mjs';
import { prepareRelease, releaseNotes } from '../scripts/prepare-release.mjs';

async function fixture(t, legacy = false) {
  const parent = path.resolve('artifacts');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'publication-test-'));
  t.after(() => removeChecked(parent, root));
  const app = path.join(root, 'source');
  const stable = path.join(root, 'release', 'stable');
  const installer = path.join(root, 'release', 'installer');
  await mkdir(path.join(app, 'electron'), { recursive: true });
  await mkdir(path.join(stable, 'resources'), { recursive: true });
  await mkdir(installer, { recursive: true });
  const build = { version: '0.2.0', buildId: 'a'.repeat(64), builtAt: '2026-09-21T00:00:00.000Z' };
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ version: build.version }));
  await writeFile(path.join(app, 'electron', 'build-info.json'), JSON.stringify(build));
  await asar.createPackage(app, path.join(stable, 'resources', 'app.asar'));
  await writeFile(path.join(stable, 'Codex Desk.exe'), 'fixture application');
  await writeFile(path.join(stable, 'resources', 'channel.json'), JSON.stringify({ channel: 'stable' }));
  await createReleaseManifest(root, stable);
  const payload = Buffer.from('fixture installer');
  const filename = legacy ? 'Codex Desk Setup 0.2.0.exe' : installerFilename(build.version);
  const info = { ...build, channel: 'stable', installer: filename, sha256: createHash('sha256').update(payload).digest('hex'),
    ...(!legacy ? { format: 1, size: payload.length } : {}) };
  const infoFile = path.join(installer, 'release-info.json');
  await writeFile(infoFile, JSON.stringify(info));
  await writeFile(path.join(installer, filename), payload);
  await writeFile(path.join(installer, 'README.txt'), `Run ${filename}`);
  await writeFile(path.join(root, 'CHANGELOG.md'), '# Releases\n\n## [0.2.0]\n\n- Updates\n\n## [0.1.0]\n\n- Initial\n');
  // The development version must never override an already approved binary.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  return { root, stable, installer, filename, payload, info, infoFile };
}

test('release versions reject prereleases, malformed numbers and unsafe components', () => {
  for (const version of ['0.2.0', '1.0.0', '12.34.56', '999999999.999999999.999999999']) assert.equal(assertReleaseVersion(version), version);
  for (const version of ['v0.2.0', '01.2.3', '1.2', '1.2.3.4', '1.2.3-beta', '1.2.3+build', '1.2.3\n', '9007199254740992.0.0', '1000000000.0.0', '0.1000000000.0', '0.0.1000000000', undefined]) {
    assert.throws(() => assertReleaseVersion(version));
  }
  assert.equal(installerFilename('0.2.0'), 'Codex-Desk-Setup-0.2.0.exe');
  assert.equal(installerFilename('0.2.0', 'nightly'), 'Codex-Desk-Nightly-Setup-0.2.0.exe');
  assert.throws(() => installerFilename('0.2.0', 'other'));
});

test('release notes require one non-empty matching section', () => {
  assert.equal(releaseNotes('## [0.2.0]\r\n\r\n- Update\r\n\r\n## [0.1.0]\r\nOld\r\n', '0.2.0'), '# Codex Desk 0.2.0\n\n- Update\n');
  assert.throws(() => releaseNotes('## [0.1.0]\nOld\n', '0.2.0'));
  assert.throws(() => releaseNotes('## [0.2.0]\n\n## [0.1.0]\nOld\n', '0.2.0'));
  assert.throws(() => releaseNotes('## [0.2.0]\nOne\n## [0.2.0]\nTwo\n', '0.2.0'));
});

for (const legacy of [false, true]) {
  test(`publication prepares checked stable bytes and canonical metadata${legacy ? ' from legacy filenames' : ''}`, async t => {
    const data = await fixture(t, legacy);
    const result = await prepareRelease(data.root);
    const expected = installerFilename('0.2.0');
    assert.equal(result.version, '0.2.0');
    assert.equal(result.tag, 'v0.2.0');
    assert.equal(result.installer, expected);
    assert.deepEqual((await readdir(result.output)).sort(), [expected, 'README.txt', 'RELEASE_NOTES.md', 'SHA256SUMS.txt', 'release-info.json'].sort());
    assert.deepEqual(await readFile(path.join(result.output, expected)), data.payload);
    assert.equal(await readFile(path.join(result.output, 'SHA256SUMS.txt'), 'utf8'), `${data.info.sha256}  ${expected}\n`);
    assert.equal(await readFile(path.join(result.output, 'README.txt'), 'utf8'), `Run ${expected}`);
    const metadata = JSON.parse(await readFile(path.join(result.output, 'release-info.json'), 'utf8'));
    assert.equal(metadata.format, 1);
    assert.equal(metadata.size, data.payload.length);
    assert.equal(metadata.buildId, data.info.buildId);
    assert.equal(await readFile(path.join(result.output, 'RELEASE_NOTES.md'), 'utf8'), '# Codex Desk 0.2.0\n\n- Updates\n');
    assert.deepEqual(await readFile(path.join(data.installer, data.filename)), data.payload);
  });
}

test('publication rejects damaged installer before replacing previous prepared output', async t => {
  const data = await fixture(t);
  const result = await prepareRelease(data.root);
  await writeFile(path.join(result.output, 'preserve.txt'), 'reviewed');
  await writeFile(path.join(data.installer, data.filename), Buffer.alloc(data.payload.length, 1));
  await assert.rejects(prepareRelease(data.root), /SHA-256/);
  assert.equal(await readFile(path.join(result.output, 'preserve.txt'), 'utf8'), 'reviewed');
});

test('publication rejects stale, mismatched and unsafe installer metadata', async t => {
  const data = await fixture(t);
  for (const patch of [{ channel: 'nightly' }, { buildId: 'b'.repeat(64) }, { version: '0.3.0' },
    { builtAt: '2026-09-20T00:00:00.000Z' }, { installer: '../evil.exe' }, { format: 2 }, { size: 999 }]) {
    await writeFile(data.infoFile, JSON.stringify({ ...data.info, ...patch }));
    await assert.rejects(prepareRelease(data.root));
  }
});

test('publication rejects tampered stable application even when installer metadata matches', async t => {
  const data = await fixture(t);
  await writeFile(path.join(data.stable, 'Codex Desk.exe'), 'modified');
  await assert.rejects(prepareRelease(data.root), /Контрольные суммы/);
});
