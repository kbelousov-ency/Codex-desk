import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { PORTAL_ORIGIN } from './router-portal.mjs';
import { validateRouterConnection } from './router-connections.mjs';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PUBLIC_ERROR_MESSAGES = {
  cancelled: 'Подключение отменено. Начните подключение заново.',
  expired: 'Время подтверждения истекло. Начните подключение заново.',
  denied: 'Подключение отклонено в браузере.',
  unauthorized: 'Ключ портала больше не действует. Подключитесь заново.',
  forbidden: 'Доступ к Claude отключён на портале.',
  network: 'Не удалось связаться с порталом. Повторите проверку.',
  timeout: 'Портал не ответил вовремя. Повторите проверку.',
  unavailable: 'Портал временно недоступен. Повторите проверку.',
  unsupported: 'Портал пока не предоставляет подключение Claude к Desk по коду. Откройте портал и выберите скачанный установщик подключения Claude.',
  invalid_response: 'Портал вернул некорректные настройки Claude.',
};

function safePortalError(error) {
  const code = Object.hasOwn(PUBLIC_ERROR_MESSAGES, error?.code) ? error.code : 'invalid_response';
  return Object.assign(new Error(PUBLIC_ERROR_MESSAGES[code]), { code, retryable: ['network', 'timeout', 'unavailable'].includes(code) });
}

function publicConnection(config) {
  return { agent: 'claude', providerName: config.providerName || 'Роутер', baseUrl: config.baseUrl,
    model: config.model || null,
    ...(config.modelAliases ? { modelAliases: { ...config.modelAliases } } : {}),
    ...(config.modelNames ? { modelNames: { ...config.modelNames } } : {}) };
}

const publicPreview = preview => ({ ...preview,
  ...(preview.modelAliases ? { modelAliases: { ...preview.modelAliases } } : {}),
  ...(preview.modelNames ? { modelNames: { ...preview.modelNames } } : {}) });

/** Window-owned approval lifecycle. Ready credentials and portal tickets never cross IPC. */
export class ClaudePortalSetupService {
  constructor({ portal, saveConnection, openExternal, assertActive = () => {}, host = os.hostname(),
    now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (typeof saveConnection !== 'function') throw new TypeError('ClaudePortalSetupService requires saveConnection.');
    Object.assign(this, { portal, saveConnection, openExternal, assertActive, host, now, setTimeoutImpl, clearTimeoutImpl });
    this.current = null;
    this.generation = 0;
    this.disposed = false;
    this.applying = false;
  }

  check(flow) {
    if (this.disposed) throw new Error('Окно настройки закрыто.');
    this.assertActive();
    if (flow !== this.current || flow.generation !== this.generation) throw new Error('Подключение отменено.');
    if (flow.expiresAt && this.now() >= flow.expiresAt) {
      this.reset();
      throw new Error('Предпросмотр истёк. Подключите портал заново.');
    }
  }

  reset() {
    this.generation++;
    const flow = this.current;
    this.current = null;
    if (flow) {
      flow.config = null;
      if (flow.timer !== undefined) this.clearTimeoutImpl(flow.timer);
    }
    this.portal?.cancel();
  }

  newFlow() {
    if (this.disposed) throw new Error('Окно настройки закрыто.');
    this.assertActive();
    if (this.applying) throw new Error('Дождитесь сохранения подключения Claude.');
    this.reset();
    const flow = { generation: this.generation, flowId: randomUUID(), config: null, preview: null, polling: null };
    this.current = flow;
    return flow;
  }

  prepareFlow(flow, connection) {
    this.check(flow);
    const config = validateRouterConnection('claude', connection);
    flow.config = config;
    flow.expiresAt = this.now() + PREVIEW_TTL_MS;
    flow.preview = { previewId: randomUUID(), ...publicConnection(config), expiresAt: new Date(flow.expiresAt).toISOString() };
    flow.timer = this.setTimeoutImpl(() => { if (this.current === flow) this.reset(); }, PREVIEW_TTL_MS);
    flow.timer?.unref?.();
    return { state: 'ready', preview: publicPreview(flow.preview) };
  }

  /** Host-only input from a verified portal adapter (for example a selected installer). */
  prepare(connection) {
    const flow = this.newFlow();
    try { return this.prepareFlow(flow, connection); }
    catch (error) { if (this.current === flow) this.reset(); throw error; }
  }

  async start() {
    if (!this.portal) throw safePortalError({ code: 'unsupported' });
    const flow = this.newFlow();
    try {
      let result;
      try { result = await this.portal.start(this.host); }
      catch (error) { throw safePortalError(error); }
      this.check(flow);
      let uri;
      try {
        uri = new URL(result.verificationUri);
        const query = [...uri.searchParams];
        if (uri.origin !== PORTAL_ORIGIN || uri.pathname !== '/device' || uri.username || uri.password || uri.hash
          || query.length !== 1 || query[0][0] !== 'code' || query[0][1] !== result.userCode
          || typeof result.flowId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result.flowId)
          || !/^[A-Z0-9-]{1,32}$/i.test(result.userCode) || typeof result.expiresAt !== 'string'
          || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= this.now()
          || !Number.isInteger(result.intervalMs) || result.intervalMs < 1000 || result.intervalMs > 300_000) throw new Error();
      } catch { throw safePortalError({ code: 'invalid_response' }); }
      flow.flowId = result.flowId;
      flow.verificationUri = uri.href;
      let browserOpened = true;
      try { await this.openExternal(flow.verificationUri); } catch { browserOpened = false; }
      this.check(flow);
      return { flowId: flow.flowId, userCode: result.userCode, verificationUri: flow.verificationUri,
        expiresAt: new Date(result.expiresAt).toISOString(), intervalMs: result.intervalMs, browserOpened };
    } catch (error) {
      if (this.current === flow) this.reset();
      throw error;
    }
  }

  flow(flowId) {
    const flow = this.current;
    if (!flow || typeof flowId !== 'string' || flow.flowId !== flowId) throw new Error('Подключение отменено или истекло. Начните заново.');
    this.check(flow);
    return flow;
  }

  poll(flowId) {
    let flow;
    try { flow = this.flow(flowId); } catch (error) { return Promise.reject(error); }
    if (flow.preview) return Promise.resolve({ state: 'ready', preview: publicPreview(flow.preview) });
    if (!flow.polling) flow.polling = this.pollOnce(flow).finally(() => { flow.polling = null; });
    return flow.polling;
  }

  async pollOnce(flow) {
    try {
      let result;
      try { result = await this.portal.poll(flow.flowId); }
      catch (error) {
        this.check(flow);
        const safe = safePortalError(error);
        if (safe.retryable) return { state: 'pending', intervalMs: 5000 };
        throw safe;
      }
      this.check(flow);
      if (result.state === 'pending') return { state: 'pending', intervalMs: result.intervalMs };
      if (result.state !== 'ready') throw safePortalError({ code: 'invalid_response' });
      return this.prepareFlow(flow, result.config);
    } catch (error) {
      if (this.current === flow) this.reset();
      throw error;
    }
  }

  async openVerification(flowId) {
    const flow = this.flow(flowId);
    if (!flow.verificationUri) throw new Error('Ссылка подтверждения отсутствует.');
    try { await this.openExternal(flow.verificationUri); }
    catch { throw new Error('Не удалось открыть браузер. Попробуйте ещё раз.'); }
  }

  cancel(flowId) {
    if (this.applying) throw new Error('Дождитесь сохранения подключения Claude.');
    if (flowId !== undefined && this.current?.flowId !== flowId) return;
    this.reset();
  }

  async apply(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'previewId')
      || typeof options.previewId !== 'string') throw new Error('Некорректное подтверждение подключения.');
    const flow = this.current;
    if (!flow?.preview || flow.preview.previewId !== options.previewId || !flow.config) throw new Error('Предпросмотр истёк. Подключите портал заново.');
    this.check(flow);
    if (this.applying) throw new Error('Дождитесь сохранения подключения Claude.');
    this.applying = true;
    const config = flow.config;
    flow.config = null;
    try {
      await this.saveConnection(config);
      return { connected: true, ...publicConnection(config) };
    } catch {
      throw new Error('Не удалось сохранить подключение Claude. Подключите портал заново.');
    } finally {
      this.applying = false;
      if (this.current === flow) this.reset();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.portal?.dispose();
  }
}
