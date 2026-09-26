import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FIELDS = ['model', 'model_provider', 'model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary', 'hide_agent_reasoning'];
const PROVIDER_FIELDS = ['name', 'base_url', 'wire_api', 'requires_openai_auth'];
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const digest = bytes => bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');
const fieldError = () => new Error('Портал вернул неподдерживаемые настройки Codex. Подключитесь через браузер заново.');

function cleanUrl(value) {
  if (!text(value, 2048)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash ? value : null;
  } catch { return null; }
}

function normalize(payload) {
  const { apiKey, provider, defaults } = record(payload) ? payload : {};
  if (!text(apiKey, 8192) || !record(provider) || !record(defaults)
    || !text(provider.name, 160) || !cleanUrl(provider.base_url)
    || provider.wire_api !== 'responses' || provider.requires_openai_auth !== false
    || typeof defaults.model !== 'string' || !MODEL.test(defaults.model)
    || typeof defaults.model_provider !== 'string' || !IDENTIFIER.test(defaults.model_provider)
    || ['__proto__', 'prototype', 'constructor'].includes(defaults.model_provider)
    || !positiveInteger(defaults.model_context_window) || !positiveInteger(defaults.model_auto_compact_token_limit)
    || defaults.model_auto_compact_token_limit > defaults.model_context_window
    || !REASONING_SUMMARIES.has(defaults.model_reasoning_summary) || typeof defaults.hide_agent_reasoning !== 'boolean') throw fieldError();
  if ([...DEFAULT_FIELDS.map(key => defaults[key]), ...PROVIDER_FIELDS.map(key => provider[key])]
    .some(value => typeof value === 'string' && value.includes(apiKey))) throw fieldError();
  // A fixed set of fields is copied; API metadata can never become arbitrary config edits.
  return {
    defaults: Object.fromEntries(DEFAULT_FIELDS.map(key => [key, defaults[key]])),
    provider: { ...Object.fromEntries(PROVIDER_FIELDS.map(key => [key, provider[key]])), experimental_bearer_token: apiKey },
  };
}

function safeValue(key, value) {
  if (value === undefined || value === null) return null;
  if (key === 'model') return typeof value === 'string' && MODEL.test(value) ? value : 'Настроено';
  if (key === 'model_provider') return typeof value === 'string' && IDENTIFIER.test(value) ? value : 'Настроено';
  if (key === 'name') return text(value, 160) ? value : 'Настроено';
  if (key === 'base_url') return cleanUrl(value) || 'Настроено';
  if (key === 'wire_api') return ['responses', 'chat'].includes(value) ? value : 'Настроено';
  if (key === 'model_reasoning_summary') return REASONING_SUMMARIES.has(value) ? value : 'Настроено';
  if (key === 'model_context_window' || key === 'model_auto_compact_token_limit') return positiveInteger(value) ? value : 'Настроено';
  if (key === 'requires_openai_auth' || key === 'hide_agent_reasoning') return typeof value === 'boolean' ? value : 'Настроено';
  return 'Настроено';
}

function editsFor(config, input) {
  const id = input.defaults.model_provider;
  const providers = config.model_providers;
  if (providers !== undefined && !record(providers)) throw new Error('Раздел провайдеров Codex имеет неподдерживаемый формат. Проверьте config.toml.');
  const old = own(providers ?? {}, id) ? providers[id] : {};
  if (!record(old)) throw new Error('Настройки выбранного провайдера Codex имеют неподдерживаемый формат. Проверьте config.toml.');
  const secrets = [input.provider.experimental_bearer_token];
  for (const item of Object.values(providers ?? {})) {
    if (!record(item)) continue;
    if (text(item.experimental_bearer_token, 8192)) secrets.push(item.experimental_bearer_token);
    if (record(item.http_headers)) for (const value of Object.values(item.http_headers)) {
      if (!text(value, 8192)) continue;
      secrets.push(value);
      if (/^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i, ''));
    }
  }
  if ([...Object.values(input.defaults), ...PROVIDER_FIELDS.map(key => input.provider[key])]
    .some(value => typeof value === 'string' && secrets.some(secret => value.includes(secret)))) throw fieldError();
  const publicValue = (key, value) => typeof value === 'string' && secrets.some(secret => value.includes(secret)) ? 'Настроено' : safeValue(key, value);
  const edits = [
    ...DEFAULT_FIELDS.map(key => ({ keyPath: key, value: input.defaults[key], mergeStrategy: 'replace' })),
    ...Object.entries(input.provider).map(([key, value]) => ({ keyPath: `model_providers.${id}.${key}`, value, mergeStrategy: 'replace' })),
  ];
  const changes = DEFAULT_FIELDS.map(key => ({ key, before: publicValue(key, config[key]), after: publicValue(key, input.defaults[key]) }));
  for (const key of PROVIDER_FIELDS) changes.push({ key: `model_providers.${id}.${key}`, before: publicValue(key, old[key]), after: publicValue(key, input.provider[key]) });
  changes.push({ key: `model_providers.${id}.experimental_bearer_token`, before: own(old, 'experimental_bearer_token') ? 'Сохранённый ключ' : null, after: 'Ключ из браузера' });
  // A provider must have one effective auth source. Preserve unrelated headers/options.
  for (const key of ['env_key', 'env_key_instructions']) {
    if (!own(old, key)) continue;
    edits.push({ keyPath: `model_providers.${id}.${key}`, value: null, mergeStrategy: 'replace' });
    changes.push({ key: `model_providers.${id}.${key}`, before: 'Настроено', after: 'Удалено: используется ключ из браузера' });
  }
  for (const key of ['http_headers', 'env_http_headers']) {
    if (!record(old[key])) {
      if (own(old, key)) throw new Error('Заголовки выбранного провайдера Codex имеют неподдерживаемый формат. Проверьте config.toml.');
      continue;
    }
    const authHeaders = Object.keys(old[key]).filter(name => name.toLowerCase() === 'authorization');
    if (!authHeaders.length) continue;
    for (const header of authHeaders) edits.push({ keyPath: `model_providers.${id}.${key}.${header}`, value: null, mergeStrategy: 'replace' });
    changes.push({ key: `model_providers.${id}.${key}.Authorization`, before: 'Настроено', after: 'Удалено: используется ключ из браузера' });
  }
  return { edits, changes, publicValue };
}

/** Browser-issued credentials stay in host memory until Apply, expiry, cancellation or disposal. */
export class PortalConfigManager {
  constructor({ request, assertActive = () => {}, readFile: read = readFile, writeFile: write = writeFile, now = Date.now } = {}) {
    if (typeof request !== 'function') throw new TypeError('PortalConfigManager requires request.');
    this._request = request;
    this._assertActive = assertActive;
    this._read = read;
    this._write = write;
    this._now = now;
    this._generation = 0;
    this._pending = null;
    this._timer = null;
    this._saving = false;
    this._disposed = false;
  }

  invalidate() {
    this._generation += 1;
    this._pending = null;
    clearTimeout(this._timer);
    this._timer = null;
  }

  dispose() { this._disposed = true; this.invalidate(); }

  _active(generation = this._generation, expiresAt = Infinity) {
    try { this._assertActive(); }
    catch { throw new Error('Подключение Codex изменилось. Подключитесь через браузер заново.'); }
    if (this._disposed || generation !== this._generation || expiresAt <= this._now()) {
      throw new Error('Проверка настроек истекла или была отменена. Подключитесь через браузер заново.');
    }
  }

  async _snapshot() {
    let response;
    try { response = await this._request('config/read', { includeLayers: true }); }
    catch { throw new Error('Не удалось прочитать конфигурацию Codex. Проверьте подключение.'); }
    const layers = Array.isArray(response?.layers) ? response.layers.filter(layer => layer?.name?.type === 'user' && layer.name.profile == null) : [];
    if (layers.length !== 1 || typeof layers[0].name.file !== 'string' || !path.isAbsolute(layers[0].name.file)
      || typeof layers[0].version !== 'string' || !layers[0].version || layers[0].disabledReason || !record(layers[0].config)) {
      throw new Error('Codex не сообщил доступный пользовательский config.toml. Обновите Codex и переподключитесь.');
    }
    const layer = layers[0];
    let bytes;
    try { bytes = await this._read(layer.name.file); }
    catch (error) {
      if (error?.code === 'ENOENT') bytes = null;
      else throw new Error('Не удалось прочитать пользовательский config.toml. Проверьте доступ к файлу.');
    }
    if (bytes !== null && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    return { configPath: layer.name.file, config: layer.config, version: layer.version, bytes, hash: digest(bytes) };
  }

  async preview(payload) {
    if (this._saving) throw new Error('Дождитесь сохранения настроек Codex.');
    this.invalidate();
    const generation = this._generation;
    this._active(generation);
    const input = normalize(payload);
    const snapshot = await this._snapshot();
    this._active(generation);
    const { edits, changes, publicValue } = editsFor(snapshot.config, input);
    const previewId = randomUUID();
    this._pending = { previewId, edits, configPath: snapshot.configPath, version: snapshot.version, hash: snapshot.hash,
      model: publicValue('model', input.defaults.model), providerName: publicValue('model_provider', input.defaults.model_provider), expiresAt: this._now() + PREVIEW_TTL_MS };
    this._timer = setTimeout(() => this.invalidate(), PREVIEW_TTL_MS);
    this._timer.unref?.();
    return { previewId, configPath: snapshot.configPath, exists: snapshot.bytes !== null,
      model: publicValue('model', input.defaults.model), providerName: publicValue('model_provider', input.defaults.model_provider), providerLabel: publicValue('name', input.provider.name),
      baseUrl: publicValue('base_url', input.provider.base_url), changes };
  }

  async save({ previewId } = {}) {
    if (this._saving) throw new Error('Дождитесь сохранения настроек Codex.');
    const pending = this._pending;
    if (!pending || typeof previewId !== 'string' || pending.previewId !== previewId || pending.expiresAt <= this._now()) {
      if (pending?.expiresAt <= this._now()) this.invalidate();
      throw new Error('Проверка настроек истекла или была отменена. Подключитесь через браузер заново.');
    }
    const generation = this._generation;
    this._active(generation, pending.expiresAt);
    // Consume before awaiting: even failed or concurrent saves cannot replay this secret-bearing preview.
    this._pending = null;
    clearTimeout(this._timer);
    this._timer = null;
    this._saving = true;
    try {
      const snapshot = await this._snapshot();
      this._active(generation, pending.expiresAt);
      if (snapshot.configPath !== pending.configPath || snapshot.version !== pending.version || snapshot.hash !== pending.hash) {
        throw new Error('Конфигурация Codex изменилась после проверки. Подключитесь через браузер заново.');
      }
      let backupPath = null;
      if (snapshot.bytes !== null) {
        backupPath = `${snapshot.configPath}.backup-${new Date(this._now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
        try { await this._write(backupPath, snapshot.bytes, { flag: 'wx', mode: 0o600 }); }
        catch { throw new Error('Не удалось создать резервную копию config.toml. Настройки не сохранены.'); }
      }
      this._active(generation, pending.expiresAt);
      let result;
      try {
        result = await this._request('config/batchWrite', { edits: pending.edits, filePath: snapshot.configPath,
          expectedVersion: snapshot.version, reloadUserConfig: false });
      } catch {
        throw new Error('Codex не подтвердил сохранение настроек. Проверьте конфигурацию; повторная попытка требует нового подключения через браузер.');
      }
      this._active(generation);
      if (!['ok', 'okOverridden'].includes(result?.status)) {
        throw new Error('Codex не подтвердил результат записи. Проверьте конфигурацию перед повторной попыткой.');
      }
      return { configPath: snapshot.configPath, backupPath, model: pending.model, providerName: pending.providerName,
        ...(result.status === 'okOverridden' ? { message: 'Настройки сохранены, но часть значений переопределена другим уровнем конфигурации Codex.' } : {}) };
    } finally { this.invalidate(); this._saving = false; }
  }
}
