import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportPayload, saveConversation } from '../electron/conversation-export.mjs';

test('export validates format and bounds and restricts default filename', () => {
  assert.equal(exportPayload({ format: 'markdown', content: 'Привет', filename: '../folder/CON.html' }).filename, 'Беседа.md');
  assert.equal(exportPayload({ format: 'html', content: 'Text', filename: 'Пример?.md' }).filename, 'Пример_.html');
  assert.throws(() => exportPayload({ format: 'exe', content: '' }));
  assert.throws(() => exportPayload({ format: 'markdown', content: 'x'.repeat(32 * 1024 * 1024 + 1) }));
});

test('native export cancellation writes nothing and chosen path receives exact UTF-8', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'desk-export-'));
  try {
    const filePath = path.join(folder, 'chat.md');
    const payload = { format: 'markdown', filename: 'Беседа.md', content: '# Беседа\n\nПривет <world>\n' };
    assert.deepEqual(await saveConversation(payload, async () => ({ canceled: true })), { canceled: true });
    assert.deepEqual(await saveConversation(payload, async options => { assert.equal(options.filters[0].extensions[0], 'md'); return { canceled: false, filePath }; }), { canceled: false, path: filePath });
    assert.equal(await readFile(filePath, 'utf8'), payload.content);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
