import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAttachment, hydrateAttachmentPreviews } from '../electron/attachments.mjs';

test('archive attachment hydration reads only owned image paths and preserves message text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-archive-attachments-'));
  try {
    const owned = path.join(dir, 'owned'); await mkdir(owned);
    const imagePath = path.join(owned, 'image.png'), externalPath = path.join(dir, 'external.png'), textPath = path.join(owned, 'secret.txt');
    await Promise.all([writeFile(imagePath, Buffer.from('image')), writeFile(externalPath, 'outside'), writeFile(textPath, 'secret')]);
    const dataUrl = 'data:image/png;base64,aW1hZ2U=';
    assert.equal(await readAttachment(owned, imagePath), dataUrl);
    assert.equal(await readAttachment(owned, externalPath), null);
    assert.equal(await readAttachment(owned, textPath), null);
    assert.equal(await readAttachment(owned, 'image.png'), null);
    const content = [{ type: 'text', text: 'Keep my message' }, { type: 'localImage', path: imagePath }, { type: 'localImage', path: externalPath }];
    const [message] = await hydrateAttachmentPreviews([{ id: 'message', type: 'userMessage', content }], owned);
    assert.equal(message.content, content);
    assert.equal(message.previews[0].dataUrl, dataUrl);
    assert.equal(message.previews[1].dataUrl, undefined);
    const tooLarge = path.join(owned, 'large.png'); await writeFile(tooLarge, Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.equal(await readAttachment(owned, tooLarge), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
