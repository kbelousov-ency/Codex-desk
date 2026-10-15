import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogVersion } from './app-updates.mjs';

// Применение скачанного обновления Release: предложение закрыться, ожидание
// занятых вкладок, снимок рабочего места и тихий запуск установщика.
// Установщик сам дожидается выхода процесса и запускает новую версию обратно;
// договорённость о переменных окружения — docs/agent-reports/self-update-contract.md.
const POLL_INTERVAL = 1000;
const MAX_MARKER_BYTES = 8192;
const MAX_LOG_BYTES = 4096;
// Разбор версии берётся из каталога обновлений: одна грамматика X.Y.Z[.сборка]
// на оба модуля, иначе правки контракта расходятся.
const SHA256_RE = /^[0-9a-f]{64}$/;
const buildNumber = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const RESULTS = new Set(['ok', 'timeout', 'error']);

function fail(message) {
  return new Error(message || 'Установка обновления сейчас недоступна.');
}

function inside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

/**
 * @param executable полный путь работающего exe; установщик сверяет процесс по нему.
 * @param stagingDirectory служебная папка со скачанным установщиком; она же cwd
 *        дочернего процесса — рабочий каталог не должен лежать внутри заменяемой папки.
 * @param prepare сохраняет снимок рабочего места и замораживает интерфейс (main.mjs).
 */
export function createSelfUpdate({ executable, userData, stagingDirectory, currentVersion, currentBuildNumber = null,
  getBusy, prepare, quit, notify = () => {}, spawn = nodeSpawn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (![executable, userData, stagingDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))
    || catalogVersion(currentVersion)?.buildNumber !== null
    || (currentBuildNumber !== null && buildNumber(currentBuildNumber) === null)
    || [getBusy, prepare, quit].some(value => typeof value !== 'function')) throw fail();
  const marker = path.join(userData, 'pending-update.json');
  const logFile = path.join(stagingDirectory, 'install.log');
  let pending = null;
  let closed = false;
  let quitScheduled = false;
  let generation = 0;
  let poll = null;
  // Шаги выстроены в цепочку: решение пользователя и срабатывание таймера
  // ожидания не должны накладываться друг на друга.
  let task = Promise.resolve();

  function publish(state) {
    try { notify(state); } catch { /* Диагностика интерфейса не должна ломать обновление. */ }
  }

  function busy() {
    try { return Boolean(getBusy()); } catch { return true; }
  }

  function stopPoll() {
    clearTimer(poll);
    poll = null;
  }

  function reset(message) {
    stopPoll();
    generation += 1;
    pending = null;
    quitScheduled = false;
    publish('error');
    return message;
  }

  function step() {
    task = task.then(advance, () => {});
    return task;
  }

  function schedulePoll() {
    stopPoll();
    poll = setTimer(() => { poll = null; step(); }, POLL_INTERVAL);
    poll?.unref?.();
  }

  async function writeMarker() {
    const body = JSON.stringify({ format: 1, version: pending.version, previousVersion: currentVersion,
      previousBuildNumber: currentBuildNumber, installerPath: pending.installerPath, log: logFile,
      startedAt: new Date(now()).toISOString() });
    const temporary = `${marker}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, marker);
  }

  async function launch() {
    await unlink(logFile).catch(() => {});
    const child = spawn(pending.installerPath, ['/S'], {
      cwd: stagingDirectory, detached: true, stdio: 'ignore', windowsHide: false,
      env: { ...process.env, CODEX_DESK_UPDATE_PID: String(process.pid),
        CODEX_DESK_UPDATE_EXE: executable, CODEX_DESK_UPDATE_LOG: logFile },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    // Маркер пишется только после фактического запуска: иначе не начавшееся
    // обновление выглядело бы провалившимся при следующем запуске. Сбой записи
    // саму установку не отменяет — она уже идёт, неизвестен останется её итог.
    try { await writeMarker(); } catch { /* итог прошлой попытки будет неизвестен */ }
  }

  /** Один шаг: занято — ждём дальше, свободно — готовим снимок и запускаем установщик. */
  async function advance() {
    if (closed || quitScheduled || !pending || pending.state === 'manual') return;
    if (busy()) {
      if (pending.state !== 'waiting') { pending.state = 'waiting'; publish('waiting'); }
      schedulePoll();
      return;
    }
    const current = ++generation;
    pending.state = 'preparing';
    publish('preparing');
    let prepared;
    try { prepared = await prepare({ requestId: pending.requestId }); }
    catch { reset(); return; }
    if (closed || current !== generation || !pending) return;
    // Снимок не удался или вкладки снова заняты — возвращаемся к ожиданию,
    // интерфейс при этом размораживает сам main.mjs по состоянию error/waiting.
    if (!prepared || busy()) { pending.state = 'waiting'; publish('waiting'); schedulePoll(); return; }
    pending.state = 'ready';
    publish('ready');
    try { await launch(); }
    catch { reset(); return; }
    if (closed || current !== generation || !pending) return;
    quitScheduled = true;
    stopPoll();
    try { quit(); } catch { quitScheduled = false; reset(); }
  }

  return {
    getState: () => pending?.state ?? (busy() ? 'busy' : 'ready'),
    /** Предлагает применить уже скачанный и сверенный установщик. */
    async offer({ installerPath, version, sha256 }) {
      if (closed || quitScheduled) throw fail();
      if (typeof installerPath !== 'string' || !path.isAbsolute(installerPath) || !inside(stagingDirectory, installerPath)
        || catalogVersion(version) === null
        || (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)))) throw fail();
      const stat = await lstat(installerPath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw fail('Скачанный установщик не найден.');
      generation += 1;
      stopPoll();
      pending = { installerPath, version, state: 'awaiting', requestId: `self-update-${now()}` };
      publish('awaiting');
      return { state: pending.state };
    },
    /** «Закрыть» — применить сейчас; «Отмена» — применить, когда закроют вручную. */
    decide(decision) {
      if (closed || quitScheduled || !pending || !['close', 'later'].includes(decision)) throw fail();
      if (decision === 'later') {
        stopPoll();
        generation += 1;
        pending.state = 'manual';
        publish('manual');
      } else {
        pending.state = 'waiting';
        publish('waiting');
        step();
      }
      return { state: pending.state };
    },
    /** Для проверок: дождаться текущего шага без обращения к таймерам. */
    settled: () => task,
    /**
     * Выход пользователя после «Отмена»: установщик запускается уже на закрытии,
     * снимок рабочего места к этому моменту делает обычный путь завершения.
     */
    async applyOnExit() {
      if (closed || quitScheduled || pending?.state !== 'manual') return false;
      quitScheduled = true;
      try { await launch(); return true; }
      catch { quitScheduled = false; return false; }
    },
    /**
     * Итог прошлой попытки при запуске. Совпала версия — обновление применилось,
     * следы убираются; не совпала — остаётся ручной путь с понятной причиной.
     */
    async review() {
      let record;
      try {
        const stat = await lstat(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MARKER_BYTES) throw fail();
        record = JSON.parse(await readFile(marker, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        await unlink(marker).catch(() => {});
        return null;
      }
      const offered = typeof record.version === 'string' ? catalogVersion(record.version) : null;
      // Путь установщика проверяется так же строго, как при приёме предложения:
      // маркер переживает перезапуск, и подменённый путь иначе был бы удалён.
      const installerPath = typeof record.installerPath === 'string' && path.isAbsolute(record.installerPath)
        && inside(stagingDirectory, record.installerPath) ? record.installerPath : null;
      if (record?.format !== 1 || !offered || !installerPath) {
        await unlink(marker).catch(() => {});
        return null;
      }
      // Сверять только X.Y.Z нельзя: заливки 0.11.0.46 и 0.11.0.47 неразличимы,
      // и провалившаяся установка выглядела бы успешной. Но и требовать точного
      // совпадения номера сборки нельзя: установщик мог быть собран без него.
      // Надёжный признак — работающая сборка отличается от прежней.
      // Отсутствующий в маркере прежний номер сборки — это «неизвестно», а не
      // «его не было»: иначе старый маркер объявил бы провал успехом.
      const previousBuild = Object.hasOwn(record, 'previousBuildNumber') ? buildNumber(record.previousBuildNumber) : undefined;
      const changed = typeof record.previousVersion === 'string'
        && (record.previousVersion !== currentVersion
          || (previousBuild !== undefined && previousBuild !== currentBuildNumber));
      const applied = offered.base === currentVersion
        && (offered.buildNumber === currentBuildNumber || changed);
      await unlink(marker).catch(() => {});
      if (applied) {
        await unlink(installerPath).catch(() => {});
        await unlink(logFile).catch(() => {});
        return { state: 'applied', version: record.version };
      }
      let result = '';
      try {
        const stat = await lstat(logFile);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_LOG_BYTES) {
          result = (await readFile(logFile, 'utf8')).trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? '';
        }
      } catch { /* Отчёта нет — установщик не дошёл даже до записи. */ }
      const reason = RESULTS.has(result) ? result : 'unknown';
      const installer = await lstat(installerPath).catch(() => null);
      return { state: 'failed', version: record.version, reason,
        installerPath: installer?.isFile() ? installerPath : null };
    },
    async close() {
      closed = true;
      generation += 1;
      stopPoll();
    },
  };
}
