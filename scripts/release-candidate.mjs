import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import asar from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';
import { applicationBuildIdentity } from '../electron/app-identity.mjs';
import { assertNotRunning, checkedPath, createReleaseManifest, fileChecksums, removeChecked, resolveNightlySource, verifyRelease } from './release-utils.mjs';

const INFO = 'electron/build-info.json';
const ARCHIVE = 'resources/app.asar';
const CANDIDATE = ['artifacts', 'release-candidate', 'app'];
const digest = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(value ?? new ArrayBuffer(0));

// Keep archive paths and unpack/executable flags, not just extracted text. Links
// are deliberately rejected: production packaging currently contains none.
function archiveEntries(archive) {
  asar.uncacheAll();
  const entries = [];
  function visit(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files)) {
      if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) throw new Error('Небезопасный путь в ASAR.');
      const filename = `${prefix}${name}`;
      if (entry.link !== undefined) throw new Error('Конверсия ASAR со ссылками не поддерживается.');
      const base = { path: filename, unpacked: Boolean(entry.unpacked) };
      if (entry.files) {
        entries.push({ ...base, type: 'directory' });
        visit(entry, `${filename}/`);
      } else entries.push({ ...base, type: 'file', executable: Boolean(entry.executable), data: asar.extractFile(archive, path.normalize(filename)) });
    }
  }
  visit(asar.getRawHeader(archive).header);
  return entries;
}

function archivePayload(entries) {
  return entries.filter(entry => entry.path !== INFO).map(({ data, ...entry }) => ({ ...entry, ...(data ? { sha256: digest(data) } : {}) })).sort((a, b) => a.path.localeCompare(b.path));
}

function sourceExecutable(manifest) {
  const files = ['Codex Desk.exe', 'Kuzmich.exe'].filter(name => manifest.files[name]);
  if (files.length !== 1) throw new Error('В Nightly требуется ровно один известный EXE.');
  return files[0];
}

function provenance(manifest) {
  return { format: 1, buildId: manifest.buildId, manifestSha256: digest(JSON.stringify(manifest)) };
}

function convertedBuildId(releaseSource, branding) {
  return digest(JSON.stringify({ conversion: 'release-branding-v1', releaseSource, branding }));
}

function archiveHeaderHash(archive) {
  return digest(asar.getRawHeader(archive).headerString);
}

// Use the same PE library as electron-builder. Signed inputs are rejected by
// NtExecutable.from: a conversion must never silently invalidate a signature.
function convertExecutable(original, iconData, headerHash, branding) {
  const executable = NtExecutable.from(original);
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error('В EXE требуется один VERSIONINFO.');
  const version = versions[0];
  const languages = version.getAllLanguagesForStringValues();
  if (!languages.length) throw new Error('В EXE отсутствует язык VERSIONINFO.');
  for (const language of languages) {
    const strings = version.getStringValues(language);
    version.setStringValues(language, {
      ProductName: branding.productName, FileDescription: branding.productName,
      InternalName: branding.executableName, OriginalFilename: `${branding.executableName}.exe`,
      ...(strings.LegalCopyright ? { LegalCopyright: strings.LegalCopyright.replace(/Кузьмич Nightly|Codex Desk Nightly/g, branding.productName) } : {}),
    });
  }
  version.outputToResourceEntries(resources.entries);
  const icon = Data.IconFile.from(iconData);
  const groups = resources.entries.filter(entry => entry.type === 14);
  if (groups.length !== 1) throw new Error('В EXE требуется одна группа иконок.');
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, groups[0].id, groups[0].lang, icon.icons.map(item => item.data));
  const integrity = resources.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  if (integrity.length !== 1) throw new Error('В EXE отсутствует единственный ресурс ASAR integrity.');
  const values = JSON.parse(bytes(integrity[0].bin).toString('utf8'));
  const appValues = values.filter(value => path.win32.normalize(value.file).toLowerCase() === 'resources\\app.asar');
  if (appValues.length !== 1 || appValues[0].alg !== 'SHA256') throw new Error('Неизвестный формат ASAR integrity.');
  appValues[0].value = headerHash;
  integrity[0].bin = Buffer.from(JSON.stringify(values));
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}

function verifyExecutableCode(original, converted) {
  const before = NtExecutable.from(original);
  const after = NtExecutable.from(converted);
  const sections = executable => executable.getAllSections().filter(section => section.info.name !== '.rsrc').map(section => ({
    name: section.info.name, virtualAddress: section.info.virtualAddress, virtualSize: section.info.virtualSize,
    characteristics: section.info.characteristics, sha256: digest(bytes(section.data)),
  }));
  assert.deepEqual(sections(after), sections(before), 'PE code and non-resource sections must remain byte-identical');
  assert.deepEqual(bytes(after.getExtraData()), bytes(before.getExtraData()), 'PE overlay must remain unchanged');
}

function unchangedExternalFiles(files) {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !['Codex Desk.exe', 'Kuzmich.exe', ARCHIVE].includes(name)));
}

async function verifyConversion(root, source, original, candidate) {
  const manifest = await verifyRelease(root, candidate, 'stable');
  const branding = applicationBuildIdentity('stable');
  const releaseSource = provenance(original);
  assert.deepEqual(manifest.releaseSource, releaseSource, 'Candidate must identify the currently verified Nightly');
  assert.equal(manifest.buildId, convertedBuildId(releaseSource, branding), 'Candidate build ID must cover source bytes and target branding');
  assert.equal(manifest.version, original.version);
  assert.equal(manifest.productName, branding.productName);
  assert.equal(manifest.iconName, branding.iconName);
  assert.deepEqual(unchangedExternalFiles(manifest.files), unchangedExternalFiles(original.files), 'All files outside PE/ASAR must be unchanged');
  assert.ok(manifest.files[`${branding.executableName}.exe`]);
  assert.equal(Object.keys(manifest.files).filter(name => name.endsWith('.exe')).length, Object.keys(original.files).filter(name => name.endsWith('.exe')).length);
  const sourceArchive = path.join(source, ARCHIVE);
  const targetArchive = path.join(candidate, ARCHIVE);
  const sourceEntries = archiveEntries(sourceArchive);
  assert.deepEqual(archivePayload(archiveEntries(targetArchive)), archivePayload(sourceEntries), 'Renderer, host, dependencies and ASAR flags must be preserved');
  const icon = sourceEntries.find(entry => entry.path === `electron/${branding.iconName}`)?.data;
  if (!icon) throw new Error('В исходном ASAR отсутствует иконка Release.');
  const originalExe = await readFile(path.join(source, sourceExecutable(original)));
  const candidateExe = await readFile(path.join(candidate, `${branding.executableName}.exe`));
  assert.equal(digest(candidateExe), digest(convertExecutable(originalExe, icon, archiveHeaderHash(targetArchive), branding)), 'PE must match the bounded resource conversion exactly');
  verifyExecutableCode(originalExe, candidateExe);
  return { source: candidate, manifest };
}

export async function verifyPreparedReleaseCandidate(root) {
  const original = await resolveNightlySource(root);
  return verifyConversion(root, original.source, original.manifest, path.join(root, ...CANDIDATE));
}

// Must be called under withReleaseLock. Preparation only writes artifacts; it
// does not replace either channel, edit source files, or touch the update queue.
export async function prepareReleaseCandidate(root, options = {}) {
  const guard = options.guard ?? assertNotRunning;
  const { source, manifest: original } = await resolveNightlySource(root);
  const candidate = path.join(root, ...CANDIDATE);
  const work = path.join(root, 'artifacts', 'release-candidate');
  const incoming = path.join(work, 'incoming');
  await checkedPath(root, candidate);
  await guard(candidate);
  await guard(incoming);
  await removeChecked(root, incoming);
  await mkdir(work, { recursive: true });
  await cp(source, incoming, { recursive: true });
  const snapshot = await verifyRelease(root, incoming, 'nightly');
  assert.deepEqual(snapshot, original, 'Nightly changed while creating the snapshot');
  const archive = path.join(incoming, ARCHIVE);
  const entries = archiveEntries(archive);
  const branding = applicationBuildIdentity('stable');
  const releaseSource = provenance(original);
  const info = { buildId: convertedBuildId(releaseSource, branding), builtAt: new Date().toISOString(), version: original.version,
    productName: branding.productName, iconName: branding.iconName, releaseSource };
  const buildInfo = entries.find(entry => entry.path === INFO);
  if (!buildInfo || buildInfo.type !== 'file' || buildInfo.unpacked) throw new Error('Неверное расположение build-info.json.');
  buildInfo.data = Buffer.from(JSON.stringify(info, null, 2));
  const updated = `${archive}.converted`;
  await asar.createPackageFromStreams(updated, entries.map(entry => ({
    path: entry.path, type: entry.type, unpacked: entry.unpacked,
    ...(entry.type === 'file' ? { stat: { size: entry.data.length, mode: entry.executable ? 0o755 : 0o644 }, streamGenerator: () => Readable.from(entry.data) } : {}),
  })));
  await rename(updated, archive);
  // Existing unpacked data was copied with the snapshot. Verify the repacker's
  // output before discarding its duplicate unpacked directory.
  const extraUnpacked = `${updated}.unpacked`;
  if (entries.some(entry => entry.unpacked)) {
    assert.deepEqual(await fileChecksums(root, extraUnpacked, new Set()), await fileChecksums(root, `${archive}.unpacked`, new Set()));
    await removeChecked(root, extraUnpacked);
  }
  const originalName = sourceExecutable(original);
  const originalExe = await readFile(path.join(incoming, originalName));
  const icon = entries.find(entry => entry.path === `electron/${branding.iconName}`)?.data;
  if (!icon) throw new Error('В исходном ASAR отсутствует иконка Release.');
  const converted = convertExecutable(originalExe, icon, archiveHeaderHash(archive), branding);
  verifyExecutableCode(originalExe, converted);
  if (originalName !== `${branding.executableName}.exe`) await removeChecked(root, path.join(incoming, originalName));
  await writeFile(path.join(incoming, `${branding.executableName}.exe`), converted);
  await writeFile(path.join(incoming, 'resources', 'channel.json'), JSON.stringify({ channel: 'stable' }, null, 2));
  await createReleaseManifest(root, incoming, 'stable');
  await verifyConversion(root, source, original, incoming);
  await verifyRelease(root, source, 'nightly');
  await guard(candidate);
  await removeChecked(root, candidate);
  await rename(incoming, candidate);
  return verifyPreparedReleaseCandidate(root);
}
