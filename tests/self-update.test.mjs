import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSelfUpdate } from '../electron/self-update.mjs';

const exists = async target => Boolean(await stat(target).catch(() => null));

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'self-update-'));
  const userData = path.join(root, 'profile');
  const staging = path.join(userData, 'updates');
  await mkdir(staging, { recursive: true });
  const installer = path.join(staging, 'Codex-Desk-Setup-0.12.0.exe');
  await writeFile(installer, 'setup');
  return { root, userData, staging, installer, executable: path.join(root, 'app', 'Codex Desk.exe') };
}

/** Подставной spawn: запоминает вызов и сообщает об успешном старте процесса. */
function recorder({ fail = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', fail ? new Error('нет доступа') : undefined));
    return child;
  };
  return { calls, spawn };
}

function harness(place, overrides = {}) {
  const published = [];
  const timers = [];
  const quits = [];
  const prepared = [];
  const { calls, spawn } = overrides.recorder ?? recorder();
  const service = createSelfUpdate({
    executable: place.executable, userData: place.userData, stagingDirectory: place.staging,
    currentVersion: '0.11.0', currentBuildNumber: 46,
    getBusy: () => false, prepare: request => { prepared.push(request); return true; },
    quit: () => quits.push(Date.now()), notify: state => published.push(state), spawn,
    setTimer: fn => { timers.push(fn); return { unref() {} }; }, clearTimer: () => {},
    ...overrides,
  });
  return { service, published, timers, quits, prepared, calls };
}

test('принятое предложение сохраняет снимок, запускает установщик молча и закрывает приложение', async () => {
  const place = await workspace();
  const { service, published, quits, prepared, calls } = harness(place);
  assert.deepEqual(await service.offer({ installerPath: place.installer, version: '0.12.0.7' }), { state: 'awaiting' });
  service.decide('close');
  await service.settled();

  assert.deepEqual(published, ['awaiting', 'waiting', 'preparing', 'ready']);
  assert.equal(prepared.length, 1);
  assert.equal(quits.length, 1);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, place.installer);
  assert.deepEqual(call.args, ['/S']);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.cwd, place.staging);
  // Протокол стыка: пути и PID передаются окружением, а не командной строкой.
  assert.equal(call.options.env.CODEX_DESK_UPDATE_PID, String(process.pid));
  assert.equal(call.options.env.CODEX_DESK_UPDATE_EXE, place.executable);
  assert.equal(call.options.env.CODEX_DESK_UPDATE_LOG, path.join(place.staging, 'install.log'));

  const marker = JSON.parse(await readFile(path.join(place.userData, 'pending-update.json'), 'utf8'));
  assert.equal(marker.version, '0.12.0.7');
  assert.equal(marker.previousVersion, '0.11.0');
  assert.equal(marker.previousBuildNumber, 46);
  assert.equal(marker.installerPath, place.installer);
  await rm(place.root, { recursive: true, force: true });
});

test('занятые вкладки держат ожидание, установщик стартует только после освобождения', async () => {
  const place = await workspace();
  let busy = true;
  const { service, published, timers, quits, calls } = harness(place, { getBusy: () => busy });
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  service.decide('close');
  await service.settled();
  assert.deepEqual(published, ['awaiting', 'waiting']);
  assert.equal(calls.length, 0, 'занятое приложение не закрывается');
  assert.equal(quits.length, 0);

  timers.pop()();
  await service.settled();
  assert.equal(calls.length, 0, 'повторная проверка занятости ничего не меняет');

  busy = false;
  timers.pop()();
  await service.settled();
  assert.equal(calls.length, 1);
  assert.equal(quits.length, 1);
  // Повторная проверка занятости намеренно не шлёт событие заново: плашка не мигает.
  assert.deepEqual(published, ['awaiting', 'waiting', 'preparing', 'ready']);
  await rm(place.root, { recursive: true, force: true });
});

test('«Отмена» откладывает применение до обычного выхода пользователя', async () => {
  const place = await workspace();
  const { service, published, quits, calls } = harness(place);
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  service.decide('later');
  await service.settled();
  assert.deepEqual(published, ['awaiting', 'manual']);
  assert.equal(calls.length, 0);
  assert.equal(quits.length, 0, 'отложенное обновление не закрывает приложение само');

  assert.equal(await service.applyOnExit(), true);
  assert.equal(calls.length, 1);
  assert.equal(await exists(path.join(place.userData, 'pending-update.json')), true);
  await rm(place.root, { recursive: true, force: true });
});

test('без предложения и после применения выход ничего не запускает', async () => {
  const place = await workspace();
  const { service, calls } = harness(place);
  assert.equal(await service.applyOnExit(), false);
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  assert.equal(await service.applyOnExit(), false, 'предложение без решения пользователя не применяется');
  assert.equal(calls.length, 0);
  await rm(place.root, { recursive: true, force: true });
});

test('снимок не сохранился — возврат к ожиданию без запуска установщика', async () => {
  const place = await workspace();
  const { service, published, timers, quits, calls } = harness(place, { prepare: () => false });
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  service.decide('close');
  await service.settled();
  assert.deepEqual(published, ['awaiting', 'waiting', 'preparing', 'waiting']);
  assert.equal(calls.length, 0);
  assert.equal(quits.length, 0);
  assert.equal(timers.length, 1, 'ожидание продолжается');
  assert.equal(await exists(path.join(place.userData, 'pending-update.json')), false);
  await rm(place.root, { recursive: true, force: true });
});

test('сорвавшийся запуск установщика не закрывает приложение', async () => {
  const place = await workspace();
  const { service, published, quits, calls } = harness(place, { recorder: recorder({ fail: true }) });
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  service.decide('close');
  await service.settled();
  assert.deepEqual(published, ['awaiting', 'waiting', 'preparing', 'ready', 'error']);
  assert.equal(calls.length, 1);
  assert.equal(quits.length, 0, 'приложение продолжает работать');
  assert.equal(await exists(path.join(place.userData, 'pending-update.json')), false,
    'не начавшееся обновление не оставляет маркер, иначе покажется провалившимся');
  await rm(place.root, { recursive: true, force: true });
});

test('маркер с путём вне служебной папки не удаляет чужой файл', async () => {
  const place = await workspace();
  const outsider = path.join(place.root, 'важный.txt');
  await writeFile(outsider, 'данные');
  await writeFile(path.join(place.userData, 'pending-update.json'), JSON.stringify({
    format: 1, version: '0.11.0', previousVersion: '0.11.0', installerPath: outsider,
  }));
  const { service } = harness(place);
  assert.equal(await service.review(), null, 'подменённый маркер отбрасывается');
  assert.equal(await exists(outsider), true, 'чужой файл остаётся на месте');
  assert.equal(await exists(path.join(place.userData, 'pending-update.json')), false);
  await rm(place.root, { recursive: true, force: true });
});

test('смена сборки внутри одной X.Y.Z признаётся применённой', async () => {
  const place = await workspace();
  await writeFile(path.join(place.userData, 'pending-update.json'), JSON.stringify({
    format: 1, version: '0.11.0.47', previousVersion: '0.11.0', previousBuildNumber: 46, installerPath: place.installer,
  }));
  const { service } = harness(place, { currentVersion: '0.11.0', currentBuildNumber: 47 });
  assert.deepEqual(await service.review(), { state: 'applied', version: '0.11.0.47' });
  await rm(place.root, { recursive: true, force: true });
});

test('установщик без номера сборки не объявляется провалом после успеха', async () => {
  const place = await workspace();
  await writeFile(path.join(place.userData, 'pending-update.json'), JSON.stringify({
    format: 1, version: '0.12.0.48', previousVersion: '0.11.0', previousBuildNumber: 46, installerPath: place.installer,
  }));
  // Сборка установщика без BUILD_NUMBER: номера у работающей версии нет.
  const { service } = harness(place, { currentVersion: '0.12.0', currentBuildNumber: null });
  assert.deepEqual(await service.review(), { state: 'applied', version: '0.12.0.48' });
  await rm(place.root, { recursive: true, force: true });
});

test('предложение принимает только проверенный файл из служебной папки', async () => {
  const place = await workspace();
  const { service } = harness(place);
  const outside = path.join(place.root, 'Codex-Desk-Setup-0.12.0.exe');
  await writeFile(outside, 'setup');
  await assert.rejects(() => service.offer({ installerPath: outside, version: '0.12.0' }));
  await assert.rejects(() => service.offer({ installerPath: path.join(place.staging, 'missing.exe'), version: '0.12.0' }));
  await assert.rejects(() => service.offer({ installerPath: place.installer, version: 'latest' }));
  await assert.rejects(() => service.offer({ installerPath: place.installer, version: '0.12.0', sha256: 'нет' }));
  await assert.rejects(() => service.offer({ installerPath: 'updates/setup.exe', version: '0.12.0' }));
  await rm(place.root, { recursive: true, force: true });
});

test('после перезапуска совпавшая версия признаётся применённой и убирает следы', async () => {
  const place = await workspace();
  await writeFile(path.join(place.userData, 'pending-update.json'), JSON.stringify({
    format: 1, version: '0.12.0.7', previousVersion: '0.11.0', installerPath: place.installer,
  }));
  const { service } = harness(place, { currentVersion: '0.12.0', currentBuildNumber: 7 });
  // Следы прежней неудачной попытки тоже убираются: иначе в профиле копятся
  // установщики по сотне мегабайт.
  const stale = path.join(place.staging, 'Codex-Desk-Setup-0.11.9.exe');
  await writeFile(stale, 'старый');
  await writeFile(path.join(place.staging, 'install.log'), 'ok\n');
  assert.deepEqual(await service.review(), { state: 'applied', version: '0.12.0.7' });
  assert.equal(await exists(path.join(place.userData, 'pending-update.json')), false);
  assert.equal(await exists(place.installer), false, 'скачанный установщик удалён');
  assert.equal(await exists(stale), false, 'прежние установщики удалены');
  assert.equal(await exists(path.join(place.staging, 'install.log')), false, 'отчёт установщика удалён');
  assert.equal(await service.review(), null, 'повторный запуск ничего не показывает');
  await rm(place.root, { recursive: true, force: true });
});

test('совпадение X.Y.Z при другом номере сборки — это провал, а не успех', async () => {
  const place = await workspace();
  await writeFile(path.join(place.userData, 'pending-update.json'), JSON.stringify({
    format: 1, version: '0.11.0.47', previousVersion: '0.11.0', installerPath: place.installer,
  }));
  const { service } = harness(place, { currentVersion: '0.11.0', currentBuildNumber: 46 });
  const outcome = await service.review();
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.version, '0.11.0.47');
  assert.equal(outcome.installerPath, place.installer, 'ручной путь остаётся');
  await rm(place.root, { recursive: true, force: true });
});

test('отчёт установщика объясняет причину неудачи и переживает его отсутствие', async () => {
  const place = await workspace();
  const marker = path.join(place.userData, 'pending-update.json');
  const record = JSON.stringify({ format: 1, version: '0.12.0.7', previousVersion: '0.11.0', installerPath: place.installer });
  await writeFile(marker, record);
  await writeFile(path.join(place.staging, 'install.log'), 'timeout\r\n');
  const { service } = harness(place);
  assert.equal((await service.review()).reason, 'timeout');

  await writeFile(marker, record);
  await writeFile(path.join(place.staging, 'install.log'), 'что-то своё');
  assert.equal((await service.review()).reason, 'unknown');

  await writeFile(marker, record);
  await rm(path.join(place.staging, 'install.log'));
  assert.equal((await service.review()).reason, 'unknown');

  await writeFile(marker, '{ не json');
  assert.equal(await service.review(), null);
  assert.equal(await exists(marker), false, 'повреждённый маркер убирается');
  await rm(place.root, { recursive: true, force: true });
});

test('закрытое приложение больше не применяет обновление', async () => {
  const place = await workspace();
  const { service, calls } = harness(place);
  await service.offer({ installerPath: place.installer, version: '0.12.0.7' });
  await service.close();
  assert.throws(() => service.decide('close'));
  assert.equal(await service.applyOnExit(), false);
  assert.equal(calls.length, 0);
  await rm(place.root, { recursive: true, force: true });
});
