import os from 'node:os';
import { CodexClient } from './codex-client.mjs';
import { findCodex } from './host-utils.mjs';
import { PortalConfigManager } from './portal-config.mjs';

/** Owned by one window. Only public metadata crosses the setup bridge. */
export class PortalSetupService {
  constructor({ portal, getSettings, openExternal, assertActive = () => {}, assertAvailable = () => {},
    runMutation, resolveExecutable = findCodex, createClient = options => new CodexClient(options),
    createManager = options => new PortalConfigManager(options), host = os.hostname(), cwd = os.homedir() }) {
    Object.assign(this, { portal, getSettings, openExternal, assertActive, assertAvailable, runMutation,
      resolveExecutable, createClient, createManager, host, cwd });
    this.current = null;
    this.generation = 0;
    this.disposed = false;
    this.applying = false;
  }

  check(flow) {
    if (this.disposed) throw new Error('Окно настройки закрыто.');
    this.assertActive();
    if (flow !== this.current || flow.generation !== this.generation) throw new Error('Подключение отменено.');
  }

  reset() {
    this.generation++;
    const flow = this.current;
    this.current = null;
    this.portal.cancel();
    flow?.manager?.dispose();
    flow?.client?.stop();
  }

  async start() {
    if (this.disposed) throw new Error('Окно настройки закрыто.');
    this.assertActive(); this.assertAvailable();
    if (this.applying) throw new Error('Дождитесь сохранения конфигурации.');
    this.reset();
    const flow = { generation: this.generation, client: null, manager: null, connecting: null, polling: null, preview: null };
    this.current = flow;
    try {
      const settings = await this.getSettings();
      this.check(flow);
      flow.preferredExecutable = settings.executable;
      flow.executable = await this.resolveExecutable(settings.executable);
      this.check(flow);
      const result = await this.portal.start(this.host);
      this.check(flow);
      flow.flowId = result.flowId;
      flow.verificationUri = result.verificationUri;
      let browserOpened = true;
      try { await this.openExternal(flow.verificationUri); } catch { browserOpened = false; }
      this.check(flow);
      return { flowId: result.flowId, userCode: result.userCode, verificationUri: result.verificationUri,
        expiresAt: result.expiresAt, intervalMs: result.intervalMs, browserOpened };
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

  async request(flow, method, params) {
    this.check(flow);
    const settings = await this.getSettings();
    this.check(flow);
    if (settings.executable !== flow.preferredExecutable) throw new Error('Выбранный Codex изменился. Подключите портал заново.');
    if (!flow.connecting) {
      flow.connecting = (async () => {
        flow.client = this.createClient({ executable: flow.executable, cwd: this.cwd, requestTimeoutMs: 30_000 });
        await flow.client.start();
        this.check(flow);
      })();
    }
    await flow.connecting;
    this.check(flow);
    const result = await flow.client.request(method, params);
    this.check(flow);
    return result;
  }

  poll(flowId) {
    let flow;
    try { flow = this.flow(flowId); }
    catch (error) { return Promise.reject(error); }
    try { this.assertAvailable(); }
    catch { return Promise.resolve({ state: 'pending', intervalMs: 1000 }); }
    if (flow.preview) return Promise.resolve({ state: 'ready', preview: flow.preview });
    if (!flow.polling) flow.polling = this.pollOnce(flow).finally(() => { flow.polling = null; });
    return flow.polling;
  }

  async pollOnce(flow) {
    try {
      let result;
      try { result = await this.portal.poll(flow.flowId); }
      catch (error) {
        this.check(flow);
        if (error?.retryable) return { state: 'pending', intervalMs: 5000 };
        throw error;
      }
      this.check(flow);
      if (result.state === 'pending') return { state: 'pending', intervalMs: result.intervalMs };
      if (result.state !== 'ready') throw new Error('Портал не подтвердил подключение. Начните заново.');
      flow.manager = this.createManager({ request: (method, params) => this.request(flow, method, params), assertActive: () => this.check(flow) });
      flow.preview = await flow.manager.preview(result.config);
      this.check(flow);
      return { state: 'ready', preview: flow.preview };
    } catch (error) {
      if (this.current === flow) this.reset();
      throw error;
    }
  }

  async openVerification(flowId) {
    const flow = this.flow(flowId);
    try { await this.openExternal(flow.verificationUri); }
    catch { throw new Error('Не удалось открыть браузер. Попробуйте ещё раз.'); }
  }

  cancel(flowId) {
    if (this.applying) throw new Error('Дождитесь сохранения конфигурации.');
    if (flowId !== undefined && this.current?.flowId !== flowId) return;
    this.reset();
  }

  async apply(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'previewId')
      || typeof options.previewId !== 'string') throw new Error('Некорректное подтверждение настроек.');
    const flow = this.current;
    if (!flow?.preview || flow.preview.previewId !== options.previewId) throw new Error('Предпросмотр истёк. Подключите портал заново.');
    this.check(flow);
    try { this.assertAvailable(); }
    catch { return { blocked: true, message: 'Дождитесь завершения настройки Codex, затем повторите применение.' }; }
    if (this.applying) throw new Error('Дождитесь сохранения конфигурации.');
    this.applying = true;
    let entered = false;
    try {
      return await this.runMutation(async () => {
        entered = true;
        this.check(flow);
        return await flow.manager.save({ previewId: options.previewId });
      });
    } catch (error) {
      if (!entered) return { blocked: true, message: 'Завершите текущие задачи, подтверждения и работу в терминале Codex, затем повторите применение.' };
      throw error;
    } finally {
      this.applying = false;
      // A busy tab can be finished before retrying the same public preview.
      if (entered && this.current === flow) this.reset();
    }
  }

  dispose() { if (!this.disposed) { this.reset(); this.disposed = true; this.portal.dispose(); } }
}
