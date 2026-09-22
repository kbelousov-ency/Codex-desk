import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with a local, read-only host fixture. No agent/model/config access.
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
  const createPage = async mode => {
    const result = await browser.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: 'UTC' });
    result.setDefaultTimeout(7000);
    result.on('pageerror', error => errors.push(error.message));
    await result.addInitScript(mode => {
      const cwd = 'C:/Fixtures/TooltipProject';
      const fixture = window.__tooltips = { starts: 0, modelRequests: 0, notificationLoads: 0 };
      const bridge = {
        async getBuildInfo() { return { channel: 'nightly', version: '0.3.0', buildId: '123456789abcdef', builtAt: '2026-09-21T10:20:00.000Z' }; },
        async getWorkspace() { return { projects: mode === 'empty' ? [] : [cwd], sessions: mode === 'empty' ? [] : [{ id: 'offline-tooltip', cwd }] }; },
        async listProjectThreads() { return { data: [], nextCursor: null }; },
        async listArchivedThreads() { return { data: [], nextCursor: null }; },
        async getDiagnosticsStatus() { return { enabled: true, directory: 'C:/Fixtures/Logs' }; },
        async getSettings() { return { cwd }; },
        async start() { fixture.starts++; throw new Error('Tooltip fixture offline'); },
        async request() { fixture.modelRequests++; throw new Error('Model requests are forbidden in tooltip UI checks'); },
        onEvent() { return () => {}; }, async setSettings() {},
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
        async getNotificationSettings() {
          fixture.notificationLoads++;
          return { supported: false, settings: { enabled: false, sound: false, completed: true, question: true, approval: true, error: true } };
        },
      };
      window.codex = { ...bridge, forSession() { return bridge; } };
    }, mode);
    await result.goto(`http://127.0.0.1:${server.address().port}`);
    await result.locator('.build-badge:visible').getByText('NIGHTLY', { exact: true }).waitFor();
    return result;
  };
  const tooltip = () => page.locator('.app-tooltip[role="tooltip"]');
  const button = name => page.getByRole('button', { name, exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dismiss = async () => {
    await page.keyboard.press('Escape');
    await page.mouse.move(600, 400);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await tooltip().waitFor({ state: 'hidden' });
  };
  const checkTooltip = async (target, expected) => {
    await tooltip().waitFor();
    assert.equal(await tooltip().count(), 1, 'The common layer renders one tooltip');
    assert.equal(await tooltip().innerText(), expected);
    const id = await tooltip().getAttribute('id');
    assert.ok(id, 'Tooltip has an accessible description ID');
    assert.ok((await target.getAttribute('aria-describedby'))?.split(/\s+/).includes(id), 'Hovered/focused target references its tooltip');
    assert.equal(await target.getAttribute('title'), null, 'Native title does not duplicate the styled description');
    assert.equal(await tooltip().evaluate(element => element.parentElement === document.body), true, 'Tooltip portal avoids clipped toolbars');
  };
  const checkFits = async () => {
    assert.equal(await tooltip().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, 'Description fits within the viewport');
  };

  page = await createPage('empty');
  assert.equal(await page.locator('.session-tab').count(), 0);
  const controls = [
    { name: 'Обновления приложения', text: 'Обновления приложения', role: 'dialog', opened: 'Обновления приложения' },
    { name: 'Палитра команд', text: 'Палитра команд (Ctrl+K)', role: 'dialog', opened: 'Палитра команд' },
    { name: 'Требуют внимания', text: 'Требуют внимания', role: 'region', opened: 'Диалоги, требующие внимания' },
    { name: 'Настройки уведомлений', text: 'Настройки уведомлений', role: 'dialog', opened: 'Быть в курсе задач' },
  ];
  for (const control of controls) {
    await dismiss();
    const target = button(control.name);
    // Hover the nested icon, as a real pointer usually lands on the SVG/path.
    await target.locator('svg').hover();
    await checkTooltip(target, control.text);
    await target.click();
    const opened = page.getByRole(control.role, { name: control.opened, exact: true });
    await opened.waitFor();
    assert.equal((await tooltip().allTextContents()).includes(control.text), false, 'Click dismisses the trigger description and preserves the action');
    await page.keyboard.press('Escape');
    await opened.waitFor({ state: 'hidden' });
  }
  assert.equal(await page.evaluate(() => window.__tooltips.notificationLoads), 1);

  await dismiss();
  const updates = button('Обновления приложения');
  await updates.hover();
  await page.waitForTimeout(150);
  assert.equal(await tooltip().count(), 0, 'Passing across icons does not immediately flash a tooltip');
  await checkTooltip(updates, 'Обновления приложения');
  await page.screenshot({ path: 'artifacts/tooltips-toolbar.png' });
  await tooltip().hover();
  await page.waitForTimeout(450);
  assert.equal(await tooltip().isVisible(), true, 'Pointer can travel into the tooltip without losing it');
  await tooltip().dispatchEvent('pointerdown', { pointerType: 'mouse' });
  assert.equal(await tooltip().isVisible(), true, 'Pointerdown inside the description allows selecting its text');
  const selected = await tooltip().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    return { text: selection.toString(), userSelect: getComputedStyle(element).userSelect };
  });
  assert.equal(selected.text, 'Обновления приложения');
  assert.notEqual(selected.userSelect, 'none', 'Tooltip text can be selected/copied');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.keyboard.press('Escape');
  await tooltip().waitFor({ state: 'hidden' });
  assert.equal(await updates.getAttribute('aria-describedby'), null, 'Dismissal removes a stale description reference');

  await dismiss();
  await page.keyboard.press('Tab');
  await updates.focus();
  await tooltip().waitFor({ timeout: 300 });
  await checkTooltip(updates, 'Обновления приложения');
  await page.keyboard.press('Escape');
  await tooltip().waitFor({ state: 'hidden' });
  assert.equal(await updates.evaluate(element => document.activeElement === element), true, 'Escape keeps keyboard focus on the action');
  await updates.evaluate(element => element.blur());
  await updates.focus();
  await checkTooltip(updates, 'Обновления приложения');
  await updates.evaluate(element => element.blur());
  await tooltip().waitFor({ state: 'hidden' });

  await dismiss();
  await updates.hover();
  await checkTooltip(updates, 'Обновления приложения');
  await page.locator('.workspace-tabs-bar').dispatchEvent('scroll');
  await tooltip().waitFor({ state: 'hidden' });
  await dismiss();
  await updates.hover();
  await checkTooltip(updates, 'Обновления приложения');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await tooltip().waitFor({ state: 'hidden' });
  await dismiss();
  await updates.hover();
  await checkTooltip(updates, 'Обновления приложения');
  await page.setViewportSize({ width: 650, height: 640 });
  await tooltip().waitFor({ state: 'hidden' });
  await dismiss();
  await button('Настройки уведомлений').hover();
  await checkTooltip(button('Настройки уведомлений'), 'Настройки уведомлений');
  await checkFits();
  await page.screenshot({ path: 'artifacts/tooltips-compact.png' });

  // The build badge retains its own richer metadata tooltip.
  await dismiss();
  await page.setViewportSize({ width: 1200, height: 800 });
  const badge = page.locator('.build-badge:visible');
  assert.equal(await badge.getAttribute('data-tooltip'), null);
  await badge.hover();
  await page.locator('.build-tooltip[role="tooltip"]').waitFor();
  assert.equal(await tooltip().count(), 0);
  assert.equal(await page.getByRole('tooltip').count(), 1, 'Build metadata has no duplicate generic tooltip');
  await page.keyboard.press('Escape');
  await page.locator('.build-tooltip').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__tooltips.modelRequests), 0);
  await page.close();

  page = await createPage('offline');
  await page.getByText('Tooltip fixture offline', { exact: true }).waitFor();
  const send = button('Отправить сообщение');
  assert.equal(await send.isDisabled(), true);
  await send.locator('svg').hover();
  await checkTooltip(send, 'Отправить (Enter)');
  await page.screenshot({ path: 'artifacts/tooltips-disabled-send.png' });
  await dismiss();
  const sidebarToggle = button('Переключить панель проектов');
  await sidebarToggle.hover();
  await checkTooltip(sidebarToggle, 'Скрыть проекты');
  await sidebarToggle.evaluate(element => element.setAttribute('data-tooltip', 'Описание изменилось во время наведения'));
  await page.waitForFunction(() => document.querySelector('.app-tooltip')?.textContent === 'Описание изменилось во время наведения');
  await checkTooltip(sidebarToggle, 'Описание изменилось во время наведения');
  await sidebarToggle.evaluate(element => element.setAttribute('data-tooltip', 'Скрыть проекты'));
  await dismiss();

  // Synthetic DOM only for unusual content/edge positions, handled by the same real layer.
  const longText = `Первая строка подсказки\nДлинное описание функции с переносами и сохранённым путём C:\\Fixtures\\${'очень-длинное-имя-'.repeat(18)}file.txt\nПоследняя строка`;
  await page.setViewportSize({ width: 650, height: 640 });
  await page.evaluate(text => {
    const target = document.createElement('button');
    target.id = 'tooltip-edge-fixture'; target.type = 'button'; target.textContent = '?';
    target.setAttribute('data-tooltip', text);
    target.style.cssText = 'position:fixed;right:1px;bottom:1px;width:26px;height:26px;z-index:9999';
    document.body.append(target);
  }, longText);
  const edge = page.locator('#tooltip-edge-fixture');
  await edge.hover();
  await checkTooltip(edge, longText);
  await settle();
  await checkFits();
  assert.equal(await tooltip().evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Long identifiers wrap without horizontal overflow');
  await page.screenshot({ path: 'artifacts/tooltips-multiline-edge.png' });
  await edge.evaluate(element => element.remove());
  await tooltip().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__tooltips.modelRequests), 0);
  assert.ok(await page.evaluate(() => window.__tooltips.starts > 0), 'Composer scenario uses an offline session fixture');
  assert.deepEqual(errors, []);
  console.log('PASS: shared styled descriptions in empty/offline workspaces; toolbar click actions; delayed nested-icon hover, keyboard focus/Escape/blur, disabled send; selectable text, dynamic updates, scroll/resize/removal dismissal; 650 px edge/multiline positioning; native titles absent and build metadata preserved. Fake host only, no model requests.');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'artifacts/tooltips-failure.png' }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => '(page unavailable)'));
  }
  throw error;
} finally { if (browser) await browser.close(); server.close(); }
