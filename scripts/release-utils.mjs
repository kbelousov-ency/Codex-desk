import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import asar from '@electron/asar';

const EXE = 'Codex Desk.exe';
const EXCLUDED = new Set(['release-manifest.json', 'resources/channel.json']);
const TRANSIENT_MOVE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MOVE_RETRY_WINDOW_MS = 5000;
const MOVE_RETRY_DELAY_MS = 250;
const TRANSACTION_NAMES = new Set(['nightly', 'stable', 'stable-previous', '.nightly-incoming', '.stable-incoming', '.nightly-old', '.previous-old', '.stable-swap']);
const TRANSACTION_PLANS = new Set([
  ...[false, true].map(replace => JSON.stringify({ steps: [...(replace ? [['nightly', '.nightly-old']] : []), ['.nightly-incoming', 'nightly']], cleanup: ['.nightly-incoming', '.nightly-old'] })),
  ...[false, true].flatMap(previous => [false, true].map(stable => JSON.stringify({ steps: [...(previous ? [['stable-previous', '.previous-old']] : []), ...(stable ? [['stable', 'stable-previous']] : []), ['.stable-incoming', 'stable']], cleanup: ['.stable-incoming', '.previous-old'] }))),
  JSON.stringify({ steps: [['stable', '.stable-swap'], ['stable-previous', 'stable'], ['.stable-swap', 'stable-previous']], cleanup: ['.stable-swap'] }),
]);

export function inside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Путь выходит за пределы рабочей папки.');
  return resolved;
}

async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function checkedPath(root, target) {
  const resolved = inside(root, target);
  let current = path.resolve(root);
  const rootStat = await lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Рабочая папка не должна быть ссылкой.');
  for (const part of path.relative(current, resolved).split(path.sep)) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error('Ссылки и junction в каталоге сборки не поддерживаются.');
  }
  return resolved;
}

export async function checkedTree(root, directory) {
  const target = await checkedPath(root, directory);
  const stat = await statOrNull(target);
  if (!stat) return target;
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) await checkedTree(root, path.join(target, entry));
  } else if (!stat.isFile()) throw new Error('В каталоге сборки найден специальный файл.');
  return target;
}

export async function removeChecked(root, target) {
  await checkedTree(root, target);
  await rm(inside(root, target), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function moveChecked(root, source, destination, options) {
  const dependencies = options.moveRetry ?? {};
  const move = dependencies.rename ?? rename;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const windows = (dependencies.platform ?? process.platform) === 'win32';
  const deadline = now() + MOVE_RETRY_WINDOW_MS;
  let lastError;
  for (let attempt = 0; ; attempt++) {
    if (lastError && now() >= deadline) throw lastError;
    // Windows may briefly retain directory handles after the application exits.
    // Revalidate before every attempt: the user may reopen it while we wait.
    await options.guard(source);
    await checkedTree(root, source);
    await checkedPath(root, destination);
    if (await statOrNull(destination)) throw new Error(`Каталог назначения уже существует: ${path.basename(destination)}.`);
    if (lastError && now() >= deadline) throw lastError;
    try { await move(inside(root, source), inside(root, destination)); return; }
    catch (error) {
      if (!windows || !TRANSIENT_MOVE_ERRORS.has(error.code) || attempt >= 20 || now() >= deadline) throw error;
      lastError = error;
      await sleep(Math.min(MOVE_RETRY_DELAY_MS, Math.max(0, deadline - now())));
    }
  }
}

export async function fileChecksums(root, directory, excluded = EXCLUDED) {
  await checkedTree(root, directory);
  const entries = Object.create(null);
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), `${relative}/`);
      else if (!excluded.has(relative)) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path.join(current, entry.name))) hash.update(chunk);
        entries[relative] = hash.digest('hex');
      }
    }
  }
  await visit(directory);
  return entries;
}

export async function readBuildInfo(directory) {
  asar.uncacheAll();
  const archive = path.join(directory, 'resources', 'app.asar');
  const info = JSON.parse(asar.extractFile(archive, path.join('electron', 'build-info.json')).toString('utf8'));
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (!/^[a-f0-9]{64}$/.test(info.buildId) || !/^\d{4}-\d\d-\d\dT/.test(info.builtAt) || !Number.isFinite(Date.parse(info.builtAt)) || typeof info.version !== 'string' || info.version !== pkg.version) throw new Error('Неверные метаданные сборки в app.asar.');
  return { buildId: info.buildId, builtAt: info.builtAt, version: info.version };
}

export async function createReleaseManifest(root, directory) {
  await checkedTree(root, directory);
  const info = await readBuildInfo(directory);
  const files = await fileChecksums(root, directory);
  if (!files[EXE] || !files['resources/app.asar']) throw new Error('В сборке нет приложения или app.asar.');
  const manifest = { format: 1, ...info, files };
  await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function verifyRelease(root, directory, expectedChannel) {
  await checkedTree(root, directory);
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  const info = await readBuildInfo(directory);
  if (manifest.format !== 1 || ['buildId', 'builtAt', 'version'].some(key => manifest[key] !== info[key])) throw new Error('Метаданные сборки не совпадают с манифестом.');
  const actual = await fileChecksums(root, directory);
  if (!actual[EXE] || !actual['resources/app.asar'] || JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Контрольные суммы сборки не совпадают. Повторите сборку Nightly перед переносом.');
  const channel = JSON.parse(await readFile(path.join(directory, 'resources', 'channel.json'), 'utf8'));
  if (!channel || Object.keys(channel).length !== 1 || !['nightly', 'stable'].includes(channel.channel) || (expectedChannel && channel.channel !== expectedChannel)) throw new Error('Неверный канал сборки.');
  return manifest;
}

export async function assertNotRunning(directory) {
  if (process.platform !== 'win32') return;
  const expected = path.join(path.resolve(directory), EXE).toLowerCase();
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'Codex Desk.exe'\" | Select-Object ExecutablePath, ProcessId) | ConvertTo-Json -Compress"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Не удалось проверить запущенные экземпляры приложения.'), { code: 'EPROCESSCHECK' })); }, 15000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(Object.assign(new Error('Не удалось проверить запущенные экземпляры приложения.'), { code: 'EPROCESSCHECK' })); });
  });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const running = Array.isArray(parsed) ? parsed : [parsed];
  if (running.some(item => typeof item.ExecutablePath !== 'string' || !item.ExecutablePath)) throw new Error('Не удалось определить путь запущенного Codex Desk. Закройте его перед обновлением.');
  if (running.some(item => typeof item.ExecutablePath === 'string' && path.resolve(item.ExecutablePath).toLowerCase() === expected)) throw new Error(`Закройте ${path.basename(directory)} перед обновлением этого канала. Другой канал можно оставить открытым.`);
}

async function writeChannel(directory, channel) {
  await writeFile(path.join(directory, 'resources', 'channel.json'), JSON.stringify({ channel }, null, 2));
}

function transactionPath(root, name) {
  if (!TRANSACTION_NAMES.has(name)) throw new Error('Неизвестный путь в операции выпуска.');
  return path.join(root, 'release', name);
}

async function writeJournal(root, journal) {
  const file = path.join(root, 'release', '.transaction.json');
  const temp = `${file}.tmp`;
  await checkedPath(root, file);
  await checkedPath(root, temp);
  await writeFile(temp, JSON.stringify(journal));
  await rename(temp, file);
}

export async function recoverRelease(root, options = {}) {
  const guard = options.guard ?? assertNotRunning;
  const file = path.join(root, 'release', '.transaction.json');
  await checkedPath(root, file);
  if (!(await statOrNull(file))) return;
  const journal = JSON.parse(await readFile(file, 'utf8'));
  if (journal.format !== 1 || !Array.isArray(journal.steps) || !Array.isArray(journal.cleanup) || !Number.isInteger(journal.completed) || journal.completed < 0 || journal.completed > journal.steps.length || !['forward', 'rollback', 'committed'].includes(journal.phase)) throw new Error('Журнал выпуска повреждён; сохранён для проверки.');
  if (!TRANSACTION_PLANS.has(JSON.stringify({ steps: journal.steps, cleanup: journal.cleanup }))) throw new Error('Журнал выпуска содержит неизвестную операцию; сохранён для проверки.');
  for (const step of journal.steps) {
    if (!Array.isArray(step) || step.length !== 2) throw new Error('Журнал выпуска повреждён.');
    for (const name of step) await checkedTree(root, transactionPath(root, name));
  }
  for (const name of journal.cleanup) await checkedTree(root, transactionPath(root, name));
  if (journal.phase !== 'committed') {
    if (journal.phase === 'forward') {
      const pending = journal.steps[journal.completed];
      if (pending) {
        const [from, to] = pending.map(name => transactionPath(root, name));
        if (!(await statOrNull(from)) && await statOrNull(to)) journal.completed++;
      }
      journal.phase = 'rollback';
      await writeJournal(root, journal);
    }
    while (journal.completed > 0) {
      const [from, to] = journal.steps[journal.completed - 1].map(name => transactionPath(root, name));
      // A previous recovery may have moved the directory before saving its cursor.
      if (await statOrNull(to)) {
        await moveChecked(root, to, from, { ...options, guard });
      } else if (!(await statOrNull(from))) throw new Error('Не найдены файлы для восстановления выпуска.');
      journal.completed--;
      await writeJournal(root, journal);
    }
  }
  for (const name of journal.cleanup) { const target = transactionPath(root, name); await guard(target); await removeChecked(root, target); }
  await removeChecked(root, file);
}

async function transaction(root, steps, cleanup, options) {
  const journal = { format: 1, steps, cleanup, completed: 0, phase: 'forward' };
  await writeJournal(root, journal);
  try {
    for (let index = 0; index < steps.length; index++) {
      const [from, to] = steps[index].map(name => transactionPath(root, name));
      await moveChecked(root, from, to, options);
      journal.completed = index + 1;
      await writeJournal(root, journal);
      await options.afterMove?.(index + 1);
    }
    journal.phase = 'committed';
    await writeJournal(root, journal);
    await recoverRelease(root, options);
  } catch (error) {
    try { await recoverRelease(root, options); } catch (recovery) { throw new Error(`${error.message} Восстановление отложено: ${recovery.message}`, { cause: error }); }
    throw error;
  }
}

export async function publishNightly(root, source, options = {}) {
  const guard = options.guard ?? assertNotRunning;
  const nightly = transactionPath(root, 'nightly');
  const incoming = transactionPath(root, '.nightly-incoming');
  await guard(nightly);
  await checkedTree(root, source);
  await guard(incoming);
  await removeChecked(root, incoming);
  await mkdir(path.join(root, 'release'), { recursive: true });
  try {
    await cp(source, incoming, { recursive: true });
    await writeChannel(incoming, 'nightly');
    await createReleaseManifest(root, incoming);
    await verifyRelease(root, incoming, 'nightly');
  } catch (error) { await guard(incoming); await removeChecked(root, incoming); throw error; }
  const steps = [];
  if (await statOrNull(nightly)) steps.push(['nightly', '.nightly-old']);
  steps.push(['.nightly-incoming', 'nightly']);
  await transaction(root, steps, ['.nightly-incoming', '.nightly-old'], { ...options, guard });
}

export async function promoteRelease(root, options = {}) {
  const guard = options.guard ?? assertNotRunning;
  const nightly = transactionPath(root, 'nightly');
  const stable = transactionPath(root, 'stable');
  const previous = transactionPath(root, 'stable-previous');
  const incoming = transactionPath(root, '.stable-incoming');
  await guard(stable);
  await guard(previous);
  const manifest = await verifyRelease(root, nightly, 'nightly');
  await guard(incoming);
  await removeChecked(root, incoming);
  try {
    await cp(nightly, incoming, { recursive: true });
    await verifyRelease(root, incoming, 'nightly');
    await writeChannel(incoming, 'stable');
  } catch (error) { await guard(incoming); await removeChecked(root, incoming); throw error; }
  const steps = [];
  if (await statOrNull(previous)) steps.push(['stable-previous', '.previous-old']);
  if (await statOrNull(stable)) steps.push(['stable', 'stable-previous']);
  steps.push(['.stable-incoming', 'stable']);
  await transaction(root, steps, ['.stable-incoming', '.previous-old'], { ...options, guard });
  return manifest;
}

export async function rollbackRelease(root, options = {}) {
  const guard = options.guard ?? assertNotRunning;
  for (const name of ['stable', 'stable-previous']) {
    await guard(transactionPath(root, name));
    await verifyRelease(root, transactionPath(root, name), 'stable');
  }
  await transaction(root, [['stable', '.stable-swap'], ['stable-previous', 'stable'], ['.stable-swap', 'stable-previous']], ['.stable-swap'], { ...options, guard });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function withReleaseLock(root, action, options = {}) {
  const directory = path.join(root, 'release');
  await checkedPath(root, directory);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, '.release.lock');
  await checkedPath(root, file);
  const owner = { pid: process.pid, token: randomUUID() };
  let handle;
  try { handle = await open(file, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize abandoned-lock recovery, including against another new builder.
    const reclaim = path.join(directory, '.release-reclaim.lock');
    await checkedPath(root, reclaim);
    let claim;
    try { claim = await open(reclaim, 'wx'); } catch { throw new Error('Другая сборка или восстановление уже выполняется.'); }
    try {
      let stale;
      try { stale = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Выпуск занят или остался незавершённый lock-файл. Проверьте release/.release.lock.'); }
      if (!Number.isInteger(stale.pid) || stale.pid <= 0 || processAlive(stale.pid)) throw new Error('Другая сборка или перенос уже выполняется.');
      await removeChecked(root, file);
      handle = await open(file, 'wx');
    } finally { await claim.close(); await removeChecked(root, reclaim); }
  }
  await handle.writeFile(JSON.stringify(owner));
  await handle.close();
  try {
    await recoverRelease(root, options);
    return await action();
  } finally {
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (current.token === owner.token) await removeChecked(root, file);
  }
}
