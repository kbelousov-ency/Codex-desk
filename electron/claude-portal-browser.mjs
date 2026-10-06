import { randomUUID } from 'node:crypto';
import { PORTAL_ORIGIN } from './router-portal.mjs';
import { isClaudeInstallerDownloadUrl } from './claude-portal-import.mjs';

const https = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };

/** An isolated portal browser. A portal download is consumed as data, never launched. */
export class ClaudePortalBrowser {
  constructor({ createWindow, readDownload, timeoutMs = 10 * 60 * 1000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
    Object.assign(this, { createWindow, readDownload, timeoutMs, setTimeoutImpl, clearTimeoutImpl });
    this.current = null;
  }

  open(parent) {
    if (this.current) { this.current.window.focus(); return this.current.promise; }
    const window = this.createWindow({ parent, width: 1040, height: 780, minWidth: 680, minHeight: 520,
      title: 'Подключить Claude через портал', autoHideMenuBar: true,
      webPreferences: { partition: `claude-router-${randomUUID()}`, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    const contents = window.webContents;
    const portalSession = contents.session;
    let finish;
    const flow = { window, promise: null, cancelled: false };
    flow.promise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.setTimeoutImpl(() => finish(new Error('Время подключения истекло. Откройте портал заново.')), this.timeoutMs);
      finish = (error, config = null) => {
        if (settled) return;
        settled = true; flow.cancelled = true; this.clearTimeoutImpl(timer);
        portalSession.removeListener('will-download', download);
        if (this.current === flow) this.current = null;
        // A remote beforeunload handler must not keep a completed or cancelled portal alive.
        if (!window.isDestroyed()) window.destroy();
        if (error) reject(error); else resolve(config);
      };
      const download = (event, item, owner) => {
        if (owner !== contents) return;
        event.preventDefault();
        let url, filename;
        try { url = item.getURL(); filename = item.getFilename(); } catch { return; }
        if (!isClaudeInstallerDownloadUrl(url) || filename !== `claude-connect-${new URL(url).pathname.split('/').at(-1)}`) return;
        if (flow.reading) return;
        flow.reading = true;
        // Capture DownloadItem values now: Electron invalidates the cancelled item next tick.
        void Promise.resolve().then(() => {
          if (!flow.cancelled) return this.readDownload({ url, filename });
        }).then(config => {
          if (!flow.cancelled) finish(null, config);
        }, () => { if (!flow.cancelled) finish(new Error('Не удалось получить настройки Claude. Создайте новое подключение на портале.')); });
      };
      portalSession.on('will-download', download);
      portalSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
      portalSession.setPermissionCheckHandler?.(() => false);
      contents.setWindowOpenHandler(({ url }) => {
        if (https(url)) void window.loadURL(url).catch(() => finish(new Error('Не удалось открыть страницу входа.')));
        return { action: 'deny' };
      });
      contents.on('will-navigate', (event, url) => { if (!https(url)) event.preventDefault(); });
      contents.on('will-redirect', (event, url) => { if (!https(url)) event.preventDefault(); });
      window.once('closed', () => { flow.cancelled = true; finish(null); });
    });
    flow.finish = finish;
    this.current = flow;
    void window.loadURL(`${PORTAL_ORIGIN}/#claude`).catch(() => finish(new Error('Не удалось открыть портал. Проверьте соединение.')));
    return flow.promise;
  }

  cancel() {
    if (!this.current) return;
    this.current.cancelled = true;
    this.current.finish(null);
  }
}
