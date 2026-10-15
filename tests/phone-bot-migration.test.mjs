import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

import { removeLegacyPhoneBotData } from '../electron/phone-bot-migration.mjs';

/**
 * Stage 5 of the Mini App plan: the personal Telegram bot is out of the build, so the one secret
 * it owned must not stay on disk. These checks are about what is removed and — just as much —
 * about what is not: the relay credential and the core's grants are shared with the new scheme.
 */

async function profile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kuzmich-phone-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const seedBot = async userData => {
  await mkdir(path.join(userData, 'telegram'), { recursive: true });
  await writeFile(path.join(userData, 'telegram', 'bot-token.json'), '{"token":"<encrypted>"}');
  await writeFile(path.join(userData, 'telegram', 'service.json'), '{"owner":{"userId":"777"},"offset":42}');
};

test('the encrypted bot token and the personal pairing record are removed with their folder', async t => {
  const userData = await profile(t);
  await seedBot(userData);
  const result = await removeLegacyPhoneBotData({ userData });
  assert.deepEqual(result.removed.sort(), ['bot-token.json', 'service.json']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryRemoved, true);
  await assert.rejects(readdir(path.join(userData, 'telegram')), /ENOENT/);
});

test('a second launch finds nothing left and reports no removal', async t => {
  const userData = await profile(t);
  await seedBot(userData);
  await removeLegacyPhoneBotData({ userData });
  const again = await removeLegacyPhoneBotData({ userData });
  assert.deepEqual(again.removed, []);
  assert.deepEqual(again.errors, []);
  assert.equal(again.directoryRemoved, false);
});

test('a profile that never had the bot is untouched', async t => {
  const userData = await profile(t);
  const result = await removeLegacyPhoneBotData({ userData });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await readdir(userData), []);
});

test('relay credential, bridge record and the grants of the core are left exactly as they are', async t => {
  const userData = await profile(t);
  await seedBot(userData);
  await mkdir(path.join(userData, 'remote-bridge'), { recursive: true });
  const kept = {
    [path.join(userData, 'remote-bridge', 'credential.json')]: '{"sealed":"ed25519-private-key"}',
    [path.join(userData, 'remote-bridge', 'bridge.json')]: '{"epoch":7,"commands":[]}',
    [path.join(userData, 'remote-control.json')]: '{"version":1,"grants":[{"grantId":"g-1","enabled":true}]}',
    [path.join(userData, 'settings.json')]: '{"model":"fixture"}',
  };
  for (const [file, body] of Object.entries(kept)) await writeFile(file, body);
  await removeLegacyPhoneBotData({ userData });
  for (const [file, body] of Object.entries(kept)) assert.equal(await readFile(file, 'utf8'), body, file);
});

test('a leftover of someone else keeps the folder, and the token is still gone', async t => {
  const userData = await profile(t);
  await seedBot(userData);
  await writeFile(path.join(userData, 'telegram', 'notes.txt'), 'not written by the bot');
  const result = await removeLegacyPhoneBotData({ userData });
  assert.deepEqual(result.removed.sort(), ['bot-token.json', 'service.json']);
  assert.equal(result.directoryRemoved, false);
  assert.deepEqual(await readdir(path.join(userData, 'telegram')), ['notes.txt']);
});

test('userData is required: a migration without a profile is a programming error, not a silent no-op', async () => {
  await assert.rejects(removeLegacyPhoneBotData({}), TypeError);
});
