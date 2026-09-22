import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { persistShellIcon, watchShellShortcutIcon } from '../electron/windows-shell-icon.mjs';

test('Explorer icon survives replacement of the channel directory and repeated starts do not rewrite it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desk-shell-icon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = path.join(root, 'nightly');
  await mkdir(channel);
  const source = path.join(channel, 'icon.ico');
  const bytes = await readFile(new URL('../electron/icon.ico', import.meta.url));
  await writeFile(source, bytes);
  const options = { source, userData: path.join(root, 'profile') };
  const icon = await persistShellIcon(options);
  const before = await stat(icon);
  assert.equal(await persistShellIcon(options), icon);
  assert.equal((await stat(icon)).mtimeMs, before.mtimeMs);
  await writeFile(icon, bytes.subarray(0, 20)); // Recover a previously interrupted write.
  assert.equal(await persistShellIcon(options), icon);
  assert.deepEqual(await readFile(icon), bytes);
  await rename(channel, path.join(root, 'old-nightly'));
  assert.deepEqual(await readFile(icon), bytes);
  assert.equal(path.dirname(icon), path.join(options.userData, 'shell-icons'));
});

test('a different icon gets its own path while the previous shell reference stays valid', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desk-shell-icon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'icon.ico');
  const options = { source, userData: path.join(root, 'profile') };
  await writeFile(source, 'old icon');
  const oldIcon = await persistShellIcon(options);
  await writeFile(source, 'new icon');
  const newIcon = await persistShellIcon(options);
  assert.notEqual(oldIcon, newIcon);
  assert.equal(await readFile(oldIcon, 'utf8'), 'old icon');
  assert.equal(await readFile(newIcon, 'utf8'), 'new icon');
});

test('shortcut repair follows late Electron registration, stops after close and ignores other channels', async () => {
  const events = new EventEmitter();
  let changed;
  let current;
  let writes = 0;
  let closed = false;
  const errors = [];
  events.close = () => { closed = true; };
  const executable = 'C:\\apps\\nightly\\Codex Desk.exe';
  const appId = 'local.codex.desk.nightly';
  const icon = 'C:\\profile\\shell-icons\\icon.ico';
  const shell = {
    readShortcutLink() { if (!current) throw new Error('Not registered yet'); return { ...current }; },
    writeShortcutLink(_filename, operation, patch) {
      assert.equal(operation, 'update');
      assert.deepEqual(patch, { icon, iconIndex: 0 });
      current = { ...current, ...patch }; writes++;
      return true;
    },
  };
  const stop = watchShellShortcutIcon({ shell, shortcut: 'Codex Desk.lnk', executable, appId, icon }, {
    watchDirectory(_directory, _options, callback) { changed = callback; return events; },
    onError: error => errors.push(error),
  });
  const wait = () => new Promise(resolve => setTimeout(resolve, 250));
  try {
    // Notification.isSupported() returns before Electron's background registration.
    current = { target: executable, appUserModelId: appId, icon: '', iconIndex: 0, toastActivatorClsid: 'preserve-me' };
    changed('rename', 'Codex Desk.lnk');
    await wait();
    assert.equal(current.icon, icon);
    assert.equal(current.toastActivatorClsid, 'preserve-me');
    changed('change', 'Codex Desk.lnk'); // Our own write must not cause a loop.
    await wait();
    assert.equal(writes, 1);
    current.icon = ''; // Electron may recreate the shortcut on a later registration.
    changed('change', null);
    await wait();
    assert.equal(current.icon, icon);
    assert.equal(writes, 2);
    current = { target: executable, appUserModelId: 'local.codex.desk.stable', icon: '' };
    changed('change', 'Codex Desk.lnk');
    await wait();
    assert.equal(current.icon, '');
    assert.equal(writes, 2);
    current = { target: executable, appUserModelId: appId, icon: '' };
    changed('change', 'Codex Desk.lnk');
    stop();
    await wait();
    assert.equal(writes, 2);
    assert.equal(closed, true);
    assert.deepEqual(errors, []);
  } finally { stop(); }
});
