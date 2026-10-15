import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteControlStore, validateRemoteControlData } from '../electron/remote-control-store.mjs';

const empty = () => ({ version: 1, grants: [], operations: [] });
async function directory(t) { const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'kuzmich-remote-store-')); t.after(() => fs.rm(folder, { recursive: true, force: true })); return folder; }
const grant = () => ({ grantId: 'grant', provider: 'codex', threadId: 'thread', cwd: path.resolve('fixture-project'), projectKey: 'project',
  title: 'Fixture', enabled: true, generation: 1, binding: { sessionId: 'session', runtimeId: 'runtime' } });

test('remote ledger freezes submitted bytes and round-trips grants without provider credentials', async t => {
  const folder = await directory(t), store = createRemoteControlStore(folder);
  assert.deepEqual(await store.read(), empty());
  const value = { ...empty(), grants: [{ ...grant(), credentials: 'do-not-persist' }] };
  const saved = store.save(value); value.grants[0].enabled = false;
  await saved;
  const encoded = await fs.readFile(store.filename, 'utf8');
  assert.equal(encoded.includes('do-not-persist'), false);
  assert.equal((await store.read()).grants[0].enabled, true);
  assert.equal((await fs.readdir(folder)).some(name => name.endsWith('.tmp')), false);
});

test('corrupt ledger is preserved and never replaced with an empty grant/operation history', async t => {
  const folder = await directory(t), store = createRemoteControlStore(folder);
  await fs.writeFile(store.filename, '{broken:');
  await assert.rejects(store.read(), /не сброшено/);
  await assert.rejects(store.save(empty()), /недоступно/);
  assert.equal(await fs.readFile(store.filename, 'utf8'), '{broken:');
  assert.equal((await fs.readdir(folder)).filter(name => name.includes('.invalid-')).length, 1);
});

test('failed rename preserves previous durable grant generation and poisons further writes', async t => {
  const folder = await directory(t), first = createRemoteControlStore(folder);
  await first.save({ ...empty(), grants: [grant()] });
  let syncs = 0;
  const store = createRemoteControlStore(folder, { io: { ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args);
      return { writeFile: (...values) => handle.writeFile(...values), sync: async () => { syncs++; await handle.sync(); }, close: () => handle.close() };
    },
    rename: async () => { throw Object.assign(new Error('disk unavailable'), { code: 'EACCES' }); },
  } });
  const value = await store.read(); value.grants[0].generation++;
  await assert.rejects(store.save(value), /Отправка остановлена/);
  assert.equal(syncs, 1, 'temporary ledger must be synced before rename');
  await assert.rejects(store.save(empty()), /недоступно/);
  assert.equal(JSON.parse(await fs.readFile(first.filename, 'utf8')).grants[0].generation, 1);
  assert.equal((await fs.readdir(folder)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('validator rejects duplicate identity and broken operation references rather than losing tombstones', () => {
  assert.throws(() => validateRemoteControlData({ ...empty(), grants: [grant(), { ...grant(), grantId: 'another' }] }));
  assert.throws(() => validateRemoteControlData({ ...empty(), operations: [{ operationId: 'unknown' }] }));
  assert.throws(() => validateRemoteControlData({ version: 2, grants: [], operations: [] }));
});

test('missing previously-read file is an error, not a new empty ledger', async t => {
  const folder = await directory(t), store = createRemoteControlStore(folder);
  await store.save({ ...empty(), grants: [grant()] });
  await fs.unlink(store.filename);
  await assert.rejects(store.read(), /не сброшено/);
});

test('temporary Windows sharing denial does not poison the ledger or reserve another operation', async t => {
  const folder = await directory(t);
  let renames = 0;
  const io = { ...fs, rename: async (...args) => {
    if (++renames < 3) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
    return fs.rename(...args);
  } };
  const store = createRemoteControlStore(folder, { io, platform: 'win32', sleep: async () => {} });
  await store.save({ ...empty(), grants: [grant()] });
  assert.equal(renames, 3);
  assert.equal((await store.read()).grants.length, 1);
  await store.save({ ...empty(), grants: [grant()] });
  assert.equal((await store.read()).operations.length, 0);
});
