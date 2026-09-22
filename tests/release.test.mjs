import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import asar from '@electron/asar';
import { checkedPath, fileChecksums, inside, promoteRelease, publishNightly, recoverRelease, removeChecked, rollbackRelease, verifyRelease, withReleaseLock } from '../scripts/release-utils.mjs';
import { queueNightlyUpdate } from '../scripts/nightly-update.mjs';

const guard = async () => {};
async function fixture(t) {
  const parent = path.resolve('artifacts');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'release-test-'));
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

async function build(root, tag) {
  const source = await binary(root, tag);
  await publishNightly(root, source, { guard });
  return verifyRelease(root, path.join(root, 'release', 'nightly'), 'nightly');
}

async function queueBuild(root, tag) {
  const installed = await verifyRelease(root, path.join(root, 'release', 'nightly'), 'nightly');
  await queueNightlyUpdate(root, await binary(root, tag), {
    version: 1, updateProtocol: 2, pid: 987654321,
    pipe: `\\\\.\\pipe\\codex-desk-nightly-987654321-${'a'.repeat(32)}`, token: 'b'.repeat(64), buildId: installed.buildId,
    executable: path.join(root, 'release', 'nightly', 'Codex Desk.exe'), userData: path.join(root, 'profile'), cwd: root,
  });
  return path.join(root, 'artifacts', 'nightly-update');
}

test('Nightly updates one fixed directory; promotion preserves every application byte and one previous stable', async t => {
  const root = await fixture(t);
  const first = await build(root, 'a');
  await promoteRelease(root, { guard });
  assert.deepEqual(await fileChecksums(root, path.join(root, 'release', 'nightly')), await fileChecksums(root, path.join(root, 'release', 'stable')));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'release', 'stable', 'resources', 'channel.json'), 'utf8')), { channel: 'stable' });
  const second = await build(root, 'b');
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, first.buildId);
  await promoteRelease(root, { guard });
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, second.buildId);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'))).buildId, first.buildId);
  await build(root, 'c');
  await promoteRelease(root, { guard });
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'))).buildId, second.buildId);
  assert.deepEqual((await readdir(path.join(root, 'release'))).sort(), ['nightly', 'stable', 'stable-previous']);
});

test('promotion uses the verified queued candidate while leaving the running Nightly and update queue intact', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  const queue = await queueBuild(root, 'b');
  const beforeQueue = await fileChecksums(root, queue, new Set());
  const nightly = path.join(root, 'release', 'nightly');
  const beforeNightly = await fileChecksums(root, nightly, new Set());
  const rejectNightly = async directory => { if (directory === nightly) throw new Error('running nightly'); };
  const promoted = await withReleaseLock(root, () => promoteRelease(root, { guard: rejectNightly }), { guard });
  assert.equal(promoted.buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'), 'stable')).buildId, promoted.buildId);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'), 'stable')).buildId, 'a'.repeat(64));
  assert.deepEqual(await fileChecksums(root, queue, new Set()), beforeQueue);
  assert.deepEqual(await fileChecksums(root, nightly, new Set()), beforeNightly);
});

test('invalid queued updates block promotion without falling back to old Nightly or modifying stable and queue', async t => {
  for (const scenario of ['json', 'null', 'version', 'size', 'buildId', 'payload', 'missingState']) {
    const root = await fixture(t);
    await build(root, 'a');
    await promoteRelease(root, { guard });
    const queue = await queueBuild(root, 'b');
    const stateFile = path.join(queue, 'state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (scenario === 'json') await writeFile(stateFile, '{');
    if (scenario === 'null') await writeFile(stateFile, 'null');
    if (scenario === 'version') await writeFile(stateFile, JSON.stringify({ ...state, version: 2 }));
    if (scenario === 'size') await writeFile(stateFile, ' '.repeat(16385));
    if (scenario === 'buildId') await writeFile(stateFile, JSON.stringify({ ...state, buildId: 'c'.repeat(64) }));
    if (scenario === 'payload') await writeFile(path.join(queue, 'app', 'resources', 'dependency.bin'), 'tampered');
    if (scenario === 'missingState') await unlink(stateFile);
    const beforeQueue = await fileChecksums(root, queue, new Set());
    const beforeRelease = await fileChecksums(root, path.join(root, 'release'), new Set());
    await assert.rejects(withReleaseLock(root, () => promoteRelease(root, { guard }), { guard }), undefined, scenario);
    assert.deepEqual(await fileChecksums(root, queue, new Set()), beforeQueue, scenario);
    assert.deepEqual(await fileChecksums(root, path.join(root, 'release'), new Set()), beforeRelease, scenario);
  }
});

test('rollback swaps stable and its backup, leaving Nightly unchanged', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  await build(root, 'b');
  await promoteRelease(root, { guard });
  await rollbackRelease(root, { guard });
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'))).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'b'.repeat(64));
});

test('tampered or extra packaged files block promotion before stable changes', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  await build(root, 'b');
  const nightly = path.join(root, 'release', 'nightly');
  await writeFile(path.join(nightly, 'resources', 'dependency.bin'), 'tampered');
  await assert.rejects(promoteRelease(root, { guard }), /Контрольные суммы/);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
  await build(root, 'c');
  await writeFile(path.join(nightly, 'unexpected.txt'), 'injected');
  await assert.rejects(promoteRelease(root, { guard }), /Контрольные суммы/);
});

test('running target prevents replacement, but a running Nightly need not stop promotion', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  const rejectNightly = async directory => { if (path.basename(directory) === 'nightly') throw new Error('running nightly'); };
  await assert.rejects(publishNightly(root, await binary(root, 'b'), { guard: rejectNightly }), /running nightly/);
  await promoteRelease(root, { guard: rejectNightly });
  const rejectStable = async directory => { if (path.basename(directory) === 'stable') throw new Error('running stable'); };
  await assert.rejects(promoteRelease(root, { guard: rejectStable }), /running stable/);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
});

test('transient Windows directory locks retry then publish the verified candidate', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  const candidate = await binary(root, 'b');
  const failures = ['EPERM', 'EACCES', 'EBUSY'];
  const waits = [];
  let time = 0;
  let guarded;
  let moves = 0;
  await publishNightly(root, candidate, {
    guard: async directory => { guarded = directory; },
    moveRetry: {
      platform: 'win32', now: () => time,
      sleep: async ms => { waits.push(ms); time += ms; },
      rename: async (from, to) => {
        assert.equal(guarded, from);
        guarded = undefined;
        moves++;
        if (failures.length) throw Object.assign(new Error('temporary lock'), { code: failures.shift() });
        await rename(from, to);
      },
    },
  });
  assert.equal(moves, 5);
  assert.deepEqual(waits, [250, 250, 250]);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
  assert.deepEqual(await readdir(path.join(root, 'release')), ['nightly', 'stable']);
});

test('persistent Windows lock has bounded retries and rolls back the previous Nightly', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  const candidate = await binary(root, 'b');
  const originalCandidate = await fileChecksums(root, candidate);
  const denied = Object.assign(new Error('persistent lock'), { code: 'EPERM' });
  let time = 0;
  let failures = 0;
  await assert.rejects(publishNightly(root, candidate, {
    guard,
    moveRetry: {
      platform: 'win32', now: () => time, sleep: async ms => { time += ms; },
      rename: async (from, to) => {
        if (path.basename(from) === '.nightly-incoming') { failures++; throw denied; }
        await rename(from, to);
      },
    },
  }), error => error === denied);
  assert.equal(failures, 180, '45 s window at 250 ms per attempt');
  assert.ok(time <= 45000);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'a'.repeat(64));
  assert.deepEqual(await fileChecksums(root, candidate), originalCandidate);
  assert.deepEqual(await readdir(path.join(root, 'release')), ['nightly', 'stable']);
});

test('nontransient rename errors and non-Windows platforms fail without retry', async t => {
  for (const [platform, code] of [['win32', 'EIO'], ['linux', 'EPERM']]) {
    const root = await fixture(t);
    await build(root, 'a');
    let calls = 0;
    const failure = Object.assign(new Error('rename failed'), { code });
    await assert.rejects(publishNightly(root, await binary(root, 'b'), {
      guard,
      moveRetry: {
        platform,
        sleep: async () => assert.fail('unexpected retry'),
        rename: async () => { calls++; throw failure; },
      },
    }), error => error === failure);
    assert.equal(calls, 1);
    assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
    assert.deepEqual(await readdir(path.join(root, 'release')), ['nightly']);
  }
});

test('application reopened during retry prevents the next directory move', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  let running = false;
  let calls = 0;
  await assert.rejects(publishNightly(root, await binary(root, 'b'), {
    guard: async directory => {
      if (running && path.basename(directory) === 'nightly') throw new Error('running nightly');
    },
    moveRetry: {
      platform: 'win32', now: () => 0,
      sleep: async () => { running = true; },
      rename: async () => { calls++; throw Object.assign(new Error('temporary lock'), { code: 'EPERM' }); },
    },
  }), /running nightly/);
  assert.equal(calls, 1);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
  assert.deepEqual(await readdir(path.join(root, 'release')), ['nightly']);
});

test('destination is rechecked when it appears during a Windows rename retry', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  let calls = 0;
  await assert.rejects(publishNightly(root, await binary(root, 'b'), {
    guard,
    moveRetry: {
      platform: 'win32', now: () => 0,
      sleep: async () => { await mkdir(path.join(root, 'release', '.nightly-old')); },
      rename: async () => { calls++; throw Object.assign(new Error('temporary lock'), { code: 'EPERM' }); },
    },
  }), /Каталог назначения уже существует/);
  assert.equal(calls, 1);
  assert.equal((await verifyRelease(root, path.join(root, 'release', 'nightly'))).buildId, 'a'.repeat(64));
  assert.deepEqual(await readdir(path.join(root, 'release')), ['nightly']);
});

test('promotion failure at every rename restores both stable versions and cleans staging', async t => {
  for (const move of [1, 2, 3]) {
    const root = await fixture(t);
    await build(root, 'a');
    await promoteRelease(root, { guard });
    await build(root, 'b');
    await promoteRelease(root, { guard });
    await build(root, 'c');
    await assert.rejects(promoteRelease(root, { guard, afterMove: step => { if (step === move) throw new Error('simulated interrupted promotion'); } }), /simulated interrupted/);
    assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'b'.repeat(64));
    assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'))).buildId, 'a'.repeat(64));
    assert.deepEqual((await readdir(path.join(root, 'release'))).sort(), ['nightly', 'stable', 'stable-previous']);
  }
});

test('interrupted rollback restores versions; restart recovers a rename before its journal update', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  await build(root, 'b');
  await promoteRelease(root, { guard });
  for (const move of [1, 2, 3]) {
    await assert.rejects(rollbackRelease(root, { guard, afterMove: step => { if (step === move) throw new Error('simulated interruption'); } }), /simulated interruption/);
    assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable'))).buildId, 'b'.repeat(64));
    assert.equal((await verifyRelease(root, path.join(root, 'release', 'stable-previous'))).buildId, 'a'.repeat(64));
  }
  const release = path.join(root, 'release');
  const journal = { format: 1, steps: [['stable', '.stable-swap'], ['stable-previous', 'stable'], ['.stable-swap', 'stable-previous']], cleanup: ['.stable-swap'], completed: 0, phase: 'forward' };
  await writeFile(path.join(release, '.transaction.json'), JSON.stringify(journal));
  await rename(path.join(release, 'stable'), path.join(release, '.stable-swap'));
  await recoverRelease(root, { guard });
  assert.equal((await verifyRelease(root, path.join(release, 'stable'))).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(release, 'stable-previous'))).buildId, 'a'.repeat(64));
});

test('path checks reject root deletion, outside paths and junctions', async t => {
  const root = await fixture(t);
  assert.throws(() => inside(root, root), /Путь/);
  assert.throws(() => inside(root, path.join(root, '..', 'outside')), /Путь/);
  await assert.rejects(removeChecked(root, root), /Путь/);
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await mkdir(target);
  await writeFile(path.join(target, 'keep.txt'), 'untouched');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkedPath(root, path.join(link, 'keep.txt')), /Ссылки/);
  await assert.rejects(removeChecked(root, link), /Ссылки/);
  // Delete the test-created junction itself, without traversing it.
  const { unlink } = await import('node:fs/promises');
  await unlink(link);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'untouched');
});

test('one operation lock spans builds, promotions and recovery and releases after failures', async t => {
  const root = await fixture(t);
  await withReleaseLock(root, async () => {
    await assert.rejects(withReleaseLock(root, async () => {}), /уже выполняется/);
  }, { guard });
  await assert.rejects(withReleaseLock(root, async () => { throw new Error('failure'); }, { guard }), /failure/);
  await withReleaseLock(root, async () => {}, { guard });
  assert.deepEqual(await readdir(path.join(root, 'release')), []);
});

test('abandoned operation lock is reclaimed after its owner exits', async t => {
  const root = await fixture(t);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  const deadPid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await mkdir(path.join(root, 'release'));
  await writeFile(path.join(root, 'release', '.release.lock'), JSON.stringify({ pid: deadPid, token: 'abandoned' }));
  let ran = false;
  await withReleaseLock(root, async () => { ran = true; }, { guard });
  assert.equal(ran, true);
  assert.deepEqual(await readdir(path.join(root, 'release')), []);
});

test('recovery itself may be interrupted after undo rename without losing either release', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  await build(root, 'b');
  await promoteRelease(root, { guard });
  const release = path.join(root, 'release');
  // The first swap rename was undone, but the recovery cursor was not yet saved.
  const journal = { format: 1, steps: [['stable', '.stable-swap'], ['stable-previous', 'stable'], ['.stable-swap', 'stable-previous']], cleanup: ['.stable-swap'], completed: 1, phase: 'rollback' };
  await writeFile(path.join(release, '.transaction.json'), JSON.stringify(journal));
  await recoverRelease(root, { guard });
  assert.equal((await verifyRelease(root, path.join(release, 'stable'))).buildId, 'b'.repeat(64));
  assert.equal((await verifyRelease(root, path.join(release, 'stable-previous'))).buildId, 'a'.repeat(64));
});

test('invalid artifact cleans incoming directory and strict channel marker rejects extra keys', async t => {
  const root = await fixture(t);
  const source = await binary(root, 'a');
  await removeChecked(root, path.join(source, 'Codex Desk.exe'));
  await assert.rejects(publishNightly(root, source, { guard }), /нет приложения/);
  assert.deepEqual(await readdir(path.join(root, 'release')), []);
  await build(root, 'b');
  const nightly = path.join(root, 'release', 'nightly');
  await writeFile(path.join(nightly, 'resources', 'channel.json'), JSON.stringify({ channel: 'nightly', unknown: true }));
  await assert.rejects(verifyRelease(root, nightly), /Неверный канал/);
});

test('unknown recovery plans cannot erase a stable directory', async t => {
  const root = await fixture(t);
  await build(root, 'a');
  await promoteRelease(root, { guard });
  const release = path.join(root, 'release');
  await writeFile(path.join(release, '.transaction.json'), JSON.stringify({ format: 1, steps: [], cleanup: ['stable'], completed: 0, phase: 'committed' }));
  await assert.rejects(recoverRelease(root, { guard }), /неизвестную операцию/);
  assert.equal((await verifyRelease(root, path.join(release, 'stable'))).buildId, 'a'.repeat(64));
});
