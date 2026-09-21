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

export function codexNativeCandidates({ env = process.env, home = env.USERPROFILE || os.homedir(), platform = process.platform } = {}) {
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [path.join(home, '.local', 'bin', binary)];
  if (platform === 'win32') {
    if (env.CODEX_INSTALL_DIR && path.isAbsolute(env.CODEX_INSTALL_DIR)) candidates.unshift(path.join(env.CODEX_INSTALL_DIR, binary));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', binary));
    const codexHome = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
    candidates.push(path.join(codexHome, 'packages', 'standalone', 'current', 'bin', binary), path.join(codexHome, 'packages', 'standalone', 'current', binary));
  }
  return candidates;
}

function npmCodexCandidates(root, arch) {
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  return [path.join(root, 'node_modules', '@openai', `codex-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'vendor', triple, 'codex', 'codex.exe'),
    path.join(root, 'vendor', triple, 'codex', 'codex.exe')];
}

export async function findCodex(preferred, options = {}) {
  const { env = process.env, home = env.USERPROFILE || os.homedir(), platform = process.platform, arch = process.arch, run = execFileAsync } = options;
  if (preferred) {
    if (!path.isAbsolute(preferred)) throw new Error('Укажите полный путь к Codex.');
    if (platform === 'win32' && path.extname(preferred).toLowerCase() !== '.exe') throw new Error('Выберите исполняемый файл codex.exe.');
    if (!(await stat(preferred)).isFile()) throw new Error('Выберите исполняемый файл codex.exe.');
    return preferred;
  }
  const candidates = [];
  try {
    const { stdout } = await run(platform === 'win32' ? 'where.exe' : 'which', ['codex'], { env, shell: false, windowsHide: true, timeout: 5000 });
    for (const candidate of stdout.trim().split(/\r?\n/)) {
      if (!candidate) continue;
      if (platform !== 'win32' || candidate.toLowerCase().endsWith('.exe')) candidates.push(candidate);
      else if (/\.cmd$/i.test(candidate)) candidates.push(...npmCodexCandidates(path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex'), arch));
    }
  } catch { /* PATH may be stale immediately after native installation. */ }
  candidates.push(...codexNativeCandidates({ env, home, platform, arch }));
  if (platform === 'win32' && env.APPDATA) candidates.push(...npmCodexCandidates(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'), arch));
  for (const candidate of [...new Set(candidates)]) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next installation. */ }
  }
  for (const extensionRoot of [path.join(home, '.vscode', 'extensions'), path.join(home, '.vscode-insiders', 'extensions')]) {
    try {
      const versions = (await readdir(extensionRoot)).filter(name => name.startsWith('openai.chatgpt-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const binary = path.join(extensionRoot, version, 'bin', platform === 'win32' ? `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${platform === 'darwin' ? 'macos' : 'linux'}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, platform === 'win32' ? 'codex.exe' : 'codex');
        try { await access(binary); return binary; } catch { /* Try next version. */ }
      }
    } catch { /* This editor is not installed. */ }
  }
  throw new Error('Codex не найден. Установите Codex CLI или выберите codex.exe в настройках подключения.');
}

function npmClaudeCandidates(root, arch) {
  return [path.join(root, 'bin', 'claude.exe'), path.join(root, 'node_modules', '@anthropic-ai', `claude-code-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'claude.exe')];
}

export async function findClaude(preferred, { env = process.env, home = env.USERPROFILE || os.homedir(), platform = process.platform, arch = process.arch, run = execFileAsync } = {}) {
  if (preferred) {
    if (!path.isAbsolute(preferred) || (platform === 'win32' && path.extname(preferred).toLowerCase() !== '.exe')) throw new Error('Выберите установленный claude.exe.');
    if (!(await stat(preferred)).isFile()) throw new Error('Выберите установленный claude.exe.');
    return preferred;
  }
  const candidates = [path.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')];
  try {
    const { stdout } = await run(platform === 'win32' ? 'where.exe' : 'which', ['claude'], { env, shell: false, windowsHide: true, timeout: 5000 });
    for (const candidate of stdout.trim().split(/\r?\n/).filter(Boolean)) {
      candidates.push(candidate);
      if (platform === 'win32' && /\.cmd$/i.test(candidate)) candidates.push(...npmClaudeCandidates(path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code'), arch));
    }
  } catch { /* Native home installation remains available without PATH. */ }
  if (platform === 'win32' && env.APPDATA) candidates.push(...npmClaudeCandidates(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'), arch));
  for (const candidate of candidates) {
    if (platform === 'win32' && !candidate.toLowerCase().endsWith('.exe')) continue;
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
