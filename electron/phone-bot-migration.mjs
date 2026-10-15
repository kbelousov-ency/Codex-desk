import path from 'node:path';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';

/**
 * One-time removal of the personal Telegram bot's data (plan v2, stage 5).
 *
 * The bot itself is gone from the build; what is left on disk is the secret it owned.
 * Two files inside `<userData>/telegram`:
 *   `bot-token.json`  — the BotFather token, encrypted with Electron safeStorage
 *   `service.json`    — pairing with the owner's Telegram account, buttons, update journal, offset
 *
 * Nothing else is touched. The relay connection (`<userData>/remote-bridge`), its Ed25519
 * credential and the per-thread grants of the core (`remote-control.json`) are shared between the
 * old and the new scheme or belong to the new one only, so they stay exactly as they are.
 *
 * Deleting what exists is the marker: a second run finds nothing and reports `removed: []`.
 * A failure is not fatal — the next launch tries again, and until then the token simply stays
 * encrypted on a disk where no code can read it any more.
 */
const LEGACY_FILES = ['bot-token.json', 'service.json'];

export async function removeLegacyPhoneBotData({ userData }) {
  if (!userData) throw new TypeError('removeLegacyPhoneBotData requires userData.');
  const directory = path.join(userData, 'telegram');
  const removed = [], errors = [];
  for (const name of LEGACY_FILES) {
    const file = path.join(directory, name);
    try {
      await stat(file);
      await rm(file, { force: true });
      removed.push(name);
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push(name);
    }
  }
  // Only an empty leftover folder is removed: anything else there was not written by the bot.
  let directoryRemoved = false;
  try {
    const rest = await readdir(directory);
    if (!rest.length) { await rmdir(directory); directoryRemoved = true; }
  } catch { /* missing or busy: the files above are what matters */ }
  return { directory, removed, directoryRemoved, errors };
}

export default removeLegacyPhoneBotData;
