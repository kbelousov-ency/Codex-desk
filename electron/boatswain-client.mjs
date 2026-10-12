export const DEFAULT_PORTAL_ORIGIN = 'https://coder-portal.encycam.com';
const MAX_JSON_BYTES = 256 * 1024;

function origin(value) {
  const url = new URL(value || DEFAULT_PORTAL_ORIGIN);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Некорректный адрес портала.');
  return url.origin;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function responseText(response, maxBytes) {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('Портал вернул слишком большой ответ.');
  return body;
}

function statusError(status) {
  if (status === 401 || status === 403) return Object.assign(new Error('Ключ роутера отклонён Portal.'), { code: 'unauthorized' });
  if (status === 409) return Object.assign(new Error('На Portal нет одобренного ключа роутера.'), { code: 'router-key-missing' });
  if (status >= 500) return Object.assign(new Error('Portal временно недоступен.'), { code: 'unavailable' });
  return Object.assign(new Error(`Portal вернул HTTP ${status}.`), { code: 'http-error' });
}

/** Router-key reads of the Boatswain relay. The key stays in these host requests. */
export class BoatswainClient {
  constructor({ portalOrigin = DEFAULT_PORTAL_ORIGIN, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('В этой среде недоступен HTTP-клиент.');
    this.origin = origin(portalOrigin);
    this.fetch = fetchImpl;
  }

  async machines(apiKey) { return this._keyRequest('/api/relay/boatswain/machines', apiKey, 'machines'); }
  async limits(apiKey) { return this._keyRequest('/api/relay/limits', apiKey, 'limits'); }

  async _keyRequest(pathname, apiKey, field) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\0]/.test(apiKey)) throw new Error('Router key недоступен.');
    const response = await this.fetch(`${this.origin}${pathname}`, { method: 'GET', credentials: 'omit', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Cache-Control': 'no-store' }, redirect: 'error' });
    if (!response.ok) throw statusError(response.status);
    const body = JSON.parse(await responseText(response, MAX_JSON_BYTES));
    if (!object(body) || !(field in body)) throw new Error('Портал вернул некорректные данные.');
    return body[field];
  }
}
