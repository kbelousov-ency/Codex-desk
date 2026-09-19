import { appendFile, cp, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { assertNotRunning, checkedPath, checkedTree, createReleaseManifest, publishNightly, removeChecked, verifyRelease, withReleaseLock } from './release-utils.mjs';

const PIPE = /^\\\\\.\\pipe\\codex-desk-nightly-\d+-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ERROR_CODES = new Map(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EEXIST'].map(code => [code, code.toLowerCase()]));
ERROR_CODES.set('EPROCESSCHECK', 'processcheck');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pendingMessage = 'Обновление Nightly уже ожидает применения. Закройте Nightly через предложение обновления или вручную; после сбоя повторите node scripts/apply-nightly-update.mjs. Новая сборка не заменяет ожидающую.';
const queueDirectory = root => path.join(root, 'artifacts', 'nightly-update');
const candidateDirectory = root => path.join(queueDirectory(root), 'app');
const executable = root => path.join(root, 'release', 'nightly', 'Codex Desk.exe');
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function failureLocation(root, error) {
  const syscall = ['rename', 'copyfile', 'mkdir', 'open', 'unlink', 'rmdir', 'scandir', 'stat', 'lstat'].includes(error?.syscall) ? error.syscall : 'unknown';
  const roles = [
    [path.join(root, 'release/nightly'), 'nightly'],
    [path.join(root, 'release/.nightly-incoming'), 'incoming'],
    [path.join(root, 'release/.nightly-old'), 'old'],
    [path.join(root, 'release/.transaction.json'), 'journal'],
    [path.join(root, 'release/.transaction.json.tmp'), 'journal'],
    [path.join(root, 'release/.release.lock'), 'lock'],
    [candidateDirectory(root), 'candidate'],
  ];
  let role = 'unknown';
  if (typeof error?.path === 'string') {
    const target = path.resolve(error.path).toLowerCase();
    role = roles.find(([prefix]) => target === path.resolve(prefix).toLowerCase() || target.startsWith(path.resolve(prefix).toLowerCase() + path.sep))?.[1] || role;
  }
  return `failure_io_${syscall}_${role}`;
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function jsonFile(root, file, limit = 16384) {
  await checkedPath(root, file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > limit) throw new Error('Неверный служебный файл обновления Nightly.');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Служебный файл обновления Nightly повреждён.'); }
}

export function validateRegistration(root, value) {
  if (!value || value.version !== 1 || (value.updateProtocol !== undefined && value.updateProtocol !== 2) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0xffffffff || !PIPE.test(value.pipe) || !SHA.test(value.token) || !SHA.test(value.buildId)
    || typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || !samePath(value.executable, executable(root))
    || !['userData', 'cwd'].every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]) && !value[key].includes('\0'))) {
    throw new Error('Неверная регистрация Nightly. Закройте Nightly и повторите сборку.');
  }
  if (!value.pipe.startsWith(`\\\\.\\pipe\\codex-desk-nightly-${value.pid}-`)) throw new Error('Процесс Nightly не совпадает с регистрацией.');
  return { version: 1, ...(value.updateProtocol === 2 ? { updateProtocol: 2 } : {}), pid: value.pid, pipe: value.pipe, token: value.token, buildId: value.buildId, executable: value.executable, userData: value.userData, cwd: value.cwd };
}

export async function requestInstance(instance, action, request = {}, { timeoutMs = 5000, connect = createConnection } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = '';
    const socket = connect(instance.pipe);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Nightly не отвечает на запрос обновления.')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: instance.token, action, ...request })}\n`));
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 8192) return finish(new Error('Неверный ответ Nightly.'));
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(response.slice(0, newline));
        if (!value || !['busy', 'awaiting', 'waiting', 'manual', 'preparing', 'ready', 'error', ...(action === 'cancel' ? ['cancelled'] : [])].includes(value.state) || (request.requestId && value.requestId !== request.requestId)) throw new Error();
        finish(null, { state: value.state });
      } catch { finish(new Error('Неверный ответ Nightly.')); }
    });
    socket.once('error', () => finish(new Error('Не удалось связаться с Nightly.')));
    socket.once('close', () => finish(new Error('Nightly закрыл подключение обновления.')));
  });
}

export async function findNightlyInstance(root, { alive = processAlive, guard = assertNotRunning, request = requestInstance } = {}) {
  let instance;
  try { instance = validateRegistration(root, await jsonFile(root, path.join(root, 'release', '.nightly-instance.json'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!instance || !alive(instance.pid)) {
    // This also detects the first upgrade from a build without the update service.
    try { await guard(path.dirname(executable(root))); }
    catch { throw new Error('Запущенный Nightly ещё не поддерживает автоматическое обновление. Один раз закройте его и повторите сборку. Release можно оставить открытым.'); }
    return null;
  }
  try {
    const response = await request(instance, 'status');
    if (response.state === 'error') throw new Error();
  } catch { throw new Error('Запущенный Nightly не отвечает службе обновления. Закройте его и повторите сборку.'); }
  return instance;
}

export async function assertNoPendingUpdate(root) {
  const directory = queueDirectory(root);
  await checkedPath(root, directory);
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(pendingMessage);
}

export async function queueNightlyUpdate(root, source, instance) {
  validateRegistration(root, instance);
  await assertNoPendingUpdate(root);
  await checkedTree(root, source);
  const directory = queueDirectory(root);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    const candidate = candidateDirectory(root);
    await cp(source, candidate, { recursive: true });
    await writeFile(path.join(candidate, 'resources', 'channel.json'), JSON.stringify({ channel: 'nightly' }));
    const manifest = await createReleaseManifest(root, candidate);
    await verifyRelease(root, candidate, 'nightly');
    const queue = { version: 1, requestId: randomUUID(), createdAt: new Date().toISOString(), buildId: manifest.buildId, instance: validateRegistration(root, instance) };
    await writeFile(path.join(directory, 'state.json'), JSON.stringify(queue), { flag: 'wx', mode: 0o600 });
    return queue;
  } catch (error) { await removeChecked(root, directory); throw error; }
}

export async function launchUpdateHelper(root, { launch = spawn } = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEX_DESK_DEV_URL;
  const child = launch(process.execPath, [path.join(root, 'scripts', 'apply-nightly-update.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child.pid;
}

export async function logUpdate(root, state) {
  if (!/^[a-z_-]{1,64}$/.test(state)) throw new Error('Неверная запись журнала обновления.');
  const file = path.join(root, 'artifacts', 'nightly-update.log');
  await checkedPath(root, file);
  await mkdir(path.dirname(file), { recursive: true });
  try { if ((await lstat(file)).size > 128 * 1024) await writeFile(file, ''); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await appendFile(file, `${new Date().toISOString()} ${state}\n`);
}

export async function discardNightlyUpdate(root, { alive = processAlive, request = requestInstance } = {}) {
  // This is explicit recovery, never an implicit overwrite by a new build.
  await withReleaseLock(root, async () => {
    const directory = queueDirectory(root);
    let owner;
    try { owner = await jsonFile(root, path.join(directory, 'worker.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (owner && (!Number.isInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid))) throw new Error('Помощник обновления Nightly ещё работает. Дождитесь его завершения.');
    let queue;
    try { queue = await readQueue(root); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        // A damaged queue cannot authenticate cancellation. Only discard it
        // once the corresponding executable is closed, retaining safe paths.
        try { await assertNotRunning(path.dirname(executable(root))); }
        catch { throw new Error('Очередь повреждена. Закройте Nightly и повторите отмену очереди.'); }
      }
    }
    if (queue && alive(queue.instance.pid)) {
      const response = await request(queue.instance, 'cancel', { requestId: queue.requestId, buildId: queue.buildId });
      if (response.state !== 'cancelled') throw new Error('Nightly уже перезапускается. Дождитесь завершения обновления.');
    }
    await removeChecked(root, directory);
  });
}

async function readQueue(root) {
  const queue = await jsonFile(root, path.join(queueDirectory(root), 'state.json'));
  if (!queue || queue.version !== 1 || !UUID.test(queue.requestId) || !SHA.test(queue.buildId) || !Number.isFinite(Date.parse(queue.createdAt)) || (queue.restartRequested !== undefined && typeof queue.restartRequested !== 'boolean')) throw new Error('Очередь обновления повреждена. Сохраните artifacts/nightly-update для диагностики.');
  return { ...queue, instance: validateRegistration(root, queue.instance) };
}

async function saveQueue(root, queue) {
  const file = path.join(queueDirectory(root), 'state.json');
  const temporary = `${file}.tmp`;
  await checkedPath(root, file);
  await checkedPath(root, temporary);
  await writeFile(temporary, JSON.stringify(queue), { mode: 0o600 });
  await rename(temporary, file);
}

async function takeWorkerLock(root, alive) {
  const file = path.join(queueDirectory(root), 'worker.json');
  await checkedPath(root, file);
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await jsonFile(root, file);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid)) throw new Error('Помощник обновления Nightly уже работает.');
    // Only a caller holding the release lock can recover a dead helper.
    await removeChecked(root, file);
    handle = await open(file, 'wx');
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  await handle.close();
}

async function launchNightly(instance, { launch = spawn } = {}) {
  const env = { ...process.env, CODEX_DESK_DATA_DIR: instance.userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEX_DESK_DEV_URL;
  const child = launch(instance.executable, [], { cwd: instance.cwd, detached: true, windowsHide: false, stdio: 'ignore', env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export async function applyNightlyUpdate(root, options = {}) {
  const alive = options.alive ?? processAlive;
  const request = options.request ?? requestInstance;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const lock = options.lock ?? (action => withReleaseLock(root, action));
  const publish = options.publish ?? (source => publishNightly(root, source));
  const guard = options.guard ?? assertNotRunning;
  const launch = options.launch ?? (instance => launchNightly(instance));
  const logger = options.log ?? (state => logUpdate(root, state));
  const log = async state => { try { await logger(state); } catch { /* Logging must never interrupt an accepted restart. */ } };
  const candidate = candidateDirectory(root);
  let queue;
  let ownsWorker = false;
  let restart = false;
  let requested = false;
  let published = false;
  let stage = 'acquiring_worker';
  async function locked(action) {
    const deadline = now() + 30000;
    for (;;) {
      let entered = false;
      try { return await lock(async () => { entered = true; return action(); }); }
      catch (error) {
        if (entered || now() >= deadline || !/уже выполняется/.test(error.message)) throw error;
        await sleep(1000);
      }
    }
  }
  try {
    await locked(async () => { queue = await readQueue(root); await takeWorkerLock(root, alive); ownsWorker = true; });
    restart = queue.restartRequested === true;
    stage = 'verifying_candidate';
    if ((await verifyRelease(root, candidate, 'nightly')).buildId !== queue.buildId) throw new Error('Сборка в очереди не совпадает с запросом обновления.');
    await log('candidate_verified');
    stage = 'preparing_host';
    if (!alive(queue.instance.pid)) {
      // After a failed publication the user may reopen the old build. Prepare
      // that instance too, preserving its current draft and tasks before retry.
      const current = await findNightlyInstance(root, { alive, guard, request });
      if (current) {
        if (!samePath(current.executable, queue.instance.executable) || !samePath(current.userData, queue.instance.userData)) {
          throw new Error('Nightly открыт с другим профилем. Закройте этот экземпляр перед повтором обновления.');
        }
        queue = { ...queue, instance: current, restartRequested: false };
        restart = false;
        await saveQueue(root, queue);
        await log('host_rebound');
      }
    }
    if (queue.instance.updateProtocol !== 2) {
      // A legacy host interprets prepare as automatic permission to quit.
      // Never send it that request, even when retrying an older queued update.
      restart = false;
      if (queue.restartRequested) { queue.restartRequested = false; await saveQueue(root, queue); }
      await log('host_manual_legacy');
    }
    const deadline = now() + (options.maxWaitMs ?? 7 * 24 * 60 * 60 * 1000);
    const params = { requestId: queue.requestId, buildId: queue.buildId };
    let prior;
    while (alive(queue.instance.pid)) {
      if (now() >= deadline) throw new Error('Истекло время ожидания завершения задач Nightly.');
      if (queue.instance.updateProtocol !== 2) { await sleep(options.pollMs ?? 2000); continue; }
      let response;
      try { requested = true; response = await request(queue.instance, 'prepare', params); }
      catch (error) { if (!alive(queue.instance.pid)) break; throw error; }
      if (response.state !== prior) { await log(`host_${response.state}`); prior = response.state; }
      if (response.state === 'error') throw new Error('Nightly не смог подготовиться к перезапуску.');
      if (['awaiting', 'waiting', 'manual'].includes(response.state)) {
        restart = false;
        if (queue.restartRequested) { queue.restartRequested = false; await saveQueue(root, queue); }
      }
      if (response.state === 'ready' && !queue.restartRequested) {
        queue.restartRequested = true;
        await saveQueue(root, queue);
      }
      if (response.state === 'ready') { restart = true; break; }
      await sleep(options.pollMs ?? 2000);
    }
    stage = 'waiting_exit';
    const exitDeadline = now() + (options.exitWaitMs ?? 120000);
    while (alive(queue.instance.pid)) {
      if (now() >= exitDeadline) throw new Error('Nightly не завершился после подготовки. Приложение не было принудительно закрыто.');
      await sleep(options.pollMs ?? 2000);
    }
    // Only acknowledged readiness authorizes relaunch. A manual close during
    // awaiting/preparing/cancellation stays closed after installation.
    await log('host_exited');
    // Chromium subprocesses may briefly outlive the main PID on Windows.
    for (;;) {
      try { await guard(path.dirname(queue.instance.executable)); break; }
      catch (error) { if (now() >= exitDeadline) throw error; await sleep(options.pollMs ?? 2000); }
    }
    stage = 'publishing';
    await locked(async () => {
      // Recheck immediately before publication, after an arbitrarily long task.
      if ((await verifyRelease(root, candidate, 'nightly')).buildId !== queue.buildId) throw new Error('Сборка изменилась во время ожидания.');
      await publish(candidate);
      published = true;
    });
    await log('published');
    stage = 'relaunching';
    if (restart) { await launch(queue.instance); await log('relaunched'); }
    stage = 'cleaning_queue';
    await removeChecked(root, queueDirectory(root));
    await log('complete');
    return { restarted: restart, buildId: queue.buildId };
  } catch (error) {
    await log(`failed_${stage}_${ERROR_CODES.get(error?.code) ?? 'unknown'}`);
    await log(failureLocation(root, error));
    if (!ownsWorker) throw error;
    if (requested && queue && alive(queue.instance.pid)) {
      try {
        const response = await request(queue.instance, 'cancel', { requestId: queue.requestId, buildId: queue.buildId });
        if (response.state === 'cancelled') {
          queue.restartRequested = false;
          await saveQueue(root, queue);
        }
      } catch { /* Host lease also releases a failed updater. */ }
    }
    await log(published ? 'launch_failed' : 'failed').catch(() => {});
    // Keep the one candidate retryable on verification/host/publication failure.
    await removeChecked(root, path.join(queueDirectory(root), 'worker.json')).catch(() => {});
    if (published) {
      // A second run must not replace an already installed build just to relaunch.
      await removeChecked(root, queueDirectory(root));
      throw new Error('Nightly обновлён, но не запустился. Откройте его обычным ярлыком.');
    }
    throw error;
  }
}
