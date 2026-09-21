import { spawn } from 'node:child_process';
import path from 'node:path';

const accessModes = new Set(['inherited', 'auto', 'read-only', 'workspace-write', 'danger-full-access']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Некорректный ${label}.`);
  }
  return value;
}

function absolutePath(value, label) {
  text(value, label, 8192);
  if (!path.win32.isAbsolute(value) || /["<>|?*]/.test(value)) throw new Error(`Нужен абсолютный ${label}.`);
  return value;
}

function literal(value) {
  // PowerShell single-quoted strings never evaluate $, backticks, or command substitutions.
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build a native interactive resume invocation without adding a prompt or modifying config. */
export function buildTerminalLaunch(options, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  if (!options || typeof options !== 'object') throw new Error('Нет параметров терминала.');
  const executable = absolutePath(options.executable, 'путь к Codex');
  if (path.win32.extname(executable).toLowerCase() !== '.exe') throw new Error('Нужен исполняемый файл Codex .exe.');
  const cwd = absolutePath(options.cwd, 'путь к папке');
  const claude = options.provider === 'claude';
  const threadId = text(claude ? options.threadId?.replace(/^claude:/, '') : options.threadId, 'идентификатор диалога', 36);
  if (!uuid.test(threadId)) throw new Error('Некорректный идентификатор диалога.');
  const access = options.access ?? 'inherited';
  if (!accessModes.has(access)) throw new Error('Неизвестный режим доступа.');
  const codexArgs = claude ? ['--resume', threadId] : ['resume', threadId, '--cd', cwd];
  if (options.model) {
    const model = text(options.model, 'идентификатор модели', 256);
    if (!(claude ? /^[a-zA-Z0-9][a-zA-Z0-9._/:+\[\]\-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]*$/).test(model)) throw new Error('Некорректный идентификатор модели.');
    codexArgs.push('--model', model);
  }
  if (options.effort) {
    const effort = text(options.effort, 'уровень рассуждений', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(effort)) throw new Error('Некорректный уровень рассуждений.');
    // Codex accepts an unquoted enum as a literal TOML fallback. This avoids the
    // native Windows PowerShell 5.1 argument binder stripping embedded quotes.
    if (claude) codexArgs.push('--effort', effort);
    else codexArgs.push('-c', `model_reasoning_effort=${effort}`);
  }
  if (access !== 'inherited') {
    if (claude) {
      codexArgs.push('--permission-mode', access === 'danger-full-access' ? 'bypassPermissions' : access === 'auto' ? 'acceptEdits' : access === 'read-only' ? 'plan' : 'manual');
      if (access === 'danger-full-access') codexArgs.push('--allow-dangerously-skip-permissions');
    } else {
      codexArgs.push('--sandbox', access === 'auto' ? 'workspace-write' : access);
      codexArgs.push('--ask-for-approval', access === 'danger-full-access' ? 'never' : 'on-request');
      codexArgs.push('-c', `approvals_reviewer=${access === 'auto' ? 'auto_review' : 'user'}`);
    }
  }
  if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env))) throw new Error('Некорректное окружение терминала.');
  return buildInteractiveLaunch({ executable, cwd, codexArgs, provider: options.provider, env: options.env }, systemRoot);
}

/** Visible console for `claude setup-token`; the CLI prints the long-lived token for the user to copy. */
export function buildClaudeSetupTokenLaunch(options, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const executable = absolutePath(options?.executable, 'путь к Claude Code');
  if (path.win32.extname(executable).toLowerCase() !== '.exe') throw new Error('Нужен исполняемый файл Claude Code .exe.');
  const cwd = absolutePath(options?.cwd, 'путь к папке');
  return buildInteractiveLaunch({ executable, cwd, codexArgs: ['setup-token'], provider: 'claude', env: options.env }, systemRoot);
}

/** Use the installed CLI's own browser login, with inherited environment and no prompts. */
export function buildClaudeAuthLaunch(options, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const executable = absolutePath(options?.executable, 'путь к Claude Code');
  if (path.win32.extname(executable).toLowerCase() !== '.exe') throw new Error('Нужен исполняемый файл Claude Code .exe.');
  const cwd = absolutePath(options?.cwd, 'путь к папке');
  return buildInteractiveLaunch({ executable, cwd, codexArgs: ['auth', 'login', '--claudeai'], provider: 'claude', env: options.env }, systemRoot);
}

export function buildCodexAuthLaunch(options, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const executable = absolutePath(options?.executable, 'путь к Codex');
  if (path.win32.extname(executable).toLowerCase() !== '.exe') throw new Error('Нужен исполняемый файл Codex .exe.');
  const cwd = absolutePath(options?.cwd, 'путь к папке');
  return buildInteractiveLaunch({ executable, cwd, codexArgs: ['login'], provider: 'codex', env: options.env }, systemRoot);
}

function buildInteractiveLaunch({ executable, cwd, codexArgs, provider, env }, systemRoot) {
  const cliName = provider === 'claude' ? 'Claude Code' : 'Codex';
  const script = `$ErrorActionPreference = 'Stop'
$codexExitCode = 1
try {
  $codexExecutable = ${literal(executable)}
  $codexArguments = @(${codexArgs.map(literal).join(', ')})
  Set-Location -LiteralPath ${literal(cwd)}
  & $codexExecutable @codexArguments
  $codexExitCode = $LASTEXITCODE
  if ($null -eq $codexExitCode) { $codexExitCode = 1 }
  if ($codexExitCode -ne 0) {
    [Console]::WriteLine('${cliName} завершился с кодом ' + $codexExitCode + '.')
    [Console]::WriteLine('Нажмите Enter, чтобы закрыть терминал.')
    [void][Console]::ReadLine()
  }
} catch {
  [Console]::WriteLine('Не удалось запустить ${cliName}: ' + $_.Exception.Message)
  [Console]::WriteLine('Нажмите Enter, чтобы закрыть терминал.')
  [void][Console]::ReadLine()
}
exit $codexExitCode`;
  const powershell = path.win32.join(absolutePath(systemRoot, 'путь к Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  // Start-Process creates a genuine interactive console with console stdin/stdout.
  // A direct detached Node child with ignored stdio inherits NUL handles instead.
  // The hidden helper waits for the visible terminal, so close represents its lifetime.
  const helperScript = `$ErrorActionPreference = 'Stop'
try {
  $codexTerminal = Start-Process -FilePath ${literal(powershell)} -WorkingDirectory ${literal(cwd)} -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', '${encodedScript}') -WindowStyle Normal -PassThru
  $codexTerminal.WaitForExit()
  exit $codexTerminal.ExitCode
} catch { exit 1 }`;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(helperScript, 'utf16le').toString('base64')];
  // Windows CreateProcess has a 32767-character command-line limit, including its executable.
  if (powershell.length + args.join(' ').length > 32000) throw new Error('Путь слишком длинный для запуска терминала.');
  return { executable: powershell, args, options: { cwd, detached: false, stdio: 'ignore', windowsHide: true, ...(env ? { env } : {}) }, script, helperScript, codexArgs };
}

/** Caller tracks spawn/error/close and owns unref; the child lives until the TUI exits. */
export function launchSessionTerminal(options, spawnImpl = spawn) {
  const launch = buildTerminalLaunch(options);
  return spawnImpl(launch.executable, launch.args, launch.options);
}

export function launchClaudeAuthTerminal(options, spawnImpl = spawn) {
  const launch = buildClaudeAuthLaunch(options);
  return spawnImpl(launch.executable, launch.args, launch.options);
}

export function launchCodexAuthTerminal(options, spawnImpl = spawn) {
  const launch = buildCodexAuthLaunch(options);
  return spawnImpl(launch.executable, launch.args, launch.options);
}

export function launchClaudeSetupTokenTerminal(options, spawnImpl = spawn) {
  const launch = buildClaudeSetupTokenLaunch(options);
  return spawnImpl(launch.executable, launch.args, launch.options);
}
