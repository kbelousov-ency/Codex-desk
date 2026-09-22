import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer + fixture IPC; no GitHub traffic, browser download, CLI or model requests.
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
  const errors = [];
  const createPage = async (options = {}) => {
    const result = await browser.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: 'UTC' });
    result.setDefaultTimeout(7000);
    result.on('pageerror', error => errors.push(error.message));
    await result.addInitScript(options => {
      const channel = options.channel || 'stable';
      const saved = JSON.parse(localStorage.getItem('fixture-updates') || '{}');
      const state = window.__appUpdates = {
        listeners: new Set(), checks: 0, downloads: 0, writes: [], failLoad: Boolean(options.failLoad), failSave: false, failDownload: false,
        status: { currentVersion: '0.2.0', channel, supported: channel === 'stable', enabled: true, phase: channel === 'stable' ? 'up-to-date' : 'disabled', checkedAt: '2026-09-21T10:20:00Z', ...saved },
      };
      state.emit = patch => { state.status = { ...state.status, ...patch }; for (const listener of state.listeners) listener(structuredClone(state.status)); };
      state.newRelease = (version = '0.3.0') => state.emit({ phase: 'available', latestVersion: version, downloadUrl: 'https://github.com/owner/repo/releases/download/v0.3.0/Setup.exe', releaseNotes: 'Новые возможности\n<img src=x onerror="window.__unsafe=1">\n[Ссылка](javascript:alert(1))' });
      window.codex = {
        async getBuildInfo() { return { channel, version: '0.2.0', buildId: '12345678901234567890' }; },
        async getWorkspace() { return { projects: [], sessions: [] }; },
        async listProjectThreads() { return { data: [], nextCursor: null }; },
        async listArchivedThreads() { return { data: [], nextCursor: null }; },
        async getSettings() { return {}; },
        async getAppUpdateStatus() {
          if (state.failLoad) throw new Error('Fixture load unavailable');
          const snapshot = structuredClone(state.status);
          if (options.eventRace) { state.newRelease(); await new Promise(resolve => setTimeout(resolve, 40)); }
          return snapshot;
        },
        onAppUpdateStatus(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async checkAppUpdates() {
          state.checks++; state.emit({ phase: 'checking', error: undefined });
          await new Promise(resolve => setTimeout(resolve, 60));
          state.emit({ phase: 'up-to-date', latestVersion: undefined, downloadUrl: undefined, checkedAt: '2026-09-21T11:20:00Z' });
          return structuredClone(state.status);
        },
        async setAppUpdatePreferences(patch) {
          state.writes.push(patch);
          if (state.failSave) throw new Error('Fixture preferences unavailable');
          const savedPatch = { ...patch, ...('skippedVersion' in patch ? { skippedVersion: patch.skippedVersion || undefined } : {}) };
          state.emit(savedPatch);
          localStorage.setItem('fixture-updates', JSON.stringify({ enabled: state.status.enabled, skippedVersion: state.status.skippedVersion }));
          return structuredClone(state.status);
        },
        async openAppUpdateDownload() { state.downloads++; if (state.failDownload) throw new Error('Fixture browser unavailable'); },
      };
      if (options.missing) for (const key of ['getAppUpdateStatus', 'onAppUpdateStatus', 'checkAppUpdates', 'setAppUpdatePreferences', 'openAppUpdateDownload']) delete window.codex[key];
    }, options);
    await result.goto(`http://127.0.0.1:${server.address().port}`);
    await result.getByRole('button', { name: 'Выбрать папку проекта', exact: true }).waitFor();
    return result;
  };
  const dialog = () => page.getByRole('dialog', { name: 'Обновления приложения', exact: true });
  const banner = () => page.getByRole('complementary', { name: 'Доступно обновление приложения' });
  const open = async () => { await page.getByRole('button', { name: 'Обновления приложения', exact: true }).click(); await dialog().waitFor(); };
  const close = async () => { await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); };

  page = await createPage();
  await open();
  await dialog().getByText('Установлена актуальная версия.', { exact: true }).waitFor();
  assert.match(await dialog().innerText(), /Версия\s*0\.2\.0/);
  assert.match(await dialog().innerText(), /21\.09\.2026, 10:20/);
  assert.equal(await dialog().getByRole('checkbox').isChecked(), true);
  const closeButton = dialog().getByRole('button', { name: 'Закрыть обновления приложения' });
  assert.equal(await closeButton.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog().getByRole('button', { name: 'Готово', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await closeButton.evaluate(el => el === document.activeElement), true);
  await dialog().getByRole('checkbox').click();
  await page.waitForFunction(() => window.__appUpdates.status.enabled === false);
  await dialog().getByRole('button', { name: 'Проверить сейчас' }).click();
  await page.waitForFunction(() => window.__appUpdates.checks === 1 && window.__appUpdates.status.phase === 'up-to-date');
  assert.equal(await dialog().getByRole('checkbox').isChecked(), false, 'Manual checks are available when automatic checks are disabled');
  await close();
  assert.equal(await page.getByRole('button', { name: 'Обновления приложения', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => window.__appUpdates.newRelease());
  await banner().waitFor();
  const position = await page.evaluate(() => ({ banner: document.querySelector('.app-update-banner').getBoundingClientRect().bottom, tabs: document.querySelector('.workspace-tabs-bar').getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.ok(position.banner <= position.tabs, 'Update notice does not cover chat tabs');
  assert.equal(position.overflow, false);
  await banner().getByRole('button', { name: 'Скачать обновление', exact: true }).click();
  await banner().getByText('Загрузка открыта в браузере. Запустите скачанный установщик.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__appUpdates.downloads), 1);
  await banner().getByRole('button', { name: 'Подробнее', exact: true }).click();
  await dialog().locator('summary').click();
  assert.match(await dialog().locator('.app-update-notes').innerText(), /<img src=x/);
  assert.equal(await dialog().locator('.app-update-notes img, .app-update-notes a').count(), 0, 'Release notes render as plain text');
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  await page.setViewportSize({ width: 700, height: 700 });
  assert.equal(await dialog().evaluate(el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }), true);
  assert.equal(await dialog().getByRole('button', { name: 'Готово', exact: true }).evaluate(el => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true, 'Dialog footer stays visible with expanded release notes');
  await page.screenshot({ path: 'artifacts/app-updates-dialog.png' });
  await close();
  await banner().getByRole('button', { name: 'Позже', exact: true }).click();
  await banner().waitFor({ state: 'hidden' });
  await page.evaluate(() => window.__appUpdates.newRelease());
  assert.equal(await banner().count(), 0, 'Later suppresses subsequent events for the same version this launch');
  assert.equal(await page.evaluate(() => window.__appUpdates.writes.length), 1, 'Later does not write a persistent skip preference');
  await page.reload();
  await page.getByRole('button', { name: 'Выбрать папку проекта', exact: true }).waitFor();
  await page.evaluate(() => window.__appUpdates.newRelease());
  await banner().waitFor();
  await banner().getByRole('button', { name: 'Пропустить эту версию', exact: true }).click();
  await banner().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__appUpdates.status.skippedVersion), '0.3.0');
  await page.reload();
  await page.getByRole('button', { name: 'Выбрать папку проекта', exact: true }).waitFor();
  await page.evaluate(() => window.__appUpdates.newRelease());
  await open();
  await dialog().getByText('Вы пропустили эту версию. Её по-прежнему можно скачать вручную.', { exact: true }).waitFor();
  assert.equal(await banner().count(), 0, 'Skip persists through restart');
  await dialog().getByRole('button', { name: 'Снова напоминать' }).click();
  await banner().waitFor();
  await close();
  await page.screenshot({ path: 'artifacts/app-updates-banner.png' });
  await page.close();

  page = await createPage({ failLoad: true });
  await open();
  await dialog().getByText(/Fixture load unavailable/).waitFor();
  await page.evaluate(() => { window.__appUpdates.failLoad = false; });
  await dialog().getByRole('button', { name: 'Повторить проверку' }).click();
  await dialog().getByText('Установлена актуальная версия.', { exact: true }).waitFor();
  await page.evaluate(() => { window.__appUpdates.failSave = true; });
  await dialog().getByRole('checkbox').click();
  await dialog().getByText(/Fixture preferences unavailable/).waitFor();
  assert.equal(await dialog().getByRole('checkbox').isChecked(), true, 'Failed preference writes leave the host value shown');
  await page.evaluate(() => { window.__appUpdates.failSave = false; });
  await dialog().getByRole('button', { name: 'Повторить сохранение' }).click();
  await page.waitForFunction(() => window.__appUpdates.status.enabled === false);
  await page.evaluate(() => { window.__appUpdates.newRelease(); window.__appUpdates.failDownload = true; });
  await dialog().getByRole('button', { name: 'Скачать обновление' }).click();
  await dialog().getByText(/Fixture browser unavailable/).waitFor();
  await page.evaluate(() => { window.__appUpdates.failDownload = false; });
  await dialog().getByRole('button', { name: 'Повторить загрузку' }).click();
  await dialog().getByText('Загрузка открыта в браузере.', { exact: true }).waitFor();
  await page.evaluate(() => window.__appUpdates.emit({ phase: 'error', error: 'GitHub временно недоступен' }));
  await dialog().getByText('GitHub временно недоступен', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'Повторить проверку' }).click();
  await dialog().getByText('Установлена актуальная версия.', { exact: true }).waitFor();
  await page.close();

  page = await createPage({ eventRace: true });
  await banner().waitFor();
  await open();
  await dialog().getByText('Доступна версия 0.3.0.', { exact: true }).waitFor();
  await page.close();

  for (const channel of ['nightly', 'development']) {
    page = await createPage({ channel });
    await page.locator('.build-badge').click();
    await dialog().getByText(/обновляется локально/).waitFor();
    assert.equal(await dialog().getByRole('checkbox').count(), 0);
    assert.equal(await dialog().getByRole('button', { name: 'Проверить сейчас' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__appUpdates.checks), 0);
    await close();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Палитра команд' }).getByRole('combobox').fill('Обновления приложения');
    await page.keyboard.press('Enter');
    await dialog().waitFor();
    await page.close();
  }
  page = await createPage({ missing: true });
  await open();
  await dialog().getByText('Онлайн-обновления недоступны в этой сборке.', { exact: true }).waitFor();
  assert.equal(await banner().count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: online update events, status race, version, plain release notes, browser action, later/skip/re-enable, manual check with automatic off, error retries, keyboard/focus, compact layout, palette/badge entry and Nightly/dev/legacy bridge fallback. Fixture IPC only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/app-updates-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally { if (browser) await browser.close(); server.close(); }