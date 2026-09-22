import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer; fake host only. No real Codex, files, exports or turns.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const createPage = async (mode = 'empty') => {
    const result = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    result.setDefaultTimeout(7000);
    await result.addInitScript(mode => {
      const state = window.__diagnostics = { exports: 0, folderCalls: 0, reports: [], outcome: 'cancel', failFolder: false, unavailable: false };
      const bridge = {
        async getWorkspace() { return { projects: [], sessions: mode === 'disconnected' ? [{ id: 'offline', cwd: 'C:/Fixtures/Offline' }] : [] }; },
        async listProjectThreads() { return { data: [], nextCursor: null }; },
        async listArchivedThreads() { return { data: [], nextCursor: null }; },
        async getDiagnosticsStatus() { return { enabled: !state.unavailable, directory: 'C:/Fixtures/Logs', ...(state.unavailable ? { error: 'Недостаточно места для журнала.' } : {}) }; },
        async exportDiagnostics() { state.exports++; if (state.outcome === 'error') throw new Error('fixture export failed'); return state.outcome === 'cancel' ? { canceled: true } : { canceled: false, path: 'C:/Fixtures/diagnostics.json' }; },
        async openDiagnosticsFolder() { state.folderCalls++; if (state.failFolder) throw new Error('fixture folder failed'); },
        reportRendererError(report) { state.reports.push(report); },
        async getSettings() { return { cwd: 'C:/Fixtures/Offline' }; },
        async start() { throw new Error('Fixture offline'); },
        onEvent() { return () => {}; },
        async setSettings() {},
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
      };
      window.codex = { ...bridge, forSession() { return bridge; } };
      if (mode === 'react-error') Object.defineProperty(window.codex, 'getWorkspace', { get() { throw new TypeError('Fixture rendering crash'); } });
    }, mode);
    await result.goto(`http://127.0.0.1:${server.address().port}`);
    return result;
  };
  page = await createPage();
  const open = () => page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  const modal = () => page.getByRole('dialog', { name: 'Диагностика', exact: true });
  const save = () => modal().getByRole('button', { name: 'Сохранить диагностику', exact: true });
  const set = patch => page.evaluate(patch => Object.assign(window.__diagnostics, patch), patch);
  await open(); await modal().getByText('Журнал включён', { exact: true }).waitFor();
  assert.equal(await page.locator('.session-tab').count(), 0, 'Diagnostics available without any open session');
  await save().click(); await modal().getByText('Сохранение отменено.', { exact: true }).waitFor();
  await set({ outcome: 'error' }); await save().click();
  await modal().getByRole('alert').filter({ hasText: 'Не удалось сохранить диагностику' }).waitFor();
  await set({ outcome: 'success' }); await save().click();
  await modal().getByText('Диагностика сохранена: C:/Fixtures/diagnostics.json', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__diagnostics.exports), 3);
  await modal().getByRole('button', { name: 'Открыть папку', exact: true }).click();
  await modal().getByText('Папка журнала открыта в проводнике.', { exact: true }).waitFor();
  await set({ failFolder: true }); await modal().getByRole('button', { name: 'Открыть папку', exact: true }).click();
  await modal().getByRole('alert').filter({ hasText: 'Не удалось открыть папку журнала' }).waitFor();
  assert.equal(await page.evaluate(() => window.__diagnostics.folderCalls), 2);
  await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Диагностика', 'Closing restores focus');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await open(); await modal().waitFor(); await page.keyboard.press('Escape');
  await set({ unavailable: true }); await open();
  await modal().getByText('Запись журнала недоступна', { exact: true }).waitFor();
  await modal().getByText('Недостаточно места для журнала.', { exact: true }).waitFor();
  assert.equal(await save().isEnabled(), true, 'Exporter remains available to recover a partial report when logging is unavailable');
  await page.screenshot({ path: 'artifacts/diagnostics-unavailable.png' });
  await page.keyboard.press('Escape');
  await set({ unavailable: false }); await open();
  await modal().getByText('Журнал включён', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/diagnostics.png' });
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const error = new TypeError('Тестовая ошибка '.repeat(500));
    error.stack = 'file:///C:/private/example.js:17:4\n'.repeat(500);
    window.dispatchEvent(new ErrorEvent('error', { error }));
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new RangeError('Fixture rejection') }));
  });
  let reports = await page.evaluate(() => window.__diagnostics.reports);
  assert.deepEqual(reports.map(report => report.kind), ['error', 'unhandledrejection']);
  assert.ok(reports.every(report => Buffer.byteLength(JSON.stringify(report), 'utf8') <= 8000), 'Reports capped by UTF-8 bytes');
  await page.evaluate(() => { for (let i = 0; i < 40; i++) window.dispatchEvent(new ErrorEvent('error', { message: 'Fixture repeated failure' })); });
  reports = await page.evaluate(() => window.__diagnostics.reports);
  assert.equal(reports.length, 20, 'Renderer errors rate limited');
  await page.close();

  page = await createPage('disconnected');
  await page.getByText('Fixture offline', { exact: true }).first().waitFor();
  await open(); await modal().getByText('Журнал включён', { exact: true }).waitFor(); await save().click();
  await modal().getByText('Сохранение отменено.', { exact: true }).waitFor();
  await page.close();

  page = await createPage('react-error');
  await page.getByRole('heading', { name: 'Не удалось отобразить приложение', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Сохранить диагностику', exact: true }).click();
  await page.getByText('Сохранение отменено.', { exact: true }).waitFor();
  assert.ok((await page.evaluate(() => window.__diagnostics.reports)).some(report => report.kind === 'react'), 'React failures captured by boundary');
  await page.screenshot({ path: 'artifacts/diagnostics-react-error.png' });
  console.log('PASS: diagnostics with zero tabs, archive and disconnected Codex; cancel/error/retry/export/folder; unavailable logging; focus restoration; bounded/rate-limited renderer reports; React fallback export. Fake host only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/diagnostics-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally { if (browser) await browser.close(); server.close(); }
