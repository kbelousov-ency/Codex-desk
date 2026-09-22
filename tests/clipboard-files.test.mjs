import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readClipboardFilePaths, WINDOWS_CLIPBOARD_FILES_SCRIPT } from '../electron/clipboard-files.mjs';

const fixture = result => ({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async () => ({ stdout: JSON.stringify(result) }) });

test('Windows clipboard returns every selected Unicode path without executing its text', async () => {
  const files = ['C:\\данные\\[пример] $name.txt', 'D:\\outside\\a`b.pdf'];
  let calls = 0;
  assert.deepEqual(await readClipboardFilePaths({ ...fixture({ files }), run: async (executable, args, options) => {
    calls++;
    assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), WINDOWS_CLIPBOARD_FILES_SCRIPT);
    assert.ok(WINDOWS_CLIPBOARD_FILES_SCRIPT.includes('::GetFileDropList()'));
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    return { stdout: `\uFEFF${JSON.stringify({ files })}` };
  } }), files);
  assert.equal(calls, 1);
});

test('empty clipboard and unsupported platform do not create file references', async () => {
  assert.equal(await readClipboardFilePaths(fixture({ files: [] })), null);
  assert.equal(await readClipboardFilePaths({ platform: 'linux', run: () => assert.fail('No Windows process on another platform') }), null);
});

test('clipboard rejects excessive or malformed results without returning a partial batch', async () => {
  await assert.rejects(readClipboardFilePaths(fixture({ tooMany: true })), /20 файлов/);
  for (const result of [null, {}, { files: 'C:\\file.pdf' }, { files: [''] }, { files: [1] }, { files: ['x'.repeat(32769)] }, { files: Array(21).fill('C:\\file.pdf') }]) {
    await assert.rejects(readClipboardFilePaths(fixture(result)), /Некорректные файлы/);
  }
});

test('timeouts and helper failures are bounded and never leak subprocess output', async () => {
  for (const run of [async () => { throw new Error('secret helper stderr'); }, async () => ({ stdout: 'invalid secret output' })]) {
    await assert.rejects(readClipboardFilePaths({ ...fixture({ files: [] }), run }), error => {
      assert.equal(error.message, 'Не удалось прочитать файлы из буфера обмена. Повторите вставку.');
      return true;
    });
  }
});

test('native STA helper serializes empty and multiple file collections as JSON without touching the clipboard', { skip: process.platform !== 'win32' }, async () => {
  const run = promisify(execFile);
  for (const files of [[], ['C:\\документы\\[пример] $name.txt', 'D:\\second file.pdf']]) {
    const reader = files.length ? `@(${files.map(file => `'${file.replaceAll("'", "''")}'`).join(', ')})` : '@()';
    const result = await readClipboardFilePaths({ run: async (executable, args, options) => {
      const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const stubbed = source.replace('[System.Windows.Forms.Clipboard]::GetFileDropList()', reader);
      assert.ok(!stubbed.includes('::GetFileDropList()'), 'The native clipboard is never read by this test');
      return run(executable, [...args.slice(0, -1), Buffer.from(stubbed, 'utf16le').toString('base64')], options);
    } });
    assert.deepEqual(result, files.length ? files : null);
  }
});
