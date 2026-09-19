import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createNightlyUpdate } from '../electron/nightly-update.mjs';

const buildId = 'a'.repeat(64);
const nextBuildId = 'b'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, overrides = {}) {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-nightly-host-'));
  const state = { busy: false, prepares: 0, quits: 0, notices: [] };
  const options = {
    releaseRoot,
    executable: path.join(releaseRoot, 'nightly', 'Codex Desk.exe'),
    userData: path.join(releaseRoot, 'profile'),
    cwd: releaseRoot,
    buildId,
    getBusy: () => state.busy,
    prepare: async () => { state.prepares++; return true; },
    quit: () => { state.quits++; },
    notify: value => state.notices.push(value),
    ...overrides,
  };
  const host = await createNightlyUpdate(options);
  t.after(async () => { await host.close(); await rm(releaseRoot, { recursive: true, force: true }); });
  const request = (action = 'prepare', extra = {}) => ({ token: host.registration.token, action, requestId: randomUUID(), buildId: nextBuildId, ...extra });
  return { releaseRoot, state, options, host, request, send: data => send(host.registration.pipe, data) };
}

function send(pipe, value, { split = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('test pipe timeout')); });
    let response = '';
    socket.on('error', reject);
    socket.on('data', data => { response += data.toString('utf8'); });
    socket.on('end', () => {
      try { resolve(response ? JSON.parse(response) : null); } catch (error) { reject(error); }
    });
    socket.on('connect', () => {
      const wire = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
      if (split) { socket.write(wire.slice(0, 7)); setImmediate(() => socket.write(wire.slice(7))); }
      else socket.write(wire);
    });
  });
}

async function permitClose(f, request) {
  assert.equal((await f.send(request)).state, 'awaiting');
  assert.equal(f.state.prepares, 0);
  assert.deepEqual(f.host.decide('close'), { state: 'waiting' });
}

test('Nightly registration identifies one local instance and status never prepares or quits', async t => {
  const f = await fixture(t);
  const registration = JSON.parse(await readFile(path.join(f.releaseRoot, '.nightly-instance.json'), 'utf8'));
  assert.deepEqual(registration, f.host.registration);
  assert.equal(registration.version, 1);
  assert.equal(registration.updateProtocol, 2);
  assert.equal(registration.pid, process.pid);
  assert.match(registration.token, /^[a-f0-9]{64}$/);
  if (process.platform === 'win32') assert.match(registration.pipe, /^\\\\\.\\pipe\\codex-desk-nightly-\d+-[a-f0-9]{32}$/);
  assert.equal((await f.send(f.request('status'))).state, 'ready');
  f.state.busy = true;
  assert.equal((await f.send(f.request('status'))).state, 'busy');
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.quits, 0);
});

test('offer never closes an idle or busy app; explicit close waits until checkpoint and readiness acknowledgment', async t => {
  const f = await fixture(t);
  const request = f.request();
  f.state.busy = true;
  assert.deepEqual(await f.send(request), { requestId: request.requestId, state: 'awaiting' });
  assert.equal(f.state.prepares, 0);
  f.state.busy = false;
  assert.equal((await f.send(request)).state, 'awaiting');
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.quits, 0);
  f.state.busy = true;
  assert.deepEqual(f.host.decide('close'), { state: 'waiting' });
  assert.equal((await f.send(request)).state, 'waiting');
  f.state.busy = false;
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  assert.equal(f.state.prepares, 1);
  assert.equal(f.state.quits, 0);
  assert.equal((await f.send(f.request('status'))).state, 'ready');
  assert.equal(f.state.quits, 0);
  assert.deepEqual(await f.send(request), { requestId: request.requestId, state: 'ready' });
  await tick();
  assert.equal(f.state.quits, 1);
  assert.equal((await f.send(request)).state, 'ready');
  await tick();
  assert.equal(f.state.quits, 1);
});

test('pending preparation is idempotent, cannot be stolen and cannot quit before checkpoint', async t => {
  let resolvePrepare;
  let prepares = 0;
  const f = await fixture(t, { prepare: () => { prepares++; return new Promise(resolve => { resolvePrepare = resolve; }); } });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  assert.equal((await f.send(request)).state, 'preparing');
  assert.equal((await f.send(f.request())).state, 'busy');
  assert.equal((await f.send({ ...request, buildId: 'c'.repeat(64) })).state, 'busy');
  assert.equal((await f.send(f.request('status'))).state, 'preparing');
  assert.equal(prepares, 1);
  assert.equal(f.state.quits, 0);
  resolvePrepare(true);
  await tick();
  assert.equal((await f.send(request)).state, 'ready');
  await tick();
  assert.equal(f.state.quits, 1);
});

test('unauthenticated, malformed, unknown and path-carrying requests cannot change host state', async t => {
  const f = await fixture(t);
  const valid = f.request();
  for (const value of [
    null, [], {}, { ...valid, token: '0'.repeat(64) }, { ...valid, token: 'abc' },
    { ...valid, action: 'launch' }, { ...valid, requestId: 'arbitrary' },
    { ...valid, buildId: '../app' }, { ...valid, userData: 'elsewhere' },
    { ...valid, executable: 'elsewhere' }, '{bad}\n', `${JSON.stringify(valid)}\n{}\n`,
  ]) assert.equal((await f.send(value)).state, 'error');
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.quits, 0);
  assert.equal((await send(f.host.registration.pipe, f.request('status'), { split: true })).state, 'ready');
});

test('oversized incoming packets are closed before parsing', async t => {
  const f = await fixture(t);
  assert.equal(await f.send(`${'x'.repeat(4097)}\n`), null);
  assert.equal(f.state.prepares, 0);
});

test('temporary renderer refusal unfreezes and permits retrying the same request', async t => {
  let ready = false;
  let attempts = 0;
  const f = await fixture(t, { prepare: async () => { attempts++; return ready; } });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  assert.equal(f.state.notices.at(-1), 'waiting');
  assert.equal(f.state.quits, 0);
  ready = true;
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  assert.equal(attempts, 2);
  assert.equal((await f.send(request)).state, 'ready');
  await tick();
  assert.equal(f.state.quits, 1);
});

test('checkpoint failure unfreezes and reports error without retrying the failed request', async t => {
  let attempts = 0;
  const f = await fixture(t, { prepare: async () => { attempts++; throw new Error('private details'); } });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  assert.deepEqual(await f.send(request), { requestId: request.requestId, state: 'error' });
  assert.equal(attempts, 1);
  assert.equal(f.state.quits, 0);
  assert.ok(f.state.notices.includes('error'));
  assert.equal((await f.send(f.request())).state, 'awaiting');
});

test('new host work racing with renderer preparation cancels restart', async t => {
  let resolvePrepare;
  const f = await fixture(t, { prepare: () => new Promise(resolve => { resolvePrepare = resolve; }) });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  f.state.busy = true;
  resolvePrepare(true);
  await tick();
  assert.equal((await f.send(request)).state, 'waiting');
  assert.equal(f.state.quits, 0);
  assert.ok(f.state.notices.includes('waiting'));
});

test('new host work after checkpoint but before ready acknowledgment cancels restart', async t => {
  const f = await fixture(t);
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  f.state.busy = true;
  assert.equal((await f.send(request)).state, 'error');
  assert.equal(f.state.quits, 0);
});

test('authenticated cancellation unfreezes pending checkpoint and ignores its late completion', async t => {
  let resolvePrepare;
  const f = await fixture(t, { prepare: () => new Promise(resolve => { resolvePrepare = resolve; }) });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  assert.equal((await f.send(f.request('cancel'))).state, 'busy');
  assert.equal((await f.send({ ...request, action: 'cancel', token: '0'.repeat(64) })).state, 'error');
  assert.equal((await f.send({ ...request, action: 'cancel' })).state, 'cancelled');
  assert.ok(f.state.notices.includes('error'));
  resolvePrepare(true);
  await tick();
  assert.equal(f.host.getState(), 'ready');
  assert.equal(f.state.quits, 0);
  assert.equal((await f.send(request)).state, 'awaiting');
});

test('Later keeps the pending update manual across polls, idle changes and delayed checkpoint completion', async t => {
  let resolvePrepare;
  const f = await fixture(t, { prepare: () => new Promise(resolve => { resolvePrepare = resolve; }) });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  assert.deepEqual(f.host.decide('later'), { state: 'manual' });
  assert.equal(f.state.notices.at(-1), 'manual');
  resolvePrepare(true);
  await tick();
  for (const busy of [true, false, false]) {
    f.state.busy = busy;
    assert.equal((await f.send(request)).state, 'manual');
    assert.equal((await f.send(f.request('status'))).state, 'manual');
  }
  assert.equal(f.state.quits, 0);
  assert.throws(() => f.host.decide('close'), /unavailable/);
});

test('Later on an offer never prepares; local decisions and remote requests cannot grant implicit consent', async t => {
  const f = await fixture(t);
  assert.throws(() => f.host.decide('close'), /unavailable/);
  const request = f.request();
  assert.equal((await f.send(request)).state, 'awaiting');
  assert.throws(() => f.host.decide('unknown'), /unavailable/);
  assert.equal((await f.send({ ...request, action: 'close' })).state, 'error');
  f.host.decide('later');
  assert.equal((await f.send(request)).state, 'manual');
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.quits, 0);
});

test('closed host releases reservation and ignores late checkpoint completion', async t => {
  let resolvePrepare;
  const f = await fixture(t, { prepare: () => new Promise(resolve => { resolvePrepare = resolve; }) });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  await f.host.close();
  assert.equal(f.state.notices.at(-1), 'error');
  resolvePrepare(true);
  await tick();
  assert.equal(f.state.quits, 0);
  assert.deepEqual(await readdir(f.releaseRoot), []);
});

test('vanished helper releases a prepared renderer after bounded lease without quitting', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = f.request();
  await permitClose(f, request);
  assert.equal((await f.send(request)).state, 'preparing');
  await tick();
  assert.equal(f.host.getState(), 'ready');
  t.mock.timers.tick(30_001);
  assert.equal(f.state.notices.at(-1), 'error');
  assert.equal((await f.send(request)).state, 'error');
  assert.equal(f.state.quits, 0);
});

test('second profile never overwrites live update registration, and close removes only own token', async t => {
  const f = await fixture(t);
  const filename = path.join(f.releaseRoot, '.nightly-instance.json');
  await assert.rejects(createNightlyUpdate({ ...f.options, userData: path.join(f.releaseRoot, 'another-profile') }), /unavailable/);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), f.host.registration);
  const replacement = { ...f.host.registration, token: 'd'.repeat(64) };
  await writeFile(filename, JSON.stringify(replacement));
  await f.host.close();
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), replacement);
});

test('crashed registration is replaced atomically and live PID registration remains untouched', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-nightly-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, '.nightly-instance.json');
  const options = { releaseRoot: root, executable: path.join(root, 'nightly', 'Codex Desk.exe'), userData: root, cwd: root, buildId, getBusy: () => false, prepare: async () => true, quit: () => {} };
  await writeFile(filename, JSON.stringify({ version: 1, pid: process.pid, token: 'other-live-process' }));
  await assert.rejects(createNightlyUpdate(options), /unavailable/);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).token, 'other-live-process');
  await writeFile(filename, JSON.stringify({ version: 1, pid: -1, token: 'crashed' }));
  const host = await createNightlyUpdate(options);
  try {
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).token, host.registration.token);
    assert.deepEqual(await readdir(root), ['.nightly-instance.json']);
  } finally { await host.close(); }
});

test('host rejects executable outside fixed Nightly and invalid metadata before publishing', async t => {
  const f = await fixture(t);
  for (const invalid of [
    { executable: path.join(f.releaseRoot, 'stable', 'Codex Desk.exe') },
    { releaseRoot: 'relative' }, { userData: 'relative' }, { cwd: 'relative' },
    { buildId: 'unidentified' }, { executable: `${f.options.executable}\0` },
  ]) await assert.rejects(createNightlyUpdate({ ...f.options, ...invalid }), /unavailable/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.releaseRoot, '.nightly-instance.json'), 'utf8')), f.host.registration);
});
