import { randomUUID } from 'node:crypto';

export const PORTAL_ORIGIN = 'https://coder-portal.encycam.com';
const MAX_RESPONSE_BYTES = 64 * 1024;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const messages = {
  cancelled: 'Подключение отменено. Начните подключение заново.',
  expired: 'Время подтверждения истекло. Начните подключение заново.',
  denied: 'Подключение отклонено в браузере.',
  unauthorized: 'Ключ портала больше не действует. Подключитесь заново.',
  forbidden: 'Доступ к Codex отключён на портале.',
  network: 'Не удалось связаться с порталом. Повторите проверку.',
  timeout: 'Портал не ответил вовремя. Повторите проверку.',
  unavailable: 'Портал временно недоступен. Повторите проверку.',
  unsupported: 'Портал пока не поддерживает подключение Codex Desk через браузер.',
  invalid_response: 'Портал вернул некорректные данные подключения.',
};

function portalError(code) {
  return Object.assign(new Error(messages[code] || messages.invalid_response), {
    code, retryable: ['network', 'timeout', 'unavailable'].includes(code),
  });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => !forbiddenKeys.has(key));
}

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function onlyKeys(value, keys) {
  return object(value) && Object.keys(value).every(key => keys.includes(key));
}

function validateConfig(apiKey, provider, defaults) {
  if (!onlyKeys(provider, ['name', 'base_url', 'wire_api', 'requires_openai_auth'])
    || !text(provider.name, 160) || provider.wire_api !== 'responses' || provider.requires_openai_auth !== false
    || !onlyKeys(defaults, ['model', 'model_provider', 'model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary', 'hide_agent_reasoning'])
    || !['model', 'model_provider', 'model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary', 'hide_agent_reasoning'].every(key => Object.hasOwn(defaults, key))
    || !text(defaults.model, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(defaults.model)
    || !text(defaults.model_provider, 128) || !/^[a-zA-Z0-9_-]+$/.test(defaults.model_provider)
    || forbiddenKeys.has(defaults.model_provider)) throw portalError('invalid_response');
  if ([...Object.values(provider), ...Object.values(defaults)].some(value => typeof value === 'string' && value.includes(apiKey))) throw portalError('invalid_response');
  try {
    const url = new URL(provider.base_url);
    if (!text(provider.base_url, 2048) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw portalError('invalid_response'); }
  for (const key of ['model_context_window', 'model_auto_compact_token_limit']) {
    if (Object.hasOwn(defaults, key) && (!Number.isSafeInteger(defaults[key]) || defaults[key] <= 0 || defaults[key] > 100_000_000)) throw portalError('invalid_response');
  }
  if (defaults.model_context_window && defaults.model_auto_compact_token_limit > defaults.model_context_window) throw portalError('invalid_response');
  if (Object.hasOwn(defaults, 'model_reasoning_summary') && !['auto', 'concise', 'detailed', 'none'].includes(defaults.model_reasoning_summary)) throw portalError('invalid_response');
  if (Object.hasOwn(defaults, 'hide_agent_reasoning') && typeof defaults.hide_agent_reasoning !== 'boolean') throw portalError('invalid_response');
  return { apiKey, provider: { ...provider }, defaults: { ...defaults } };
}

function verificationUri(value, code, complete) {
  try {
    const url = new URL(value);
    const entries = [...url.searchParams];
    if (url.origin !== PORTAL_ORIGIN || url.pathname !== '/device' || url.username || url.password || url.hash
      || (complete ? entries.length !== 1 || entries[0][0] !== 'code' || entries[0][1] !== code : entries.length !== 0)) throw new Error();
    return url.href;
  } catch { throw portalError('invalid_response'); }
}

/** Host-only device flow. Never pass the ready config (or this client) to renderer/diagnostics. */
export class RouterPortalClient {
  #flow = null;
  #lastEnd = null;
  #disposed = false;

  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, timers = {}, setTimeoutImpl, clearTimeoutImpl } = {}) {
    if (typeof fetchImpl !== 'function') throw portalError('network');
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimeoutImpl || timers.setTimeout || setTimeout;
    this.clearTimer = clearTimeoutImpl || timers.clearTimeout || clearTimeout;
  }

  #end(flow, code = 'cancelled') {
    if (!flow) return;
    if (flow.expiryTimer !== undefined) this.clearTimer(flow.expiryTimer);
    flow.deviceCode = '';
    flow.apiKey = '';
    flow.controller.abort();
    if (this.#flow === flow) {
      this.#flow = null;
      this.#lastEnd = { id: flow.id, code };
    }
  }

  #assertActive(flow) {
    if (this.#flow !== flow || flow.controller.signal.aborted) throw portalError(this.#lastEnd?.id === flow.id ? this.#lastEnd.code : 'cancelled');
    if (flow.expiresAt && this.now() >= flow.expiresAt) {
      this.#end(flow, 'expired');
      throw portalError('expired');
    }
  }

  #getFlow(id) {
    if (!this.#flow || id !== this.#flow.id) throw portalError(this.#lastEnd?.id === id ? this.#lastEnd.code : 'cancelled');
    this.#assertActive(this.#flow);
    return this.#flow;
  }

  async #request(flow, pathname, { method = 'GET', body, token } = {}) {
    this.#assertActive(flow);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    flow.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = this.setTimer(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(portalError(timedOut ? 'timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const request = async () => {
      const response = await this.fetch(`${PORTAL_ORIGIN}${pathname}`, {
        method, headers: { Accept: 'application/json', 'Cache-Control': 'no-store',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      if (controller.signal.aborted) { void response.body?.cancel?.().catch(() => {}); throw portalError(timedOut ? 'timeout' : 'cancelled'); }
      if (response.status !== 200 && response.status !== 400) {
        void response.body?.cancel?.().catch(() => {});
        if (response.status === 401) throw portalError('unauthorized');
        if (response.status === 403) throw portalError('forbidden');
        if (response.status === 404 || response.status === 405) throw portalError('unsupported');
        if (response.status === 429 || response.status >= 500) throw portalError('unavailable');
        throw portalError('invalid_response');
      }
      if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES || !response.body?.getReader) {
        void response.body?.cancel?.().catch(() => {});
        throw portalError('invalid_response');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw portalError(timedOut ? 'timeout' : 'cancelled');
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) { cancelReader(); throw portalError('invalid_response'); }
          chunks.push(Buffer.from(chunk.value));
        }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch { throw portalError('invalid_response'); }
        if (!object(value)) throw portalError('invalid_response');
        return { status: response.status, value };
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        reader.releaseLock();
      }
    };
    try {
      const result = await Promise.race([request(), aborted]);
      this.#assertActive(flow);
      return result;
    } catch (error) {
      this.#assertActive(flow);
      if (error?.code && Object.hasOwn(messages, error.code)) throw portalError(error.code);
      throw portalError(timedOut ? 'timeout' : 'network');
    } finally {
      this.clearTimer(timer);
      controller.signal.removeEventListener('abort', abortListener);
      flow.controller.signal.removeEventListener('abort', abort);
    }
  }

  async start(host) {
    if (this.#disposed) throw portalError('cancelled');
    this.cancel();
    const flow = { id: randomUUID(), controller: new AbortController(), deviceCode: '', apiKey: '', expiresAt: 0, pending: null };
    this.#flow = flow;
    try {
      const { status, value } = await this.#request(flow, '/api/device/codex', {
        method: 'POST', body: { client: 'Codex Desk', host: text(host, 255) ? host : 'Windows' },
      });
      if (status !== 200 || !text(value.device_code, 4096) || !text(value.user_code, 32) || !/^[A-Z0-9-]+$/i.test(value.user_code)
        || value.user_code.includes(value.device_code) || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 3600
        || !Number.isInteger(value.interval) || value.interval < 1 || value.interval > 300) throw portalError('invalid_response');
      verificationUri(value.verification_uri, value.user_code, false);
      flow.verificationUri = verificationUri(value.verification_uri_complete, value.user_code, true);
      flow.deviceCode = value.device_code;
      flow.intervalMs = value.interval * 1000;
      flow.expiresAt = this.now() + value.expires_in * 1000;
      flow.nextPollAt = this.now() + flow.intervalMs;
      flow.expiryTimer = this.setTimer(() => this.#end(flow, 'expired'), value.expires_in * 1000);
      flow.expiryTimer?.unref?.();
      return { flowId: flow.id, userCode: value.user_code, verificationUri: flow.verificationUri, expiresAt: new Date(flow.expiresAt).toISOString(), intervalMs: flow.intervalMs };
    } catch (error) {
      this.#end(flow);
      throw error;
    }
  }

  verificationUri(flowId) { return this.#getFlow(flowId).verificationUri; }

  poll(flowId) {
    let flow;
    try { flow = this.#getFlow(flowId); } catch (error) { return Promise.reject(error); }
    if (flow.pending) return flow.pending;
    if (this.now() < flow.nextPollAt) return Promise.resolve({ state: 'pending', intervalMs: flow.nextPollAt - this.now() });
    const pending = this.#poll(flow).finally(() => { if (flow.pending === pending) flow.pending = null; });
    flow.pending = pending;
    return pending;
  }

  async #poll(flow) {
    try {
      flow.nextPollAt = this.now() + flow.intervalMs;
      if (!flow.apiKey) {
        const { status, value } = await this.#request(flow, '/api/device/codex/token', { method: 'POST', body: { device_code: flow.deviceCode } });
        if (status === 400) {
          if (value.error === 'authorization_pending' || value.error === 'slow_down') {
            if (value.error === 'slow_down') flow.intervalMs = Math.min(flow.intervalMs + 5000, 300_000);
            flow.nextPollAt = this.now() + flow.intervalMs;
            return { state: 'pending', intervalMs: flow.intervalMs };
          }
          if (value.error === 'access_denied') throw portalError('denied');
          if (value.error === 'expired_token') throw portalError('expired');
          throw portalError('invalid_response');
        }
        if (!text(value.api_key, 8192) || !/^[\x21-\x7e]+$/.test(value.api_key)) throw portalError('invalid_response');
        flow.apiKey = value.api_key;
        flow.deviceCode = '';
      }
      const provider = await this.#request(flow, '/api/codex/provider', { token: flow.apiKey });
      const defaults = await this.#request(flow, '/api/codex/defaults', { token: flow.apiKey });
      if (provider.status !== 200 || defaults.status !== 200) throw portalError('invalid_response');
      const config = validateConfig(flow.apiKey, provider.value, defaults.value);
      this.#assertActive(flow);
      this.#end(flow);
      return { state: 'ready', config };
    } catch (error) {
      if (!error.retryable) this.#end(flow, error.code);
      throw error;
    }
  }

  cancel(flowId) {
    if (this.#flow && (flowId === undefined || flowId === this.#flow.id)) this.#end(this.#flow);
  }

  dispose() { this.#disposed = true; this.cancel(); }
}
