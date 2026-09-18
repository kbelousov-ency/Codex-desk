import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeImage, publicConfig, directoryPath } from '../electron/host-utils.mjs';

test('pasted PNG accepted, disguised executable and oversized input rejected', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  assert.equal(decodeImage({ dataUrl }).extension, 'png');
  assert.throws(() => decodeImage({ dataUrl: 'data:image/png;base64,TVqQAAMAAAAEAAAA' }));
  assert.throws(() => decodeImage({ dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }));
  assert.throws(() => decodeImage({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(28_000_001) }));
});
test('renderer receives model defaults but no provider credentials', () => {
  assert.deepEqual(publicConfig({ model: 'configured-model', model_reasoning_effort: 'high', model_providers: { secret: 'token' }, mcp_servers: { env: 'secret' } }), { model: 'configured-model', model_reasoning_effort: 'high' });
});
test('workspace picker rejects relative paths and files', async () => {
  await assert.rejects(directoryPath('../outside'));
  await assert.rejects(directoryPath(new URL(import.meta.url).pathname));
  assert.equal(typeof await directoryPath(process.cwd()), 'string');
});
