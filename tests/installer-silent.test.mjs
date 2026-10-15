import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Контракт тихого самообновления: docs/agent-reports/self-update-contract.md.
// Живой прогон макросов — scripts/ui-silent-update-host.mjs (настоящий NSIS и
// подставное приложение) и scripts/test-installer.ps1 -SilentUpdate (настоящий
// установщик Nightly). Здесь — исходный текст и поведение самой проверки процесса.
const root = process.cwd();
const source = await readFile(path.join(root, 'scripts', 'installer.nsh'), 'utf8');
// Инструкции без комментариев: в комментариях слова вроде taskkill объясняют запрет.
const code = source.split(/\r?\n/).map(line => line.replace(/^\s*;.*$/, '')).join('\n');

test('тихое обновление: режим включают только /S и переменная с pid', () => {
  assert.match(source, /ReadEnvStr \$\{_MODE\} "CODEX_DESK_UPDATE_PID"/);
  assert.match(source, /ReadEnvStr \$\{_EXE\} "CODEX_DESK_UPDATE_EXE"/);
  assert.match(source, /ReadEnvStr \$\{_LOG\} "CODEX_DESK_UPDATE_LOG"/);
  // Чтение переменных обёрнуто в ${If} ${Silent}: обычный мастер режим не включает.
  const block = source.match(/!macro deskUpdateEnv[\s\S]*?!macroend/)[0];
  assert.match(block, /\$\{If\} \$\{Silent\}[\s\S]*CODEX_DESK_UPDATE_PID/);
  assert.match(block, /\$\{If\} \$\{_MODE\} == ""\s+StrCpy \$\{_MODE\} "0"/);
  // Переменные протокола установщик только читает.
  assert.equal(/SetEnvironmentVariableW\(w "CODEX_DESK_UPDATE/.test(source), false);
  // Путь для проверки процесса по-прежнему едет в отдельной переменной.
  assert.match(source, /SetEnvironmentVariableW\(w "CODEX_DESK_INSTALL_TARGET", w "\$\{_TARGET\}"\)/);
});

test('тихое обновление: ждём 120 секунд и никогда не завершаем приложение', () => {
  assert.match(source, /!define DESK_UPDATE_WAIT_MS 120000/);
  assert.match(source, /\$\{If\} \$2 >= \$\{DESK_UPDATE_WAIT_MS\}/);
  assert.match(source, /Sleep \$\{DESK_UPDATE_POLL_MS\}/);
  for (const forbidden of [/taskkill/i, /Stop-Process/i, /KILL_PROCESS/, /nsProcess::/, /TerminateProcess/]) {
    assert.equal(forbidden.test(code), false, `установщик не должен уметь ${forbidden}`);
  }
});

test('тихое обновление: три строки отчёта и обещанные коды выхода', () => {
  const reports = [...source.matchAll(/!insertmacro deskUpdateReport "([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(reports)].sort(), ['error', 'ok', 'timeout']);
  assert.match(source, /FileWrite \$R8 "\$\{_TEXT\}\$\\r\$\\n"/);
  assert.match(source, /FileWrite \$R8 "error\$\\r\$\\n"/); // .onInstFailed без LogicLib
  // Отказ — 2, прочий сбой — 3, успех — обычный 0 без SetErrorLevel.
  const waiting = source.match(/!macro customCheckAppRunning[\s\S]*?!macroend/)[0];
  assert.match(waiting, /deskUpdateReport "timeout"\s+SetErrorLevel 2/);
  assert.match(waiting, /deskUpdateReport "error"\s+SetErrorLevel 3/);
  assert.equal((waiting.match(/\bQuit\b/g) ?? []).length, 2);
});

test('тихое обновление: успех отчитывается и возвращает приложение с --updated', () => {
  const install = source.match(/!macro customInstall\r?\n[\s\S]*?!macroend/)[0];
  assert.match(install, /\$\{If\} \$0 == "1"/);
  assert.match(install, /!insertmacro deskUpdateReport "ok"/);
  assert.match(install, /StrCpy \$1 "\$\{SETUP_ARGS\} --updated"/);
  assert.match(install, /\$\{StdUtils\.ExecShellAsUser\} \$0 "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "open" "\$1"/);
  // Отчёт пишется до запуска: приложение должно узнать результат даже если старт не удался.
  assert.ok(install.indexOf('deskUpdateReport "ok"') < install.indexOf('ExecShellAsUser'));
});

test('тихое обновление: правила установки для текущего пользователя сохранены', () => {
  const currentUser = source.match(/!macro deskCurrentUser[\s\S]*?!macroend/)[0];
  assert.match(currentUser, /\$\{If\} \$\{isForAllUsers\}/);
  assert.match(currentUser, /SetErrorLevel 2\s+Quit/);
  assert.match(currentUser, /!insertmacro deskUpdateReport "error"/);
  assert.match(currentUser, /Кузьмич устанавливается только для текущего пользователя/);
  assert.match(source, /!insertmacro setInstallModePerUser/);
  // Мастер и финальная страница не изменились.
  assert.match(source, /MUI_FINISHPAGE_RUN_FUNCTION "DeskStartApp"/);
  assert.match(source, /Закройте Кузьмича и повторите действие\. Приложение не будет закрыто автоматически\./);
});

test('тихое обновление: деинсталлятор остаётся прежним', () => {
  const waiting = source.match(/!macro customCheckAppRunning[\s\S]*?!macroend/)[0];
  assert.match(waiting, /!ifdef BUILD_UNINSTALLER\s+StrCpy \$3 "0"/);
  assert.match(source, /!ifndef BUILD_UNINSTALLER\s+; A failed silent self-update/);
});

// Проверка процесса идёт по ПОЛНОМУ пути: Release и Nightly называются одинаково.
// Берём настоящую команду из installer.nsh и выполняем её так же, как nsExec.
function processProbe() {
  const line = source.match(/nsExec::ExecToStack \/TIMEOUT=30000 `[^`]*-Command "([^"]+)"`/);
  assert.ok(line, 'не нашли команду проверки процесса');
  return line[1].replace(/\$\$/g, '$');
}

function probe(target) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processProbe()],
    { windowsHide: true, timeout: 120_000, env: { ...process.env, CODEX_DESK_INSTALL_TARGET: target } }).status;
}

test('проверка процесса различает одинаковые имена по разным путям', { skip: process.platform !== 'win32' }, async context => {
  // Своя копия с уникальным именем: по имени node.exe в системе ходят чужие
  // процессы, у которых не читается путь, и проверка честно отвечает «не знаю».
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-installer-silent-'));
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');
  await mkdir(first);
  await mkdir(second);
  const application = path.join(first, 'Kuzmich-probe.exe');
  await copyFile(process.execPath, application);
  const running = spawn(application, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
  const finished = new Promise(resolve => running.once('exit', resolve));
  // Windows освобождает файл образа не мгновенно после выхода процесса: без
  // повторов уборка изредка падает с EBUSY и роняет весь набор.
  context.after(async () => { running.kill(); await finished; await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(probe(application), 1);
  // Тот же файл по другому пути — не считается работающим: Release и Nightly
  // называются одинаково, различить их может только полный путь.
  assert.equal(probe(path.join(second, 'Kuzmich-probe.exe')), 0);
  assert.equal(probe(path.join(temporary, 'codex-desk-no-such-application.exe')), 0);
});
