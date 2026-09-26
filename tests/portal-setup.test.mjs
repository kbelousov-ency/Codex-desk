import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalSetupService } from '../electron/portal-setup.mjs';

function fixture(extra = {}) {
  const calls = [], opened = [], settings = { executable: 'fixture.exe' };
  const config = { apiKey: 'private-router-key', defaults: { model: 'fixture' }, provider: {} };
  const preview = { previewId: 'preview-1', configPath: 'C:/fixture/config.toml', exists: true, model: 'fixture', changes: [] };
  let serial = 0, active = null, reserved = false;
  const portal = {
    async start() { active = `flow-${++serial}`; return { flowId: active, userCode: 'CODE-TEST', verificationUri: 'https://coder-portal.encycam.com/device?code=CODE-TEST', expiresAt: '2099-01-01T00:00:00Z', intervalMs: 5000 }; },
    async poll(id) { assert.equal(id, active); calls.push('token'); return { state: 'ready', config }; },
    cancel() { active = null; }, dispose() { active = null; },
  };
  const service = new PortalSetupService({ portal, host: 'test', cwd: 'C:/fixture', getSettings: async () => settings,
    resolveExecutable: async preferred => preferred,
    openExternal: async uri => { opened.push(uri); },
    assertAvailable: () => { if (reserved) throw new Error('busy'); },
    runMutation: async task => { reserved = true; try { return await task(); } finally { reserved = false; } },
    createClient: () => ({ async start() { calls.push('connect'); }, async request(method) { calls.push(method); return {}; }, stop() { calls.push('stop'); } }),
    createManager: ({ request, assertActive }) => ({
      async preview(value) { assert.equal(value.apiKey, config.apiKey); await request('config/read', {}); assertActive(); return preview; },
      async save(options) { assert.equal(options.previewId, preview.previewId); await request('config/batchWrite', {}); return { configPath: preview.configPath, backupPath: 'fixture.backup' }; },
      dispose() { calls.push('dispose-manager'); },
    }), ...extra });
  return { service, portal, calls, opened, settings, preview, config };
}

test('browser approval returns public preview, native save uses mutation gate and never exposes the key', async () => {
  const f = fixture();
  const started = await f.service.start();
  assert.equal(started.browserOpened, true);
  assert.equal(f.opened.length, 1);
  const result = await f.service.poll(started.flowId);
  assert.equal(result.state, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /private-router-key|apiKey/);
  assert.deepEqual(await f.service.poll(started.flowId), result);
  assert.equal(f.calls.filter(v => v === 'token').length, 1);
  await f.service.apply({ previewId: result.preview.previewId });
  assert.equal(f.calls.filter(v => v === 'config/batchWrite').length, 1);
  await assert.rejects(f.service.apply({ previewId: result.preview.previewId }));
  await assert.rejects(f.service.poll(started.flowId));
  f.service.dispose();
});

test('browser open failure preserves code and reopening only uses the host-owned link', async () => {
  let fail = true, opened;
  const f = fixture({ openExternal: async uri => { if (fail) throw new Error('secret-raw'); opened = uri; } });
  const started = await f.service.start();
  assert.equal(started.browserOpened, false);
  fail = false;
  await assert.rejects(f.service.openVerification('https://evil.test'));
  await f.service.openVerification(started.flowId);
  assert.equal(opened, started.verificationUri);
  f.service.cancel(started.flowId);
  await assert.rejects(f.service.openVerification(started.flowId));
});

test('a cancelled pending poll cannot produce a preview or write configuration', async () => {
  const f = fixture();
  let release;
  f.portal.poll = () => new Promise(resolve => { release = resolve; });
  const started = await f.service.start();
  const polling = f.service.poll(started.flowId);
  f.service.cancel(started.flowId);
  release({ state: 'ready', config: f.config });
  await assert.rejects(polling, /отменено/);
  assert.equal(f.calls.includes('config/read'), false);
});

test('double polling shares one preview and late cancellation cannot cancel a newer flow', async () => {
  const f = fixture();
  const old = await f.service.start(), current = await f.service.start();
  f.service.cancel(old.flowId);
  const a = f.service.poll(current.flowId), b = f.service.poll(current.flowId);
  assert.strictEqual(a, b);
  await a;
  assert.equal(f.calls.filter(v => v === 'config/read').length, 1);
  f.service.dispose();
});

test('busy tabs keep a ready preview available, invalid options and changed CLI cannot write', async () => {
  let busy = true;
  const f = fixture({ runMutation: async task => { if (busy) throw new Error('user task active'); return task(); } });
  const started = await f.service.start();
  await f.service.poll(started.flowId);
  await assert.rejects(f.service.apply({ previewId: 'preview-1', configPath: 'arbitrary' }), /Некорректное/);
  assert.equal((await f.service.apply({ previewId: 'preview-1' })).blocked, true);
  assert.equal((await f.service.poll(started.flowId)).state, 'ready');
  busy = false;
  f.settings.executable = 'different.exe';
  await assert.rejects(f.service.apply({ previewId: 'preview-1' }), /изменился/);
  assert.equal(f.calls.includes('config/batchWrite'), false);
});

test('window disposal cancels late start before a browser can open', async () => {
  let release;
  const f = fixture({ resolveExecutable: () => new Promise(resolve => { release = resolve; }) });
  const starting = f.service.start();
  await Promise.resolve();
  f.service.dispose();
  release('fixture.exe');
  await assert.rejects(starting, /закрыто/);
  assert.equal(f.opened.length, 0);
});

test('temporary portal read and setup contention keep the same browser approval for retry', async () => {
  let busy = false, temporary = true;
  const f = fixture({ assertAvailable: () => { if (busy) throw new Error('busy'); } });
  const poll = f.portal.poll;
  f.portal.poll = async id => {
    if (temporary) { temporary = false; throw Object.assign(new Error('safe network error'), { retryable: true }); }
    return poll(id);
  };
  const started = await f.service.start();
  assert.equal((await f.service.poll(started.flowId)).state, 'pending');
  busy = true;
  assert.equal((await f.service.poll(started.flowId)).state, 'pending');
  busy = false;
  assert.equal((await f.service.poll(started.flowId)).state, 'ready');
  busy = true;
  assert.equal((await f.service.apply({ previewId: 'preview-1' })).blocked, true);
  busy = false;
  assert.ok((await f.service.apply({ previewId: 'preview-1' })).configPath);
  assert.equal(f.opened.length, 1);
});
