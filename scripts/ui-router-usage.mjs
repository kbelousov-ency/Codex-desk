import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { activeView, fixtureServer, installFixture, limitsDialog, ready, sampleSnapshot, updateSnapshot } from './router-usage-fixture.mjs';

const server = await fixtureServer();
await mkdir('artifacts', { recursive: true });
let browser, page;
const credits = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Moscow' });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await installFixture(page, { secondTab: true });
  await page.goto(server.url); await ready(page);
  await page.waitForFunction(() => window.__limits.first.requests.some(value => value?.threadId === window.__limits.first.thread.id));
  const trigger = () => activeView(page).locator('.router-usage-trigger');
  const dialog = () => limitsDialog(page);
  const field = name => dialog().locator(`[data-limit-field="${name}"]`);
  const spend = name => dialog().locator(`[data-spend="${name}"] strong`);
  await trigger().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) .router-usage-trigger')?.getAttribute('aria-label') === 'Лимит · 80% осталось');
  await trigger().click(); await dialog().waitFor();
  assert.equal(await dialog().locator('[data-router-limit]').count(), 1);
  assert.equal(await field('remaining').innerText(), credits(25600));
  assert.equal(await field('total').innerText(), credits(32000));
  assert.equal(await field('percent').innerText(), '80%');
  assert.match(await field('reset').innerText(), /19.*окт|19\.10/);
  assert.match(await field('reset').innerText(), /06:00/);
  assert.equal(await spend('session').innerText(), credits(125.5));
  assert.equal(await spend('today').innerText(), credits(345.67));
  assert.equal(await dialog().locator('[data-router-band]').count(), 0, 'Codex hides Fable even if a malformed snapshot includes it');
  assert.doesNotMatch(await dialog().innerText(), /Подробнее|fixture@|fixture-secret|TierA|FREE_POOL|За 24 часа|9[\s\u00a0]999/);
  assert.match(await dialog().locator('.router-credit-freshness').innerText(), /Обновлено/);
  const box = await dialog().boundingBox(); assert.ok(box && Math.abs(box.width - 340) < 2 && box.height < 430, 'The common card is compact');
  await page.screenshot({ path: 'artifacts/router-usage-compact.png' });
  assert.equal(await dialog().locator('[data-spend="session"] small').innerText(), 'Текущий диалог');
  assert.ok(await page.evaluate(() => window.__limits.first.requests.every(value => value && Object.hasOwn(value, 'threadId')) && window.__limits.first.requests.at(-1).threadId === window.__limits.first.thread.id), 'UI explicitly scopes the resumed session request to its native thread ID');

  const period = { key: 'active-fixture', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-10-19T03:00:00Z', limit_credits: 37000, used_credits: 4243.93, remaining_credits: 32756.07, used_percent: 11.47 };
  for (const scenario of [
    { name: 'ledger priority', patch: { ledger_used_credits: 18658 }, remaining: 18342, total: 37000, percent: '49,6%' },
    { name: 'zero ledger is data', patch: { ledger_used_credits: 0 }, remaining: 37000, total: 37000, percent: '100%' },
    { name: 'ledger without quota', patch: { ledger_used_credits: 18658, limit_credits: null }, remaining: null, total: null, percent: '—' },
    { name: 'zero quota has no percent', patch: { ledger_used_credits: 18658, limit_credits: 0 }, remaining: 0, total: 0, percent: '—' },
    { name: 'overspend clamps remaining', patch: { ledger_used_credits: 40000 }, remaining: 0, total: 37000, percent: '0%' },
    { name: 'null ledger retains reported values', patch: { ledger_used_credits: null }, remaining: 32756.07, total: 37000, percent: '88,5%' },
  ]) {
    await updateSnapshot(page, { ...sampleSnapshot(), limits: [{ ...period, ...scenario.patch }] });
    assert.equal(await field('remaining').innerText(), scenario.remaining === null ? '—' : credits(scenario.remaining), scenario.name);
    assert.equal(await field('total').innerText(), scenario.total === null ? '—' : credits(scenario.total), scenario.name);
    assert.equal(await field('percent').innerText(), scenario.percent, scenario.name);
    assert.equal(await trigger().getAttribute('aria-label'), scenario.percent === '—' ? 'Лимит' : `Лимит · ${scenario.percent} осталось`, scenario.name);
  }
  const active = { ...period, limit_credits: 32000, ledger_used_credits: 8284.012071 };
  const free = { key: 'free-pool-fixture', available: false, tier: null, state: 'FREE_POOL', limit_credits: null, used_credits: null, remaining_credits: null };
  for (const limits of [[active, free], [free, active]]) {
    await updateSnapshot(page, { ...sampleSnapshot(), limits });
    assert.equal(await field('percent').innerText(), '74,1%');
    assert.equal(await field('remaining').innerText(), credits(23715.987929));
    assert.equal(await dialog().locator('[data-router-limit]').count(), 1);
    assert.doesNotMatch(await dialog().innerText(), /FREE_POOL|free-pool-fixture/);
  }
  for (const limits of [[{ ...active, available: false }], [active, { ...period, key: 'unknown', available: null }]]) {
    await updateSnapshot(page, { ...sampleSnapshot(), limits });
    assert.equal(await trigger().getAttribute('aria-label'), 'Лимит', 'Unavailable/multiple quotas never create a combined percentage');
    assert.equal(await field('remaining').innerText(), '—'); assert.equal(await field('total').innerText(), '—');
  }
  await updateSnapshot(page, { ...sampleSnapshot(), limits: [{ name: 'Codex', left: 75, limitCredits: null, usedCredits: null, remainingCredits: null, resetAt: null }], spend: { session: { credits: 0 }, today: { credits: null, partial: true, reason: 'Coverage unavailable', since: '2026-10-11T21:00:00Z' } } });
  assert.equal(await field('percent').innerText(), '75%', 'Known percentage does not invent unknown credit amounts');
  assert.equal(await field('remaining').innerText(), '—'); assert.equal(await field('total').innerText(), '—'); assert.equal(await field('reset').innerText(), '—');
  assert.equal(await spend('session').innerText(), '0', 'Measured zero remains a number');
  assert.equal(await spend('today').innerText(), '—', 'Unknown spend is never zero');
  await updateSnapshot(page, { ...sampleSnapshot(), spend: { session: { credits: 5, partial: true, reason: 'Child session unavailable' }, today: { credits: 12, partial: true, since: '2026-10-12T08:00:00Z' } } });
  assert.equal(await spend('session').innerText(), '5'); assert.equal(await spend('today').innerText(), '12');
  for (const period of ['session', 'today']) assert.match(await dialog().locator(`[data-spend="${period}"]`).innerText(), /частич/i, 'Partial coverage stays visible');
  assert.doesNotMatch(await dialog().innerText(), /NaN|Infinity|undefined/);
  await updateSnapshot(page, { ...sampleSnapshot(), limits: [], limitReason: 'Fixture limit timeout' });
  assert.match(await dialog().innerText(), /Fixture limit timeout/);
  assert.equal(await spend('today').innerText(), credits(345.67), 'Quota failure preserves independently fetched spend');
  await updateSnapshot(page, sampleSnapshot());

  // An old request must not win after switching away and back to the tab.
  await page.evaluate(() => { window.__limits.first.defer = true; window.__limits.first.current = { ...window.__limits.first.current, spend: { session: { credits: 999 }, today: { credits: 999 } } }; });
  await dialog().getByRole('button', { name: 'Обновить лимиты', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__limits.first.pending));
  await page.locator('.session-tab[data-session-id="limits-b"]').getByRole('tab').click();
  await dialog().waitFor({ state: 'hidden' });
  await page.evaluate(value => { window.__limits.first.current = value; }, sampleSnapshot());
  await page.locator('.session-tab[data-session-id="limits-a"]').getByRole('tab').click();
  await trigger().click(); await dialog().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-spend="session"] strong')?.textContent?.includes('125'));
  await page.evaluate(() => window.__limits.first.pending()); await page.waitForTimeout(100);
  assert.equal(await spend('session').innerText(), credits(125.5), 'A late response cannot overwrite the fresh activation');
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  assert.equal(await trigger().evaluate(node => node === document.activeElement), true);
  for (const size of [{ width: 940, height: 700 }, { width: 650, height: 700 }]) {
    await page.setViewportSize(size); await trigger().click(); await dialog().waitFor();
    const bounds = await dialog().boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= size.height + 1, `Card fits ${size.width}px`);
    assert.equal(await dialog().evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, 'Normal card needs no internal scrollbar');
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: compact credit limits; remaining percentage; ledger precedence; zero/unknown/overspend; free pool; ambiguous quotas; partial spend; stale-response isolation; Escape and narrow viewports. Fixture only; no CLI/model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/router-usage-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await server.close(); }
