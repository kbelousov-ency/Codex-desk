import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildTerminalLaunch, launchSessionTerminal } from '../electron/terminal-launcher.mjs';

const options = {
  executable: 'C:\\Program Files\\Codex\\codex.exe',
  cwd: 'E:\\Мои проекты\\CodexDesk',
  threadId: '01965001-a55b-71da-bf8f-e23a3337ad7f',
  model: 'configured-model',
  effort: 'ultra',
  access: 'inherited',
};

test('terminal resumes the exact thread and preserves selected model/effort without a prompt', () => {
  const launch = buildTerminalLaunch(options, 'D:\\Windows');
  assert.equal(launch.executable, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(launch.codexArgs, ['resume', options.threadId, '--cd', options.cwd, '--model', options.model, '-c', 'model_reasoning_effort=ultra']);
  assert.deepEqual(launch.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(launch.args[4], 'base64').toString('utf16le'), launch.helperScript);
  assert.ok(launch.helperScript.includes(Buffer.from(launch.script, 'utf16le').toString('base64')));
  assert.deepEqual(launch.options, { cwd: options.cwd, detached: false, stdio: 'ignore', windowsHide: true });
  assert.match(launch.script, /& \$codexExecutable @codexArguments/);
  assert.match(launch.helperScript, /-WindowStyle Normal -PassThru/);
  assert.match(launch.helperScript, /\$codexTerminal.WaitForExit\(\)/);
  assert.match(launch.helperScript, /exit \$codexTerminal.ExitCode/);
  assert.doesNotMatch(launch.script, /Invoke-Expression|Start-Process|--last|--yolo|--dangerously/);
});

test('explicit access modes use the same sandbox, reviewer and approvals as the chat', () => {
  for (const [access, sandbox, approval, reviewer] of [
    ['auto', 'workspace-write', 'on-request', 'auto_review'],
    ['read-only', 'read-only', 'on-request', 'user'],
    ['workspace-write', 'workspace-write', 'on-request', 'user'],
    ['danger-full-access', 'danger-full-access', 'never', 'user'],
  ]) {
    const { codexArgs } = buildTerminalLaunch({ ...options, model: '', effort: '', access });
    assert.deepEqual(codexArgs, ['resume', options.threadId, '--cd', options.cwd, '--sandbox', sandbox, '--ask-for-approval', approval, '-c', `approvals_reviewer=${reviewer}`]);
  }
  assert.deepEqual(buildTerminalLaunch({ ...options, model: '', effort: '', access: 'inherited' }).codexArgs,
    ['resume', options.threadId, '--cd', options.cwd]);
});

test('PowerShell values preserve apostrophes, unicode and shell metacharacters as literals', () => {
  const cwd = "E:\\Проект O'Brien\\$(throw 1);`boom & other";
  const executable = "C:\\O'Brien $x `x\\codex.exe";
  const launch = buildTerminalLaunch({ ...options, cwd, executable });
  assert.equal(launch.codexArgs[3], cwd);
  assert.ok(launch.script.includes("$codexExecutable = 'C:\\O''Brien $x `x\\codex.exe'"));
  assert.ok(launch.script.includes("Set-Location -LiteralPath 'E:\\Проект O''Brien\\$(throw 1);`boom & other'"));
  assert.equal(Buffer.from(launch.args[4], 'base64').toString('utf16le'), launch.helperScript);
  assert.ok(launch.helperScript.includes("-WorkingDirectory 'E:\\Проект O''Brien\\$(throw 1);`boom & other'"));
});

test('invalid renderer-derived values never reach a child process', () => {
  for (const invalid of [
    { threadId: '--last' }, { threadId: options.threadId + '\n' }, { threadId: 12 },
    { executable: 'codex.exe' }, { executable: 'C:\\codex.cmd' }, { executable: 'C:\\bad\nname.exe' },
    { cwd: '../folder' }, { cwd: 'E:\\bad\0folder' }, { cwd: 'E:\\bad"folder' },
    { access: 'all' }, { model: '--help' }, { model: 'model\nname' }, { model: 'a'.repeat(257) },
    { effort: 'ultra\nauto' }, { effort: '"high"' },
  ]) assert.throws(() => launchSessionTerminal({ ...options, ...invalid }, () => assert.fail('spawn called')));
  assert.throws(() => buildTerminalLaunch({ ...options, cwd: 'E:\\' + 'a'.repeat(8190) }), /путь|длинный/);
});

test('launcher returns the owned child unchanged so callers can observe its full lifecycle', () => {
  const child = new EventEmitter();
  let calls = 0;
  const result = launchSessionTerminal(options, (executable, args, spawnOptions) => {
    calls++;
    assert.ok(executable.endsWith('\\powershell.exe'));
    assert.equal(args[3], '-EncodedCommand');
    assert.equal(spawnOptions.detached, false);
    assert.equal(spawnOptions.windowsHide, true);
    return child;
  });
  assert.equal(calls, 1);
  assert.equal(result, child);
  const events = [];
  result.on('spawn', () => events.push('spawn'));
  result.on('close', () => events.push('close'));
  child.emit('spawn');
  child.emit('close', 0);
  assert.deepEqual(events, ['spawn', 'close']);
});
