import path from 'node:path';
import { PORTAL_ORIGIN } from './router-portal.mjs';
import { validateRouterConnection } from './router-connections.mjs';

const MAX_SCRIPT_BYTES = 128 * 1024;
const INSTALLER_PATH = /^\/api\/connect\/claude\/([A-Za-z0-9_-]{43})\.exe$/;
const INSTALLER_NAME = /^claude-connect-([A-Za-z0-9_-]{43})(?: \(\d{1,4}\))?\.exe$/i;
const ALIASES = ['opus', 'fable', 'sonnet', 'haiku'];
const MESSAGES = {
  invalid_installer: 'Выберите установщик подключения Claude, скачанный с портала.',
  expired: 'Ссылка подключения Claude истекла или уже использована. Скачайте новый установщик на портале.',
  invalid_response: 'Портал вернул неподдерживаемые настройки Claude. Скачайте новый установщик подключения.',
  network: 'Не удалось получить настройки Claude с портала. Повторите подключение.',
  timeout: 'Портал не ответил вовремя. Повторите подключение Claude.',
  unavailable: 'Портал временно недоступен. Повторите подключение Claude позже.',
};
const error = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.invalid_response), {
  code, retryable: ['network', 'timeout', 'unavailable'].includes(code),
});

function downloadToken(value) {
  try {
    const url = new URL(value);
    if (url.origin !== PORTAL_ORIGIN || url.username || url.password || url.search || url.hash) return null;
    return INSTALLER_PATH.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

export function isClaudeInstallerDownloadUrl(value) {
  return typeof value === 'string' && downloadToken(value) !== null;
}

function installerToken(source) {
  if (typeof source !== 'string' || !source || source.length > 32768 || /[\x00-\x1f\x7f]/.test(source)) throw error('invalid_installer');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
    const token = downloadToken(source);
    if (!token) throw error('invalid_installer');
    return token;
  }
  const token = INSTALLER_NAME.exec(path.win32.basename(path.basename(source)))?.[1];
  if (!token) throw error('invalid_installer');
  return token;
}

/** Static data extraction only. PowerShell, executable code, hooks and other environment settings are never run or applied. */
export function parseClaudeInstallerScript(scriptText) {
  if (typeof scriptText !== 'string' || Buffer.byteLength(scriptText, 'utf8') > MAX_SCRIPT_BYTES) throw error('invalid_response');
  const blocks = [...scriptText.matchAll(/^\$envJson\s*=\s*@'\r?\n(?<json>[\s\S]*?)\r?\n'@\s*$/gm)];
  if (blocks.length === 0) throw error('expired');
  if (blocks.length !== 1) throw error('invalid_response');
  let env;
  try { env = JSON.parse(blocks[0].groups.json); } catch { throw error('invalid_response'); }
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.keys(env).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw error('invalid_response');
  const connection = {
    apiKey: env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: env.ANTHROPIC_BASE_URL,
    authScheme: 'bearer',
    providerName: 'ENCY router',
  };
  const modelAliases = {}, modelNames = {};
  for (const alias of ALIASES) {
    const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    if (Object.hasOwn(env, key)) modelAliases[alias] = env[key];
    if (Object.hasOwn(env, `${key}_NAME`)) modelNames[alias] = env[`${key}_NAME`];
  }
  if (Object.keys(modelAliases).length) connection.modelAliases = modelAliases;
  if (Object.keys(modelNames).length) connection.modelNames = modelNames;
  try { return validateRouterConnection('claude', connection); }
  catch { throw error('invalid_response'); }
}

/** Retrieve the script tied to a selected installer, using its ticket only at the originating portal. */
export async function downloadClaudeInstallerConfig(source, { fetchImpl = globalThis.fetch, timeoutMs = 15_000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const token = installerToken(source);
  if (typeof fetchImpl !== 'function') throw error('network');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeoutImpl(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(error('timeout'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const request = async () => {
    const response = await fetchImpl(`${PORTAL_ORIGIN}/api/connect/claude/${token}.ps1`, {
      headers: { Accept: 'text/plain', 'Cache-Control': 'no-store' }, signal: controller.signal,
      redirect: 'error', credentials: 'omit', cache: 'no-store',
    });
    if (controller.signal.aborted) { void response.body?.cancel?.().catch(() => {}); throw error('timeout'); }
    if (response.status !== 200) {
      void response.body?.cancel?.().catch(() => {});
      if ([401, 403, 404, 410].includes(response.status)) throw error('expired');
      if (response.status === 429 || response.status >= 500) throw error('unavailable');
      throw error('invalid_response');
    }
    if (Number(response.headers?.get('content-length')) > MAX_SCRIPT_BYTES || !response.body?.getReader) {
      void response.body?.cancel?.().catch(() => {});
      throw error('invalid_response');
    }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw error('timeout');
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_SCRIPT_BYTES) { cancelReader(); throw error('invalid_response'); }
        chunks.push(Buffer.from(chunk.value));
      }
      return parseClaudeInstallerScript(Buffer.concat(chunks, length).toString('utf8'));
    } finally {
      controller.signal.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  };
  try { return await Promise.race([request(), aborted]); }
  catch (cause) {
    // Never expose a raw network error: its URL contains the personal installer ticket.
    throw error(Object.hasOwn(MESSAGES, cause?.code) ? cause.code : timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeoutImpl(timer);
    controller.signal.removeEventListener('abort', abortListener);
  }
}
