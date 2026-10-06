import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudePortalSetupService } from '../electron/claude-portal-setup.mjs';

const connection = { apiKey: 'private-claude-router-key', baseUrl: 'https://router.example.test/anthropic',
  authScheme: 'bearer', providerName: 'Test router', model: 'claude-sonnet-fixture' };

function fixture(options = {}) {
  let now = Date.parse('2026-10-05T10:00:00Z'), serial = 0;
  const timers = new Map(), saved = [], opened = [];
  const portal = {
    async start() { return { flowId: `flow-${++serial}`, userCode: 'CODE-TEST',
      verificationUri: 'https://coder-portal.encycam.com/device?code=CODE-TEST',
      expiresAt: '2026-10-05T10:10:00Z', intervalMs: 5000 }; },
    async poll() { return { state: 'ready', config: connection }; },
    cancel() {}, dispose() {},
  };
  const service = new ClaudePortalSetupService({ portal, now: () => now,
    setTimeoutImpl(fn, delay) { const key = ++serial; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeoutImpl(key) { timers.delete(key); },
    saveConnection: async config => { saved.push(config); return { apiKey: 'must-not-be-returned' }; },
    openExternal: async uri => { opened.push(uri); }, ...options });
  return { service, portal, saved, opened, timers, advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
  } };
}

test('host-only imported config requires explicit one-time Apply and emits only public metadata', async () => {
  const f = fixture();
  const input = { ...connection };
  const result = f.service.prepare(input);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(Object.keys(result.preview).sort(), ['agent', 'baseUrl', 'expiresAt', 'model', 'previewId', 'providerName']);
  assert.doesNotMatch(JSON.stringify(result), /private-claude-router-key|apiKey/);
  input.apiKey = 'mutated-caller-value';
  const applied = await f.service.apply({ previewId: result.preview.previewId });
  assert.equal(f.saved[0].apiKey, connection.apiKey);
  assert.equal(applied.connected, true);
  assert.doesNotMatch(JSON.stringify(applied), /private-claude-router-key|apiKey|must-not-be-returned/);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.service.apply({ previewId: result.preview.previewId }), /Предпросмотр/);
});

test('portal routing names are reviewable and returned maps cannot mutate saved configuration', async () => {
  const f = fixture();
  const result = f.service.prepare({ ...connection, modelAliases: { opus: 'cc/claude-opus-5-5[1m]' }, modelNames: { opus: 'Claude Opus 5.5' } });
  assert.equal(result.preview.modelAliases.opus, 'cc/claude-opus-5-5[1m]');
  assert.equal(result.preview.modelNames.opus, 'Claude Opus 5.5');
  result.preview.modelAliases.opus = 'mutated';
  result.preview.modelNames.opus = 'mutated';
  await f.service.apply({ previewId: result.preview.previewId });
  assert.equal(f.saved[0].modelAliases.opus, 'cc/claude-opus-5-5[1m]');
  assert.equal(f.saved[0].modelNames.opus, 'Claude Opus 5.5');
});

test('preview rejects malformed config and invalidates an older approval', async () => {
  const f = fixture();
  const old = f.service.prepare(connection);
  for (const extra of [{ env: { SECRET: 'secret' } }, { baseUrl: 'http://unsafe.example' }, { providerName: connection.apiKey }]) {
    assert.throws(() => f.service.prepare({ ...connection, ...extra }), /Некорректные/);
  }
  await assert.rejects(f.service.apply({ previewId: old.preview.previewId }));
  assert.equal(f.saved.length, 0);
  assert.equal(f.timers.size, 0);
});

test('cancel, expiry, disposal and another window cannot apply a retained preview', async () => {
  for (const finish of ['cancel', 'expire', 'dispose']) {
    const f = fixture(), other = fixture();
    const result = f.service.prepare(connection);
    await assert.rejects(other.service.apply({ previewId: result.preview.previewId }));
    if (finish === 'expire') f.advance(10 * 60 * 1000);
    else f.service[finish]();
    await assert.rejects(f.service.apply({ previewId: result.preview.previewId }));
    assert.equal(f.saved.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('simultaneous Apply calls save once; replacement and cancellation wait for the save', async () => {
  let release;
  const f = fixture({ saveConnection: () => new Promise(resolve => { release = resolve; }) });
  const result = f.service.prepare(connection);
  const saving = f.service.apply({ previewId: result.preview.previewId });
  await assert.rejects(f.service.apply({ previewId: result.preview.previewId }));
  assert.throws(() => f.service.prepare(connection), /Дождитесь/);
  assert.throws(() => f.service.cancel(), /Дождитесь/);
  release();
  assert.equal((await saving).connected, true);
  assert.equal(f.timers.size, 0);
});

test('failed storage consumes approval and never forwards a raw secret-bearing error', async () => {
  const f = fixture({ saveConnection: async () => { throw new Error(connection.apiKey); } });
  const result = f.service.prepare(connection);
  await assert.rejects(f.service.apply({ previewId: result.preview.previewId }), error =>
    error.message.includes('Не удалось сохранить') && !error.message.includes(connection.apiKey));
  await assert.rejects(f.service.apply({ previewId: result.preview.previewId }), /Предпросмотр/);
});

test('device adapter opens host-owned verification and produces a shared public preview', async () => {
  const f = fixture();
  const started = await f.service.start();
  assert.equal(started.browserOpened, true);
  assert.deepEqual(f.opened, [started.verificationUri]);
  const first = f.service.poll(started.flowId), second = f.service.poll(started.flowId);
  assert.strictEqual(first, second);
  const ready = await first;
  assert.deepEqual(await f.service.poll(started.flowId), ready);
  assert.equal(f.saved.length, 0);
  await f.service.apply({ previewId: ready.preview.previewId });
  assert.equal(f.saved.length, 1);
});

test('device adapter cancellation discards a late secret-bearing config', async () => {
  const f = fixture();
  let release;
  f.portal.poll = () => new Promise(resolve => { release = resolve; });
  const started = await f.service.start();
  const pending = f.service.poll(started.flowId);
  f.service.cancel(started.flowId);
  release({ state: 'ready', config: connection });
  await assert.rejects(pending, /отменено/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.saved.length, 0);
});

test('retryable portal failure retains the flow and terminal errors are sanitized', async () => {
  const f = fixture();
  const started = await f.service.start();
  f.portal.poll = async () => { throw Object.assign(new Error(connection.apiKey), { code: 'network' }); };
  assert.deepEqual(await f.service.poll(started.flowId), { state: 'pending', intervalMs: 5000 });
  f.portal.poll = async () => { throw Object.assign(new Error(connection.apiKey), { code: 'forbidden' }); };
  await assert.rejects(f.service.poll(started.flowId), error => error.code === 'forbidden' && !error.message.includes(connection.apiKey));
  await assert.rejects(f.service.poll(started.flowId), /отменено/);
});

test('missing verified device adapter is explicit and makes no network or browser call', async () => {
  const f = fixture({ portal: undefined });
  await assert.rejects(f.service.start(), { code: 'unsupported' });
  assert.equal(f.opened.length, 0);
  assert.equal(f.saved.length, 0);
});

test('unsafe verification metadata cannot expose secrets or open an unrelated URL', async () => {
  for (const patch of [
    { verificationUri: 'https://evil.example/device?code=CODE-TEST' },
    { verificationUri: 'https://coder-portal.encycam.com/device?code=CODE-TEST&token=secret' },
    { verificationUri: connection.apiKey },
    { expiresAt: connection.apiKey }, { intervalMs: connection.apiKey },
  ]) {
    const f = fixture();
    const start = f.portal.start;
    f.portal.start = async () => ({ ...await start(), ...patch });
    await assert.rejects(f.service.start(), error => error.code === 'invalid_response' && !error.message.includes(connection.apiKey));
    assert.equal(f.opened.length, 0);
  }
});

test('late device start from a closed window never opens the browser', async () => {
  const f = fixture();
  let release;
  const start = f.portal.start;
  f.portal.start = () => new Promise(resolve => { release = resolve; });
  const pending = f.service.start();
  f.service.dispose();
  release(await start());
  await assert.rejects(pending, /закрыто/);
  assert.equal(f.opened.length, 0);
});
