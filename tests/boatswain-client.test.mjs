import test from 'node:test';
import assert from 'node:assert/strict';
import { BoatswainClient } from '../electron/boatswain-client.mjs';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('Boatswain relay reads keep the Router key in the host request only', async () => {
  const calls = [];
  const client = new BoatswainClient({ fetchImpl: async (url, options) => { calls.push([url, options]); return response(200, url.endsWith('/limits') ? { limits: [] } : { machines: [] }); } });
  assert.deepEqual(await client.limits('router-secret'), []);
  assert.deepEqual(await client.machines('router-secret'), []);
  assert.equal(calls[0][0], 'https://coder-portal.encycam.com/api/relay/limits');
  assert.equal(calls[1][0], 'https://coder-portal.encycam.com/api/relay/boatswain/machines');
  for (const [, options] of calls) {
    assert.equal(options.headers.Authorization, 'Bearer router-secret');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
  }
});

test('Boatswain relay rejects an unusable key, a plain-text portal and auth failures', async () => {
  const client = new BoatswainClient({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(() => client.machines(''), /Router key/);
  await assert.rejects(() => client.machines('key\nInjected: 1'), /Router key/);
  assert.throws(() => new BoatswainClient({ portalOrigin: 'http://coder-portal.encycam.com', fetchImpl: async () => {} }), /адрес портала/);
  const denied = new BoatswainClient({ fetchImpl: async () => response(401, {}) });
  await assert.rejects(() => denied.machines('router-secret'), error => error.code === 'unauthorized');
});

test('Boatswain relay rejects an oversized or shapeless portal answer', async () => {
  const huge = new BoatswainClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(300 * 1024) }) });
  await assert.rejects(() => huge.machines('router-secret'), /слишком большой/);
  const shapeless = new BoatswainClient({ fetchImpl: async () => response(200, { other: [] }) });
  await assert.rejects(() => shapeless.machines('router-secret'), /некорректные данные/);
});
