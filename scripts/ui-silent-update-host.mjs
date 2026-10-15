// Live check of the silent self-update protocol in scripts/installer.nsh.
//
// The real macros are compiled by the real NSIS (the compiler electron-builder
// already downloaded) into a throwaway installer whose payload is a stub exe, so
// every branch — the 120 s wait, the report file, the exit codes, the relaunch
// with --updated — runs for real without installing or starting Кузьмич.
// The full Nightly installer is covered separately by scripts/test-installer.ps1.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const checks = [];
const failures = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures.push(name);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The stub plays both roles. A `stay-alive` file next to it means "pretend to be
// the running application until `stop` appears"; otherwise it records how it was
// launched and exits, which is how the relaunch is observed.
const stubSource = `using System;
using System.IO;
using System.Threading;
public static class KuzmichStub {
  public static int Main(string[] args) {
    string home = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    if (File.Exists(Path.Combine(home, "stay-alive"))) {
      while (!File.Exists(Path.Combine(home, "stop"))) Thread.Sleep(100);
      return 0;
    }
    File.WriteAllText(Path.Combine(home, "launched.txt"), Environment.CommandLine + Environment.NewLine);
    return 0;
  }
}
`;

function nsisCompiler() {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
  const root = path.join(cache, 'nsis-3.0.4.1');
  if (!existsSync(root)) return null;
  const inner = spawnSync('cmd', ['/c', 'dir', '/b', root], { encoding: 'utf8' }).stdout
    .split(/\r?\n/).map(line => line.trim()).filter(name => name.startsWith('nsis-3.0.4.1-'))
    .map(name => path.join(root, name, 'makensis.exe')).filter(file => existsSync(file));
  if (!inner.length) return null;
  const plugins = path.join(cache, 'nsis-resources-3.4.1');
  const pluginDir = spawnSync('cmd', ['/c', 'dir', '/b', plugins], { encoding: 'utf8' }).stdout
    .split(/\r?\n/).map(line => line.trim()).filter(name => name.startsWith('nsis-resources-3.4.1-'))
    .map(name => path.join(plugins, name, 'plugins', 'x86-unicode')).filter(dir => existsSync(dir));
  if (!pluginDir.length) return null;
  return { makensis: inner[0], plugins: pluginDir[0] };
}

// Everything the installer include expects from electron-builder's own template.
function harnessScript({ stub, output, templateInclude, plugins, include }) {
  return `Unicode true
RequestExecutionLevel user
Name "Кузьмич Nightly"
Caption "Кузьмич Nightly Setup"
OutFile "${output}"
ShowInstDetails nevershow
AutoCloseWindow true
Page instfiles
!addplugindir /x86-unicode "${plugins}"
!addincludedir "${templateInclude}"
!include LogicLib.nsh
!include FileFunc.nsh
!include StdUtils.nsh

!define PRODUCT_NAME "Кузьмич Nightly"
!define APP_EXECUTABLE_FILENAME "Kuzmich.exe"
!define APP_FILENAME "Kuzmich"
!define SETUP_ARGS ""

; Same definition electron-builder generates for the installer flags.
!macro _isForAllUsers _a _b _t _f
  \${StdUtils.TestParameter} $R9 "allusers"
  StrCmp "$R9" "true" \`\${_t}\` \`\${_f}\`
!macroend
!define isForAllUsers \`"" isForAllUsers ""\`
!macro _isUpdated _a _b _t _f
  \${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" isUpdated ""\`

Var hasPerMachineInstallation
Var hasPerUserInstallation
!macro setInstallModePerUser
!macroend

!include "${include}"

Function .onInit
  ReadEnvStr $INSTDIR "KUZMICH_HARNESS_INSTDIR"
  !insertmacro customInit
FunctionEnd

Section "install"
  !insertmacro customCheckAppRunning
  ReadEnvStr $R0 "KUZMICH_HARNESS_FAIL"
  \${If} $R0 == "1"
    Abort
  \${EndIf}
  SetOutPath $INSTDIR
  File "/oname=Kuzmich.exe" "${stub}"
  !insertmacro customInstall
SectionEnd
`;
}

async function main() {
  const compiler = nsisCompiler();
  if (process.platform !== 'win32' || !compiler) {
    process.stdout.write('Пропуск: нужен Windows и загруженный NSIS из кэша electron-builder.\n');
    return;
  }
  const work = await mkdtemp(path.join(root, 'artifacts', 'silent-update-'));
  const stub = path.join(work, 'stub.exe');
  const fakeDir = path.join(work, 'fake');
  const installDir = path.join(work, 'install');
  const setup = path.join(work, 'Harness-Setup.exe');
  await mkdir(fakeDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  const sourceFile = path.join(work, 'stub.cs');
  await writeFile(sourceFile, stubSource, 'utf8');
  const build = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:STUB_SOURCE -Raw -Encoding UTF8) -OutputAssembly $env:STUB_EXE -OutputType ConsoleApplication"],
  { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: { ...process.env, STUB_SOURCE: sourceFile, STUB_EXE: stub } });
  check('стенд: скомпилирован подставной exe', build.status === 0 && existsSync(stub), build.stderr?.trim().slice(0, 300) ?? '');
  if (!existsSync(stub)) { report(work); return; }

  // The fake "running application" shares the executable name with the real
  // Nightly on purpose: only the full path may decide.
  const fakeExe = path.join(fakeDir, 'Kuzmich.exe');
  await copyFile(stub, fakeExe);
  await writeFile(path.join(fakeDir, 'stay-alive'), '', 'utf8');

  const scriptFile = path.join(work, 'harness.nsi');
  await writeFile(scriptFile, harnessScript({
    stub, output: setup, plugins: compiler.plugins,
    templateInclude: path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include'),
    include: path.join(root, 'scripts', 'installer.nsh'),
  }), 'utf8');
  const compiled = spawnSync(compiler.makensis, ['/V2', scriptFile], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  check('NSIS компилирует настоящие макросы installer.nsh', compiled.status === 0 && existsSync(setup),
    `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`.trim().slice(0, 600));
  if (!existsSync(setup)) { report(work); return; }

  const otherKuzmich = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'Kuzmich.exe'\" | ForEach-Object { $_.ExecutablePath }) -join ';'"],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout?.trim() ?? '';

  const runSetup = (env, args = ['/S']) => new Promise(resolve => {
    const child = spawn(setup, args, { windowsHide: true, detached: false, env: { ...process.env, ...env } });
    const started = Date.now();
    child.once('exit', code => resolve({ code, seconds: (Date.now() - started) / 1000 }));
  });
  const startFake = () => {
    const child = spawn(fakeExe, [], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid;
  };
  const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
  // Ask the stub to leave and make sure it did: clearing the flag too early would
  // leave a stray "running application" in the next scenario.
  const stopFake = async id => {
    await writeFile(path.join(fakeDir, 'stop'), '', 'utf8');
    for (let i = 0; i < 100 && alive(id); i++) await sleep(100);
  };
  const clearStop = async () => { await rm(path.join(fakeDir, 'stop'), { force: true }); };

  // --- 1. the application closes while the installer waits -------------------
  await clearStop();
  let pid = startFake();
  await sleep(1500);
  const log1 = path.join(work, 'report-ok.txt');
  const updateEnv = {
    CODEX_DESK_UPDATE_PID: String(pid), CODEX_DESK_UPDATE_EXE: fakeExe, CODEX_DESK_UPDATE_LOG: log1,
    KUZMICH_HARNESS_INSTDIR: installDir,
  };
  const okRun = runSetup(updateEnv);
  await sleep(8000);
  const installedBeforeExit = existsSync(path.join(installDir, 'Kuzmich.exe'));
  await stopFake(pid);
  const okResult = await okRun;
  check('ждал, пока приложение не закрылось (ничего не ставил раньше)', !installedBeforeExit && okResult.seconds > 8,
    `${okResult.seconds.toFixed(1)} с`);
  check('тихое обновление завершилось кодом 0', okResult.code === 0, `код ${okResult.code}`);
  const okLog = existsSync(log1) ? await readFile(log1, 'utf8') : '';
  check('отчёт содержит единственную строку ok', okLog.trim() === 'ok', JSON.stringify(okLog));
  check('приложение установлено', existsSync(path.join(installDir, 'Kuzmich.exe')));
  let launched = '';
  for (let i = 0; i < 60 && !launched; i++) {
    await sleep(500);
    if (existsSync(path.join(installDir, 'launched.txt'))) launched = readFileSync(path.join(installDir, 'launched.txt'), 'utf8');
  }
  check('установленное приложение запущено с --updated', /--updated/.test(launched), JSON.stringify(launched.trim()));
  check('запущен именно установленный exe', launched.toLowerCase().includes(path.join(installDir, 'Kuzmich.exe').toLowerCase()),
    JSON.stringify(launched.trim()));
  check('одноимённый Kuzmich.exe по другому пути не считается работающим', otherKuzmich.length > 0,
    otherKuzmich || 'во время прогона другого Kuzmich.exe не было — проверка полного пути не подтверждена');

  // --- 2. the application never closes --------------------------------------
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  await clearStop();
  pid = startFake();
  await sleep(1500);
  const log2 = path.join(work, 'report-timeout.txt');
  const timeoutResult = await runSetup({ ...updateEnv, CODEX_DESK_UPDATE_PID: String(pid), CODEX_DESK_UPDATE_LOG: log2 });
  const timeoutLog = existsSync(log2) ? await readFile(log2, 'utf8') : '';
  check('отказ по таймауту не раньше 120 с', timeoutResult.seconds >= 120 && timeoutResult.seconds < 170,
    `${timeoutResult.seconds.toFixed(1)} с`);
  check('отчёт содержит единственную строку timeout', timeoutLog.trim() === 'timeout', JSON.stringify(timeoutLog));
  check('код выхода 2', timeoutResult.code === 2, `код ${timeoutResult.code}`);
  check('установки не было', !existsSync(path.join(installDir, 'Kuzmich.exe')));
  const stillAlive = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'if (Get-Process -Id $env:FAKE_PID -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }'],
  { windowsHide: true, timeout: 60_000, env: { ...process.env, FAKE_PID: String(pid) } }).status === 0;
  check('установщик не завершил приложение принудительно', stillAlive);
  await stopFake(pid);

  // --- 3. /allusers stays refused in the silent update mode -----------------
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  await clearStop();
  const log3 = path.join(work, 'report-allusers.txt');
  const allUsers = await runSetup({ ...updateEnv, CODEX_DESK_UPDATE_LOG: log3 }, ['/S', '/allusers']);
  const allUsersLog = existsSync(log3) ? await readFile(log3, 'utf8') : '';
  check('/allusers отвергнут кодом 2', allUsers.code === 2, `код ${allUsers.code}`);
  check('/allusers отчитался строкой error', allUsersLog.trim() === 'error', JSON.stringify(allUsersLog));
  check('/allusers ничего не поставил', !existsSync(path.join(installDir, 'Kuzmich.exe')));

  // --- 4. a failing installation reports error ------------------------------
  const log4 = path.join(work, 'report-error.txt');
  const failed = await runSetup({ ...updateEnv, CODEX_DESK_UPDATE_LOG: log4, KUZMICH_HARNESS_FAIL: '1' });
  const failedLog = existsSync(log4) ? await readFile(log4, 'utf8') : '';
  check('сбой установки отчитался строкой error', failedLog.trim() === 'error', JSON.stringify(failedLog));
  check('сбой установки дал ненулевой код', failed.code !== 0, `код ${failed.code}`);

  // --- 5. a plain silent install is unchanged -------------------------------
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  const log5 = path.join(work, 'report-plain.txt');
  const plain = await runSetup({ KUZMICH_HARNESS_INSTDIR: installDir, CODEX_DESK_UPDATE_LOG: log5 });
  check('обычная тихая установка без PID: код 0', plain.code === 0, `код ${plain.code}`);
  check('обычная тихая установка ничего не писала в отчёт', !existsSync(log5));
  await sleep(2000);
  check('обычная тихая установка не перезапускает приложение', !existsSync(path.join(installDir, 'launched.txt')));
  check('обычная тихая установка поставила файлы', existsSync(path.join(installDir, 'Kuzmich.exe')));

  report(work);
}

function report(work) {
  process.stdout.write(`\nПроверок: ${checks.length}, не прошло: ${failures.length}\nАртефакты: ${work}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => { process.stdout.write(`Сбой сценария: ${error.stack}\n`); process.exitCode = 1; });
