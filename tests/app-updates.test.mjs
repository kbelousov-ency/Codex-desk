import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppUpdateService, AppUpdateStore, compareVersions, releaseUpdate, validDownloadUrl, UPDATE_API, UPDATE_INTERVAL, UPDATE_START_DELAY } from '../electron/app-updates.mjs';

const url = version => `https://github.com/kbelousov-ency/Codex-desk/releases/download/v${version}/Codex-Desk-Setup-${version}.exe`;
const release = (version = '0.3.0') => ({ tag_name: `v${version}`, draft: false, prerelease: false, body: 'Новая функция',
  assets: [{ name: `Codex-Desk-Setup-${version}.exe`, size: 1234, state: 'uploaded', browser_download_url: url(version) }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-app-updates-'));
  const filename = path.join(directory, 'updates.json');
  const calls = [], events = [], opened = [], timers = new Map();
  let now = Date.parse('2026-09-21T12:00:00Z');
  const store = new AppUpdateStore(filename);
  const service = new AppUpdateService({ buildInfo: { channel: 'stable', version: '0.2.0' }, store,
    fetch: async (...args) => { calls.push(args); return Response.json(release()); },
    openExternal: async value => { opened.push(value); }, publish: state => events.push(state), now: () => now,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.set(timer, timer); return timer; },
    clearTimer: timer => timers.delete(timer), ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, filename, calls, events, opened, timers, advance: value => { now += value; } };
}

test('numeric stable versions never offer a downgrade or prerelease', () => {
  assert.equal(compareVersions('0.10.0', '0.9.12'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.999'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  for (const value of ['0.02.0', '0.2', 'v0.2.0', '0.3.0-beta.1', '0.2.0+build', '1.1.9999999999']) assert.throws(() => compareVersions(value, '0.2.0'));
  assert.equal(releaseUpdate(release('0.2.0'), '0.2.0'), null);
  assert.equal(releaseUpdate(release('0.1.0'), '0.2.0'), null);
  for (const changed of [{ prerelease: true }, { draft: true }, { tag_name: 'v0.3.0-beta.1' }, { assets: [] }]) {
    assert.throws(() => releaseUpdate({ ...release(), ...changed }, '0.2.0'));
  }
});

test('download allowlist binds HTTPS host, repository, tag and installer version', () => {
  assert.equal(validDownloadUrl(url('0.3.0'), '0.3.0'), true);
  for (const suffix of ['Codex.Desk.Setup.0.3.0.exe', 'Codex%20Desk%20Setup%200.3.0.exe']) {
    assert.equal(validDownloadUrl(url('0.3.0').replace('Codex-Desk-Setup-0.3.0.exe', suffix), '0.3.0'), true);
  }
  for (const value of [url('0.4.0'), url('0.3.0') + '?next=evil', url('0.3.0') + '#x',
    url('0.3.0').replace('https:', 'http:'), url('0.3.0').replace('github.com', 'github.com.evil.test'),
    url('0.3.0').replace('github.com', 'user@github.com'), url('0.3.0').replace('Codex-desk/', 'evil/'),
    url('0.3.0').replace('Setup-0.3.0.exe', 'Nightly-0.3.0.exe'), 'file:///setup.exe', 'javascript:alert(1)']) {
    assert.equal(validDownloadUrl(value, '0.3.0'), false, value);
    const info = release(); info.assets[0].browser_download_url = value;
    assert.throws(() => releaseUpdate(info, '0.2.0'));
  }
  const mismatched = release(); mismatched.assets[0].name = 'Codex.Desk.Setup.0.3.0.exe';
  assert.throws(() => releaseUpdate(mismatched, '0.2.0'));
});

test('check sends only public request metadata and download needs explicit action', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.openDownload());
  const status = await f.service.check();
  assert.equal(status.phase, 'available');
  assert.equal(status.latestVersion, '0.3.0');
  assert.equal(status.currentVersion, '0.2.0');
  assert.deepEqual(f.events.map(event => event.phase), ['checking', 'available']);
  assert.equal(f.calls[0][0], UPDATE_API);
  const request = f.calls[0][1];
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(Object.keys(request.headers).some(key => /authorization|cookie/i.test(key)), false);
  assert.deepEqual(f.opened, []);
  await f.service.openDownload();
  assert.deepEqual(f.opened, [url('0.3.0')]);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).checkedAt, status.checkedAt);
  await f.service.check();
  assert.equal(f.calls.length, 1, 'consecutive successful clicks reuse the result');
});

test('start and six-hour polling, opt out, manual check, persisted skip and restart', async t => {
  const f = await fixture(t);
  await f.service.start();
  assert.equal([...f.timers.values()][0].delay, UPDATE_START_DELAY);
  assert.equal(f.calls.length, 0);
  const timer = [...f.timers.values()][0]; f.timers.delete(timer); timer.fn();
  while (!f.service.inflight) await tick();
  await f.service.inflight;
  assert.equal([...f.timers.values()][0].delay, UPDATE_INTERVAL);
  await f.service.setPreferences({ enabled: false, skippedVersion: '0.3.0' });
  assert.equal(f.timers.size, 0);
  f.advance(UPDATE_INTERVAL);
  await f.service.check(false);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.check()).phase, 'available', 'manual check still works when automatic checks are off');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.store.snapshot()).skippedVersion, '0.3.0');
  const reopened = new AppUpdateStore(f.filename);
  assert.equal((await reopened.snapshot()).enabled, false);
  await f.service.setPreferences({ skippedVersion: null, enabled: true });
  assert.equal((await f.store.snapshot()).skippedVersion, undefined);
  assert.equal([...f.timers.values()][0].delay, UPDATE_START_DELAY);
});

test('disabled channels and isolated profiles never access the network', async t => {
  for (const options of [{ buildInfo: { channel: 'nightly', version: '0.2.0' } },
    { buildInfo: { channel: 'development', version: '0.2.0' } }, { networkAllowed: false }]) {
    const f = await fixture(t, options);
    await f.service.start(); await f.service.check();
    assert.equal((await f.service.status()).supported, false);
    assert.equal((await f.service.status()).phase, 'disabled');
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    await assert.rejects(f.service.openDownload());
  }
});

test('bad responses produce a retryable error, never a download', async t => {
  for (const response of [new Response('', { status: 403 }), new Response('', { status: 429 }),
    new Response('', { status: 500 }), new Response('{invalid'), Response.json({ ...release(), assets: [] }),
    new Response('x'.repeat(1024 * 1024 + 1)), new Response('{}', { headers: { 'Content-Length': 2 * 1024 * 1024 } })]) {
    let first = true;
    const f = await fixture(t, { fetch: async () => first ? (first = false, response) : Response.json(release()) });
    assert.equal((await f.service.check()).phase, 'error');
    await assert.rejects(f.service.openDownload());
    assert.equal((await f.service.check()).phase, 'available');
  }
  const f = await fixture(t, { fetch: async () => { throw new Error('proxy password=private'); } });
  assert.equal((await f.service.check()).error.includes('private'), false);
});

test('no releases is a successful check and current/newer versions do not notify', async t => {
  for (const response of [new Response('', { status: 404 }), Response.json(release('0.2.0')), Response.json(release('0.1.0'))]) {
    const f = await fixture(t, { fetch: async () => response });
    assert.equal((await f.service.check()).phase, 'up-to-date');
    assert.equal((await f.service.status()).latestVersion, undefined);
    await assert.rejects(f.service.openDownload());
  }
});

test('overlapping requests coalesce; opt out and shutdown cancel stale results', async t => {
  let resolveFetch, count = 0;
  const f = await fixture(t, { fetch: () => { count++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const first = f.service.check();
  while (!resolveFetch) await tick();
  const second = f.service.check();
  await f.service.setPreferences({ enabled: false });
  resolveFetch(Response.json(release()));
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal((await f.service.status()).phase, 'idle');
  assert.equal(f.events.some(event => event.phase === 'available'), false);
  await assert.rejects(f.service.openDownload());
  const third = f.service.check();
  while (count < 2) await tick();
  const closing = f.service.close();
  resolveFetch(Response.json(release()));
  await Promise.all([third, closing]);
  assert.equal(f.events.some(event => event.phase === 'available'), false);
});

test('timeout surfaces an error and a failed store cannot hide preferences loss', async t => {
  const f = await fixture(t, { fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const check = f.service.check();
  while (!f.timers.size) await tick();
  [...f.timers.values()][0].fn();
  assert.match((await check).error, /слишком много времени/);
  for (const patch of [null, [], { url: 'https://evil.test' }, { enabled: 'yes' }, { skippedVersion: '1.0' }, { skippedVersion: undefined }]) {
    await assert.rejects(f.service.setPreferences(patch));
  }
  await writeFile(f.filename, '{broken');
  await assert.rejects(f.service.setPreferences({ enabled: false }));
  assert.equal((await f.service.status()).enabled, true);
});
