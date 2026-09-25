import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat, lstat, open, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import TOML from '@iarna/toml';
import { findCodex, findClaude } from './host-utils.mjs';
import { MemoryRulesService } from './memory-rules.mjs';

const execFileAsync = promisify(execFile);
const IDS = new Set(['codex', 'claude', 'git']);
const LABELS = { codex: 'Codex CLI', claude: 'Claude Code CLI', git: 'Git' };
const INSTALL_URLS = { codex: 'https://chatgpt.com/codex/install.ps1', claude: 'https://claude.ai/install.ps1' };
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const hash = bytes => bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');
const staleConfig = 'Файл или конфигурация Codex изменились после проверки. Выберите файл заново.';

function componentId(id) {
  if (!IDS.has(id)) throw new Error('Неизвестный компонент установки.');
  return id;
}

function versionFrom(stdout, id) {
  // Only a recognized version is public: CLI output can contain arbitrary text or credentials.
  const patterns = {
    codex: /(?:^|\n)\s*(?:codex(?:-cli)?\s+v?)(\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.]+)?)(?:\s|$)/i,
    claude: /(?:^|\n)\s*(?:claude(?: code)?\s+v?)?(\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.]+)?)(?:\s+\(Claude Code\)|\s*$)/i,
    git: /(?:^|\n)\s*git version (\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.]+)?)(?:\s|$)/i,
  };
  return String(stdout || '').match(patterns[id])?.[1] ?? null;
}

async function findGit({ env, home, platform, run }) {
  const candidates = [];
  try {
    const result = await run(platform === 'win32' ? 'where.exe' : 'which', ['git'], { env, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    candidates.push(...String(result.stdout).trim().split(/\r?\n/).filter(Boolean));
  } catch { /* A just-installed Git may not be on this process's PATH. */ }
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'));
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || (platform === 'win32' && !/\.exe$/i.test(candidate))) continue;
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try another candidate. */ }
  }
  throw new Error('Git не найден.');
}

/** Local setup only. No model calls, credentials reads, or automatic installations. */
export class SetupService {
  constructor({ directory, env = process.env, home = env.USERPROFILE || os.homedir(), platform = process.platform,
    getSettings = async () => ({}), saveSettings = async () => {}, getClaudeEnvironment = async () => env,
    assertMutable = () => {}, beforeUpdate = async () => {}, initialExisting = false, hasExistingUser, now = Date.now, run = execFileAsync,
    finders = {}, beforeConfigCommit = async () => {}, writeBackup = writeFile,
    memoryRules = new MemoryRulesService({ env, home }) } = {}) {
    if (!directory || !path.isAbsolute(directory)) throw new TypeError('SetupService requires an absolute directory.');
    Object.assign(this, { directory, env, home, platform, getSettings, saveSettings, getClaudeEnvironment, beforeUpdate,
      assertMutable, initialExisting, hasExistingUser, now, run, beforeConfigCommit, writeBackup, memoryRules });
    this.finders = {
      codex: (preferred, options) => findCodex(preferred, options),
      claude: (preferred, options) => findClaude(preferred, options),
      git: (_preferred, options) => findGit(options),
      ...finders,
    };
    this.filename = path.join(directory, 'setup.json');
    this._mutation = null;
    this._pending = null;
    this._timer = null;
    this._previewGeneration = 0;
    this._startPromise = null;
    this._disposed = false;
  }

  get busy() { return Boolean(this._mutation); }
  get activeComponent() { return this._mutation?.component ?? null; }
  async waitForIdle() { await this._mutation?.finished; }

  previewMemoryRules(provider) {
    this._active();
    return this.memoryRules.preview(provider);
  }

  async applyMemoryRules(options) {
    if (!options || !['codex', 'claude'].includes(options.provider)) throw new Error('Неизвестный агент.');
    return this._exclusive(options.provider, () => this.memoryRules.apply(options));
  }

  _active() { if (this._disposed) throw new Error('Приложение закрывается.'); }

  async _exclusive(component, task) {
    this._active();
    if (this._mutation) throw new Error('Дождитесь завершения текущей операции настройки.');
    this.assertMutable(component);
    let finish;
    const reservation = { component, finished: new Promise(resolve => { finish = resolve; }) };
    this._mutation = reservation;
    try { return await task(); }
    finally { if (this._mutation === reservation) this._mutation = null; finish(); }
  }

  async state() {
    this._active();
    const existing = this.hasExistingUser ? await this.hasExistingUser() : this.initialExisting;
    if (!existing) {
      // Installing a CLI creates settings.json before the wizard is finished. A durable
      // started marker keeps an interrupted first run resumable on the next launch.
      this._startPromise ??= (async () => {
        await mkdir(this.directory, { recursive: true });
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, started: true, completed: false, deferred: false }), { flag: 'wx', mode: 0o600 });
          try { await link(temporary, this.filename); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { await unlink(temporary).catch(() => {}); }
      })().catch(() => { this._startPromise = null; throw new Error('Не удалось сохранить начало настройки. Проверьте доступ к папке приложения.'); });
      await this._startPromise;
    }
    let saved;
    try { saved = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать состояние мастера настройки.');
    }
    const completed = saved?.completed === true;
    const deferred = saved?.deferred === true;
    return { show: !completed && !deferred && (!existing || saved?.started === true), completed, deferred };
  }

  _configPaths() {
    const defaultPath = path.join(this.home, '.codex', 'config.toml');
    const customHome = typeof this.env.CODEX_HOME === 'string' && this.env.CODEX_HOME.trim() !== '';
    if (customHome && !path.isAbsolute(this.env.CODEX_HOME)) throw new Error('CODEX_HOME должен содержать абсолютный путь. Исправьте переменную окружения и повторите настройку.');
    const targetPath = customHome ? path.join(this.env.CODEX_HOME, 'config.toml') : defaultPath;
    return { targetPath, defaultPath, customHome: path.normalize(targetPath).toLowerCase() !== path.normalize(defaultPath).toLowerCase() };
  }

  async _exists(filename) {
    try { await lstat(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Не удалось проверить доступ к config.toml.'); }
  }

  async _check(id, preferred) {
    let settings = {};
    if (id !== 'git') settings = await this.getSettings(id);
    const selected = preferred ?? settings?.executable;
    let executable;
    try { executable = await this.finders[id](selected, { env: this.env, home: this.home, platform: this.platform, run: this.run }); }
    catch {
      return { id, status: selected ? 'error' : 'missing', message: selected ? `Сохранённый путь к ${LABELS[id]} недоступен. Укажите установленный файл.` : `${LABELS[id]} не найден.` };
    }
    try {
      const env = id === 'claude' ? await this.getClaudeEnvironment() : this.env;
      const result = await this.run(executable, ['--version'], { env, cwd: this.home, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
      const version = versionFrom(result.stdout, id);
      if (!version) throw new Error('Unrecognized version');
      return { id, status: 'installed', executable, version };
    } catch { return { id, status: 'error', executable, message: `${LABELS[id]} найден, но проверить его запуск не удалось. Выберите другой файл или повторите проверку.` }; }
  }

  async scan() {
    this._active();
    const config = this._configPaths();
    const components = await Promise.all([...IDS].map(id => this._check(id)));
    return { components, config: { ...config, exists: await this._exists(config.targetPath) }, platformSupported: this.platform === 'win32' };
  }

  async setExecutable(id, filename) {
    componentId(id);
    if (id === 'git') throw new Error('Путь к Git определяется автоматически.');
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]/.test(filename)
      || (this.platform === 'win32' && path.extname(filename).toLowerCase() !== '.exe')) throw new Error('Выберите установленный исполняемый файл .exe.');
    return this._exclusive(id, async () => {
      let file;
      try { file = await stat(filename); } catch { throw new Error('Выбранный файл недоступен.'); }
      if (!file.isFile()) throw new Error('Выберите исполняемый файл, а не папку.');
      const checked = await this._check(id, filename);
      if (checked.status !== 'installed') throw new Error(checked.message);
      this.assertMutable(id);
      await this.saveSettings(id, { executable: filename });
      return this.scan();
    });
  }

  _progress(callback, component, stage, message) {
    try { callback?.({ component, stage, message }); } catch { /* A closing renderer must not abort installation. */ }
  }

  _includePath(filename) {
    const directory = path.dirname(filename);
    const key = Object.keys(this.env).find(value => value.toLowerCase() === 'path') || 'PATH';
    const delimiter = this.platform === 'win32' ? ';' : ':';
    const values = String(this.env[key] || '').split(delimiter).filter(Boolean);
    if (!values.some(value => value.toLowerCase() === directory.toLowerCase())) this.env[key] = [directory, ...values].join(delimiter);
  }

  async update(id, onProgress) {
    componentId(id);
    if (id !== 'codex') throw new Error('Обновлять из Desk можно только Codex CLI.');
    if (this.platform !== 'win32') throw new Error('Автоматическое обновление доступно только в Windows.');
    return this._exclusive(id, async () => {
      const current = await this._check(id);
      if (current.status !== 'installed' || !current.executable) throw new Error('Codex CLI не найден или не запускается.');
      this.assertMutable(id);
      await this.beforeUpdate(id);
      this.assertMutable(id);
      this._progress(onProgress, id, 'installing', 'Обновляется Codex CLI. Это может занять несколько минут.');
      try {
        try {
          const updateEnv = { ...this.env, CODEX_NON_INTERACTIVE: '1' };
          delete updateEnv.TERM;
          await this.run(current.executable, ['update'], {
            env: updateEnv, cwd: this.home, shell: false, windowsHide: true,
            timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024,
          });
        } catch {
          const defaultExecutable = path.join(this.env.LOCALAPPDATA || path.join(this.home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
          if (path.resolve(current.executable).toLowerCase() !== path.resolve(defaultExecutable).toLowerCase()) throw new Error('Штатное обновление не завершилось для выбранного пути Codex CLI. Укажите native Codex CLI или обновите его вручную.');
          // Native update may require an interactive terminal. Fall back to the same
          // fixed official installer used for first-time Codex setup.
          try {
            const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $setupScript = Invoke-RestMethod -Uri '" + INSTALL_URLS.codex + "' -TimeoutSec 60; & ([scriptblock]::Create($setupScript)); if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }";
            const powershell = this.env.SystemRoot ? path.join(this.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
            await this.run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
              env: { ...this.env, CODEX_NON_INTERACTIVE: '1' }, cwd: this.home, shell: false, windowsHide: true,
              timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024,
            });
          } catch { throw new Error('Не удалось обновить Codex CLI. Проверьте сеть и повторите попытку.'); }
        }
        this._progress(onProgress, id, 'checking', 'Проверяется обновлённый Codex CLI.');
        const updated = await this._check(id);
        if (updated.status !== 'installed' || !updated.executable) throw new Error('Обновление завершилось, но Codex CLI пока не запускается.');
        await this.saveSettings(id, { executable: updated.executable });
        this._includePath(updated.executable);
        this._progress(onProgress, id, 'done', 'Codex CLI обновлён, версия ' + updated.version + '.');
        return await this.scan();
      } catch (error) {
        this._progress(onProgress, id, 'error', error.message);
        throw error;
      }
    });
  }
  async install(id, onProgress) {
    componentId(id);
    if (this.platform !== 'win32') throw new Error('Автоматическая установка доступна только в Windows.');
    return this._exclusive(id, async () => {
      const current = await this._check(id);
      if (current.status === 'installed') {
        this._progress(onProgress, id, 'done', LABELS[id] + ' уже установлен.');
        return this.scan();
      }
      // Existing but broken executables require explicit path repair. Never silently replace a working installation.
      if (current.status === 'error') throw new Error(`${LABELS[id]} уже обнаружен, но не запускается. Сначала проверьте путь к исполняемому файлу.`);
      this.assertMutable(id);
      this._progress(onProgress, id, 'installing', 'Устанавливается ' + LABELS[id] + '. Это может занять несколько минут.');
      try {
        if (id === 'git') {
          try { await this.run('winget.exe', ['--version'], { env: this.env, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }); }
          catch { throw new Error('Для установки Git нужен «Установщик приложений» Windows (winget). Установите Git с https://git-scm.com/download/win и нажмите «Проверить снова».'); }
          try {
            await this.run('winget.exe', ['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity', '--silent'],
              { env: this.env, shell: false, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024 });
          } catch { throw new Error('Не удалось установить Git через winget. Проверьте сеть и разрешения Windows или установите Git с https://git-scm.com/download/win.'); }
        } else {
          const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $setupScript = Invoke-RestMethod -Uri '${INSTALL_URLS[id]}' -TimeoutSec 60; & ([scriptblock]::Create($setupScript)); if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
          const powershell = this.env.SystemRoot ? path.join(this.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
          try {
            await this.run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
              { env: { ...this.env, ...(id === 'codex' ? { CODEX_NON_INTERACTIVE: '1' } : {}) }, cwd: this.home, shell: false, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024 });
          } catch { throw new Error(`Не удалось завершить установку ${LABELS[id]}. Проверьте сеть и доступ к официальному сайту, затем нажмите «Проверить снова» или повторите установку.`); }
        }
        this._progress(onProgress, id, 'checking', `Проверяется установленный ${LABELS[id]}.`);
        const installed = await this._check(id);
        if (installed.status !== 'installed') throw new Error(`Установщик завершился, но ${LABELS[id]} пока не запускается. Нажмите «Проверить снова» или укажите путь к установленному файлу.`);
        if (id !== 'git') await this.saveSettings(id, { executable: installed.executable });
        this._includePath(installed.executable);
        this._progress(onProgress, id, 'done', LABELS[id] + ' установлен, версия ' + installed.version + '.');
        return await this.scan();
      } catch (error) {
        this._progress(onProgress, id, 'error', error.message);
        throw error;
      }
    });
  }

  invalidatePreview() {
    this._previewGeneration += 1;
    this._pending = null;
    clearTimeout(this._timer);
    this._timer = null;
  }

  async _snapshot(filename, { missing = true } = {}) {
    let handle;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
      if (info.size > MAX_CONFIG_BYTES) throw new Error('too large');
      handle = await open(filename, 'r');
      const before = await handle.stat();
      if (before.size > MAX_CONFIG_BYTES || !before.isFile()) throw new Error('too large');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length > MAX_CONFIG_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('changed');
      return { bytes, hash: hash(bytes), identity: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}` };
    } catch (error) {
      if (missing && error.code === 'ENOENT') return { bytes: null, hash: hash(null), identity: 'missing' };
      throw new Error('Не удалось прочитать файл конфигурации. Нужен обычный файл TOML размером до 2 МБ с доступом для чтения.');
    } finally { await handle?.close(); }
  }

  async previewConfig(filename) {
    this._active();
    if (this.busy) throw new Error('Дождитесь завершения текущей операции настройки.');
    this.invalidatePreview();
    const generation = this._previewGeneration;
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.toml') throw new Error('Выберите файл конфигурации в формате .toml.');
    const source = await this._snapshot(filename, { missing: false });
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
      const value = TOML.parse(decoded.replace(/^\uFEFF/, ''));
      if (!Object.keys(value).length) throw new Error('empty config');
    } catch { throw new Error('Файл не содержит корректную непустую конфигурацию TOML в UTF-8. Проверьте скачанный файл.'); }
    const config = this._configPaths();
    const target = await this._snapshot(config.targetPath);
    const fallback = config.customHome ? await this._snapshot(config.defaultPath) : target;
    this._active();
    if (generation !== this._previewGeneration || this.busy) throw new Error('Выбор файла изменился. Выберите конфигурацию заново.');
    const previewId = randomUUID();
    this._pending = { previewId, filename, source, config, target, fallback, expiresAt: this.now() + PREVIEW_TTL_MS };
    this._timer = setTimeout(() => this.invalidatePreview(), PREVIEW_TTL_MS);
    this._timer.unref?.();
    return { previewId, filename: path.basename(filename), ...config, exists: target.bytes !== null };
  }

  async applyConfig({ previewId, replaceExisting = false, useDefaultPath = false } = {}) {
    return this._exclusive('codex', async () => {
      const pending = this._pending;
      if (!pending || pending.previewId !== previewId || pending.expiresAt <= this.now()) {
        this.invalidatePreview();
        throw new Error('Проверка файла истекла или была отменена. Выберите файл заново.');
      }
      const configPath = useDefaultPath === true ? pending.config.defaultPath : pending.config.targetPath;
      const expected = useDefaultPath === true ? pending.fallback : pending.target;
      if (expected.bytes !== null && replaceExisting !== true) throw new Error('Подтвердите замену существующего config.toml с резервной копией.');
      const check = async () => {
        if (this._configPaths().targetPath !== pending.config.targetPath) throw new Error(staleConfig);
        const source = await this._snapshot(pending.filename, { missing: false });
        const target = await this._snapshot(configPath);
        if (source.hash !== pending.source.hash || source.identity !== pending.source.identity || target.hash !== expected.hash || target.identity !== expected.identity) throw new Error(staleConfig);
      };
      let temporary;
      let backupPath = null;
      try {
        await check();
        this.assertMutable('codex');
        await mkdir(path.dirname(configPath), { recursive: true });
        if (expected.bytes !== null) {
          backupPath = `${configPath}.backup-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
          try { await this.writeBackup(backupPath, expected.bytes, { flag: 'wx', mode: 0o600 }); }
          catch { throw new Error('Не удалось создать резервную копию config.toml. Настройки не изменены.'); }
        }
        temporary = `${configPath}.${randomUUID()}.tmp`;
        let handle;
        try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(pending.source.bytes); await handle.sync(); }
        finally { await handle?.close(); }
        await this.beforeConfigCommit();
        await check();
        this.assertMutable('codex');
        // Rename preserves a complete file. New destinations use exclusive link creation,
        // preventing an independently created config from being overwritten after preflight.
        if (expected.bytes === null) await link(temporary, configPath);
        else await rename(temporary, configPath);
        return { configPath, backupPath };
      } catch (error) {
        if (error.message === staleConfig || error.message?.startsWith('Не удалось создать резервную')) throw error;
        throw new Error('Не удалось применить конфигурацию Codex. Проверьте доступ к файлу и выберите конфигурацию заново. Существующие резервные копии сохранены.');
      } finally {
        this.invalidatePreview();
        if (temporary) await unlink(temporary).catch(() => {});
      }
    });
  }

  async complete({ provider, deferred = false } = {}) {
    if (provider !== undefined && !['codex', 'claude'].includes(provider)) throw new Error('Неизвестный агент.');
    return this._exclusive(null, async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, completed: deferred !== true, deferred: deferred === true,
          ...(provider ? { provider } : {}), updatedAt: new Date(this.now()).toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filename);
      } catch { throw new Error('Не удалось сохранить результат настройки. Повторите завершение мастера.'); }
      finally { await unlink(temporary).catch(() => {}); }
      this.invalidatePreview();
      return this.state();
    });
  }

  dispose() { this._disposed = true; this.invalidatePreview(); }
}
