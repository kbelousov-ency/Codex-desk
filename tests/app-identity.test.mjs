import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationBuildIdentity, applicationIconName, applicationIdentity, applicationShortcutName, applicationWindowAppearance } from '../electron/app-identity.mjs';

test('Кузьмич оформляет все видимые каналы', () => {
  for (const [channel, title] of [
    ['stable', 'Кузьмич — Release'],
    ['nightly', 'Кузьмич — Nightly'],
    ['development', 'Кузьмич — Development'],
    ['experimental3', 'Кузьмич — Experimental 3'],
  ]) assert.deepEqual(applicationWindowAppearance(channel), {
    title, backgroundColor: channel === 'nightly' || channel === 'experimental3' ? '#171A19' : '#101311',
  });
  for (const channel of ['unknown', '__proto__', null, undefined]) assert.throws(() => applicationWindowAppearance(channel));
});

test('production channels retain their established Windows identity', () => {
  for (const [channel, name] of Object.entries({ stable: 'Кузьмич', nightly: 'Кузьмич Nightly', experimental3: '\u041a\u0443\u0437\u044c\u043c\u0438\u0447 Experimental 3', development: 'Кузьмич Development' })) {
    assert.deepEqual(applicationIdentity(channel), { name, appId: `local.codex.desk.${channel}` });
  }
});

test('all packaged channels use the Kuzmich logo asset', () => {
  assert.equal(applicationIconName('stable'), 'kuzmich.ico');
  assert.equal(applicationIconName('development'), 'kuzmich.ico');
  assert.equal(applicationIconName('nightly'), 'kuzmich.ico');
  assert.equal(applicationIconName('experimental3'), 'kuzmich.ico');
  assert.throws(() => applicationIconName('__proto__'));
});

test('packaged metadata and icons are explicit per channel; compatibility executable names remain', () => {
  assert.deepEqual(applicationBuildIdentity('stable'), { productName: 'Кузьмич', executableName: 'Codex Desk', iconName: 'kuzmich.ico' });
  assert.deepEqual(applicationBuildIdentity('nightly'), { productName: 'Кузьмич Nightly', executableName: 'Kuzmich', iconName: 'kuzmich.ico' });
  assert.deepEqual(applicationBuildIdentity('experimental3'), { productName: 'Кузьмич Experimental 3', executableName: 'Kuzmich', iconName: 'kuzmich.ico' });
  for (const channel of ['development', '__proto__', undefined]) assert.throws(() => applicationBuildIdentity(channel));
});

test('shell icon repair follows the bounded built PE name even after channel-marker promotion', () => {
  assert.equal(applicationShortcutName('Кузьмич Nightly'), 'Кузьмич Nightly.lnk');
  assert.equal(applicationShortcutName('Кузьмич Experimental 3'), 'Кузьмич Experimental 3.lnk');
  assert.equal(applicationShortcutName('Codex Desk'), 'Кузьмич.lnk');
  for (const name of [undefined, '../../foreign', '__proto__']) assert.equal(applicationShortcutName(name), 'Кузьмич.lnk');
});

test('disposable process identities cannot overwrite the production registration or another test', () => {
  const identities = [731, 732].map(pid => applicationIdentity('nightly', pid));
  assert.deepEqual(identities, [
    { name: 'Кузьмич Test 731', appId: 'local.codex.desk.test.731' },
    { name: 'Кузьмич Test 732', appId: 'local.codex.desk.test.732' },
  ]);
  for (const channel of ['stable', 'nightly', 'experimental3', 'development']) {
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
