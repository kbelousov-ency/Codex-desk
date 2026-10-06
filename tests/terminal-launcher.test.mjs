import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTerminalLaunch, launchSessionTerminal, launchClaudeAuthTerminal, launchClaudeSetupTokenTerminal } from '../electron/terminal-launcher.mjs';

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

test('Claude source settings stay out of argv and are removed when an owned terminal exits or fails', async () => {
  const secret = 'router-test-terminal-secret';
  for (const [launcher, event] of [[launchSessionTerminal, 'close'], [launchClaudeAuthTerminal, 'error'], [launchClaudeSetupTokenTerminal, 'close']]) {
    const settingsOverrides = { env: { ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://router.example.test' }, apiKeyHelper: '' };
    const child = new EventEmitter();
    let filename;
    const result = await launcher({ ...options, provider: 'claude', settingsOverrides, env: { ANTHROPIC_AUTH_TOKEN: secret } }, (_exe, args, spawnOptions) => {
      const helper = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const encodedScript = helper.match(/'-EncodedCommand', '([^']+)'/)[1];
      const script = Buffer.from(encodedScript, 'base64').toString('utf16le');
      filename = script.match(/'--settings', '([^']+)'/)[1].replaceAll("''", "'");
      assert.equal(script.includes(secret), false);
      assert.equal(helper.includes(secret), false);
      assert.equal(spawnOptions.env.ANTHROPIC_AUTH_TOKEN, secret);
      return child;
    });
    assert.equal(result, child);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), settingsOverrides);
    child.emit(event, event === 'error' ? new Error(secret) : 0);
    // File cleanup is asynchronous and belongs to the launcher, independent of UI listeners.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await stat(filename); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await assert.rejects(stat(filename), { code: 'ENOENT' });
  }
});

test('Codex terminal appends routing overrides without placing its router token on the command line', () => {
  const configOverrides = ['model_provider="codex_desk_router"', 'model_providers.codex_desk_router={name="Router",wire_api="responses",requires_openai_auth=false,base_url="https://router.example.test/v1",env_key="CODEX_DESK_ROUTER_TOKEN"}'];
  const launch = buildTerminalLaunch({ ...options, configOverrides, env: { CODEX_DESK_ROUTER_TOKEN: 'router-secret' } });
  for (const override of configOverrides) assert.ok(launch.codexArgs.includes(override));
  assert.equal(launch.script.includes('router-secret'), false);
  assert.equal(launch.options.env.CODEX_DESK_ROUTER_TOKEN, 'router-secret');
  assert.throws(() => buildTerminalLaunch({ ...options, configOverrides: ['bad\nfield=value'] }), /Некорректный/);
  assert.throws(() => buildTerminalLaunch({ ...options, configOverrides: '--help' }), /Некорректные/);
});

test('Windows native argv receives exact TOML values through PowerShell 5.1', { skip: process.platform !== 'win32' }, async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-terminal-argv-'));
  try {
    const executable = path.join(directory, 'argv.exe'), source = path.join(directory, 'argv.cs');
    await writeFile(source, 'using System; using System.Web.Script.Serialization; public class Program { public static int Main(string[] args) { Console.WriteLine(new JavaScriptSerializer().Serialize(args)); return 0; } }');
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition (Get-Content -LiteralPath $env:ARGV_SOURCE -Raw) -ReferencedAssemblies 'System.Web.Extensions' -OutputAssembly $env:ARGV_EXE -OutputType ConsoleApplication"], {
      windowsHide: true, timeout: 30000, env: { ...process.env, ARGV_SOURCE: source, ARGV_EXE: executable },
    });
    const configOverrides = [
      'model_provider="codex_desk_router"',
      'model_providers.codex_desk_router={name="Router with spaces",wire_api="responses",requires_openai_auth=false,base_url="https://router.example.test/v1",env_key="CODEX_DESK_ROUTER_TOKEN"}',
      'model_providers.codex_desk_router.name="A \\"quoted\\" name $() `!"',
    ];
    const launch = buildTerminalLaunch({ ...options, executable, cwd: directory, configOverrides });
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch.script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
    assert.deepEqual(JSON.parse(stdout.trim()), launch.codexArgs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
