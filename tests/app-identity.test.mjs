import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationIdentity } from '../electron/app-identity.mjs';

test('production channels retain their established Windows identity', () => {
  for (const [channel, name] of Object.entries({ stable: 'Codex Desk', nightly: 'Codex Desk Nightly', development: 'Codex Desk Development' })) {
    assert.deepEqual(applicationIdentity(channel), { name, appId: `local.codex.desk.${channel}` });
  }
});

test('disposable process identities cannot overwrite the production registration or another test', () => {
  const identities = [731, 732].map(pid => applicationIdentity('nightly', pid));
  assert.deepEqual(identities, [
    { name: 'Codex Desk Test 731', appId: 'local.codex.desk.test.731' },
    { name: 'Codex Desk Test 732', appId: 'local.codex.desk.test.732' },
  ]);
  for (const channel of ['stable', 'nightly', 'development']) {
    const production = applicationIdentity(channel);
    assert.ok(identities.every(identity => identity.name !== production.name && identity.appId !== production.appId));
  }
});

test('invalid channel and process identifiers cannot become shell identities', () => {
  for (const channel of ['unknown', '__proto__', null, undefined]) assert.throws(() => applicationIdentity(channel));
  for (const pid of [null, 0, -1, 1.5, Infinity, NaN, '731', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applicationIdentity('nightly', pid));
  }
});
