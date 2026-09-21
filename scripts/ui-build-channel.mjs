import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with a read-only fake host. No Codex/model/config access.
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
  const createPage = async (mode, channel = 'stable') => {
    const result = await browser.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: 'UTC' });
    result.setDefaultTimeout(7000);
    result.on('pageerror', error => errors.push(error.message));
    await result.addInitScript(({ mode, channel }) => {
      const state = window.__build = { calls: 0 };
      const thread = { id: 'archive-fixture', name: 'Архивный диалог', cwd: 'C:/Fixtures/Project', turns: [] };
      const bridge = {
        async getBuildInfo() { state.calls++; if (mode === 'failure') throw new Error('Fixture unavailable'); return { channel, version: '0.1.0', buildId: '123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123', builtAt: mode === 'invalid-date' ? 'not a date' : '2026-09-18T10:20:00.000Z' }; },
        async getWorkspace() { return { projects: [], sessions: mode === 'tabs' ? [{ id: 'first', cwd: thread.cwd }, { id: 'second', cwd: thread.cwd }] : [] }; },
        async listProjectThreads() { return { data: [], nextCursor: null }; },
        async listArchivedThreads() { return { data: [thread], nextCursor: null }; },
        async readArchivedThread() { return { thread, items: [], turns: [], nextCursor: null }; },
        async getDiagnosticsStatus() { return { enabled: true, directory: 'C:/Fixtures/Logs' }; },
        async getSettings() { return { cwd: thread.cwd }; },
        async start() { throw new Error('Fixture offline'); },
        onEvent() { return () => {}; }, async setSettings() {},
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
      };
      window.codex = { ...bridge, forSession() { return bridge; } };
      if (mode === 'missing') delete window.codex.getBuildInfo;
    }, { mode, channel });
    await result.goto(`http://127.0.0.1:${server.address().port}`);
    return result;
  };
  const badge = () => page.locator('.build-badge:visible');
  const tooltip = () => page.locator('.build-tooltip[role="tooltip"]');
  const diagnostics = () => page.getByRole('dialog', { name: 'Диагностика', exact: true });
  const openDiagnostics = async () => { await page.locator('button[aria-label="Диагностика"]:visible').click(); await diagnostics().waitFor(); };
  const checkBadgeFits = async () => {
    assert.equal(await badge().isVisible(), true);
    assert.equal(await badge().evaluate(element => {
      const rect = element.getBoundingClientRect();
      const parent = element.closest('.sidebar').getBoundingClientRect();
      return rect.right <= parent.right && rect.left >= parent.left && rect.width > 0;
    }), true, 'Channel stays readable inside the sidebar at compact widths');
  };

  page = await createPage('empty');
  await badge().getByText('RELEASE', { exact: true }).waitFor();
  assert.equal(await page.locator('.session-tab').count(), 0);
  assert.match(await badge().getAttribute('aria-label'), /RELEASE\nВерсия 0\.1\.0\nСборка 123456789abc\n18\.09\.2026, 10:20/);
  assert.equal(await badge().getAttribute('title'), null, 'Only the styled tooltip appears');
  await badge().hover();
  await tooltip().waitFor();
  assert.match(await tooltip().innerText(), /Codex Desk[\s\S]*RELEASE[\s\S]*Версия\s*0\.1\.0[\s\S]*Сборка\s*123456789abc[\s\S]*18\.09\.2026, 10:20/);
  assert.equal(await badge().getAttribute('aria-describedby'), await tooltip().getAttribute('id'));
  await tooltip().hover();
  assert.equal(await tooltip().isVisible(), true, 'Pointer can enter the tooltip to read or select metadata');
  await page.keyboard.press('Escape');
  await tooltip().waitFor({ state: 'hidden' });
  await badge().focus();
  await tooltip().waitFor();
  await page.keyboard.press('Escape');
  await tooltip().waitFor({ state: 'hidden' });
  await badge().press('Enter');
  const updates = page.getByRole('dialog', { name: 'Обновления приложения', exact: true });
  await updates.waitFor();
  assert.equal(await tooltip().count(), 0, 'Opening updates dismisses the tooltip');
  await page.keyboard.press('Escape');
  await updates.waitFor({ state: 'hidden' });
  await checkBadgeFits();
  await openDiagnostics();
  await diagnostics().getByText('RELEASE', { exact: true }).waitFor();
  assert.equal(await diagnostics().locator('time').getAttribute('datetime'), '2026-09-18T10:20:00.000Z');
  assert.match(await diagnostics().locator('.build-details').innerText(), /Версия\s*0\.1\.0/);
  assert.match(await diagnostics().locator('.build-details').innerText(), /Сборка\s*123456789abc/);
  assert.match(await diagnostics().locator('time').innerText(), /18\.09\.2026, 10:20/);
  await page.screenshot({ path: 'artifacts/channel-release.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.locator('.archive-thread:visible').click();
  await page.locator('.archive-view:visible').waitFor();
  await badge().getByText('RELEASE', { exact: true }).waitFor();
  await openDiagnostics();
  await diagnostics().getByText('RELEASE', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__build.calls), 1, 'Empty workspace, archive and modal share one metadata request');
  await page.close();

  page = await createPage('tabs', 'nightly');
  await badge().getByText('NIGHTLY', { exact: true }).waitFor();
  assert.equal(await page.locator('.session-tab').count(), 2);
  await page.getByText('Fixture offline', { exact: true }).first().waitFor();
  await page.locator('.session-tab').last().getByRole('tab').click();
  await badge().getByText('NIGHTLY', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1000, height: 800 });
  await checkBadgeFits();
  await badge().hover();
  await tooltip().waitFor();
  assert.equal(await tooltip().evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  }), true, 'Compact tooltip stays in the viewport without sidebar clipping');
  await page.screenshot({ path: 'artifacts/channel-nightly-tooltip.png' });
  await openDiagnostics();
  await diagnostics().getByText('NIGHTLY', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__build.calls), 1, 'Independent disconnected tabs do not repeat metadata IPC');
  await page.screenshot({ path: 'artifacts/channel-nightly.png' });
  await page.close();

  page = await createPage('missing');
  await badge().getByText('DEV', { exact: true }).waitFor();
  await openDiagnostics();
  await diagnostics().getByText('Не указана', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__build.calls), 0, 'Legacy fixtures without the new bridge still work');
  await page.close();

  page = await createPage('failure');
  await badge().getByText('—', { exact: true }).waitFor();
  await openDiagnostics();
  await diagnostics().getByText('Сведения о сборке недоступны.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__build.calls), 1);
  await page.close();

  page = await createPage('invalid-date', 'development');
  await badge().getByText('DEV', { exact: true }).waitFor();
  assert.doesNotMatch(await badge().getAttribute('aria-label'), /Invalid|not a date/);
  await badge().hover();
  await tooltip().waitFor();
  assert.equal(await tooltip().locator('time').count(), 0);
  await openDiagnostics();
  assert.equal(await diagnostics().locator('time').count(), 0, 'Bad dates cannot crash diagnostics or mislead the user');
  assert.deepEqual(errors, []);
  console.log('PASS: release/nightly/dev identity in empty, independent offline and archive views; compact badge; styled hover/focus/Escape tooltip and update action; one shared IPC; version/hash/date in diagnostics; missing/failing bridge and invalid date fallback. Fake host only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/channel-failure.png' }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '(page unavailable)')); }
  throw error;
} finally { if (browser) await browser.close(); server.close(); }
