import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SettingsStore } from './window-session.mjs';

// Проверка обновлений идёт через каталог «Приложения» портала роутера, а не GitHub.
// Карточку и установщик авторизует существующая Portal-сессия приложения (cookie в
// изолированном partition); ключ роутера и данные диалогов в запросы не попадают.
export const UPDATE_CATALOG_ORIGIN = 'https://coder-portal.encycam.com';
export const UPDATE_CATALOG_PATH = '/api/apps/codex-desk';
export const UPDATE_CATALOG = UPDATE_CATALOG_ORIGIN + UPDATE_CATALOG_PATH;
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_START_DELAY = 15_000;
const MANUAL_INTERVAL = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 10 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEGMENT = '(0|[1-9]\\d{0,8})';
const STABLE_RE = new RegExp(`^${SEGMENT}\\.${SEGMENT}\\.${SEGMENT}$`);
const CATALOG_RE = new RegExp(`^${SEGMENT}\\.${SEGMENT}\\.${SEGMENT}(?:\\.${SEGMENT})?$`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const stableVersion = value => typeof value === 'string' && STABLE_RE.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) throw new Error('Некорректный номер версии приложения.');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

/** Версия каталога: X.Y.Z пакета плюс необязательный номер сборки Jenkins (X.Y.Z.N). */
export function catalogVersion(value) {
  const match = typeof value === 'string' && value.length <= 64 ? CATALOG_RE.exec(value) : null;
  if (!match) return null;
  return { value, base: `${match[1]}.${match[2]}.${match[3]}`, buildNumber: match[4] === undefined ? null : Number(match[4]) };
}

export const updateVersion = value => catalogVersion(value) !== null;

function preferences(value) {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    ...(updateVersion(value?.skippedVersion) ? { skippedVersion: value.skippedVersion } : {}),
    ...(timestamp(value?.checkedAt) ? { checkedAt: value.checkedAt } : {}),
    ...(timestamp(value?.attemptedAt) ? { attemptedAt: value.attemptedAt } : {}),
  };
}

function preferencePatch(patch) {
  if (!object(patch) || Object.keys(patch).some(key => !['enabled', 'skippedVersion'].includes(key))
    || (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean')
    || (Object.hasOwn(patch, 'skippedVersion') && patch.skippedVersion !== null && !updateVersion(patch.skippedVersion))) {
    throw new Error('Некорректные настройки обновлений приложения.');
  }
  return { ...patch };
}

/** A separate profile file; no CLI credentials, models or history enter it. */
export class AppUpdateStore extends SettingsStore {
  async snapshot() { return preferences(await super.snapshot()); }
  update(patch) {
    const clean = preferencePatch(patch);
    return this._update(previous => preferences({ ...preferences(previous), ...clean }));
  }
  markAttempt(value) { return this._update(previous => ({ ...preferences(previous), attemptedAt: value })); }
  markChecked(value) { return this._update(previous => ({ ...preferences(previous), checkedAt: value })); }
}

const installerNames = base => [`Codex-Desk-Setup-${base}.exe`, `Codex.Desk.Setup.${base}.exe`, `Codex Desk Setup ${base}.exe`];

/** Only the catalog's own file path for the offered version can be downloaded by the host. */
export function validDownloadUrl(value, version) {
  if (!catalogVersion(version) || typeof value !== 'string' || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === UPDATE_CATALOG_ORIGIN && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === `${UPDATE_CATALOG_PATH}/versions/${version}/file`;
  } catch { return false; }
}

function newerCandidate(a, b) {
  const order = compareVersions(a.base, b.base);
  if (order !== 0) return order > 0;
  return (a.buildNumber ?? -1) > (b.buildNumber ?? -1);
}

/**
 * Правила контракта: сначала численно X.Y.Z; при равенстве известный номер сборки
 * обновляет установку без номера, но кандидат без номера никого не вытесняет.
 */
function newerThanCurrent(candidate, current) {
  const order = compareVersions(candidate.base, current.version);
  if (order !== 0) return order > 0;
  if (candidate.buildNumber === null) return false;
  return current.buildNumber === null || candidate.buildNumber > current.buildNumber;
}

/**
 * Выбор кандидата из карточки каталога. Порядок versions[] — по времени заливки,
 * доверять ему нельзя; непригодные записи (чужой канал, неверная форма) пропускаются,
 * повреждённая карточка целиком — ошибка контракта.
 */
export function catalogUpdate(card, current) {
  if (!object(card) || card.slug !== 'codex-desk' || !Array.isArray(card.versions) || card.versions.length > 200) {
    throw new Error('Portal вернул некорректный каталог приложения.');
  }
  let best = null;
  for (const entry of card.versions) {
    if (!object(entry)) continue;
    const parsed = catalogVersion(entry.version);
    if (!parsed) continue;
    // Записи без канала допустимы — их публикует текущий Jenkins; чужой канал — нет.
    if (entry.channel != null && entry.channel !== 'stable') continue;
    if (!installerNames(parsed.base).includes(entry.filename)) continue;
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes <= 0 || entry.size_bytes > MAX_INSTALLER_BYTES) continue;
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256.toLowerCase())) continue;
    if (entry.url !== `${UPDATE_CATALOG_PATH}/versions/${parsed.value}/file`) continue;
    const candidate = { ...parsed, entry };
    if (!best || newerCandidate(candidate, best)) best = candidate;
  }
  if (!best || !newerThanCurrent(best, current)) return null;
  return {
    latestVersion: best.value,
    downloadUrl: UPDATE_CATALOG_ORIGIN + best.entry.url,
    filename: best.entry.filename,
    sha256: best.entry.sha256.toLowerCase(),
    sizeBytes: best.entry.size_bytes,
    releaseNotes: typeof best.entry.release_notes === 'string' ? best.entry.release_notes.slice(0, 12_000) : '',
  };
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Ответ Portal слишком большой.');
  if (!response.body) throw new Error('Portal вернул пустой ответ.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Ответ Portal слишком большой.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const RESET = { latestVersion: undefined, downloadUrl: undefined, releaseNotes: undefined,
  filename: undefined, sha256: undefined, sizeBytes: undefined, downloadedPath: undefined, downloadedVersion: undefined };

/** Portal-authorised metadata and download; installation always requires user action. */
export class AppUpdateService {
  constructor({ buildInfo, store, portal, saveDirectory, reveal, publish = () => {}, networkAllowed = true,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { store, portal, saveDirectory, reveal, publish, now, setTimer, clearTimer });
    this.current = { version: buildInfo.version,
      buildNumber: Number.isSafeInteger(buildInfo.buildNumber) && buildInfo.buildNumber > 0 ? buildInfo.buildNumber : null };
    this.supported = networkAllowed && buildInfo.channel === 'stable' && stableVersion(buildInfo.version);
    this.state = { currentVersion: buildInfo.version, channel: buildInfo.channel, enabled: true, supported: this.supported,
      phase: this.supported ? 'idle' : 'disabled' };
    this.generation = 0;
  }

  async load() {
    if (!this.loaded) this.loaded = this.store.snapshot().then(value => {
      this.saved = value;
      Object.assign(this.state, { enabled: value.enabled, skippedVersion: value.skippedVersion, checkedAt: value.checkedAt });
    }).catch(error => { this.loaded = null; throw error; });
    await this.loaded;
  }
  async status() { await this.load(); return { ...this.state }; }
  emit(patch = {}) {
    Object.assign(this.state, patch);
    if (!this.closed) this.publish({ ...this.state });
    return { ...this.state };
  }
  schedule(delay) {
    this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed || !this.started || !this.supported || !this.state.enabled) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.check(false).catch(() => this.schedule(UPDATE_INTERVAL));
    }, delay);
    this.timer?.unref?.();
  }
  async start() {
    await this.load();
    if (this.closed || this.started) return;
    this.started = true;
    // Each launch can discover an update. A persisted one-minute throttle also
    // prevents repeated restarts from spamming the portal.
    const elapsed = this.now() - Date.parse(this.saved.attemptedAt || '');
    this.schedule(Math.max(UPDATE_START_DELAY, Number.isFinite(elapsed) && elapsed >= 0 ? MANUAL_INTERVAL - elapsed : 0));
  }
  async setPreferences(patch) {
    const clean = preferencePatch(patch);
    await this.load();
    if (this.closed) throw new Error('Приложение закрывается.');
    await this.store.update(clean);
    this.saved = { ...this.saved, ...clean };
    if (clean.skippedVersion === null) delete this.saved.skippedVersion;
    if (clean.enabled === false) {
      this.generation++;
      this.controller?.abort();
      this.emit({ enabled: false, skippedVersion: this.saved.skippedVersion,
        ...(this.state.phase === 'checking' ? { phase: 'idle' } : {}) });
      this.schedule(0);
    } else {
      this.emit({ enabled: this.saved.enabled, skippedVersion: this.saved.skippedVersion });
      if (clean.enabled === true) this.schedule(UPDATE_START_DELAY);
    }
    return { ...this.state };
  }
  async check(manual = true) {
    await this.load();
    if (this.closed || !this.supported || (!manual && !this.state.enabled)) return { ...this.state };
    if (this.inflight) return this.inflight;
    // A successful result may be reused for one minute, including manual clicks.
    // Failed checks remain immediately retryable; scheduled attempts stay six hours apart.
    if (this.lastSuccess !== undefined && this.now() - this.lastSuccess < MANUAL_INTERVAL) {
      this.schedule(UPDATE_INTERVAL);
      return { ...this.state };
    }
    const generation = this.generation;
    this.inflight = this.perform(generation).finally(() => { this.inflight = null; this.schedule(UPDATE_INTERVAL); });
    return this.inflight;
  }
  async perform(generation) {
    const controller = new AbortController();
    this.controller = controller;
    let timeout;
    try {
      const attemptedAt = new Date(this.now()).toISOString();
      await this.store.markAttempt(attemptedAt);
      this.saved.attemptedAt = attemptedAt;
      if (this.closed || generation !== this.generation) return { ...this.state };
      this.emit({ phase: 'checking', error: undefined });
      // Контракт: без входа в Portal, одобренного ключа и действующего допуска
      // к продукту каталог не запрашивается вовсе.
      const portal = await this.portal.status();
      if (this.closed || generation !== this.generation) return { ...this.state };
      if (portal?.state !== 'signed-in') throw new Error('Войдите в Portal, чтобы проверять обновления приложения.');
      if (portal.keyState !== 'approved' || !(portal.products?.codex || portal.products?.claude)) {
        throw new Error('Доступ к роутеру не подтверждён в Portal. Обновления пока недоступны.');
      }
      timeout = this.setTimer(() => controller.abort(), 15_000);
      const response = await this.portal.fetch(UPDATE_CATALOG, { signal: controller.signal, redirect: 'error',
        credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.status === 401) throw new Error('Сессия Portal истекла. Войдите снова.');
      if (response.status === 403) throw new Error('Portal отказал в доступе к каталогу обновлений.');
      // 404 карточки — несовместимый контракт сервиса, а не «обновлений нет».
      if (response.status === 404) throw new Error('Каталог обновлений не найден на Portal. Повторите позже.');
      if (response.status === 429) throw new Error('Portal временно ограничил частоту проверок. Повторите позже.');
      if (!response.ok) throw new Error(`Не удалось проверить Portal (HTTP ${response.status}). Повторите позже.`);
      const update = catalogUpdate(await boundedJson(response), this.current);
      if (this.closed || generation !== this.generation) return { ...this.state };
      const checkedAt = new Date(this.now()).toISOString();
      await this.store.markChecked(checkedAt);
      if (this.closed || generation !== this.generation) return { ...this.state };
      this.saved.checkedAt = checkedAt;
      this.lastSuccess = this.now();
      return this.emit({ phase: update ? 'available' : 'up-to-date', checkedAt, error: undefined, ...RESET, ...update });
    } catch (error) {
      if (this.closed || generation !== this.generation) return { ...this.state };
      // Fetch errors can include network details; expose only our own bounded messages.
      const message = controller.signal.aborted ? 'Проверка заняла слишком много времени. Проверьте сеть и повторите.'
        : /^(Войдите в Portal|Доступ к роутеру|Сессия Portal|Portal |Каталог обновлений|Ответ Portal|Не удалось проверить Portal|Не удалось прочитать настройки)/.test(error?.message)
          ? error.message : 'Не удалось проверить обновления. Проверьте подключение к сети компании и повторите.';
      return this.emit({ phase: 'error', error: message, ...RESET });
    } finally { this.clearTimer(timeout); if (this.controller === controller) this.controller = null; }
  }
  /** Скачивает установщик Portal-сессией в папку загрузок, сверяет размер и SHA-256. */
  async openDownload() {
    await this.load();
    if (this.downloadTask) return this.downloadTask;
    const { latestVersion, downloadUrl, filename, sha256, sizeBytes } = this.state;
    const parsed = latestVersion ? catalogVersion(latestVersion) : null;
    if (this.closed || !this.supported || this.state.phase !== 'available' || !parsed
      || !validDownloadUrl(downloadUrl, latestVersion) || !installerNames(parsed.base).includes(filename)
      || typeof sha256 !== 'string' || !SHA256_RE.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error('Сначала проверьте наличие новой версии приложения.');
    }
    const task = this._download({ generation: this.generation, downloadUrl, filename, sha256, sizeBytes, version: latestVersion })
      .finally(() => { if (this.downloadTask === task) this.downloadTask = null; });
    this.downloadTask = task;
    return task;
  }
  async _download({ generation, downloadUrl, filename, sha256, sizeBytes, version }) {
    const controller = new AbortController();
    this.downloadController = controller;
    const timeout = this.setTimer(() => controller.abort(), DOWNLOAD_TIMEOUT);
    const directory = this.saveDirectory();
    const staging = path.join(directory, `.${filename}.${randomUUID()}.part`);
    let handle = null;
    try {
      this.emit({ phase: 'downloading', error: undefined });
      const response = await this.portal.fetch(downloadUrl, { signal: controller.signal, redirect: 'error',
        credentials: 'include', cache: 'no-store' });
      if (response.status === 401) throw new Error('Сессия Portal истекла. Войдите снова.');
      if (response.status === 403) throw new Error('Portal отказал в скачивании установщика.');
      if (response.status === 404) throw new Error('Установщик недоступен на Portal. Проверьте обновления позже.');
      if (!response.ok) throw new Error(`Не удалось скачать установщик (HTTP ${response.status}). Повторите позже.`);
      if (!response.body) throw new Error('Portal вернул пустой ответ.');
      await mkdir(directory, { recursive: true });
      handle = await open(staging, 'wx');
      const reader = response.body.getReader();
      const digest = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > sizeBytes) throw new Error('Установщик не совпадает с каталогом Portal. Проверьте обновления позже.');
          digest.update(value);
          await handle.write(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (size !== sizeBytes || digest.digest('hex') !== sha256) {
        throw new Error('Установщик не совпадает с каталогом Portal. Проверьте обновления позже.');
      }
      await handle.sync().catch(() => {});
      await handle.close();
      handle = null;
      const target = await this._reserveName(directory, filename);
      await rename(staging, target);
      if (this.closed || generation !== this.generation) return { ...this.state };
      this.emit({ phase: 'available', downloadedPath: target, downloadedVersion: version, error: undefined });
      try { await this.reveal(target); } catch { /* Папка не открылась — файл уже на месте. */ }
      return { ...this.state };
    } catch (error) {
      if (!this.closed && generation === this.generation && this.state.phase === 'downloading') this.emit({ phase: 'available' });
      const message = controller.signal.aborted ? 'Скачивание заняло слишком много времени. Повторите попытку.'
        : /^(Сессия Portal|Portal |Установщик|Не удалось скачать установщик|Не удалось сохранить установщик)/.test(error?.message)
          ? error.message : 'Не удалось скачать установщик. Проверьте подключение к сети компании и повторите.';
      throw new Error(message);
    } finally {
      this.clearTimer(timeout);
      if (this.downloadController === controller) this.downloadController = null;
      if (handle) await handle.close().catch(() => {});
      await unlink(staging).catch(() => {});
    }
  }
  /** Одноимённый файл в загрузках не перезаписывается — выбирается свободное имя. */
  async _reserveName(directory, filename) {
    const extension = path.extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    for (let index = 0; index < 50; index++) {
      const candidate = path.join(directory, index === 0 ? filename : `${stem} (${index})${extension}`);
      try { await (await open(candidate, 'wx')).close(); return candidate; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('Не удалось сохранить установщик: слишком много одноимённых файлов.');
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.clearTimer(this.timer);
    this.controller?.abort();
    this.downloadController?.abort();
    await this.inflight;
    await this.downloadTask?.catch(() => {});
    await this.store.flush();
  }
}
