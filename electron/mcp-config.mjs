import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';

const MAX_IMPORT_BYTES = 256 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COMMON_FIELDS = new Set(['enabled', 'required', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools', 'default_tools_approval_mode', 'tools']);
const HTTP_FIELDS = new Set(['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'auth']);
const STDIO_FIELDS = new Set(['command', 'args', 'env', 'env_vars', 'cwd']);
const APPROVAL_MODES = new Set(['auto', 'prompt', 'writes', 'approve']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const cleanString = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value);
const processString = value => typeof value === 'string' && !value.includes('\u0000');
const nonemptyString = value => cleanString(value) && value.trim().length > 0;
const stringList = value => Array.isArray(value) && value.every(nonemptyString);
const positiveNumber = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const digest = bytes => bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');

// Error messages deliberately contain field names only, never values or parser excerpts.
function fieldError(field, reason = 'имеет неверный формат') {
  const label = /^[a-z][a-z0-9_.]{0,80}$/.test(field) ? ` «${field}»` : '';
  return new Error(`Поле${label} ${reason}. Проверьте блок MCP.`);
}

function validMap(value, keyPattern, validateValue) {
  return record(value) && Object.entries(value).every(([key, item]) => keyPattern.test(key) && validateValue(item));
}

function httpUrl(value) {
  if (!nonemptyString(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url : null;
  } catch { return null; }
}

function validateServer(server) {
  if (!record(server)) throw new Error('Каждый MCP-сервер должен быть таблицей [mcp_servers.имя].');
  const http = own(server, 'url');
  const stdio = own(server, 'command');
  if (http === stdio) throw new Error('Для каждого MCP-сервера укажите либо url, либо command.');
  const transportFields = http ? HTTP_FIELDS : STDIO_FIELDS;
  for (const field of Object.keys(server)) {
    if (!COMMON_FIELDS.has(field) && !transportFields.has(field)) {
      throw fieldError(field, 'не поддерживается для этого подключения');
    }
  }
  if (http && !httpUrl(server.url)) throw fieldError('url', 'должно содержать адрес http:// или https://');
  if (stdio && !nonemptyString(server.command)) throw fieldError('command');
  for (const field of ['enabled', 'required']) {
    if (own(server, field) && typeof server[field] !== 'boolean') throw fieldError(field);
  }
  for (const field of ['startup_timeout_sec', 'tool_timeout_sec']) {
    if (own(server, field) && !positiveNumber(server[field])) throw fieldError(field, 'должно быть положительным числом секунд');
  }
  if (own(server, 'args') && (!Array.isArray(server.args) || !server.args.every(processString))) throw fieldError('args', 'должно быть массивом строк');
  for (const field of ['enabled_tools', 'disabled_tools']) {
    if (own(server, field) && !stringList(server[field])) throw fieldError(field, 'должно быть массивом строк');
  }
  if (own(server, 'cwd') && !nonemptyString(server.cwd)) throw fieldError('cwd');
  if (own(server, 'env') && !validMap(server.env, ENV_NAME, processString)) throw fieldError('env');
  if (own(server, 'env_vars') && (!stringList(server.env_vars) || !server.env_vars.every(value => ENV_NAME.test(value)))) throw fieldError('env_vars', 'должно быть массивом имён переменных окружения');
  if (own(server, 'http_headers') && !validMap(server.http_headers, HEADER_NAME, cleanString)) throw fieldError('http_headers');
  if (own(server, 'env_http_headers') && !validMap(server.env_http_headers, HEADER_NAME, value => typeof value === 'string' && ENV_NAME.test(value))) throw fieldError('env_http_headers');
  if (own(server, 'bearer_token_env_var') && (typeof server.bearer_token_env_var !== 'string' || !ENV_NAME.test(server.bearer_token_env_var))) throw fieldError('bearer_token_env_var');
  if (own(server, 'auth') && !['oauth', 'chatgpt'].includes(server.auth)) throw fieldError('auth', 'должно быть oauth или chatgpt');
  if (own(server, 'default_tools_approval_mode') && !APPROVAL_MODES.has(server.default_tools_approval_mode)) throw fieldError('default_tools_approval_mode');
  if (own(server, 'tools')) {
    if (!record(server.tools)) throw fieldError('tools');
    for (const policy of Object.values(server.tools)) {
      if (!record(policy)) throw fieldError('tools');
      for (const field of Object.keys(policy)) {
        if (!['approval_mode', 'output_token_limit'].includes(field)) throw fieldError(`tools.${field}`, 'не поддерживается');
      }
      if (own(policy, 'approval_mode') && !APPROVAL_MODES.has(policy.approval_mode)) throw fieldError('tools.approval_mode');
      if (own(policy, 'output_token_limit') && (!Number.isSafeInteger(policy.output_token_limit) || policy.output_token_limit < 1)) throw fieldError('tools.output_token_limit');
    }
  }
}

function normalizeJsonImport(value) {
  if (!record(value) || Object.keys(value).length !== 1 || !own(value, 'mcpServers') || !record(value.mcpServers)) {
    throw new Error('JSON должен содержать только объект mcpServers с настройками серверов.');
  }
  const servers = Object.create(null);
  for (const [name, config] of Object.entries(value.mcpServers)) {
    if (!record(config)) throw new Error('Каждый MCP-сервер в JSON должен быть объектом настроек.');
    // Retain every ordinary field for the canonical validator. Never silently
    // discard unknown options or interpret user keys as object prototypes.
    const server = Object.create(null);
    for (const [field, item] of Object.entries(config)) {
      if (field !== 'type' && field !== 'headers') server[field] = item;
    }
    if (own(config, 'type')) {
      if (['http', 'streamable-http'].includes(config.type)) {
        if (!own(config, 'url') || own(config, 'command')) throw new Error('Для HTTP-сервера в JSON укажите url без command.');
      } else if (config.type === 'stdio') {
        if (!own(config, 'command') || own(config, 'url')) throw new Error('Для stdio-сервера в JSON укажите command без url.');
      } else throw new Error('Поддерживаемые типы MCP в JSON: http, streamable-http и stdio.');
    }
    if (own(config, 'headers')) {
      if (own(config, 'http_headers')) throw new Error('Не указывайте headers и http_headers одновременно.');
      server.http_headers = config.headers;
    }
    servers[name] = server;
  }
  return { mcp_servers: servers };
}

function parseImport(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Вставьте настройки MCP в формате TOML или JSON с объектом mcpServers.');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('Блок MCP слишком большой: максимум 256 КБ.');
  let source = text.trim().replace(/^\uFEFF/, '');
  const fenced = source.match(/^```(toml|json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) source = fenced[2];
  let parsed;
  if (source.trimStart().startsWith('{') || fenced?.[1]?.toLowerCase() === 'json') {
    let json;
    try { json = JSON.parse(source.trim()); }
    catch { throw new Error('Некорректный JSON. Проверьте двойные кавычки, запятые и скобки.'); }
    parsed = normalizeJsonImport(json);
  } else {
    try { parsed = TOML.parse(source); }
    catch (error) {
      const line = Number.isSafeInteger(error?.line) ? `, строка ${error.line + 1}` : '';
      throw new Error(`Некорректный TOML${line}. Вставьте блоки [mcp_servers.имя] или JSON с объектом mcpServers.`);
    }
  }
  if (!record(parsed) || Object.keys(parsed).length !== 1 || !own(parsed, 'mcp_servers') || !record(parsed.mcp_servers)) {
    throw new Error('Можно импортировать только таблицы [mcp_servers.имя] и их вложенные настройки. Удалите остальные разделы.');
  }
  const entries = Object.entries(parsed.mcp_servers);
  if (!entries.length || entries.length > 100) throw new Error('Вставьте настройки от 1 до 100 MCP-серверов.');
  for (const [name, server] of entries) {
    if (!NAME.test(name)) throw new Error('Имя MCP-сервера: от 1 до 128 латинских букв, цифр, дефисов или подчёркиваний.');
    validateServer(server);
  }
  return parsed.mcp_servers;
}

function summary(name, value) {
  const server = record(value) ? value : {};
  const url = httpUrl(server.url);
  // Never include URL userinfo, query/fragment, process arguments, env or header values.
  const address = url ? `${url.protocol}//${url.host}${url.pathname}`
    : typeof server.command === 'string' ? server.command : '';
  return {
    name,
    transport: typeof server.url === 'string' ? 'http' : 'stdio',
    address,
    enabled: server.enabled !== false,
    headerNames: [...new Set([
      ...Object.keys(record(server.http_headers) ? server.http_headers : {}),
      ...Object.keys(record(server.env_http_headers) ? server.env_http_headers : {}),
      ...(typeof server.bearer_token_env_var === 'string' ? ['Authorization'] : []),
    ])].sort(),
    envNames: [...new Set([
      ...Object.keys(record(server.env) ? server.env : {}),
      ...(Array.isArray(server.env_vars) ? server.env_vars.filter(value => typeof value === 'string') : []),
      ...Object.values(record(server.env_http_headers) ? server.env_http_headers : {}).filter(value => typeof value === 'string'),
      ...(typeof server.bearer_token_env_var === 'string' ? [server.bearer_token_env_var] : []),
    ])].sort(),
  };
}

/** Import secrets stay in the host until a single-use preview is saved or expires. */
export class McpConfigManager {
  constructor({ request, assertActive = () => {}, readFile: read = readFile, writeFile: write = writeFile, now = Date.now } = {}) {
    if (typeof request !== 'function') throw new TypeError('McpConfigManager requires request.');
    this._request = request;
    this._assertActive = assertActive;
    this._read = read;
    this._write = write;
    this._now = now;
    this._pending = null;
    this._generation = 0;
    this._saving = false;
    this._timer = null;
  }

  invalidate() {
    this._generation += 1;
    this._pending = null;
    clearTimeout(this._timer);
    this._timer = null;
  }

  dispose() { this.invalidate(); }

  _active(generation = this._generation) {
    try { this._assertActive(); }
    catch { throw new Error('Подключение Codex изменилось. Подключитесь и проверьте блок MCP заново.'); }
    if (generation !== this._generation) throw new Error('Проверка MCP больше не актуальна. Проверьте блок заново.');
  }

  async _snapshot() {
    let response;
    try { response = await this._request('config/read', { includeLayers: true }); }
    catch { throw new Error('Не удалось прочитать конфигурацию Codex. Проверьте подключение.'); }
    const layers = response?.layers?.filter?.(layer => layer?.name?.type === 'user' && layer.name.profile == null) ?? [];
    if (layers.length !== 1 || typeof layers[0].name.file !== 'string' || !path.isAbsolute(layers[0].name.file)
      || typeof layers[0].version !== 'string' || !layers[0].version || layers[0].disabledReason) {
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
    return {
      configPath: layer.name.file,
      version: layer.version,
      servers: record(layer.config?.mcp_servers) ? layer.config.mcp_servers : {},
      bytes,
      hash: digest(bytes),
    };
  }

  async list() {
    const generation = this._generation;
    this._active(generation);
    const snapshot = await this._snapshot();
    this._active(generation);
    return { configPath: snapshot.configPath, servers: Object.entries(snapshot.servers).map(([name, server]) => summary(name, server)) };
  }

  async preview(text) {
    if (this._saving) throw new Error('Дождитесь сохранения MCP-серверов.');
    this.invalidate();
    const generation = this._generation;
    this._active(generation);
    const servers = parseImport(text);
    const snapshot = await this._snapshot();
    this._active(generation);
    const previewId = randomUUID();
    const conflicts = Object.keys(servers).filter(name => own(snapshot.servers, name));
    this._pending = { previewId, servers, configPath: snapshot.configPath, version: snapshot.version, hash: snapshot.hash,
      expiresAt: this._now() + PREVIEW_TTL_MS, conflicts };
    this._timer = setTimeout(() => this.invalidate(), PREVIEW_TTL_MS);
    this._timer.unref?.();
    return {
      previewId,
      configPath: snapshot.configPath,
      servers: Object.entries(servers).map(([name, server]) => ({ ...summary(name, server), exists: conflicts.includes(name) })),
      conflicts,
    };
  }

  async save({ previewId, replaceExisting = false } = {}) {
    if (this._saving) throw new Error('Дождитесь сохранения MCP-серверов.');
    const pending = this._pending;
    if (!pending || typeof previewId !== 'string' || pending.previewId !== previewId || pending.expiresAt <= this._now()) {
      if (pending?.expiresAt <= this._now()) this.invalidate();
      throw new Error('Проверка MCP истекла или была отменена. Вставьте и проверьте блок заново.');
    }
    if (pending.conflicts.length && replaceExisting !== true) throw new Error('Подтвердите замену существующих MCP-серверов или отмените импорт.');
    const generation = this._generation;
    this._active(generation);
    this._saving = true;
    try {
      const snapshot = await this._snapshot();
      this._active(generation);
      if (snapshot.configPath !== pending.configPath || snapshot.version !== pending.version || snapshot.hash !== pending.hash) {
        this.invalidate();
        throw new Error('Конфигурация Codex изменилась после проверки. Проверьте блок MCP заново.');
      }
      let backupPath = null;
      if (snapshot.bytes !== null) {
        backupPath = `${snapshot.configPath}.backup-${new Date(this._now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
        try { await this._write(backupPath, snapshot.bytes, { flag: 'wx', mode: 0o600 }); }
        catch { throw new Error('Не удалось создать резервную копию config.toml. Настройки не сохранены.'); }
      }
      this._active(generation);
      let result;
      try {
        result = await this._request('config/batchWrite', {
          edits: Object.entries(pending.servers).map(([name, server]) => ({ keyPath: `mcp_servers.${name}`, value: server, mergeStrategy: 'replace' })),
          filePath: snapshot.configPath,
          expectedVersion: snapshot.version,
          reloadUserConfig: false,
        });
      } catch {
        this.invalidate();
        throw new Error('Codex не подтвердил сохранение MCP. Обновите список и проверьте конфигурацию; повторный импорт требует новой проверки.');
      }
      this.invalidate();
      if (!['ok', 'okOverridden'].includes(result?.status)) {
        throw new Error('Codex не подтвердил результат записи. Обновите список MCP-серверов перед повторной попыткой.');
      }
      return {
        configPath: snapshot.configPath,
        backupPath,
        servers: Object.keys(pending.servers),
        ...(result.status === 'okOverridden' ? { message: 'Настройки сохранены, но часть значений переопределена другим уровнем конфигурации Codex.' } : {}),
      };
    } finally { this._saving = false; }
  }
}
