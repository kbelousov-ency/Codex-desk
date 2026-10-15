import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotStore } from '../electron/update-checkpoint.mjs';

const snapshot = draft => ({ version: 1, activeIndex: 0, tabs: [{ cwd: path.resolve('fixture-project'), settings: {}, draft, attachments: [] }] });
const fault = code => Object.assign(new Error(`injected ${code}`), { code });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, { io = {}, platform = 'win32', sleep } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-writer-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'workspace-state.json');
  const previous = JSON.stringify(snapshot('previous'));
  await fs.writeFile(filename, previous);
  const waits = [];
  const store = createSnapshotStore(directory, { basename: 'workspace-state.json', io: { ...fs, ...io }, platform,
    sleep: sleep || (async ms => { waits.push(ms); }), readError: 'read failed' });
  return { store, filename, directory, previous, waits };
}

for (const code of ['EPERM', 'EBUSY']) {
  test(`temporary ${code} retries only rename and flush waits for replacement`, async t => {
    let attempts = 0, writes = 0;
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { io: {
      async writeFile(...args) { writes++; return fs.writeFile(...args); },
      async rename(...args) { if (++attempts === 1) throw fault(code); return fs.rename(...args); },
    }, sleep: async ms => { assert.equal(ms, 25); entered.resolve(); await release.promise; } });
    const saving = f.store.save(snapshot('next'));
    let flushed = false;
    const flushing = f.store.flush().then(() => { flushed = true; });
    await entered.promise;
    assert.equal(flushed, false);
    assert.equal(await fs.readFile(f.filename, 'utf8'), f.previous);
    release.resolve();
    await Promise.all([saving, flushing]);
    assert.equal(attempts, 2);
    assert.equal(writes, 1);
    assert.equal((await f.store.read()).tabs[0].draft, 'next');
    assert.deepEqual(await fs.readdir(f.directory), ['workspace-state.json']);
  });

  test(`permanent ${code} exhausts ten rename attempts, preserves old bytes and rejects flush`, async t => {
    let attempts = 0;
    const error = fault(code);
    const f = await fixture(t, { io: { rename: async () => { attempts++; throw error; } } });
    const saving = f.store.save(snapshot('next'));
    await Promise.all([assert.rejects(saving, e => e === error), assert.rejects(f.store.flush(), e => e === error)]);
    assert.equal(attempts, 10);
    assert.deepEqual(f.waits, [25, 50, 75, 100, 100, 100, 100, 100, 100]);
    assert.equal(f.waits.reduce((a, b) => a + b), 750);
    assert.equal(await fs.readFile(f.filename, 'utf8'), f.previous);
    assert.deepEqual(await fs.readdir(f.directory), ['workspace-state.json']);
    await f.store.read();
    await assert.rejects(f.store.flush(), e => e === error, 'A read cannot acknowledge a failed write');
  });
}

for (const [code, platform] of [['EACCES', 'win32'], ['ENOSPC', 'win32'], ['EPERM', 'linux'], ['EBUSY', 'darwin']]) {
  test(`${platform} ${code} is not retried`, async t => {
    let attempts = 0;
    const f = await fixture(t, { platform, io: { rename: async () => { attempts++; throw fault(code); } } });
    await assert.rejects(f.store.save(snapshot('next')), { code });
    await assert.rejects(f.store.flush(), { code });
    assert.equal(attempts, 1);
    assert.deepEqual(f.waits, []);
    assert.equal(await fs.readFile(f.filename, 'utf8'), f.previous);
  });
}

for (const operation of ['mkdir', 'writeFile']) {
  test(`${operation} failure is propagated without rename or retry`, async t => {
    let attempts = 0, renames = 0;
    const f = await fixture(t, { io: {
      [operation]: async (...args) => {
        attempts++;
        if (operation === 'writeFile') await fs.writeFile(args[0], 'partial temporary bytes', args[2]);
        throw fault('EPERM');
      },
      rename: async () => { renames++; },
    } });
    await assert.rejects(f.store.save(snapshot('next')), { code: 'EPERM' });
    await assert.rejects(f.store.flush(), { code: 'EPERM' });
    assert.equal(attempts, 1);
    assert.equal(renames, 0);
    assert.deepEqual(f.waits, []);
    assert.equal(await fs.readFile(f.filename, 'utf8'), f.previous);
    assert.deepEqual(await fs.readdir(f.directory), ['workspace-state.json']);
  });
}

test('cleanup failure never masks rename failure or deletes the destination', async t => {
  const original = fault('EACCES'), removed = [];
  const f = await fixture(t, { io: {
    rename: async () => { throw original; },
    unlink: async filename => { removed.push(filename); throw fault('EBUSY'); },
  } });
  await assert.rejects(f.store.save(snapshot('next')), error => error === original);
  await assert.rejects(f.store.flush(), error => error === original);
  assert.equal(await fs.readFile(f.filename, 'utf8'), f.previous);
  assert.equal(removed.length, 1);
  assert.ok(removed[0].startsWith(f.filename + '.') && removed[0].endsWith('.tmp'));
});

test('cleanup failure after successful replacement does not repeat a committed save', async t => {
  let renames = 0;
  const f = await fixture(t, { io: {
    rename: async (...args) => { renames++; await fs.rename(...args); },
    unlink: async () => { throw fault('EBUSY'); },
  } });
  await f.store.save(snapshot('next'));
  await f.store.flush();
  assert.equal(renames, 1);
  assert.equal((await f.store.read()).tabs[0].draft, 'next');
});

test('concurrent saves stay serialized throughout retries and freeze input bytes', async t => {
  const entered = deferred(), release = deferred(), written = [], replaced = [];
  let attempts = 0;
  const f = await fixture(t, { io: {
    writeFile: async (...args) => { written.push(JSON.parse(args[1]).tabs[0].draft); await fs.writeFile(...args); },
    rename: async (...args) => {
      if (++attempts === 1) throw fault('EBUSY');
      replaced.push(JSON.parse(await fs.readFile(args[0], 'utf8')).tabs[0].draft);
      await fs.rename(...args);
    },
  }, sleep: async () => { entered.resolve(); await release.promise; } });
  const first = f.store.save(snapshot('first'));
  await entered.promise;
  const flushing = f.store.flush();
  const value = snapshot('second');
  const second = f.store.save(value);
  value.tabs[0].draft = 'mutated';
  assert.deepEqual(written, ['first']);
  release.resolve();
  await Promise.all([first, second, flushing]);
  await f.store.save(snapshot('third'));
  assert.deepEqual(replaced, ['first', 'second', 'third']);
  assert.equal((await f.store.read()).tabs[0].draft, 'third');
});

test('an explicit later save can recover after exhausted retries without re-running the failed save', async t => {
  let fail = true, writes = 0;
  const f = await fixture(t, { io: {
    writeFile: async (...args) => { writes++; await fs.writeFile(...args); },
    rename: async (...args) => { if (fail) throw fault('EPERM'); await fs.rename(...args); },
  } });
  await assert.rejects(f.store.save(snapshot('failed')), { code: 'EPERM' });
  fail = false;
  await f.store.save(snapshot('recovered'));
  await f.store.flush();
  assert.equal(writes, 2);
  assert.equal((await f.store.read()).tabs[0].draft, 'recovered');
});
