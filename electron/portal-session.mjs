export const PORTAL_PARTITION = 'persist:kuzmich-portal';
const PORTAL_ORIGIN = 'https://coder-portal.encycam.com';
const MAX_BODY_BYTES = 64 * 1024;

function signedOut(message) {
  return { state: 'signed-out', keyState: 'none', products: { codex: false, claude: false }, ...(message ? { message } : {}) };
}

function publicText(value) {
  return typeof value === 'string' && value.length <= 512 && !/[\r\n\0]/.test(value) ? value : undefined;
}

async function readJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_BODY_BYTES) throw new Error('oversized');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('oversized'); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('oversized');
  }
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-response');
  return body;
}

function failureMessage(error) {
  if (error?.status === 401) return 'Сессия Portal истекла. Войдите снова.';
  if (error?.kind === 'csrf') return 'Portal отклонил запрос: ошибка CSRF.';
  if (error?.kind === 'product_disabled') return 'Продукт отключён на Portal.';
  if (error?.message === 'oversized') return 'Ответ Portal превышает 64 КиБ.';
  if (error?.status) return 'Portal временно недоступен.';
  return 'Не удалось связаться с Portal. Повторите попытку.';
}

export class PortalSessionService {
  #routerKey = null;

  constructor({ session, authWindow, now = Date.now, cacheTtlMs = 60_000, timeoutMs = 15_000, maxAuthRedirects = 3 }) {
    Object.assign(this, { session, authWindow, now, cacheTtlMs, timeoutMs, maxAuthRedirects });
    this.snapshot = signedOut();
    this.cachedAt = null;
    this.generation = 0;
    this.controllers = new Set();
    this.refreshTask = null;
    this.loginFlow = null;
    this.logoutTask = null;
  }

  _session() { return typeof this.session === 'function' ? this.session() : this.session; }
  _public() { return structuredClone(this.snapshot); }

  async _request(pathname, method = 'GET') {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this._session().fetch(PORTAL_ORIGIN + pathname, {
        method, credentials: 'include', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'X-Requested-With': 'fetch' } : {}) },
      });
      let body;
      try { body = await readJson(response); }
      catch (error) { if (!response.ok) error.status = response.status; throw error; }
      if (!response.ok) {
        const detail = body.detail?.error || body.error;
        throw Object.assign(new Error('portal-request'), { status: response.status, kind: detail?.type, heldBy: publicText(detail?.email) });
      }
      return body;
    } finally { clearTimeout(timer); controller.abort(); this.controllers.delete(controller); }
  }

  _key(body, created = false) {
    this.#routerKey = null;
    if (body.has_key === true || created) {
      if (typeof body.approved !== 'boolean' || typeof body.api_key !== 'string') throw new Error('invalid-response');
      if (body.approved) this.#routerKey = body.api_key;
      return { keyState: body.approved ? 'approved' : 'pending' };
    }
    if (body.has_key !== false) throw new Error('invalid-response');
    const heldBy = publicText(body.held_by);
    return heldBy ? { keyState: 'held-elsewhere', heldBy } : { keyState: 'none' };
  }

  async _refresh() {
    if (this.refreshTask) return this.refreshTask;
    const generation = this.generation;
    const wasSignedIn = this.snapshot.state === 'signed-in';
    const task = (async () => {
      try {
        const me = await this._request('/api/me');
        if (generation !== this.generation) return this._public();
        const email = publicText(me.email);
        if (!email || typeof me.has_key !== 'boolean') throw new Error('invalid-response');
        this.#routerKey = null;
        this.snapshot = {
          state: 'signed-in', email, ...(publicText(me.name) ? { name: me.name } : {}),
          keyState: me.has_key ? (me.key_approved === true ? 'approved' : 'pending') : 'none',
          products: { codex: me.entitlements?.codex?.enabled === true, claude: me.entitlements?.claude?.enabled === true },
        };
        const key = await this._request('/api/key');
        if (generation !== this.generation) return this._public();
        this.snapshot = { ...this.snapshot, ...this._key(key) };
      } catch (error) {
        if (generation !== this.generation) return this._public();
        this.#routerKey = null;
        this.snapshot = error?.status === 401 ? signedOut(wasSignedIn ? failureMessage(error) : undefined) : { ...this.snapshot, message: failureMessage(error) };
      }
      if (generation === this.generation) this.cachedAt = this.now();
      return this._public();
    })();
    this.refreshTask = task;
    try { return await task; } finally { if (this.refreshTask === task) this.refreshTask = null; }
  }

  async status({ refresh = false } = {}) {
    if (this.logoutTask) await this.logoutTask;
    if (this.loginFlow) return this._public();
    if (refresh || this.cachedAt === null || this.now() - this.cachedAt >= this.cacheTtlMs) return this._refresh();
    return this._public();
  }

  login({ parent = null } = {}) {
    if (this.loginFlow) { this.authWindow.focus(); return this.loginFlow.promise; }
    if (this.logoutTask) return this.logoutTask.then(() => this.login({ parent }));
    this._invalidate();
    this.snapshot = { ...signedOut(), state: 'signing-in' };
    const flow = { redirects: 0, check: null };
    flow.promise = new Promise(resolve => { flow.resolve = resolve; });
    this.loginFlow = flow;
    const finish = message => {
      if (this.loginFlow !== flow) return;
      if (this.snapshot.state !== 'signed-in') this.snapshot = signedOut(message || this.snapshot.message || 'Вход отменён.');
      this.loginFlow = null;
      this.authWindow.close();
      flow.resolve(this._public());
    };
    const check = (closed = false) => {
      if (this.loginFlow !== flow) return;
      flow.check ??= this._refresh();
      void flow.check.then(() => finish(closed && this.snapshot.state !== 'signed-in' ? 'Вход отменён.' : undefined));
    };
    try {
      this.authWindow.show({
        url: PORTAL_ORIGIN + '/auth/login?next=%2F', parent,
        onClosed: () => check(true),
        onNavigated: target => {
          const url = new URL(target);
          if (url.origin === PORTAL_ORIGIN && !url.pathname.startsWith('/auth/')) check();
        },
        onRedirect: (event, target) => {
          const url = new URL(target);
          if (url.origin === PORTAL_ORIGIN && url.pathname === '/auth/login' && ++flow.redirects > this.maxAuthRedirects) {
            event.preventDefault();
            this._invalidate();
            finish('Portal повторяет вход. Закройте окно и попробуйте снова.');
          }
        },
      });
    } catch { finish('Не удалось открыть окно входа в Portal.'); }
    return flow.promise;
  }

  focusLogin() { return this.authWindow.focus(); }

  _invalidate() {
    this.generation++;
    this.cachedAt = null;
    this.refreshTask = null;
    this.#routerKey = null;
    for (const controller of this.controllers) controller.abort();
  }

  cancelLogin() {
    const flow = this.loginFlow;
    this.loginFlow = null;
    this._invalidate();
    this.authWindow.close();
    if (flow) { this.snapshot = signedOut('Вход отменён.'); flow.resolve(this._public()); }
  }

  async requestKey() {
    if (this.loginFlow) return this._public();
    const initialGeneration = this.generation;
    await this.status();
    if (initialGeneration !== this.generation) return this._public();
    if (this.snapshot.state !== 'signed-in') return this._public();
    this._invalidate();
    const generation = this.generation;
    try {
      const key = await this._request('/api/key', 'POST');
      if (generation === this.generation) {
        const { message, heldBy, ...previous } = this.snapshot;
        this.snapshot = { ...previous, ...this._key(key, true) };
      }
    } catch (error) {
      if (generation === this.generation) {
        if (error?.status === 401) this.snapshot = signedOut(failureMessage(error));
        else if (error?.status === 409 && error.kind === 'key_on_other_email') {
          this.snapshot = { ...this.snapshot, keyState: 'held-elsewhere', ...(error.heldBy ? { heldBy: error.heldBy } : {}), message: 'Ключ уже выдан на другую почту. Войдите под ней.' };
        } else this.snapshot = { ...this.snapshot, message: failureMessage(error) };
      }
    }
    return this._public();
  }

  async routerKey() {
    await this.status();
    return this.snapshot.state === 'signed-in' && this.snapshot.keyState === 'approved' ? this.#routerKey : null;
  }

  logout() {
    if (this.logoutTask) return this.logoutTask;
    this.cancelLogin();
    this.snapshot = signedOut();
    // /auth/logout also terminates Keycloak SSO; clear only this app's partition instead.
    const task = (async () => {
      try { await this._session().clearStorageData(); }
      catch { this.snapshot = signedOut('Не удалось очистить локальную сессию Portal. Повторите выход.'); }
      return this._public();
    })();
    this.logoutTask = task;
    void task.finally(() => { if (this.logoutTask === task) this.logoutTask = null; });
    return task;
  }
}
