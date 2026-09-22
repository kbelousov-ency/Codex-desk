import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { COMPOSER_FILE_LIMIT } from './composer-files.mjs';

// CF_HDROP contains every Explorer selection. FileNameW, exposed by Electron's
// custom-format API, contains only the first path. Use Windows' supported STA
// clipboard reader instead; never interpolate clipboard/renderer text as code.
export const WINDOWS_CLIPBOARD_FILES_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$composerFiles = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($composerFiles.Count -gt ${COMPOSER_FILE_LIMIT}) {
  [Console]::Write('{"tooMany":true}')
} else {
  $composerResult = @{ files = @($composerFiles | ForEach-Object { [string]$_ }) }
  [Console]::Write((ConvertTo-Json -InputObject $composerResult -Compress -Depth 2))
}
`;

/** Read only on an explicit paste. No text/image clipboard reads or writes. */
export async function readClipboardFilePaths({ platform = process.platform, env = process.env, run = promisify(execFile) } = {}) {
  if (platform !== 'win32') return null;
  const executable = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let result;
  try {
    const { stdout } = await run(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(WINDOWS_CLIPBOARD_FILES_SCRIPT, 'utf16le').toString('base64'),
    ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Не удалось прочитать файлы из буфера обмена. Повторите вставку.');
  }
  if (result?.tooMany === true) throw new Error('За один раз можно добавить не больше 20 файлов.');
  if (!result || !Array.isArray(result.files) || result.files.length > COMPOSER_FILE_LIMIT
    || result.files.some(file => typeof file !== 'string' || !file || file.length > 32768)) {
    throw new Error('Некорректные файлы в буфере обмена. Скопируйте их ещё раз.');
  }
  return result.files.length ? result.files : null;
}
