import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CodexClient } from './codex-client.mjs';
import { findCodex } from './host-utils.mjs';
import { PortalConfigManager } from './portal-config.mjs';
import { RouterPortalClient, PORTAL_ORIGIN } from './router-portal.mjs';

const PRODUCTS = ['codex', 'claude'];
const DROP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'];
const MODEL_NAMES = new Set(['OPUS', 'FABLE', 'SONNET', 'HAIKU'].flatMap(family =>
  ['ANTHROPIC_DEFAULT_' + family + '_MODEL', 'ANTHROPIC_DEFAULT_' + family + '_MODEL_NAME']));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = message => Object.assign(new Error(message), { publicMessage: true });

function claudeEnv(payload) {
  const env = payload?.settings?.env;
  if (!object(env) || Object.entries(env).some(([name, value]) => typeof value !== 'string'
    || (name.startsWith('ANTHROPIC_DEFAULT_') && name.includes('_MODEL') && !MODEL_NAMES.has(name)))) {
    throw failure('Portal вернул некорректные переменные Claude.');
  }
  try {
    const url = new URL(env.ANTHROPIC_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw failure('Portal вернул небезопасный адрес Claude.'); }
  if (typeof env.ANTHROPIC_AUTH_TOKEN !== 'string' || !env.ANTHROPIC_AUTH_TOKEN.trim() || /[\r\n\0]/.test(env.ANTHROPIC_AUTH_TOKEN)) {
    throw failure('Portal не вернул пригодный ключ Claude.');
  }
  return env;
}

export class PortalConnectService {
  #secrets = new Set();

  constructor({ portalSession, session, scan, getSettings = async () => ({}), env = process.env,
    fetchImpl = globalThis.fetch, routerPortal = new RouterPortalClient({ fetchImpl }),
    resolveExecutable = findCodex, createClient = options => new CodexClient(options),
    createManager = options => new PortalConfigManager(options), runMutation = (_product, task) => task(),
    routerConnections, boatswainSetup, reconnectAfterSetup = () => {}, files = fs, now = Date.now,
    uuid = randomUUID, timeoutMs = 15_000, cwd = os.homedir() }) {
    Object.assign(this, { portalSession, session, scan, getSettings, env, fetchImpl, routerPortal,
      resolveExecutable, createClient, createManager, runMutation, routerConnections, boatswainSetup,
      reconnectAfterSetup, files, now, uuid, timeoutMs, cwd });
    this.current = { running: false, products: {} };
    this.generation = 0;
    this.controllers = new Set();
  }

  status() {
    const snapshot = structuredClone(this.current);
    for (const result of Object.values(snapshot.products)) for (const name of ['message', 'configPath', 'backupPath']) {
      if (typeof result[name] === 'string') for (const secret of this.#secrets) result[name] = result[name].replaceAll(secret, '[скрыто]');
    }
    return snapshot;
  }

  _check(generation) { if (generation !== this.generation) throw failure('Подключение отменено.'); }
  _set(generation, product, value) { if (generation === this.generation) this.current.products[product] = value; }

  cancel() {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.routerPortal.cancel();
    this.current.running = false;
    for (const product of PRODUCTS) if (this.current.products[product]?.state === 'working') this.current.products[product] = { state: 'error', message: 'Подключение отменено.' };
  }

  async connect({ products = PRODUCTS } = {}) {
    if (this.current.running) return this.status();
    const selected = Array.isArray(products) ? PRODUCTS.filter(product => products.includes(product)) : PRODUCTS;
    const generation = ++this.generation;
    this.current = { running: true, products: Object.fromEntries(selected.map(product => [product, { state: 'idle' }])) };
    try {
      const sessionStatus = await this.portalSession.status();
      this._check(generation);
      if (sessionStatus.state !== 'signed-in') throw failure('Войдите в Portal.');
      if (sessionStatus.keyState !== 'approved') throw failure('Ключ Portal на паузе или ещё не одобрен. Дождитесь одобрения.');
      const key = await this.portalSession.routerKey();
      this._check(generation);
      if (!key) {
        const latest = await this.portalSession.status();
        this._check(generation);
        throw failure(latest.state === 'signed-in' ? 'Ключ Portal на паузе или недоступен.' : 'Войдите в Portal.');
      }
      this.#secrets.add(key);
      const scan = await this.scan();
      this._check(generation);
      for (const product of selected) {
        this._check(generation);
        if (sessionStatus.products?.[product] !== true) { this._set(generation, product, { state: 'skipped', message: 'Portal не даёт доступ.' }); continue; }
        const component = scan?.components?.find(component => component.id === product);
        if (component?.status !== 'installed') { this._set(generation, product, { state: 'skipped', message: 'CLI ' + product + ' не установлен или недоступен.' }); continue; }
        const result = { state: 'working' };
        this._set(generation, product, result);
        try {
          if (product === 'codex') await this._codex(generation, key, result);
          else await this._claude(generation, result);
          this._check(generation);
          this._set(generation, product, { ...result, state: 'done', message: 'Подключение проверено.' });
        } catch (error) {
          this._set(generation, product, { ...result, state: error?.skipped ? 'skipped' : 'error', message: this._message(error, result) });
        }
      }
    } catch (error) {
      for (const product of selected) this._set(generation, product, { state: 'error', message: this._message(error, {}) });
    } finally { if (generation === this.generation) this.current.running = false; }
    return this.status();
  }

  _message(error, result) {
    let message = error?.verification ? error.message + (error.status === 401 ? ' Войдите в Portal снова.' : '')
      : error?.status === 401 || error?.code === 'unauthorized' ? 'Сессия или ключ Portal истекли. Войдите в Portal снова.'
      : error?.publicMessage ? error.message : 'Не удалось подключить CLI. Проверьте Portal и повторите попытку.';
    if (Object.hasOwn(result, 'configPath')) message += ' Резервная копия: ' + (result.backupPath || 'не создана — файла раньше не было') + '. Записанные настройки не откатывались.';
    return message;
  }

  async _mutate(generation, product, task) {
    let entered = false;
    let result;
    try {
      result = await this.runMutation(product, async () => { entered = true; this._check(generation); return task(); });
    } catch (error) {
      if (!entered) throw failure('Завершите текущие задачи, подтверждения и работу в терминале ' + product + ', затем повторите подключение.');
      throw error;
    }
    this._check(generation);
    if (result?.blocked) throw failure(result.message || 'Текущая задача блокирует запись настроек.');
    return result;
  }

  async _codex(generation, key, result) {
    const payload = await this.routerPortal.config(key);
    this._check(generation);
    const settings = await this.getSettings('codex');
    this._check(generation);
    let executable;
    try { executable = await this.resolveExecutable(settings.executable); }
    catch { throw Object.assign(failure('Выбранный Codex CLI не установлен или недоступен. Повторите проверку установки.'), { skipped: true }); }
    this._check(generation);
    let client;
    let manager;
    let connecting;
    try {
      manager = this.createManager({
        assertActive: () => this._check(generation),
        request: async (method, params) => {
          this._check(generation);
          const latest = await this.getSettings('codex');
          this._check(generation);
          if (latest.executable !== settings.executable) throw failure('Выбранный Codex изменился. Повторите подключение.');
          connecting ??= (async () => {
            client = this.createClient({ executable, cwd: this.cwd, requestTimeoutMs: 30_000 });
            await client.start();
          })();
          await connecting;
          this._check(generation);
          const response = await client.request(method, params);
          this._check(generation);
          return response;
        },
      });
      const preview = await manager.preview(payload);
      this._check(generation);
      await this._mutate(generation, 'codex', async () => {
        const saved = await manager.save({ previewId: preview.previewId });
        this._check(generation);
        if (saved?.blocked) return saved;
        Object.assign(result, { configPath: saved.configPath, backupPath: saved.backupPath ?? null });
        await this._verify(generation, payload.provider.base_url, key);
        this._check(generation);
        await this.reconnectAfterSetup('codex', 'Настройки с портала сохранены. Подключение обновлено.');
      });
    } finally { manager?.dispose(); client?.stop(); }
  }

  async _json(generation, url, { cookie = false, key } = {}) {
    this._check(generation);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(failure('Portal не ответил вовремя или подключение отменено.'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const request = async () => {
        const options = { method: 'GET', credentials: cookie ? 'include' : 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', 'Cache-Control': 'no-store', ...(key ? { Authorization: 'Bearer ' + key } : {}) } };
        const session = typeof this.session === 'function' ? this.session() : this.session;
        const response = await (cookie ? session.fetch(url, options) : this.fetchImpl(url, options));
        if (!response.ok) throw Object.assign(failure('Portal отклонил запрос подключения.'), { status: response.status });
        if (Number(response.headers?.get?.('content-length')) > 64 * 1024) throw failure('Ответ Portal превышает 64 КиБ.');
        const chunks = [];
        let size = 0;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 64 * 1024) { await reader.cancel(); throw failure('Ответ Portal превышает 64 КиБ.'); }
              chunks.push(Buffer.from(value));
            }
          } finally { reader.releaseLock(); }
        } else {
          const text = await response.text();
          if (Buffer.byteLength(text) > 64 * 1024) throw failure('Ответ Portal превышает 64 КиБ.');
          chunks.push(Buffer.from(text));
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw failure('Portal вернул некорректный JSON.'); }
      };
      const value = await Promise.race([request(), aborted]);
      this._check(generation);
      return value;
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort(); this.controllers.delete(controller); }
  }

  async _verify(generation, baseUrl, key) {
    try { await this._json(generation, baseUrl.replace(/\/+$/, '') + '/models', { key }); }
    catch (error) {
      if (error?.status) throw Object.assign(failure('Проверка подключения через роутер не прошла (HTTP ' + error.status + ').'), { status: error.status, verification: true });
      throw error;
    }
  }

  async _read(filename) {
    try { return await this.files.readFile(filename); }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure('Не удалось прочитать ' + filename + '.'); }
  }

  async _writeClaude(generation, env, result) {
    const home = this.env.USERPROFILE || os.homedir();
    const filename = path.join(this.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
    const original = await this._read(filename);
    this._check(generation);
    let backupPath = null;
    if (original !== null) {
      backupPath = filename + '.backup-' + new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '-' + this.uuid();
      await this.files.writeFile(backupPath, original, { flag: 'wx', mode: 0o600 });
      result.backupPath = backupPath;
      this._check(generation);
    }
    let existing = {};
    try { if (original !== null) existing = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw failure('Некорректный JSON в ' + filename + '. Резервная копия: ' + backupPath + '.'); }
    if (!object(existing) || (existing.env !== undefined && !object(existing.env))) throw failure('Настройки или env не являются объектом в ' + filename + '. Резервная копия: ' + backupPath + '.');
    const merged = { ...existing.env };
    for (const name of DROP) delete merged[name];
    // claude.ps1 Write-Settings merges env only; portal model/effort/update extras must not replace user preferences.
    const output = { ...existing, env: { ...merged, ...env } };
    await this.files.mkdir(path.dirname(filename), { recursive: true });
    this._check(generation);
    const temporary = filename + '.tmp-' + this.uuid();
    try {
      await this.files.writeFile(temporary, JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      this._check(generation);
      const current = await this._read(filename);
      this._check(generation);
      if ((original === null) !== (current === null) || (original !== null && !original.equals(current))) throw failure('Настройки изменились во время подключения: ' + filename + '. Резервная копия: ' + backupPath + '.');
      await this.files.rename(temporary, filename);
      this._check(generation);
      Object.assign(result, { configPath: filename, backupPath });
    } finally { await this.files.rm(temporary, { force: true }); }
  }

  async _claude(generation, result) {
    const payload = await this._json(generation, PORTAL_ORIGIN + '/api/config/claude?scope=global', { cookie: true });
    const env = claudeEnv(payload);
    this.#secrets.add(env.ANTHROPIC_AUTH_TOKEN);
    this._check(generation);
    await this._mutate(generation, 'claude', async () => {
      await this._writeClaude(generation, env, result);
      const baseUrl = env.ANTHROPIC_BASE_URL.replace(/\/+$/, '');
      // connect.py:185 uses a separate /v1 base for Claude verification; gateway/app.py:951 serves only /v1/models.
      await this._verify(generation, baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1', env.ANTHROPIC_AUTH_TOKEN);
      this._check(generation);
      const connection = await this.boatswainSetup.readClaudeConnection();
      this._check(generation);
      if (!connection) throw failure('Не удалось прочитать записанное подключение Claude.');
      await this.routerConnections.set('claude', connection);
      this._check(generation);
      await this.reconnectAfterSetup('claude', 'Claude подключён через роутер.');
    });
  }
}
