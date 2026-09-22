import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decodeImage, publicConfig, directoryPath, findCodex, findClaude } from '../electron/host-utils.mjs';

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

async function cliFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { home: root, env: { LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') },
    platform: 'win32', run: async () => { throw new Error('PATH has not refreshed'); } } };
}

async function executable(filename) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, 'fixture');
  return filename;
}

test('Codex discovery finds standalone install before PATH refresh', async t => {
  const { options } = await cliFixture(t);
  const binary = await executable(path.join(options.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  assert.equal(await findCodex(undefined, options), binary);
});

test('Codex discovery handles custom CODEX_INSTALL_DIR and CODEX_HOME standalone layout', async t => {
  const { root, options } = await cliFixture(t);
  options.env.CODEX_INSTALL_DIR = path.join(root, 'custom-bin');
  const custom = await executable(path.join(options.env.CODEX_INSTALL_DIR, 'codex.exe'));
  assert.equal(await findCodex(undefined, options), custom);
  await rm(custom);
  options.env.CODEX_HOME = path.join(root, 'custom-home');
  const binary = await executable(path.join(options.env.CODEX_HOME, 'packages', 'standalone', 'current', 'bin', 'codex.exe'));
  assert.equal(await findCodex(undefined, options), binary);
});

test('Codex npm discovery supports custom prefix and native ARM64 without executing cmd shims', async t => {
  const { root, options } = await cliFixture(t);
  const prefix = path.join(root, 'npm-custom');
  const binary = await executable(path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'codex', 'codex.exe'));
  const calls = [];
  options.run = async (file, args) => { calls.push({ file, args }); return { stdout: path.join(prefix, 'codex.cmd') }; };
  options.arch = 'arm64';
  assert.equal(await findCodex(undefined, options), binary);
  assert.deepEqual(calls, [{ file: 'where.exe', args: ['codex'] }]);
});

test('Codex npm discovery works even when where reports no match', async t => {
  const { options } = await cliFixture(t);
  const binary = await executable(path.join(options.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
  options.arch = 'x64';
  assert.equal(await findCodex(undefined, options), binary);
});

test('Claude discovery finds native home and modern npm bin without running cmd shims', async t => {
  const { root, options } = await cliFixture(t);
  const native = await executable(path.join(root, '.local', 'bin', 'claude.exe'));
  assert.equal(await findClaude(undefined, options), native);
  await rm(native);
  const binary = await executable(path.join(options.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  assert.equal(await findClaude(undefined, options), binary);
});

test('preferred CLI paths reject directories and command shims', async t => {
  const { root, options } = await cliFixture(t);
  const fakeDirectory = path.join(root, 'codex.exe');
  await mkdir(fakeDirectory);
  await assert.rejects(findCodex(fakeDirectory, options), /исполняемый/);
  await assert.rejects(findClaude(fakeDirectory, options), /claude.exe/);
  await assert.rejects(findCodex(path.join(root, 'codex.cmd'), options), /codex.exe/);
});
