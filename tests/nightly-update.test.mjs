import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import asar from '@electron/asar';
import { applyNightlyUpdate, assertNoPendingUpdate, discardNightlyUpdate, findNightlyInstance, launchUpdateHelper, logUpdate, queueNightlyUpdate, requestInstance, validateRegistration } from '../scripts/nightly-update.mjs';
import { promoteRelease, publishNightly, removeChecked, verifyRelease } from '../scripts/release-utils.mjs';

const guard = async () => {};
async function fixture(t) {
  const parent = path.resolve('artifacts');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'nightly-update-test-'));
  t.after(() => removeChecked(parent, root));
  return root;
}

async function binary(root, tag) {
  const source = path.join(root, `source-${tag}`);
  const app = path.join(root, `app-${tag}`);
  await mkdir(path.join(source, 'resources'), { recursive: true });
  await mkdir(path.join(app, 'electron'), { recursive: true });
  await writeFile(path.join(source, 'Codex Desk.exe'), `fake executable ${tag}`);
  await writeFile(path.join(source, 'resources', 'dependency.bin'), `dependency ${tag}`);
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await writeFile(path.join(app, 'electron', 'build-info.json'), JSON.stringify({ buildId: tag.repeat(64), builtAt: '2026-09-18T00:00:00.000Z', version: '0.1.0' }));
  await asar.createPackage(app, path.join(source, 'resources', 'app.asar'));
  return source;
}

function instance(root) {
  return { version: 1, pid: 987654321, pipe: `\\\\.\\pipe\\codex-desk-nightly-987654321-${'a'.repeat(32)}`, token: 'b'.repeat(64), buildId: 'a'.repeat(64), executable: path.join(root, 'release', 'nightly', 'Codex Desk.exe'), userData: path.join(root, 'profile'), cwd: root };
}

async function queued(t) {
  const root = await fixture(t);
  const original = await binary(root, 'a');
  await publishNightly(root, original, { guard });
  await promoteRelease(root, { guard });
  const registration = instance(root);
  await queueNightlyUpdate(root, await binary(root, 'b'), registration);
  return { root, registration, candidate: path.join(root, 'artifacts', 'nightly-update', 'app') };
}

test('registration is constrained to this exact Nightly executable and authenticated named pipe', async t => {
  const root = await fixture(t);
  const valid = instance(root);
  assert.deepEqual(validateRegistration(root, valid), valid);
  for (const override of [{ version: 2 }, { pid: -1 }, { pipe: '\\\\.\\pipe\\other' }, { token: 'secret' }, { buildId: 'short' }, { userData: 'relative' }, { cwd: 'relative' }, { executable: path.join(root, 'release', 'stable', 'Codex Desk.exe') }, { pid: 12 }]) {
    assert.throws(() => validateRegistration(root, { ...valid, ...override }), /Неверная|не совпадает/);
  }
});

test('first upgrade detects legacy running Nightly and never requests preparation', async t => {
  const root = await fixture(t);
  let requests = 0;
  await assert.rejects(findNightlyInstance(root, { guard: async () => { throw new Error('running'); }, request: async () => { requests++; } }), /Один раз закройте/);
  assert.equal(requests, 0);
  assert.equal(await findNightlyInstance(root, { guard }), null);
});

test('live registry status check does not prepare; dead stale registry falls back to normal publication', async t => {
  const root = await fixture(t);
  const registration = instance(root);
  await mkdir(path.join(root, 'release'));
  await writeFile(path.join(root, 'release', '.nightly-instance.json'), JSON.stringify(registration));
  const actions = [];
  assert.deepEqual(await findNightlyInstance(root, { alive: () => true, request: async (_instance, action) => { actions.push(action); return { state: 'busy' }; } }), registration);
  assert.deepEqual(actions, ['status']);
  assert.equal(await findNightlyInstance(root, { alive: () => false, guard }), null);
  await writeFile(path.join(root, 'release', '.nightly-instance.json'), 'x'.repeat(16385));
  await assert.rejects(findNightlyInstance(root), /Неверный служебный/);
});

test('one immutable candidate blocks concurrent builds and retains original release until ready', async t => {
  const { root, registration, candidate } = await queued(t);
  await assert.rejects(assertNoPendingUpdate(root), /уже ожидает/);
  await assert.rejects(queueNightlyUpdate(root, await binary(root, 'c'), registration), /уже ожидает/);
  assert.equal((await verifyRelease(root, candidate, 'nightly')).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
});

test('busy tasks defer replacement, same request polls, then child processes exit before publish and relaunch', async t => {
  const { root, registration } = await queued(t);
  let running = true;
  let tick = 0;
  let guardCalls = 0;
  const calls = [];
  const requests = [];
  const phases = ['busy', 'preparing', 'ready'];
  const result = await applyNightlyUpdate(root, {
    alive: () => running,
    now: () => tick,
    sleep: async ms => { tick += ms; },
    request: async (record, action, params) => {
      assert.deepEqual(record, registration);
      requests.push(params);
      calls.push(action);
      const state = phases.shift();
      if (state === 'ready') running = false;
      return { state };
    },
    guard: async () => { guardCalls++; if (guardCalls < 3) throw new Error('renderer still exiting'); },
    publish: async source => { calls.push('publish'); assert.equal(running, false); await publishNightly(root, source, { guard }); },
    launch: async record => { calls.push('launch'); assert.deepEqual(record, registration); },
  });
  assert.deepEqual(calls, ['prepare', 'prepare', 'prepare', 'publish', 'launch']);
  assert.equal(new Set(requests.map(item => item.requestId)).size, 1);
  assert.ok(requests.every(item => item.buildId === 'b'.repeat(64)));
  assert.equal(guardCalls, 3);
  assert.deepEqual(result, { restarted: true, buildId: 'b'.repeat(64) });
  await assertNoPendingUpdate(root);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
  const log = await readFile(path.join(root, 'artifacts', 'nightly-update.log'), 'utf8');
  for (const secret of [registration.token, registration.userData, registration.pipe]) assert.equal(log.includes(secret), false);
});

test('candidate corruption blocks any preparation and stays available for explicit discard', async t => {
  const { root, candidate } = await queued(t);
  await writeFile(path.join(candidate, 'resources', 'dependency.bin'), 'tampered');
  let requests = 0;
  await assert.rejects(applyNightlyUpdate(root, { alive: () => true, request: async () => { requests++; }, guard }), /Контрольные суммы/);
  assert.equal(requests, 0);
  await assert.rejects(assertNoPendingUpdate(root), /уже ожидает/);
  assert.deepEqual((await readdir(path.join(root, 'artifacts', 'nightly-update'))).sort(), ['app', 'state.json']);
  await discardNightlyUpdate(root, { alive: () => false });
  await assertNoPendingUpdate(root);
});

test('candidate revalidation after host exit prevents bytes changed during long task from publishing', async t => {
  const { root, candidate } = await queued(t);
  let running = true;
  let publications = 0;
  await assert.rejects(applyNightlyUpdate(root, {
    alive: () => running, guard,
    request: async () => { await writeFile(path.join(candidate, 'resources', 'dependency.bin'), 'tampered after first check'); running = false; return { state: 'ready' }; },
    publish: async () => { publications++; },
  }), /Контрольные суммы/);
  assert.equal(publications, 0);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
});

test('lost ready reply after preparing still reopens accepted update; manually closed busy host stays closed', async t => {
  for (const prepared of [false, true]) {
    const { root } = await queued(t);
    let running = true;
    let calls = 0;
    let launches = 0;
    const result = await applyNightlyUpdate(root, {
      alive: () => running, guard,
      request: async () => { calls++; if (calls === 1) return { state: prepared ? 'preparing' : 'busy' }; running = false; throw new Error('pipe closed'); },
      sleep: async () => {},
      publish: async source => publishNightly(root, source, { guard }),
      launch: async () => { launches++; },
    });
    assert.equal(result.restarted, prepared);
    assert.equal(launches, prepared ? 1 : 0);
  }
});

test('hung graceful exit is never killed, cancels preparation and keeps candidate retryable', async t => {
  const { root } = await queued(t);
  let time = 0;
  let publication = false;
  const actions = [];
  await assert.rejects(applyNightlyUpdate(root, {
    alive: () => true, guard,
    request: async (_instance, action) => { actions.push(action); return { state: action === 'cancel' ? 'cancelled' : 'ready' }; },
    now: () => time, sleep: async ms => { time += ms; }, exitWaitMs: 10, pollMs: 5,
    publish: async () => { publication = true; },
  }), /не завершился/);
  assert.equal(publication, false);
  assert.deepEqual(actions, ['prepare', 'cancel']);
  await assert.rejects(assertNoPendingUpdate(root), /уже ожидает/);
});

test('publication retry preserves an accepted restart after the original host already exited', async t => {
  const { root } = await queued(t);
  let running = true;
  let launches = 0;
  await assert.rejects(applyNightlyUpdate(root, {
    alive: () => running, guard,
    request: async () => { running = false; return { state: 'ready' }; },
    publish: async () => { throw new Error('temporary file locked'); },
  }), /temporary file locked/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'artifacts/nightly-update/state.json'), 'utf8')).restartRequested, true);
  const result = await applyNightlyUpdate(root, { alive: () => false, guard, publish: async source => publishNightly(root, source, { guard }), launch: async () => { launches++; } });
  assert.equal(result.restarted, true);
  assert.equal(launches, 1);
});

test('post-publication launch failure clears candidate and reports ordinary shortcut recovery', async t => {
  const { root } = await queued(t);
  let running = true;
  await assert.rejects(applyNightlyUpdate(root, {
    alive: () => running, guard,
    request: async () => { running = false; return { state: 'ready' }; },
    publish: async source => publishNightly(root, source, { guard }),
    launch: async () => { throw new Error('spawn failed'); },
  }), /обновлён, но не запустился/);
  await assertNoPendingUpdate(root);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'b'.repeat(64));
});

test('duplicate workers and discard cannot overwrite a live helper', async t => {
  const { root } = await queued(t);
  const directory = path.join(root, 'artifacts', 'nightly-update');
  await writeFile(path.join(directory, 'worker.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(applyNightlyUpdate(root, { guard }), /уже работает/);
  await assert.rejects(discardNightlyUpdate(root), /ещё работает/);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'worker.json'), 'utf8')), { pid: process.pid });
});

test('discard cancels matching preparation and leaves installed channels intact', async t => {
  const { root } = await queued(t);
  let cancelled = false;
  await discardNightlyUpdate(root, { alive: () => true, request: async (_instance, action, params) => { assert.equal(action, 'cancel'); assert.equal(params.buildId, 'b'.repeat(64)); cancelled = true; return { state: 'cancelled' }; } });
  assert.equal(cancelled, true);
  await assertNoPendingUpdate(root);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
});

test('helper launch is detached and returns immediately with no host lifecycle wait', async t => {
  const root = await fixture(t);
  const { EventEmitter } = await import('node:events');
  let unref = false;
  const pid = await launchUpdateHelper(root, { launch: (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, [path.join(root, 'scripts', 'apply-nightly-update.mjs')]);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.cwd, root);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    const child = new EventEmitter(); child.pid = 12; child.unref = () => { unref = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  assert.equal(pid, 12);
  assert.equal(unref, true);
});

test('real named-pipe client authenticates and correlates responses, including cancel', async t => {
  const root = await fixture(t);
  const record = instance(root);
  record.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-desk-nightly-test-${randomBytes(16).toString('hex')}` : path.join(root, 'test.sock');
  const seen = [];
  const server = createServer(socket => { socket.setEncoding('utf8'); socket.once('data', data => { const request = JSON.parse(data); seen.push(request); socket.end(`${JSON.stringify({ requestId: request.requestId, state: request.action === 'cancel' ? 'cancelled' : 'ready' })}\n`); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(record.pipe, resolve); });
  try {
    assert.deepEqual(await requestInstance(record, 'status'), { state: 'ready' });
    assert.deepEqual(await requestInstance(record, 'cancel', { requestId: 'abc' }), { state: 'cancelled' });
    assert.ok(seen.every(request => request.token === record.token));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('generic updater logs reject arbitrary text and rotate at a bounded size', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts', 'nightly-update.log'), 'x'.repeat(128 * 1024 + 1));
  await logUpdate(root, 'complete');
  const content = await readFile(path.join(root, 'artifacts', 'nightly-update.log'), 'utf8');
  assert.match(content, / complete\n$/);
  assert.ok(content.length < 100);
  await assert.rejects(logUpdate(root, 'secret token or path'), /Неверная запись/);
});
