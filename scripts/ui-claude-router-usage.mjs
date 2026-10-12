import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { activeView, fixtureServer, installFixture, limitsDialog, ready, sampleSnapshot, updateSnapshot } from './router-usage-fixture.mjs';

const cases = [
  { name: 'Codex comparison', provider: 'codex', connectionSource: 'router', routed: true },
  { name: 'inherited routed Claude', provider: 'claude', connectionSource: 'inherited', routed: true },
  { name: 'inherited personal Claude', provider: 'claude', connectionSource: 'inherited', routed: false },
  { name: 'explicit routed Claude', provider: 'claude', connectionSource: 'router', routed: true },
];
const server = await fixtureServer(); await mkdir('artifacts', { recursive: true });
let browser, page, codexStyle;
const credits = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const scenario of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Moscow' });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await installFixture(page, scenario); await page.goto(server.url); await ready(page);
    const view = activeView(page), trigger = view.locator('.router-usage-trigger'), plan = view.locator('.usage-limit-plain');
    if (scenario.routed) {
      await page.waitForFunction(() => window.__limits.first.requests.some(value => value?.threadId === window.__limits.first.thread.id));
      await trigger.waitFor();
      await page.waitForFunction(() => document.querySelector('.router-usage-trigger')?.getAttribute('aria-label') === 'Лимит · 80% осталось');
      await trigger.click(); const dialog = limitsDialog(page); await dialog.waitFor();
      assert.match(await dialog.locator('header').innerText(), scenario.provider === 'claude' ? /Лимиты[\s\S]*Claude/ : /Лимиты[\s\S]*Codex/);
      assert.equal(await dialog.locator('[data-limit-field="remaining"]').innerText(), credits(25600));
      assert.equal(await dialog.locator('[data-limit-field="total"]').innerText(), credits(32000));
      assert.equal(await dialog.locator('[data-spend="session"] strong').innerText(), credits(125.5));
      assert.equal(await dialog.locator('[data-spend="today"] strong').innerText(), credits(345.67));
      assert.equal(await dialog.locator('[data-spend="session"] small').innerText(), 'Текущий диалог');
      assert.ok(await page.evaluate(() => window.__limits.first.requests.at(-1).threadId === window.__limits.first.thread.id), 'Credit query carries the restored native thread ID');
      assert.doesNotMatch(await dialog.innerText(), /Подробнее|За 24 часа|fixture@|TierA|FREE_POOL/);
      const style = await dialog.evaluate(node => {
        const values = element => { const s = getComputedStyle(element); return { font: s.font, color: s.color, padding: s.padding, borderRadius: s.borderRadius, background: s.backgroundColor }; };
        return { width: node.getBoundingClientRect().width, panel: values(node), remaining: values(node.querySelector('[data-limit-field="remaining"]')), total: values(node.querySelector('[data-limit-field="total"]')), session: values(node.querySelector('[data-spend="session"]')), today: values(node.querySelector('[data-spend="today"]')) };
      });
      if (scenario.provider === 'codex') {
        codexStyle = style; assert.equal(await dialog.locator('[data-router-band]').count(), 0);
        await page.screenshot({ path: 'artifacts/limits-codex-identical.png' });
        await dialog.screenshot({ path: 'artifacts/limits-codex-card.png' });
      } else {
        assert.deepEqual(style, codexStyle, 'Both agents share identical dimensions, typography, spacing and colors');
        assert.equal(await dialog.locator('[data-router-band="fable"]').count(), 1);
        assert.match(await dialog.locator('[data-router-band="fable"]').innerText(), /Fable[\s\S]*60%/);
        assert.match(await dialog.locator('[data-router-band="fable"]').innerText(), /06:00/);
        assert.equal(await plan.count(), 0, `${scenario.name}: routed CLI has no claude.ai plan control`);
        await page.screenshot({ path: 'artifacts/limits-claude-identical.png' });
        await dialog.screenshot({ path: 'artifacts/limits-claude-card.png' });
        // Remaining-only portal data must never imply a known zero credit balance.
        await updateSnapshot(page, { ...sampleSnapshot('claude'), limits: [{ name: 'Claude', left: 30, resetAt: '2026-10-19T03:00:00Z', limitCredits: null, usedCredits: null, remainingCredits: null, bands: [{ name: 'Fable', left: 46, resetAt: '2026-10-19T03:00:00Z' }] }], spend: { session: { credits: null, reason: 'Relay has no credit amounts' }, today: { credits: null, since: '2026-10-11T21:00:00Z' } } });
        assert.equal(await trigger.getAttribute('aria-label'), 'Лимит · 30% осталось');
        assert.equal(await dialog.locator('[data-limit-field="remaining"]').innerText(), '—');
        assert.equal(await dialog.locator('[data-limit-field="total"]').innerText(), '—');
        assert.equal(await dialog.locator('[data-spend="session"] strong').innerText(), '—');
        assert.equal(await dialog.locator('[data-spend="today"] strong').innerText(), '—');
        assert.match(await dialog.locator('[data-router-band="fable"]').innerText(), /46%/);
        await updateSnapshot(page, sampleSnapshot('claude'));
      }
      assert.ok(await page.evaluate(() => window.__limits.first.calls > 0), scenario.name);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      for (const size of [{ width: 940, height: 700 }, { width: 650, height: 700 }]) {
        await page.setViewportSize(size); await trigger.click(); await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `${scenario.name} fits ${size.width}px`);
        assert.equal(await dialog.evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, 'A normal card has no scrollbar');
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      }
    } else {
      await page.waitForFunction(() => window.__limits.first.usage > 0); await plan.waitFor();
      assert.equal(await trigger.count(), 0, 'Personal Claude has no router UI');
      assert.equal(await page.evaluate(() => window.__limits.first.calls), 0, 'Personal Claude never requests router usage');
    }
    assert.deepEqual(errors, [], scenario.name); await context.close();
  }
  console.log('PASS: identical compact Codex/Claude credit cards, Claude-only Fable, remaining-only portal data, inherited/explicit router and personal-source separation, narrow viewports. Fixture only; no real CLI/token/model request.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/claude-router-usage-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await server.close(); }
