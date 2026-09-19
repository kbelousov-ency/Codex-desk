import { SettingsStore } from './window-session.mjs';

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true, sound: false, completed: true, question: true, approval: true, error: true,
});
const HEADINGS = Object.freeze({
  completed: 'Задача завершена', question: 'Codex ждёт ответа', approval: 'Нужно разрешение', error: 'Ошибка в диалоге',
});
const MAX_SEEN = 512;
const MAX_VISIBLE = 32;
const MIN_INTERVAL = 2_000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

function settingsPatch(patch) {
  if (!object(patch) || Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_NOTIFICATION_SETTINGS, key) || typeof patch[key] !== 'boolean')) {
    throw new Error('Некорректные настройки уведомлений.');
  }
  return { ...patch };
}

function normalizeSettings(value) {
  return Object.fromEntries(Object.entries(DEFAULT_NOTIFICATION_SETTINGS).map(([key, fallback]) =>
    [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
}

/** Own profile file; never writes Codex configuration or session settings. */
export class NotificationSettingsStore extends SettingsStore {
  async snapshot() { return normalizeSettings(await super.snapshot()); }
  update(patch) {
    const clean = settingsPatch(patch);
    return this._update(previous => ({ ...normalizeSettings(previous), ...clean }));
  }
}

function notificationPayload(value) {
  if (!object(value) || Object.keys(value).some(key => !['sessionId', 'kind', 'eventId', 'title'].includes(key))
    || !identifier(value.sessionId) || !identifier(value.eventId) || !Object.hasOwn(HEADINGS, value.kind)
    || typeof value.title !== 'string' || value.title.length > 160 || /[\x00-\x1f\x7f]/.test(value.title)) {
    throw new Error('Некорректное уведомление.');
  }
  return { sessionId: value.sessionId, kind: value.kind, eventId: value.eventId, title: value.title.trim() };
}

/** Native delivery only. The renderer decides which live events need attention. */
export class NotificationService {
  constructor({ Notification, settings, icon, diagnostics, now = Date.now, available = () => true }) {
    this.Notification = Notification;
    this.settings = settings;
    this.icon = icon;
    this.diagnostics = diagnostics;
    this.now = now;
    this.available = available;
    this.windows = new Map();
  }

  supported() {
    try { return this.Notification?.isSupported() === true; } catch { return false; }
  }

  async getSettings() { return { settings: await this.settings.snapshot(), supported: this.supported() }; }
  async setSettings(patch) {
    await this.settings.update(settingsPatch(patch));
    const result = await this.getSettings();
    for (const state of this.windows.values()) {
      for (const entry of [...state.visible.values()]) {
        if (!result.settings.enabled || !result.settings[entry.kind]) this.dismiss(state, entry);
      }
    }
    return result;
  }

  registerWindow(record) {
    this.windows.set(record, { activeSessionId: undefined, seen: new Map(), visible: new Map(), lastShown: new Map() });
  }

  validWindow(record) {
    return this.available() && this.windows.has(record) && !record.rendererGone && !record.workspaceClosing
      && !record.window.isDestroyed() && !record.window.webContents.isDestroyed();
  }

  ownedSession(record, id) {
    const session = record.sessions.get(id);
    if (!session || session.disposed) throw new Error('Недопустимая или закрытая сессия.');
    return session;
  }

  focused(record) {
    return !record.window.isDestroyed() && !record.window.isMinimized() && record.window.isFocused();
  }

  setContext(record, context) {
    if (!object(context) || Object.keys(context).some(key => key !== 'activeSessionId')
      || (context.activeSessionId !== undefined && !identifier(context.activeSessionId))) throw new Error('Некорректная активная сессия.');
    if (context.activeSessionId !== undefined) this.ownedSession(record, context.activeSessionId);
    const state = this.windows.get(record);
    if (!state || !this.validWindow(record)) return;
    state.activeSessionId = context.activeSessionId;
    this.dismissRead(record);
  }

  focusChanged(record) {
    if (!this.validWindow(record)) return;
    record.window.webContents.send('host:windowFocus', this.focused(record));
    this.dismissRead(record);
  }

  dismissRead(record) {
    const state = this.windows.get(record);
    if (!state || !this.focused(record)) return;
    for (const entry of [...state.visible.values()]) if (entry.sessionId === state.activeSessionId) this.dismiss(state, entry);
  }

  dismiss(state, entry) {
    if (state.visible.get(entry.key) !== entry) return;
    state.visible.delete(entry.key);
    entry.notification.removeAllListeners();
    try { entry.notification.close(); } catch { /* Dismissal cannot interrupt a tab or window close. */ }
  }

  async notify(record, value) {
    const payload = notificationPayload(value);
    const session = this.ownedSession(record, payload.sessionId);
    if (!this.validWindow(record) || session.terminal) return;
    const state = this.windows.get(record);
    const eventKey = JSON.stringify([payload.sessionId, payload.kind, payload.eventId]);
    if (state.seen.has(eventKey)) return;
    state.seen.set(eventKey, payload.sessionId);
    while (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.keys().next().value);
    const settings = await this.settings.snapshot();
    // Ownership, focus and availability can all change while settings are read.
    if (!this.validWindow(record) || this.windows.get(record) !== state || record.sessions.get(payload.sessionId) !== session || session.disposed || session.terminal
      || !this.supported() || !settings.enabled || !settings[payload.kind]
      || (this.focused(record) && state.activeSessionId === payload.sessionId)) return;
    const key = JSON.stringify([payload.sessionId, payload.kind]);
    const last = state.lastShown.get(key);
    if (last !== undefined && this.now() - last < MIN_INTERVAL) return;
    state.lastShown.set(key, this.now());
    const previous = state.visible.get(key);
    if (previous) this.dismiss(state, previous);
    while (state.visible.size >= MAX_VISIBLE) this.dismiss(state, state.visible.values().next().value);
    let entry;
    try {
      const notification = new this.Notification({
        title: HEADINGS[payload.kind], body: payload.title || 'Codex Desk', silent: !settings.sound,
        ...(this.icon ? { icon: this.icon } : {}),
      });
      entry = { notification, key, sessionId: payload.sessionId, kind: payload.kind };
      state.visible.set(key, entry);
      notification.on('click', () => {
        if (state.visible.get(key) !== entry || !this.validWindow(record) || record.sessions.get(payload.sessionId) !== session || session.disposed || session.terminal) return;
        // Consume first: restoring the window may synchronously send a focus event.
        this.dismiss(state, entry);
        const win = record.window;
        state.activeSessionId = payload.sessionId;
        // Select the target before native focus clears unread state in the renderer.
        win.webContents.send('host:notificationActivated', { sessionId: payload.sessionId });
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
      });
      notification.on('close', () => this.dismiss(state, entry));
      notification.on('failed', () => {
        this.dismiss(state, entry);
        this.diagnostics?.error('notification.failed', new Error('Native notification failed.'));
      });
      notification.show();
    } catch (error) {
      if (entry) this.dismiss(state, entry);
      this.diagnostics?.error('notification.failed', error);
    }
  }

  dismissSession(record, sessionId) {
    const state = this.windows.get(record);
    if (!state) return;
    for (const entry of [...state.visible.values()]) if (entry.sessionId === sessionId) this.dismiss(state, entry);
  }

  closeSession(record, sessionId) {
    const state = this.windows.get(record);
    if (!state) return;
    if (state.activeSessionId === sessionId) state.activeSessionId = undefined;
    this.dismissSession(record, sessionId);
    for (const [key, owner] of state.seen) if (owner === sessionId) state.seen.delete(key);
    for (const kind of Object.keys(HEADINGS)) state.lastShown.delete(JSON.stringify([sessionId, kind]));
  }

  closeWindow(record) {
    const state = this.windows.get(record);
    if (!state) return;
    this.windows.delete(record);
    for (const entry of [...state.visible.values()]) this.dismiss(state, entry);
  }
}
