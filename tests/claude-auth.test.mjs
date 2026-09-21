import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAuthService, publicClaudeAuthStatus, readClaudeAuthStatus } from '../electron/claude-auth.mjs';
import { WindowSession } from '../electron/window-session.mjs';
import { buildClaudeAuthLaunch, launchClaudeAuthTerminal } from '../electron/terminal-launcher.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const context = { executable: 'C:\\Tools\\claude.exe', cwd: 'E:\\Мой проект', env: { CLAUDE_CONFIG_DIR: 'E:\\Мой профиль', KEEP: 'inherited' } };

test('native auth status has bounded execution, inherited environment and only public fields', async () => {
  const raw = { loggedIn: true, authMethod: 'oauth_token', email: 'user@example.com', subscriptionType: 'max', apiProvider: 'firstParty', accessToken: 'secret', nested: { password: 'secret' } };
  const status = await readClaudeAuthStatus(context, async (executable, args, options) => {
    assert.equal(executable, context.executable);
    assert.deepEqual(args, ['auth', 'status']);
    assert.deepEqual(options, { cwd: context.cwd, env: context.env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    return { stdout: JSON.stringify(raw), stderr: 'secret' };
  });
  const { accessToken, nested, ...expected } = raw;
  assert.deepEqual(status, expected);
  assert.deepEqual(publicClaudeAuthStatus('{"loggedIn":false,"email":"bad\\nline","apiProvider":12}'), { loggedIn: false });
});

test('signed-out exit 1 is valid, every other status failure is generic without CLI output', async () => {
  const signedOut = await readClaudeAuthStatus(context, async () => { throw { code: 1, stdout: '{"loggedIn":false}', stderr: 'secret' }; });
  assert.deepEqual(signedOut, { loggedIn: false });
  for (const result of [
    { code: 1, stdout: '{"loggedIn":true}' }, { code: 2, stdout: '{"loggedIn":false}' },
    { code: 1, killed: true, stdout: '{"loggedIn":false}' }, { code: 1, stdout: 'secret' }, { code: 'ENOENT' },
  ]) await assert.rejects(readClaudeAuthStatus(context, async () => { throw { ...result, stderr: 'sensitive-output', message: 'sensitive-output' }; }), error => {
    assert.match(error.message, /проверить авторизацию/); assert.doesNotMatch(error.message, /secret|sensitive/); return true;
  });
  for (const raw of ['null', '[]', '{}', '{"loggedIn":"true"}', 'secret']) assert.throws(() => publicClaudeAuthStatus(raw), /проверить авторизацию/);
});

test('browser login uses fixed Claude CLI arguments and genuine interactive console', () => {
  const launch = buildClaudeAuthLaunch({ ...context, cwd: "E:\\O'Brien\\$(throw 1);`x &" });
  assert.deepEqual(launch.codexArgs, ['auth', 'login', '--claudeai']);
  assert.match(launch.script, /& \$codexExecutable @codexArguments/);
  assert.ok(launch.script.includes("Set-Location -LiteralPath 'E:\\O''Brien\\$(throw 1);`x &'"));
  assert.match(launch.script, /Claude Code/);
  assert.match(launch.helperScript, /-WindowStyle Normal -PassThru/);
  assert.equal(launch.options.env, context.env);
  assert.doesNotMatch(launch.script, /--resume|--model|--effort|--permission|Invoke-Expression|logout/);
  const child = new EventEmitter();
  assert.equal(launchClaudeAuthTerminal(context, (_exe, _args, options) => { assert.equal(options.env, context.env); return child; }), child);
  for (const invalid of [{ executable: 'claude.exe' }, { executable: 'C:\\claude.cmd' }, { cwd: 'relative' }, { cwd: 'E:\\bad\nfolder' }]) {
    assert.throws(() => launchClaudeAuthTerminal({ ...context, ...invalid }, () => assert.fail('Unexpected spawn')));
  }
});

function fixture({ launch, readStatus, resolveDirectory, resolveClaudeExecutable } = {}) {
  const sessions = [], calls = [], events = [], children = [];
  const service = new ClaudeAuthService({
    getSessions: () => sessions, getEnvironment: () => context.env,
    readStatus: readStatus || (async options => { calls.push(['status', options]); return { loggedIn: true, authMethod: 'oauth_token' }; }),
    launchTerminal: options => {
      calls.push(['launch', options]);
      if (launch) return launch(options);
      const child = new EventEmitter(); child.unref = () => calls.push(['unref']); child.kill = () => assert.fail('Login console must remain independent');
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  const add = (provider = 'claude') => {
    const session = new WindowSession({ settings: { provider, cwd: context.cwd, executable: context.executable, model: 'existing', effort: 'medium', access: 'auto' },
      claudeAuth: service, resolveDirectory: resolveDirectory || (async value => value), resolveClaudeExecutable: resolveClaudeExecutable || (async value => value),
      send: (type, data) => events.push({ session, type, data }) });
    sessions.push(session); return session;
  };
  return { service, sessions, calls, events, children, add };
}

test('status and login need neither bootstrap nor thread, and cannot be invoked for Codex', async () => {
  const f = fixture(); const session = f.add();
  const status = await f.service.status(session);
  assert.deepEqual(status, { loggedIn: true, authMethod: 'oauth_token', configDirectory: context.env.CLAUDE_CONFIG_DIR, loginInProgress: false });
  assert.deepEqual(await f.service.login(session), { started: true });
  assert.equal(session.client, null); assert.equal(session.currentThreadId, null);
  assert.deepEqual(f.calls.find(([kind]) => kind === 'launch')[1], { ...context, configDirectory: context.env.CLAUDE_CONFIG_DIR });
  assert.equal((await f.service.status(session)).loginInProgress, true);
  await assert.rejects(f.service.login(session), /Дождитесь/);
  const codex = f.add('codex');
  await assert.rejects(f.service.status(codex), /настройках Claude/);
  await assert.rejects(f.service.login(codex), /настройках Claude/);
  f.children[0].emit('close', 0); await tick();
  assert.deepEqual(f.events.at(-1).data, { state: 'closed', loggedIn: true });
  assert.equal(f.events.some(event => event.session === codex), false);
  assert.equal(f.service.active, null);
});

test('login locks every Claude tab before awaiting paths and waits for stopped processes', async () => {
  const stopped = deferred(); const f = fixture();
  const first = f.add(), second = f.add(), codex = f.add('codex');
  let stops = 0;
  first.client = { stop: () => { stops++; assert.equal(f.events[0].data.state, 'opened'); }, stopAndWait: () => stopped.promise };
  second.client = { stop: () => { stops++; }, stopAndWait: async () => {} };
  codex.client = { stop: () => assert.fail('Codex must keep running') };
  first.currentThreadId = 'claude:current';
  const login = f.service.login(first);
  await tick();
  assert.equal(stops, 2); assert.equal(f.calls.some(([kind]) => kind === 'launch'), false);
  assert.throws(() => second.start(), /Дождитесь/);
  assert.throws(() => second.setSettings({ cwd: 'different' }), /Дождитесь/);
  await assert.rejects(second.request('turn/start'), /Дождитесь/);
  await assert.rejects(second.openTerminal(), /Дождитесь/);
  assert.doesNotThrow(() => codex.assertLocalControl());
  const added = f.add();
  assert.throws(() => added.start(), /Дождитесь/);
  assert.equal(f.events.at(-1).session, added);
  assert.deepEqual(f.events.at(-1).data, { state: 'opened' });
  stopped.resolve(); await login;
  f.children[0].emit('close', 0); await tick();
  assert.equal(first.currentThreadId, 'claude:current');
  assert.equal(first.settings.model, 'existing');
  assert.equal(first.settings.effort, 'medium');
  assert.equal(first.settings.access, 'auto');
  for (const session of [first, second, added]) {
    assert.doesNotThrow(() => session.assertLocalControl());
    assert.equal(f.events.filter(event => event.session === session && event.data.state === 'closed').length, 1);
  }
});

test('any busy Claude session prevents login before transports are stopped', async () => {
  for (const field of ['terminal', 'pendingBoots', 'pendingMutations', 'requests', 'activeThreadTurns', 'compactingThreads', 'mcpRefreshing']) {
    const f = fixture(); const first = f.add(), other = f.add();
    if (other[field]?.set) other[field].set('id', true);
    else if (other[field]?.add) other[field].add('id');
    else other[field] = true;
    first.client = { stop: () => assert.fail(`Stopped while ${field}`) };
    await assert.rejects(f.service.login(first), /всех вкладках Claude/);
    assert.equal(f.service.active, null); assert.equal(f.events.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('stop timeout and path errors release locks and notify all paused tabs', async () => {
  for (const mode of ['stop', 'path']) {
    const f = fixture(mode === 'path' ? { resolveClaudeExecutable: async () => { throw new Error('Нет установленного CLI.'); } } : {});
    const first = f.add(), second = f.add();
    if (mode === 'stop') first.client = { stop: () => {}, stopAndWait: async () => { throw new Error('CLI ещё завершает работу.'); } };
    await assert.rejects(f.service.login(first));
    assert.equal(f.service.active, null);
    assert.equal(f.calls.some(([kind]) => kind === 'launch'), false);
    assert.equal(f.events.filter(event => event.type === 'auth' && event.data.state === 'closed').length, 2);
    assert.doesNotThrow(() => second.assertLocalControl());
  }
});

test('a failed stop waits for other process exits before notifying renderers to reconnect', async () => {
  const f = fixture(); const first = f.add(), second = f.add(); const slow = deferred();
  first.client = { stop: () => {}, stopAndWait: async () => { throw new Error('First stop failed.'); } };
  second.client = { stop: () => {}, stopAndWait: () => slow.promise };
  const login = f.service.login(first);
  const result = assert.rejects(login, /First stop failed/);
  await tick();
  assert.ok(f.service.active);
  assert.equal(f.events.some(event => event.data.state === 'closed'), false);
  assert.equal(f.calls.some(([kind]) => kind === 'launch'), false);
  slow.resolve(); await result;
  assert.equal(f.service.active, null);
  assert.equal(f.events.filter(event => event.data.state === 'closed').length, 2);
});

test('a stop timeout retains the old process across reconnects and later login attempts', async () => {
  const f = fixture(); const session = f.add(); const exit = deferred();
  let attempts = 0;
  const oldClient = { stop: () => {}, stopAndWait: async () => {
    if (++attempts === 1) throw new Error('CLI ещё завершает работу.');
    await exit.promise;
  } };
  session.client = oldClient;
  await assert.rejects(f.service.login(session), /CLI ещё/);
  assert.equal(session.client, null);
  assert.ok(f.service.stoppingClients.has(oldClient));
  // The renderer reconnects with a different client before trying login again.
  session.client = { stop: () => {}, stopAndWait: async () => {} };
  const retry = f.service.login(session);
  await tick();
  assert.equal(attempts, 2);
  assert.equal(f.calls.some(([kind]) => kind === 'launch'), false);
  exit.resolve();
  assert.deepEqual(await retry, { started: true });
  assert.equal(f.service.stoppingClients.size, 0);
  f.children[0].emit('close', 0); await tick();
});

test('login completion reflects signed-out status and status failure without claiming success', async () => {
  for (const failed of [false, true]) {
    const f = fixture({ readStatus: async () => {
      if (failed) throw new Error('secret-cli-output');
      return { loggedIn: false };
    } });
    const session = f.add(); await f.service.login(session);
    f.children[0].emit('close', 0); await tick();
    const closed = f.events.at(-1).data;
    assert.equal(closed.state, 'closed');
    if (failed) {
      assert.equal(closed.loggedIn, undefined); assert.match(closed.error, /проверить авторизацию/); assert.doesNotMatch(closed.error, /secret/);
    } else assert.deepEqual(closed, { state: 'closed', loggedIn: false });
    assert.equal(f.service.active, null);
  }
});

test('spawn error and close-before-spawn release once and never leak child error text', async () => {
  for (const mode of ['throw', 'error', 'early-close', 'nonzero']) {
    const child = new EventEmitter(); child.unref = () => {};
    const f = fixture({ launch: () => {
      if (mode === 'throw') throw new Error('launch failed');
      queueMicrotask(() => {
        if (mode === 'error') child.emit('error', new Error('sensitive-child-output'));
        else if (mode === 'early-close') child.emit('close', 0);
        else { child.emit('spawn'); child.emit('close', 4); }
      }); return child;
    } });
    const session = f.add();
    if (mode === 'nonzero') assert.deepEqual(await f.service.login(session), { started: true });
    else await assert.rejects(f.service.login(session));
    await tick();
    child.emit('close', 3); await tick();
    assert.equal(f.service.active, null);
    const closed = f.events.filter(event => event.data.state === 'closed');
    assert.equal(closed.length, 1);
    assert.doesNotMatch(JSON.stringify(closed.map(event => event.data)), /sensitive-child-output/);
  }
});

test('disposed tabs get no late events and application dispose never kills login', async () => {
  const f = fixture(); const session = f.add();
  await f.service.login(session);
  session.dispose(); const count = f.events.length;
  f.service.dispose(); f.children[0].emit('close', 0); await tick();
  assert.equal(f.service.active, null); assert.equal(f.events.length, count);
});
