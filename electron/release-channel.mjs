import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const channels = new Set(['stable', 'nightly', 'development']);
const profileNames = { stable: 'Codex Desk', nightly: 'Codex Desk Nightly', development: 'Codex Desk Development' };
const initialProfileFiles = ['settings.json', 'workspace.json'];
const markerName = '.nightly-profile-initialized.json';
const maxProfileBytes = 1024 * 1024;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value);
}

function validBuildId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validBuiltAt(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** The external channel marker can change on promotion without rebuilding app.asar. */
export function resolveReleaseChannel({ isPackaged, resourcesPath, buildInfo = {} }) {
  let channel = 'development';
  if (isPackaged) {
    try {
      const filename = path.join(resourcesPath, 'channel.json');
      const metadata = lstatSync(filename);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024) throw new Error('Invalid marker');
      const manifest = JSON.parse(readFileSync(filename, 'utf8'));
      if (!plainObject(manifest) || Object.keys(manifest).length !== 1 || !['stable', 'nightly'].includes(manifest.channel)) throw new Error('Invalid marker');
      channel = manifest.channel;
    } catch {
      throw new Error('Не удалось определить канал сборки Codex Desk: файл resources/channel.json отсутствует или повреждён. Восстановите папку приложения из полной сборки.');
    }
    if (!plainObject(buildInfo) || !validVersion(buildInfo.version) || !validBuildId(buildInfo.buildId) || !validBuiltAt(buildInfo.builtAt)) {
      throw new Error('Метаданные сборки Codex Desk отсутствуют или повреждены. Восстановите папку приложения из полной сборки.');
    }
  }
  // Only these bounded, public values may reach the renderer and diagnostics.
  return Object.freeze({
    channel,
    version: validVersion(buildInfo?.version) ? buildInfo.version : 'development',
    buildId: validBuildId(buildInfo?.buildId) ? buildInfo.buildId : null,
    builtAt: validBuiltAt(buildInfo?.builtAt) ? buildInfo.builtAt : null,
  });
}

export function resolveChannelPaths({ appData, channel, dataDirOverride }) {
  if (!channels.has(channel)) throw new Error('Неизвестный канал Codex Desk.');
  if (dataDirOverride !== undefined && dataDirOverride !== null && dataDirOverride !== '') {
    if (typeof dataDirOverride !== 'string') throw new Error('Некорректная папка данных Codex Desk.');
    const userData = path.resolve(dataDirOverride);
    // Disposable test profiles never consult or populate the real profile.
    return Object.freeze({ userData, attachmentsDirectory: path.join(userData, 'attachments') });
  }
  if (typeof appData !== 'string' || !path.isAbsolute(appData)) throw new Error('Некорректная папка данных Codex Desk.');
  const legacyDataDirectory = path.join(appData, profileNames.stable);
  return Object.freeze({
    userData: path.join(appData, profileNames[channel]),
    // Codex owns shared history with absolute image paths. Keeping this existing
    // image directory lets both channels display old and newly attached images.
    attachmentsDirectory: path.join(legacyDataDirectory, 'attachments'),
    ...(channel === 'nightly' ? { legacyDataDirectory } : {}),
  });
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

async function maybeStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Never seed settings through redirected profile folders or file symlinks. */
async function requirePlainDirectory(directory, create = false) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const metadata = await maybeStat(current);
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('unsafe-directory');
  }
  if (create) await mkdir(absolute, { recursive: true });
  const metadata = await maybeStat(absolute);
  if (!metadata) return false;
  // Compare entries through lstat instead of string equality with realpath:
  // Windows may provide harmless 8.3 aliases in TEMP or the profile path.
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe-directory');
  return true;
}

async function readProfileFile(filename) {
  const metadata = await maybeStat(filename);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxProfileBytes) throw new Error('invalid-profile-file');
  const bytes = await readFile(filename);
  if (bytes.length > maxProfileBytes || !plainObject(JSON.parse(bytes.toString('utf8')))) throw new Error('invalid-profile-file');
  return bytes;
}

async function createFileOnce(filename, bytes) {
  // Stage a complete file, then publish it atomically without replacing a file
  // created by another launch in the meantime. Never modify the stable source.
  const temporary = path.join(path.dirname(filename), `.profile-copy-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.close();
    try { await link(temporary, filename); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** Seed Nightly defaults once. Authorisation, Codex config and Chromium stay untouched. */
export async function initializeChannelProfile(paths) {
  if (!paths.legacyDataDirectory) return { status: 'skipped', copied: [], issues: [] };
  const copied = [];
  const issues = [];
  try {
    if (samePath(paths.userData, paths.legacyDataDirectory)) throw new Error('unsafe-directory');
    await requirePlainDirectory(paths.userData, true);
    const marker = path.join(paths.userData, markerName);
    const existingMarker = await maybeStat(marker);
    if (existingMarker) {
      if (!existingMarker.isFile() || existingMarker.isSymbolicLink()) throw new Error('invalid-marker');
      return { status: 'already-initialized', copied, issues };
    }
    if (await requirePlainDirectory(paths.legacyDataDirectory)) {
      for (const name of initialProfileFiles) {
        try {
          const target = path.join(paths.userData, name);
          const existing = await maybeStat(target);
          if (existing) {
            if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('invalid-profile-file');
            continue;
          }
          const bytes = await readProfileFile(path.join(paths.legacyDataDirectory, name));
          if (bytes && await createFileOnce(target, bytes)) copied.push(name);
        } catch {
          issues.push(name);
        }
      }
    }
    // An empty source also counts as an initial run: later stable changes must
    // never silently change the independently configured Nightly profile.
    await createFileOnce(marker, JSON.stringify({ version: 1 }));
    return { status: issues.length ? 'failed' : 'initialized', copied, issues };
  } catch {
    return { status: 'failed', copied, issues: [...issues, 'profile-initialization'] };
  }
}
