import { randomUUID } from 'node:crypto';

const https = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
};

/**
 * The portal sign-in page shown inside the app: the only step of an automatic setup a
 * person still performs. Its Keycloak session lives in an isolated partition, downloads
 * are refused — the host fetches what it needs itself — and nothing from the page can be
 * launched. Closing the window is a cancellation, not a silent stall.
 */
export class PortalAuthWindow {
  constructor({ createWindow, title = 'Вход в Portal', partition, backgroundColor }) {
    if (typeof createWindow !== 'function') throw new TypeError('PortalAuthWindow requires createWindow.');
    Object.assign(this, { createWindow, title, partition, backgroundColor });
    this.current = null;
  }

  get open() { return Boolean(this.current && !this.current.window.isDestroyed()); }

  show({ url, parent = null, onClosed = () => {}, onNavigated = () => {}, onRedirect = () => {} }) {
    if (!https(url)) throw new Error('Портал вернул небезопасный адрес входа.');
    if (this.open) { this.focus(); return this.current; }
    const window = this.createWindow({
      ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
      width: 1040, height: 780, minWidth: 680, minHeight: 520, title: this.title, autoHideMenuBar: true,
      ...(this.backgroundColor === undefined ? {} : { backgroundColor: this.backgroundColor }),
      webPreferences: { partition: this.partition || `portal-auth-${randomUUID()}`, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    const contents = window.webContents;
    const session = contents.session;
    session.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler?.(() => false);
    const refuseDownload = event => event.preventDefault();
    session.on('will-download', refuseDownload);
    // Keycloak lives on its own origin, so sign-in may leave the portal; only https may load,
    // and a popup is folded into this window rather than escaping to the system browser.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (https(target)) void contents.loadURL(target).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, target) => { if (!https(target)) event.preventDefault(); });
    contents.on('will-redirect', (event, target) => { if (!https(target)) event.preventDefault(); else onRedirect(event, target); });
    contents.on('did-navigate', (_event, target) => onNavigated(target));
    const flow = { window, url };
    window.once('closed', () => { session.removeListener('will-download', refuseDownload); if (this.current !== flow) return; this.current = null; onClosed(); });
    this.current = flow;
    void contents.loadURL(url).catch(() => {});
    return flow;
  }

  focus() {
    if (!this.open) return false;
    const { window } = this.current;
    if (window.isMinimized?.()) window.restore();
    window.show?.(); window.focus?.();
    return true;
  }

  /** Closing from the host is not a cancellation: the flow already knows how it ended. */
  close() {
    const flow = this.current;
    this.current = null;
    if (flow && !flow.window.isDestroyed()) flow.window.destroy();
  }
}
