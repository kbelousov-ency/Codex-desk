import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with an isolated Codex bridge fixture. The fixture only
// serves router usage data; it never starts Codex or sends a model request.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const cwd = 'C:/Fixtures/ROUTER';
    const model = { id: 'fixture-router-model', model: 'fixture-router-model', displayName: 'Fixture Router', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Fixture' }] };
    const snapshot = {
      available: true,
      fetchedAt: '2026-09-22T10:00:00.000Z',
      overview: { email: 'fixture@example.test', last_24h: { credits: 9999, requests: 20, failures: 0 } },
      limits: [{ key: 'coder-fixture', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-09-28T03:00:00Z', limit_credits: 100, used_credits: 20, remaining_credits: 80, used_percent: 20 }],
    };
    const router = window.__router = { current: snapshot, calls: 0 };
    const listeners = new Set();
    const settings = { cwd, model: model.id, effort: 'high', access: 'workspace-write' };
    const bridge = {
      async start() {
        return { initialize: {}, cwd, models: [model], executable: 'C:/Fixtures/codex.exe', account: { account: null, requiresOpenaiAuth: false }, provider: 'codex', capabilities: { compact: true, steer: true, terminal: false, mcp: false, archive: true, usage: false }, config: { model: model.id, model_reasoning_effort: 'high', model_provider: 'router' } };
      },
      async getSettings() { return { ...settings }; },
      async setSettings(patch) { Object.assign(settings, patch); },
      async getRouterUsage() { router.calls += 1; return structuredClone(router.current); },
      async request(method, params = {}) {
        if (method === 'thread/list') return { data: [], nextCursor: null };
        if (method === 'thread/start') return { thread: { id: 'router-thread', cwd, turns: [] }, model: params.model };
        if (method === 'turn/start') return { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } };
        throw new Error(`Unexpected fixture request ${method}`);
      },
      async respond() {},
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
      async chooseDirectory() { return cwd; },
      async chooseExecutable() { return null; },
      async openPath() {},
      async showPathMenu() {},
      async saveImages(images) { return images; },
      async readAttachment() { return null; },
    };
    window.codex = {
      ...bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [{ id: 'router-session', cwd, provider: 'codex' }] }; },
      async listProjectThreads() { return { data: [], nextCursor: null }; },
      async createSession() { return { id: 'router-session', cwd, provider: 'codex' }; },
      async closeSession() {},
      forSession() { return bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const trigger = () => view().locator('.router-usage-trigger');
  const dialog = () => page.getByRole('dialog', { name: 'Статистика роутера', exact: true });
  const flush = () => page.waitForTimeout(100);
  const field = (name) => dialog().locator(`[data-limit-field="${name}"] dd`);
  const setSnapshot = snapshot => page.evaluate(value => { window.__router.current = value; }, snapshot);

  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await trigger().waitFor();
  await page.waitForFunction(() => document.querySelector('.router-usage-trigger')?.disabled === false);
  await page.waitForFunction(() => window.__router.calls > 0);
  await page.waitForFunction(() => document.querySelector('.router-usage-trigger')?.getAttribute('aria-label') === 'Роутер · 20%');
  assert.equal(await trigger().getAttribute('aria-label'), 'Роутер · 20%', 'Configured router provider exposes the usage trigger');

  await trigger().click();
  await dialog().waitFor();
  assert.equal(await dialog().locator('[data-router-limit]').count(), 1);
  assert.equal(await field('used').innerText(), '20');
  assert.equal(await field('percent').innerText(), '20%');
  assert.equal(await field('total').innerText(), '100');
  assert.equal(await field('remaining').innerText(), '80');
  assert.match(await field('reset').innerText(), /2026|03:00/, 'Reset timestamp is shown');
  assert.match(await dialog().innerText(), /fixture@example\.test/);
  assert.match(await dialog().innerText(), /9[\s\u00a0]?999\s*кредитов/, 'last_24h credits remain separate from the current limit usage');
  assert.match(await dialog().innerText(), /Запросы за 24 часа[\s\S]*20/);
  assert.doesNotMatch(await dialog().innerText(), /9[\s\u00a0]?999\s*\s*\/\s*100/, 'Daily credits never replace used_credits');

  // The ledger records the full period spend even when the other usage fields disagree.
  const periodLimit = { key: 'coder-fixture', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-09-28T03:00:00Z', limit_credits: 37000, used_credits: 4243.93, remaining_credits: 32756.07, used_percent: 11.47 };
  const credits = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  for (const scenario of [
    { name: 'Ledger spend wins over disagreeing usage fields', patch: { ledger_used_credits: 18658 }, expected: { used: credits(18658), total: credits(37000), remaining: credits(18342), percent: '50,4%' } },
    { name: 'Zero ledger spend is data, not a fallback trigger', patch: { ledger_used_credits: 0 }, expected: { used: '0', total: credits(37000), remaining: credits(37000), percent: '0%' } },
    { name: 'Ledger without a quota does not reuse a stale remaining amount or percent', patch: { ledger_used_credits: 18658, limit_credits: null }, expected: { used: credits(18658), total: '—', remaining: '—', percent: '—' } },
    { name: 'A zero quota cannot produce a percentage', patch: { ledger_used_credits: 18658, limit_credits: 0 }, expected: { used: credits(18658), total: '0', remaining: '0', percent: '—' } },
    { name: 'Overspending cannot make the remaining amount negative', patch: { ledger_used_credits: 40000 }, expected: { used: credits(40000), total: credits(37000), remaining: '0', percent: '108,1%' } },
    { name: 'Null ledger retains the reported usage fields', patch: { ledger_used_credits: null }, expected: { used: credits(4243.93), total: credits(37000), remaining: credits(32756.07), percent: '11,5%' } },
  ]) {
    await setSnapshot({ available: true, fetchedAt: '2026-09-24T10:00:00.000Z', overview: { email: 'fixture@example.test', last_24h: { credits: 9999, requests: 20, failures: 0 } }, limits: [{ ...periodLimit, ...scenario.patch }] });
    await dialog().getByRole('button', { name: 'Обновить статистику роутера', exact: true }).click();
    await page.waitForFunction(expected => Object.entries(expected).every(([name, value]) => document.querySelector(`[data-limit-field="${name}"] dd`)?.textContent === value), scenario.expected);
    for (const [name, value] of Object.entries(scenario.expected)) assert.equal(await field(name).innerText(), value, `${scenario.name}: ${name}`);
    const expectedTrigger = scenario.expected.percent === '—' ? `Роутер · ${credits(9999)} кр./сут` : `Роутер · ${scenario.expected.percent}`;
    assert.equal(await trigger().getAttribute('aria-label'), expectedTrigger, `${scenario.name}: trigger uses the same percentage as the card`);
  }

  // Numeric zero is data; null means unavailable and is rendered as an em dash.
  await setSnapshot({ available: true, fetchedAt: '2026-09-22T10:01:00.000Z', overview: { email: 'fixture@example.test', last_24h: { credits: 0, requests: 0, failures: 0 } }, limits: [{ key: 'coder-fixture', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: null, limit_credits: null, used_credits: 0, remaining_credits: 0 }] });
  const callsBeforeZero = await page.evaluate(() => window.__router.calls);
  await dialog().getByRole('button', { name: 'Обновить статистику роутера', exact: true }).click();
  await page.waitForFunction(before => window.__router.calls > before, callsBeforeZero);
  assert.equal(await field('used').innerText(), '0');
  assert.equal(await field('total').innerText(), '—');
  assert.equal(await field('remaining').innerText(), '0');
  assert.equal(await field('percent').innerText(), '—');
  assert.equal(await field('reset').innerText(), '—');
  assert.equal(await trigger().getAttribute('aria-label'), 'Роутер · 0 кр./сут', 'Without a published quota the trigger shows the measured daily spend, not «—»');
  const zeroText = await dialog().innerText();
  assert.match(zeroText, /Недостаточно данных для расчёта процента лимита\./, 'The popover explains why the percentage is missing');
  assert.match(zeroText, /За 24 часа[\s\S]*0\s*кредитов/, 'A measured zero daily credit value remains visible');
  assert.match(zeroText, /Запросы за 24 часа[\s\S]*0/, 'A measured zero request count remains visible');
  assert.match(zeroText, /Ошибки за 24 часа[\s\S]*0/, 'A measured zero failure count remains visible');
  assert.doesNotMatch(zeroText, /NaN|Infinity|undefined/);

  // Two keys are shown separately; the trigger must not sum them.
  await setSnapshot({ available: true, fetchedAt: '2026-09-22T10:02:00.000Z', overview: { email: 'fixture@example.test', last_24h: { credits: 9999, requests: 20, failures: 0 } }, limits: [
    { key: 'coder-fixture', available: true, tier: 'TierA', state: 'ACTIVE', reset_at: '2026-09-28T03:00:00Z', limit_credits: 100, used_credits: 20, remaining_credits: 80 },
    { key: 'review-fixture', available: true, tier: 'TierB', state: 'ACTIVE', reset_at: '2026-09-29T03:00:00Z', limit_credits: 50, used_credits: 7, remaining_credits: 43 },
  ] });
  await dialog().getByRole('button', { name: 'Обновить статистику роутера', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-router-limit]').length === 2);
  assert.match(await trigger().getAttribute('aria-label'), /^Роутер · 9[\s  ]999 кр\.\/сут$/, 'Multiple keys show the daily spend, never a summed-up percentage');
  assert.equal(await dialog().locator('[data-router-limit]').count(), 2);
  assert.equal(await dialog().locator('[data-router-limit]').nth(0).locator('[data-limit-field="used"] dd').innerText(), '20');
  assert.equal(await dialog().locator('[data-router-limit]').nth(1).locator('[data-limit-field="used"] dd').innerText(), '7');
  assert.equal(await dialog().locator('[data-router-limit]').nth(1).locator('[data-limit-field="percent"] dd').innerText(), '14%');

  // A limit endpoint failure retains independently fetched daily overview data.
  await setSnapshot({ available: true, fetchedAt: '2026-09-22T10:03:00.000Z', limitReason: 'fixture limit timeout', overview: { email: 'fixture@example.test', last_24h: { credits: 9999, requests: 20, failures: 0 } }, limits: [] });
  await dialog().getByRole('button', { name: 'Обновить статистику роутера', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('fixture limit timeout'));
  assert.match(await dialog().innerText(), /Не удалось обновить лимиты: fixture limit timeout/);
  assert.match(await dialog().innerText(), /9[\s\u00a0]?999\s*кредитов/);

  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(await trigger().evaluate(node => node === document.activeElement), true, 'Escape closes the dialog and restores trigger focus');

  for (const size of [{ width: 940, height: 700 }, { width: 650, height: 700 }]) {
    await page.setViewportSize(size); await flush();
    await trigger().click(); await dialog().waitFor();
    const box = await dialog().boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Router usage dialog fits ${size.width}px viewport`);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: router usage appears only for model_provider=router; ledger spend priority, zero/null ledger and quotas, usage fallback, overspending, daily overview, multiple keys, partial limit errors, refresh, Escape focus and narrow viewports are covered. Fixture bridge only; no real token or model request.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/router-usage-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
