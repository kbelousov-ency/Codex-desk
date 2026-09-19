import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export async function directoryPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Нужен абсолютный путь к папке.');
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw new Error('Выберите папку проекта.');
  return resolved;
}

export async function findCodex(preferred) {
  if (preferred) {
    if (!path.isAbsolute(preferred)) throw new Error('Укажите полный путь к Codex.');
    await access(preferred);
    if (process.platform === 'win32' && path.extname(preferred).toLowerCase() !== '.exe') throw new Error('Выберите исполняемый файл codex.exe.');
    return preferred;
  }
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { windowsHide: true, timeout: 5000 });
    for (const candidate of stdout.trim().split(/\r?\n/)) {
      if (process.platform !== 'win32' || candidate.toLowerCase().endsWith('.exe')) return candidate;
    }
    // npm installs a .cmd shim on Windows; launch its native binary directly.
    const nativeRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
    await access(nativeRoot);
    return nativeRoot;
  } catch { /* Fall through to an installed VS Code Codex binary. */ }
  for (const extensionRoot of [path.join(os.homedir(), '.vscode', 'extensions'), path.join(os.homedir(), '.vscode-insiders', 'extensions')]) {
    try {
      const versions = (await readdir(extensionRoot)).filter(name => name.startsWith('openai.chatgpt-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const binary = path.join(extensionRoot, version, 'bin', process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
        try { await access(binary); return binary; } catch { /* Try next version. */ }
      }
    } catch { /* This editor is not installed. */ }
  }
  throw new Error('Codex не найден. Установите Codex CLI или выберите codex.exe в настройках подключения.');
}

export async function findClaude(preferred) {
  if (preferred) {
    if (!path.isAbsolute(preferred) || (process.platform === 'win32' && path.extname(preferred).toLowerCase() !== '.exe')) throw new Error('Выберите установленный claude.exe.');
    await access(preferred); return preferred;
  }
  const candidates = [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')];
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { windowsHide: true, timeout: 5000 });
    candidates.push(...stdout.trim().split(/\r?\n/).filter(Boolean));
  } catch { /* Native home installation remains available without PATH. */ }
  for (const candidate of candidates) {
    if (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe')) continue;
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try another known executable. */ }
  }
  throw new Error('Claude Code не найден. Установите Claude Code CLI и войдите в него, либо выберите claude.exe в настройках подключения.');
}

export function decodeImage(image) {
  if (!image || typeof image.dataUrl !== 'string') throw new Error('Некорректное изображение.');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.dataUrl);
  if (!match || match[2].length > 28_000_000) throw new Error('Поддерживаются PNG, JPEG, WebP и GIF до 20 МБ.');
  const bytes = Buffer.from(match[2], 'base64');
  const kind = match[1];
  const valid = kind === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : kind === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : kind === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid || bytes.length > 20 * 1024 * 1024) throw new Error('Файл не является поддерживаемым изображением.');
  return { bytes, extension: kind === 'jpeg' ? 'jpg' : kind };
}

export function publicConfig(config = {}) {
  // Config can contain credentials in custom provider/MCP settings. Never send it wholesale to the renderer.
  return Object.fromEntries(['model', 'model_reasoning_effort', 'model_reasoning_summary', 'sandbox_mode', 'approval_policy', 'approvals_reviewer', 'service_tier', 'model_provider'].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}
