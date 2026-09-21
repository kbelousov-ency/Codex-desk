import { SettingsStore } from './window-session.mjs';

export const UPDATE_REPOSITORY = 'kbelousov-ency/Codex-desk';
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_START_DELAY = 15_000;
const MANUAL_INTERVAL = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) throw new Error('Некорректный номер версии приложения.');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function preferences(value) {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    ...(stableVersion(value?.skippedVersion) ? { skippedVersion: value.skippedVersion } : {}),
    ...(timestamp(value?.checkedAt) ? { checkedAt: value.checkedAt } : {}),
    ...(timestamp(value?.attemptedAt) ? { attemptedAt: value.attemptedAt } : {}),
  };
}

function preferencePatch(patch) {
  if (!object(patch) || Object.keys(patch).some(key => !['enabled', 'skippedVersion'].includes(key))
    || (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean')
    || (Object.hasOwn(patch, 'skippedVersion') && patch.skippedVersion !== null && !stableVersion(patch.skippedVersion))) {
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

const installerNames = version => [`Codex-Desk-Setup-${version}.exe`, `Codex.Desk.Setup.${version}.exe`, `Codex Desk Setup ${version}.exe`];

/** Only this repository's exact, versioned Setup asset can be opened by the host. */
export function validDownloadUrl(value, version) {
  if (!stableVersion(version) || typeof value !== 'string' || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && !url.search && !url.hash
      && installerNames(version).some(name => decodeURIComponent(url.pathname) === `/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`);
  } catch { return false; }
}

export function releaseUpdate(release, currentVersion) {
  if (!object(release) || release.draft !== false || release.prerelease !== false) throw new Error('GitHub вернул некорректный стабильный выпуск.');
  const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  if (!stableVersion(version)) throw new Error('Номер выпуска GitHub не соответствует формату vMAJOR.MINOR.PATCH.');
  if (compareVersions(version, currentVersion) <= 0) return null;
  const asset = Array.isArray(release.assets) && release.assets.find(item => object(item) && installerNames(version).includes(item.name)
    && item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0 && validDownloadUrl(item.browser_download_url, version)
    && decodeURIComponent(new URL(item.browser_download_url).pathname).endsWith(`/${item.name}`));
  if (!asset) throw new Error(`Выпуск ${version} ещё не содержит готового установщика Windows. Повторите проверку позже.`);
  return { latestVersion: version, releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,
    downloadUrl: asset.browser_download_url, releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 12_000) : '' };
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Ответ GitHub слишком большой.');
  if (!response.body) throw new Error('GitHub вернул пустой ответ.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Ответ GitHub слишком большой.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Public GitHub metadata only; downloads and installation always require user action. */
export class AppUpdateService {
  constructor({ buildInfo, store, fetch, openExternal, publish = () => {}, networkAllowed = true,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.store = store;
    this.fetch = fetch;
    this.openExternal = openExternal;
    this.publish = publish;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
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
    // prevents repeated restarts from exhausting GitHub's unauthenticated quota.
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
      timeout = this.setTimer(() => controller.abort(), 15_000);
      const response = await this.fetch(UPDATE_API, { signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Codex-Desk-Update-Check' } });
      let update = null;
      if (response.status !== 404) {
        if (response.status === 403 || response.status === 429) throw new Error('GitHub временно ограничил частоту проверок. Повторите позже.');
        if (!response.ok) throw new Error(`Не удалось проверить GitHub (HTTP ${response.status}). Повторите позже.`);
        update = releaseUpdate(await boundedJson(response), this.state.currentVersion);
      }
      if (this.closed || generation !== this.generation) return { ...this.state };
      const checkedAt = new Date(this.now()).toISOString();
      await this.store.markChecked(checkedAt);
      if (this.closed || generation !== this.generation) return { ...this.state };
      this.saved.checkedAt = checkedAt;
      this.lastSuccess = this.now();
      return this.emit({ phase: update ? 'available' : 'up-to-date', checkedAt, error: undefined,
        latestVersion: undefined, releaseUrl: undefined, downloadUrl: undefined, releaseNotes: undefined, ...update });
    } catch (error) {
      if (this.closed || generation !== this.generation) return { ...this.state };
      // Fetch errors can include network details; expose only our own bounded messages.
      const message = controller.signal.aborted ? 'Проверка заняла слишком много времени. Проверьте интернет и повторите.'
        : /^(GitHub |Ответ GitHub |Не удалось проверить GitHub |Выпуск |Номер выпуска |Не удалось прочитать настройки)/.test(error?.message)
          ? error.message : 'Не удалось проверить обновления. Проверьте подключение к интернету и повторите.';
      return this.emit({ phase: 'error', error: message, latestVersion: undefined, releaseUrl: undefined, downloadUrl: undefined, releaseNotes: undefined });
    } finally { this.clearTimer(timeout); if (this.controller === controller) this.controller = null; }
  }
  async openDownload() {
    await this.load();
    const { latestVersion, downloadUrl } = this.state;
    if (this.closed || !this.supported || this.state.phase !== 'available' || !validDownloadUrl(downloadUrl, latestVersion)) {
      throw new Error('Сначала проверьте наличие новой версии приложения.');
    }
    await this.openExternal(downloadUrl);
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.clearTimer(this.timer);
    this.controller?.abort();
    await this.inflight;
    await this.store.flush();
  }
}
