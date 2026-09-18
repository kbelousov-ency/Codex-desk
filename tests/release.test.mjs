import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import asar from '@electron/asar';
import { checkedPath, fileChecksums, inside, promoteRelease, publishNightly, recoverRelease, removeChecked, rollbackRelease, verifyRelease, withReleaseLock } from '../scripts/release-utils.mjs';

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
