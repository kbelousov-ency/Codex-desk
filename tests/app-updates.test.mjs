import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppUpdateService, AppUpdateStore, catalogUpdate, catalogVersion, compareVersions, validDownloadUrl,
  UPDATE_CATALOG, UPDATE_INTERVAL, UPDATE_START_DELAY } from '../electron/app-updates.mjs';

const ORIGIN = 'https://coder-portal.encycam.com';
const fileUrl = version => `/api/apps/codex-desk/versions/${version}/file`;
const PAYLOAD = Buffer.from('installer-bytes-payload');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');
const entry = (version = '0.3.0.7', overrides = {}) => {
  const base = version.split('.').slice(0, 3).join('.');
  return { version, filename: `Codex-Desk-Setup-${base}.exe`, size_bytes: PAYLOAD.length, sha256: PAYLOAD_SHA,
    created_at: '2026-10-15T10:00:00Z', channel: 'stable', release_notes: 'Новая функция', url: fileUrl(version), ...overrides };
};
const card = (...versions) => ({ slug: 'codex-desk', title: 'Кузьмич', versions: versions.length ? versions : [entry()] });
const signedIn = { state: 'signed-in', keyState: 'approved', products: { codex: true, claude: false } };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-app-updates-'));
  const filename = path.join(directory, 'updates.json');
  const downloads = path.join(directory, 'downloads');
  const staging = path.join(directory, 'profile', 'updates');
  const calls = [], events = [], revealed = [], timers = new Map();
  let now = Date.parse('2026-10-15T12:00:00Z');
  const store = new AppUpdateStore(filename);
  const service = new AppUpdateService({
    buildInfo: { channel: 'stable', version: '0.2.0' }, store,
    portal: {
      status: options.portalStatus || (async () => signedIn),
      fetch: options.portalFetch || (async (...args) => {
        calls.push(args);
        return args[0] === UPDATE_CATALOG ? Response.json(options.card ?? card()) : new Response(PAYLOAD);
      }),
    },
    saveDirectory: kind => kind === 'apply' ? staging : downloads,
    reveal: async value => { revealed.push(value); },
    publish: state => events.push(state), now: () => now,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.set(timer, timer); return timer; },
    clearTimer: timer => timers.delete(timer), ...options.service });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, filename, downloads, staging, calls, events, revealed, timers, advance: value => { now += value; } };
}

test('catalog versions compare numerically and build numbers follow the contract', () => {
  assert.deepEqual(catalogVersion('0.11.0.10'), { value: '0.11.0.10', base: '0.11.0', buildNumber: 10 });
  assert.deepEqual(catalogVersion('0.11.0'), { value: '0.11.0', base: '0.11.0', buildNumber: null });
  for (const value of ['0.02.0', '0.2', 'v0.2.0', '0.3.0-beta.1', '0.2.0+b', '0.2.0.0.1', '0.2.0.01', '1.1.9999999999']) {
    assert.equal(catalogVersion(value), null, value);
  }
  assert.equal(compareVersions('0.10.0', '0.9.12'), 1);
  assert.throws(() => compareVersions('0.11.0.5', '0.11.0'), /Некорректный номер/);
  const current = { version: '0.11.0', buildNumber: null };
  assert.equal(catalogUpdate(card(entry('0.11.0.9'), entry('0.11.0.10')), current).latestVersion, '0.11.0.10',
    'build numbers compare numerically, never lexicographically');
  assert.equal(catalogUpdate(card(entry('0.11.0.5')), current).latestVersion, '0.11.0.5',
    'same base with a known build number updates a client without one');
  assert.equal(catalogUpdate(card(entry('0.11.0')), current), null, 'both without build numbers is not an update');
  assert.equal(catalogUpdate(card(entry('0.11.0.5')), { version: '0.11.0', buildNumber: 5 }), null);
  assert.equal(catalogUpdate(card(entry('0.11.0.6')), { version: '0.11.0', buildNumber: 5 }).latestVersion, '0.11.0.6');
  assert.equal(catalogUpdate(card(entry('0.11.0')), { version: '0.11.0', buildNumber: 5 }), null,
    'a candidate without a number never displaces a numbered build');
  assert.equal(catalogUpdate(card(entry('0.10.9.99')), current), null, 'the base version decides first');
});

test('foreign channels and malformed catalog entries are skipped; a broken card is a contract error', () => {
  const current = { version: '0.2.0', buildNumber: null };
  assert.equal(catalogUpdate(card(entry('0.3.0.7', { channel: 'nightly' })), current), null);
  assert.equal(catalogUpdate(card(entry('0.3.0.7', { channel: null })), current).latestVersion, '0.3.0.7',
    'записи без канала публикует текущий Jenkins');
  for (const broken of [
    entry('0.3.0.7', { filename: 'Codex-Desk-Nightly-0.3.0.exe' }),
    entry('0.3.0.7', { filename: 'Codex-Desk-Setup-0.3.0.7.exe' }),
    entry('0.3.0.7', { url: fileUrl('0.3.0.8') }),
    entry('0.3.0.7', { url: `https://evil.test${fileUrl('0.3.0.7')}` }),
    entry('0.3.0.7', { sha256: 'xyz' }),
    entry('0.3.0.7', { size_bytes: 0 }),
    entry('0.3.0.7', { size_bytes: 2.5 }),
  ]) assert.equal(catalogUpdate(card(broken), current), null, JSON.stringify(broken));
  assert.equal(catalogUpdate({ slug: 'codex-desk', versions: [] }, current), null, 'пустой каталог — не ошибка');
  for (const malformed of [null, [], { slug: 'other-app', versions: [entry()] }, { slug: 'codex-desk', versions: {} }]) {
    assert.throws(() => catalogUpdate(malformed, current), /некорректный каталог/);
  }
});

test('download URL is pinned to the portal catalog path of the offered version', () => {
  assert.equal(validDownloadUrl(`${ORIGIN}${fileUrl('0.3.0.7')}`, '0.3.0.7'), true);
  for (const value of [`${ORIGIN}${fileUrl('0.3.0.8')}`, `${ORIGIN}${fileUrl('0.3.0.7')}?next=evil`,
    `${ORIGIN}${fileUrl('0.3.0.7')}#x`, `${ORIGIN.replace('https', 'http')}${fileUrl('0.3.0.7')}`,
    `https://user@coder-portal.encycam.com${fileUrl('0.3.0.7')}`,
    `https://coder-portal.encycam.com.evil.test${fileUrl('0.3.0.7')}`, 'file:///setup.exe', 'javascript:alert(1)']) {
    assert.equal(validDownloadUrl(value, '0.3.0.7'), false, value);
  }
});

test('check requires the portal session and sends only cookie-authorised metadata requests', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.openDownload());
  const status = await f.service.check();
  assert.equal(status.phase, 'available');
  assert.equal(status.latestVersion, '0.3.0.7');
  assert.equal(status.currentVersion, '0.2.0');
  assert.equal(status.downloadUrl, `${ORIGIN}${fileUrl('0.3.0.7')}`);
  assert.equal(status.releaseNotes, 'Новая функция');
  assert.deepEqual(f.events.map(event => event.phase), ['checking', 'available']);
  assert.equal(f.calls[0][0], UPDATE_CATALOG);
  const request = f.calls[0][1];
  assert.equal(request.credentials, 'include');
  assert.equal(request.redirect, 'error');
  assert.equal(Object.keys(request.headers || {}).some(key => /authorization|x-api-key/i.test(key)), false);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).checkedAt, status.checkedAt);
  await f.service.check();
  assert.equal(f.calls.length, 1, 'consecutive successful clicks reuse the result');
});

test('signed-out, pending key and missing entitlement block the catalog request', async t => {
  for (const [portalStatus, pattern] of [
    [async () => ({ state: 'signed-out', keyState: 'none', products: {} }), /Войдите в Portal/],
    [async () => ({ ...signedIn, keyState: 'pending' }), /Доступ к роутеру/],
    [async () => ({ ...signedIn, products: { codex: false, claude: false } }), /Доступ к роутеру/],
    [async () => { throw new Error('portal offline password=private'); }, /Не удалось проверить обновления/],
  ]) {
    const f = await fixture(t, { portalStatus });
    const status = await f.service.check();
    assert.equal(status.phase, 'error');
    assert.match(status.error, pattern);
    assert.equal(status.error.includes('private'), false);
    assert.equal(f.calls.length, 0, 'no catalog request without an authorised session');
    await assert.rejects(f.service.openDownload());
  }
});

test('portal errors remain bounded and retryable, never a download', async t => {
  for (const [response, pattern] of [
    [new Response('', { status: 401 }), /Сессия Portal истекла/],
    [new Response('', { status: 403 }), /Portal отказал/],
    [new Response('', { status: 404 }), /Каталог обновлений не найден/],
    [new Response('', { status: 429 }), /ограничил частоту/],
    [new Response('', { status: 500 }), /HTTP 500/],
    [new Response('{invalid'), /Не удалось проверить обновления/],
    [Response.json({ slug: 'other-app', versions: [] }), /некорректный каталог/],
    [new Response('x'.repeat(1024 * 1024 + 1)), /слишком большой/],
    [new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024) } }), /слишком большой/],
  ]) {
    let first = true;
    const f = await fixture(t, { portalFetch: async url => url !== UPDATE_CATALOG ? new Response(PAYLOAD)
      : first ? (first = false, response) : Response.json(card()) });
    const status = await f.service.check();
    assert.equal(status.phase, 'error');
    assert.match(status.error, pattern);
    await assert.rejects(f.service.openDownload());
    assert.equal((await f.service.check()).phase, 'available');
  }
  const f = await fixture(t, { portalFetch: async () => { throw new Error('proxy password=private'); } });
  assert.equal((await f.service.check()).error.includes('private'), false);
});

test('equal, older and empty catalogs mean up-to-date', async t => {
  for (const value of [card(entry('0.2.0')), card(entry('0.1.5.9')), { slug: 'codex-desk', versions: [] }]) {
    const f = await fixture(t, { card: value });
    assert.equal((await f.service.check()).phase, 'up-to-date');
    assert.equal((await f.service.status()).latestVersion, undefined);
    await assert.rejects(f.service.openDownload());
  }
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
  await f.service.setPreferences({ enabled: false, skippedVersion: '0.3.0.7' });
  assert.equal(f.timers.size, 0);
  f.advance(UPDATE_INTERVAL);
  await f.service.check(false);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.check()).phase, 'available', 'manual check still works when automatic checks are off');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.store.snapshot()).skippedVersion, '0.3.0.7', 'a four-part catalog version can be skipped');
  const reopened = new AppUpdateStore(f.filename);
  assert.equal((await reopened.snapshot()).enabled, false);
  await f.service.setPreferences({ skippedVersion: null, enabled: true });
  assert.equal((await f.store.snapshot()).skippedVersion, undefined);
  assert.equal([...f.timers.values()][0].delay, UPDATE_START_DELAY);
});

test('disabled channels and isolated profiles never touch the portal', async t => {
  for (const options of [{ service: { buildInfo: { channel: 'nightly', version: '0.2.0' } } },
    { service: { buildInfo: { channel: 'development', version: '0.2.0' } } }, { service: { networkAllowed: false } }]) {
    const f = await fixture(t, options);
    await f.service.start(); await f.service.check();
    assert.equal((await f.service.status()).supported, false);
    assert.equal((await f.service.status()).phase, 'disabled');
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    await assert.rejects(f.service.openDownload());
  }
});

test('download verifies size and SHA-256, saves into downloads and reveals the file', async t => {
  const f = await fixture(t);
  await f.service.check();
  const status = await f.service.openDownload();
  assert.equal(status.downloadedVersion, '0.3.0.7');
  const saved = status.downloadedPath;
  assert.equal(path.dirname(saved), f.downloads);
  assert.equal(path.basename(saved), 'Codex-Desk-Setup-0.3.0.exe');
  assert.deepEqual(await readFile(saved), PAYLOAD);
  assert.deepEqual(f.revealed, [saved]);
  assert.equal(status.phase, 'available');
  assert.deepEqual(f.events.map(event => event.phase).slice(-2), ['downloading', 'available']);
  const request = f.calls.at(-1)[1];
  assert.equal(request.credentials, 'include');
  assert.equal(request.redirect, 'error');
  const again = await f.service.openDownload();
  assert.equal(path.basename(again.downloadedPath), 'Codex-Desk-Setup-0.3.0 (1).exe', 'existing files are never overwritten');
  assert.equal((await readdir(f.downloads)).filter(name => name.endsWith('.part')).length, 0, 'no staging leftovers');
});

test('тихая установка получает проверенный файл из служебной папки, а не из загрузок', async t => {
  const applied = [];
  const f = await fixture(t, { service: { apply: async request => { applied.push(request); } } });
  assert.equal((await f.service.status()).canApply, true);
  await f.service.check();
  const status = await f.service.installUpdate();
  assert.equal(applied.length, 1);
  assert.equal(path.dirname(applied[0].installerPath), f.staging, 'файл кладётся в служебную папку профиля');
  assert.equal(applied[0].version, '0.3.0.7');
  assert.equal(applied[0].sha256, PAYLOAD_SHA);
  assert.deepEqual(await readFile(applied[0].installerPath), PAYLOAD);
  assert.deepEqual(f.revealed, [], 'папка загрузок при тихой установке не открывается');
  assert.equal(status.phase, 'available');
  assert.deepEqual(await readdir(f.downloads).catch(() => []), []);

  await writeFile(path.join(f.staging, 'install.log'), 'ok\n');
  const repeat = await f.service.installUpdate();
  assert.equal(path.basename(repeat.downloadedPath), 'Codex-Desk-Setup-0.3.0.exe',
    'повторная попытка не плодит копий по сотне мегабайт');
  assert.deepEqual((await readdir(f.staging)).sort(), ['Codex-Desk-Setup-0.3.0.exe', 'install.log'],
    'отчёт установщика при очистке сохраняется');
});

test('сорванная передача установщика возвращает обычный ручной путь', async t => {
  const f = await fixture(t, { service: { apply: async () => { throw new Error('занято'); } } });
  await f.service.check();
  await assert.rejects(f.service.installUpdate(), /Запустите скачанный установщик вручную/);
  const status = await f.service.status();
  assert.equal(status.phase, 'available', 'предложение остаётся');
  assert.equal(path.dirname(status.downloadedPath), f.staging);
  assert.deepEqual(f.revealed, [status.downloadedPath], 'файл показан в папке');
});

test('параллельный запрос другого назначения не получает чужую задачу', async t => {
  let release;
  const applied = [];
  const f = await fixture(t, {
    portalFetch: async url => url === UPDATE_CATALOG ? Response.json(card())
      : new Promise(resolve => { release = () => resolve(new Response(PAYLOAD)); }),
    service: { apply: async request => { applied.push(request); } },
  });
  await f.service.check();
  const install = f.service.installUpdate();
  while (!release) await tick();
  await assert.rejects(f.service.openDownload(), /уже скачивается/,
    'иначе «Скачать» отчитается о файле в загрузках, которого там нет');
  release();
  await install;
  assert.equal(applied.length, 1);
  assert.deepEqual(f.revealed, []);
});

test('итог провала показывает ровно тот файл, который записала служба применения', async t => {
  const f = await fixture(t);
  const installer = path.join(f.staging, 'Codex-Desk-Setup-0.3.0.exe');
  await assert.rejects(f.service.revealOutcomeFile(), /недоступен/, 'без итога показывать нечего');
  f.service.setOutcome({ state: 'applied', version: '0.3.0.7' });
  await assert.rejects(f.service.revealOutcomeFile(), /недоступен/, 'у успеха файла уже нет');
  f.service.setOutcome({ state: 'failed', version: '0.3.0.7', reason: 'timeout', installerPath: installer });
  await f.service.revealOutcomeFile();
  assert.deepEqual(f.revealed, [installer], 'renderer путь не передаёт — он берётся из итога');
  f.service.acknowledgeOutcome();
  await assert.rejects(f.service.revealOutcomeFile(), /недоступен/);
});

test('без тихой установки остаётся только скачивание', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).canApply, false);
  await f.service.check();
  assert.throws(() => f.service.installUpdate(), /Автоматическая установка недоступна/);
});

test('ход скачивания сообщается с ограничением частоты', async t => {
  const chunks = [PAYLOAD.subarray(0, 8), PAYLOAD.subarray(8, 16), PAYLOAD.subarray(16)];
  let clock = Date.parse('2026-10-15T12:00:00Z');
  const f = await fixture(t, {
    portalFetch: async url => url === UPDATE_CATALOG ? Response.json(card()) : new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); },
    })),
    // Время идёт быстрее порога, поэтому каждый кадр даёт событие хода.
    service: { now: () => (clock += 250) },
  });
  await f.service.check();
  await f.service.openDownload();
  const reported = f.events.filter(event => event.progress).map(event => event.progress.received);
  assert.deepEqual(reported[0], 0, 'ход показывается сразу, ещё до первого кадра');
  assert.deepEqual(reported.at(-1), PAYLOAD.length);
  assert.deepEqual(reported, [...reported].sort((a, b) => a - b), 'значения только растут');
  assert.equal(f.events.at(-1).progress, undefined, 'после завершения полоса убирается');
  assert.equal(f.events.at(-1).phase, 'available');
  for (const event of f.events) if (event.progress) assert.equal(event.progress.total, PAYLOAD.length);
});

test('corrupted or unauthorised downloads keep the offer and leave no files', async t => {
  for (const [file, pattern] of [
    [() => new Response(Buffer.from('tampered')), /не совпадает/],
    [() => new Response(Buffer.concat([PAYLOAD, Buffer.from('x')])), /не совпадает/],
    [() => new Response('', { status: 401 }), /Сессия Portal истекла/],
    [() => new Response('', { status: 404 }), /Установщик недоступен/],
  ]) {
    const f = await fixture(t, { portalFetch: async url => url === UPDATE_CATALOG ? Response.json(card()) : file() });
    await f.service.check();
    await assert.rejects(f.service.openDownload(), pattern);
    assert.equal((await f.service.status()).phase, 'available', 'the offer survives a failed download');
    assert.equal((await f.service.status()).downloadedPath, undefined);
    assert.deepEqual(await readdir(f.downloads).catch(() => []), [], 'failed downloads leave nothing behind');
    assert.deepEqual(f.revealed, []);
  }
});

test('overlapping checks coalesce; opt out and shutdown cancel stale results', async t => {
  let resolveFetch, count = 0;
  const f = await fixture(t, { portalFetch: () => { count++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const first = f.service.check();
  while (!resolveFetch) await tick();
  const second = f.service.check();
  await f.service.setPreferences({ enabled: false });
  resolveFetch(Response.json(card()));
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal((await f.service.status()).phase, 'idle');
  assert.equal(f.events.some(event => event.phase === 'available'), false);
  await assert.rejects(f.service.openDownload());
  const third = f.service.check();
  while (count < 2) await tick();
  const closing = f.service.close();
  resolveFetch(Response.json(card()));
  await Promise.all([third, closing]);
  assert.equal(f.events.some(event => event.phase === 'available'), false);
});

test('timeout surfaces an error and a failed store cannot hide preferences loss', async t => {
  const f = await fixture(t, { portalFetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
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
