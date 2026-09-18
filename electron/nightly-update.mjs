import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';

const MAX_REQUEST_BYTES = 4096;
const MAX_REGISTRATION_BYTES = 8192;
const PREPARED_LEASE_MS = 30_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const BUILD_ID = /^[a-f0-9]{64}$/i;

function fail() {
  return new Error('Nightly update connection is unavailable.');
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 4096 && !value.includes('\0') && path.isAbsolute(value);
}

function pipePath(name) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const error = () => { server.off('listening', listening); reject(fail()); };
    const listening = () => { server.off('error', error); resolve(); };
    server.once('error', error);
    server.once('listening', listening);
    server.listen(endpoint);
  });
}

function stop(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function readRegistration(filename) {
  let stat;
  try { stat = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw fail(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REGISTRATION_BYTES) throw fail();
  try { return JSON.parse(await readFile(filename, 'utf8')); } catch { throw fail(); }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * Called only by the packaged Nightly host in its fixed release/nightly folder.
 * The caller reserves the host and freezes the renderer synchronously in
 * prepare(), then saves its checkpoint before resolving true. notify('error')
 * must release that reservation; a helper that vanishes must not freeze the UI.
 * No renderer content or paths are accepted through this local control pipe.
 */
export async function createNightlyUpdate({ releaseRoot, executable, userData, cwd, buildId, getBusy, prepare, quit, notify = () => {} }) {
  if (![releaseRoot, executable, userData, cwd].every(validPath)
      || !samePath(executable, path.join(releaseRoot, 'nightly', 'Codex Desk.exe'))
      || !BUILD_ID.test(buildId) || [getBusy, prepare, quit, notify].some(value => typeof value !== 'function')) throw fail();
  const root = path.resolve(releaseRoot);
  const rootStat = await lstat(root).catch(() => { throw fail(); });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail();
  const filename = path.join(root, '.nightly-instance.json');
  const token = randomBytes(32).toString('hex');
  const endpoint = pipePath(`codex-desk-nightly-${process.pid}-${randomBytes(16).toString('hex')}`);
  const rootHash = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
  const ownerEndpoint = pipePath(`codex-desk-nightly-owner-${rootHash}`);
  const registration = Object.freeze({ version: 1, pid: process.pid, pipe: endpoint, token, buildId, executable, userData, cwd });
  const sockets = new Set();
  const owner = net.createServer(socket => socket.destroy());
  const server = net.createServer(socket => accept(socket));
  owner.maxConnections = 1;
  server.maxConnections = 16;
  let closed = false;
  let closing;
  let pending = null;
  let failed = null;
  let generation = 0;
  let lease = null;
  let quitScheduled = false;
  let registered = false;
  let rateStart = Date.now();
  let requests = 0;

  function publish(state) {
    try { notify(state); } catch { /* UI diagnostics must not affect the updater. */ }
  }

  function busy() {
    try { return Boolean(getBusy()); } catch { return true; }
  }

  function resetPreparation() {
    clearTimeout(lease);
    lease = null;
    generation += 1;
    failed = pending ? { requestId: pending.requestId, buildId: pending.buildId } : null;
    pending = null;
    publish('error');
  }

  function deferPreparation() {
    clearTimeout(lease);
    lease = null;
    generation += 1;
    pending = null;
    failed = null;
    publish('busy');
  }

  function armLease() {
    clearTimeout(lease);
    lease = setTimeout(() => { if (!closed && !quitScheduled) resetPreparation(); }, PREPARED_LEASE_MS);
    lease.unref();
  }

  function authenticate(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
      && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(token, 'hex'));
  }

  function reply(socket, result, shouldQuit = false) {
    if (socket.destroyed || closed) return;
    socket.end(`${JSON.stringify(result)}\n`, () => {
      if (!shouldQuit || closed || quitScheduled || pending?.state !== 'ready') return;
      // end's callback runs after the response is handed to the local transport.
      // Never close the UI merely because preparation completed: the helper must
      // have obtained readiness and be waiting for a graceful process exit.
      quitScheduled = true;
      clearTimeout(lease);
      setImmediate(() => {
        if (closed) return;
        if (busy()) { quitScheduled = false; resetPreparation(); return; }
        try { quit(); } catch { quitScheduled = false; resetPreparation(); }
      });
    });
  }

  function beginPreparation(request) {
    const currentGeneration = ++generation;
    pending = { requestId: request.requestId, buildId: request.buildId, state: 'preparing' };
    publish('preparing');
    armLease();
    // Invoke directly so the caller can reserve the host before any further IPC
    // is handled. Even an immediately resolved result is observed asynchronously.
    let prepared;
    try { prepared = prepare({ requestId: request.requestId, buildId: request.buildId }); }
    catch { resetPreparation(); return; }
    Promise.resolve(prepared).then(ok => {
      if (closed || currentGeneration !== generation) return;
      if (!ok || busy()) { deferPreparation(); return; }
      pending.state = 'ready';
      publish('ready');
      armLease();
    }, () => {
      if (!closed && currentGeneration === generation) resetPreparation();
    });
  }

  function handle(socket, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || !authenticate(request.token)
        || Object.keys(request).some(key => !['token', 'action', 'requestId', 'buildId'].includes(key))) {
      reply(socket, { state: 'error' }); return;
    }
    const requestId = typeof request.requestId === 'string' && UUID.test(request.requestId) ? request.requestId : undefined;
    if (request.action === 'status') {
      reply(socket, { ...(requestId ? { requestId } : {}), state: pending?.state === 'preparing' ? 'preparing' : busy() ? 'busy' : 'ready' });
      return;
    }
    if (!['prepare', 'cancel'].includes(request.action) || !requestId || typeof request.buildId !== 'string' || !BUILD_ID.test(request.buildId)) {
      reply(socket, { state: 'error' }); return;
    }
    if (request.action === 'cancel') {
      if (pending && (pending.requestId !== requestId || pending.buildId !== request.buildId)) {
        reply(socket, { requestId, state: 'busy' }); return;
      }
      if (quitScheduled) { reply(socket, { requestId, state: 'ready' }); return; }
      if (pending) resetPreparation();
      failed = null;
      reply(socket, { requestId, state: 'cancelled' }); return;
    }
    if (pending) {
      if (pending.requestId !== requestId || pending.buildId !== request.buildId) {
        reply(socket, { requestId, state: 'busy' }); return;
      }
      if (pending.state === 'ready' && busy()) { resetPreparation(); reply(socket, { requestId, state: 'error' }); return; }
      const state = pending.state;
      reply(socket, { requestId, state }, state === 'ready');
      return;
    }
    if (failed?.requestId === requestId && failed.buildId === request.buildId) {
      reply(socket, { requestId, state: 'error' }); return;
    }
    failed = null;
    if (busy()) { publish('busy'); reply(socket, { requestId, state: 'busy' }); return; }
    beginPreparation(request);
    reply(socket, { requestId, state: 'preparing' });
  }

  function accept(socket) {
    if (closed) { socket.destroy(); return; }
    if (Date.now() - rateStart > 30_000) { rateStart = Date.now(); requests = 0; }
    if (++requests > 64) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let received = false;
    socket.on('data', chunk => {
      if (received) return;
      if (buffer.length + chunk.length > MAX_REQUEST_BYTES) { received = true; socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const lineEnd = buffer.indexOf(10);
      if (lineEnd < 0) return;
      received = true;
      let request;
      try {
        if (buffer.subarray(lineEnd + 1).toString('utf8').trim()) throw fail();
        request = JSON.parse(buffer.subarray(0, lineEnd).toString('utf8'));
      } catch { reply(socket, { state: 'error' }); return; }
      handle(socket, request);
    });
  }

  async function close() {
    if (closing) return closing;
    closed = true;
    generation += 1;
    clearTimeout(lease);
    if (pending && !quitScheduled) publish('error');
    for (const socket of sockets) socket.destroy();
    closing = (async () => {
      await stop(server);
      if (registered) {
        try {
          const existing = await readRegistration(filename);
          if (existing?.token === token) await unlink(filename);
        } catch { /* A changed, malformed or redirected registration is not ours. */ }
      }
      await stop(owner);
    })();
    return closing;
  }

  let temporary;
  try {
    // A second profile of the same executable may run for tests. It must never
    // steal update ownership or erase the first instance's registration.
    await listen(owner, ownerEndpoint);
    const existing = await readRegistration(filename);
    if (existing && processIsAlive(existing.pid)) throw fail();
    await listen(server, endpoint);
    temporary = path.join(root, `.nightly-instance-${token}.tmp`);
    await writeFile(temporary, `${JSON.stringify(registration)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
    temporary = null;
    registered = true;
    owner.on('error', () => { void close(); });
    server.on('error', () => { void close(); });
  } catch {
    if (temporary) await unlink(temporary).catch(() => {});
    await close();
    throw fail();
  }
  return { registration, close, getState: () => pending?.state ?? (busy() ? 'busy' : 'ready') };
}
