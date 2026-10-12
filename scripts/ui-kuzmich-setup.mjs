import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Перекраска темы собирается из тех же src/*.css: если цвет в приложении поменяли, а тему
// не пересобрали, дальше проверять нечего — упадём сразу и с понятным текстом.
execFileSync(process.execPath, ['scripts/kuzmich-theme-colors.mjs', '--check'], { stdio: 'inherit' });

// Exercise the real Kuzmich wizard against an isolated bridge fixture. No CLI installation,
// no Portal sign-in window, no cookie and no model request happens in this browser test.
const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'kuzmich-fixture', configureServer(vite) {
    vite.middlewares.use('/kuzmich-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/kuzmich-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:kuzmich-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:kuzmich-fixture' ? id : null; }, load(id) {
    if (id === 'virtual:kuzmich-fixture') return 'import React from "react"; import { createRoot } from "react-dom/client"; import KuzmichSetupWizard from "/src/KuzmichSetupWizard.tsx"; import "/src/styles.css"; const root = createRoot(document.getElementById("root")); window.__kuzmich.unmount = () => root.unmount(); root.render(React.createElement(KuzmichSetupWizard, { initial: true, onClose: provider => { window.__kuzmich.closed.push(provider); root.unmount(); } }));';
  } }],
});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/kuzmich-fixture`;
await mkdir('artifacts', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const scenario = new URLSearchParams(location.search).get('scenario') || 'default';
    const sessions = {
      default: { state: 'signed-out', keyState: 'none', products: { codex: true, claude: true } },
      pending: { state: 'signed-in', email: 'fixture@example.test', name: 'Пользователь Фикстуры', keyState: 'pending', products: { codex: true, claude: true } },
      nokey: { state: 'signed-in', email: 'fixture@example.test', keyState: 'none', products: { codex: true, claude: false } },
      held: { state: 'signed-in', email: 'fixture@example.test', keyState: 'held-elsewhere', heldBy: 'other@example.test', products: { codex: true, claude: true } },
      resuming: { state: 'signing-in', keyState: 'none', products: { codex: false, claude: false } },
      approved: { state: 'signed-in', email: 'fixture@example.test', keyState: 'approved', products: { codex: true, claude: true } },
      codexonly: { state: 'signed-in', email: 'fixture@example.test', keyState: 'approved', products: { codex: true, claude: false } },
    };
    const fixture = window.__kuzmich = {
      calls: [], closed: [], progressListeners: new Set(), focusCalls: 0,
      failClaude: false, holdLogin: false, releaseLogin: null, holdPortal: false, releasePortal: null,
      session: sessions[scenario] || sessions.default,
      loginResult: { state: 'signed-in', email: 'fixture@example.test', keyState: 'approved', products: { codex: true, claude: true } },
      requestKeyState: 'pending',
      connect: { running: false, products: {} },
      connectStages: [],
      scan: {
        platformSupported: true,
        components: [
          { id: 'codex', status: scenario === 'missing' ? 'missing' : 'installed', version: 'Codex CLI 1.0', executable: 'C:\\CLI\\codex.exe' },
          { id: 'claude', status: scenario === 'missing' ? 'missing' : 'installed', version: 'Claude Code CLI 2.1', executable: 'C:\\CLI\\claude.exe' },
          { id: 'git', status: 'installed' },
        ],
        config: { targetPath: 'D:\\Codex Home\\config.toml', defaultPath: 'C:\\Users\\Fixture\\.codex\\config.toml', customHome: false, exists: true },
        router: { configured: false, reachable: null, message: 'Роутер не настроен' },
      },
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const hold = async () => { if (fixture.holdPortal) await new Promise(resolve => { fixture.releasePortal = resolve; }); };
    window.codex = {
      // Канал сборки включает брендовую тему и даёт мастеру русское имя продукта.
      async getBuildInfo() { return { channel: 'experimental3', version: '0.0.0-fixture' }; },
      setup: {
      async state() { return { show: true, completed: false, deferred: false, experimental3: true }; },
      async scan() { fixture.calls.push({ method: 'scan' }); return clone(fixture.scan); },
      async install(id) {
        fixture.calls.push({ method: 'install', id });
        for (const listener of fixture.progressListeners) listener({ component: id, stage: 'installing', message: 'Устанавливаем выбранную программу…' });
        await new Promise(resolve => setTimeout(resolve, 60));
        if (id === 'claude' && fixture.failClaude) { fixture.failClaude = false; throw new Error('Не удалось скачать Claude. Попробуйте ещё раз.'); }
        Object.assign(fixture.scan.components.find(component => component.id === id), { status: 'installed', executable: `C:\\CLI\\${id}.exe`, version: `${id} 1.0` });
        for (const listener of fixture.progressListeners) listener({ component: id, stage: 'done', message: 'Установка завершена' });
        return clone(fixture.scan);
      },
      async chooseExecutable(id) { fixture.calls.push({ method: 'chooseExecutable', id }); return null; },
      async portalSession(options) {
        fixture.calls.push({ method: 'portalSession', options: options ? clone(options) : undefined });
        await hold();
        return clone(fixture.session);
      },
      async portalLogin() {
        fixture.calls.push({ method: 'portalLogin' });
        if (fixture.holdLogin) await new Promise(resolve => { fixture.releaseLogin = resolve; });
        fixture.session = clone(fixture.loginResult);
        return clone(fixture.session);
      },
      async portalLogout() {
        fixture.calls.push({ method: 'portalLogout' });
        await hold();
        fixture.session = { state: 'signed-out', keyState: 'none', products: { codex: false, claude: false } };
        return clone(fixture.session);
      },
      async portalRequestKey() {
        fixture.calls.push({ method: 'portalRequestKey' });
        await hold();
        fixture.session = { ...clone(fixture.session), keyState: fixture.requestKeyState };
        return clone(fixture.session);
      },
      async focusPortalLogin() { fixture.calls.push({ method: 'focusPortalLogin' }); fixture.focusCalls += 1; return true; },
      async portalConnect(options) {
        fixture.calls.push({ method: 'portalConnect', options: options ? clone(options) : undefined });
        const wanted = (options && options.products) || [];
        // The host answers immediately with a running status; the wizard then polls.
        const products = { ...clone(fixture.connect.products) };
        for (const id of wanted) products[id] = { state: 'working', message: `Готовим ${id}…` };
        fixture.connect = { running: true, products };
        return clone(fixture.connect);
      },
      async portalConnectStatus() {
        fixture.calls.push({ method: 'portalConnectStatus' });
        const next = fixture.connectStages.shift();
        if (next) fixture.connect = clone(next);
        return clone(fixture.connect);
      },
      async complete(options) { fixture.calls.push({ method: 'complete', options: clone(options) }); },
      onProgress(listener) { fixture.progressListeners.add(listener); return () => fixture.progressListeners.delete(listener); },
    } };
  });
  const fontOf = locator => locator.evaluate(element => getComputedStyle(element).fontFamily);
  const fontsReady = selector => page.evaluate(async family => { await document.fonts.ready; return document.fonts.check(family); }, selector);
  const dialogText = () => page.locator('.setup-dialog').innerText();
  const assertNoExternalWording = async where => {
    const text = await dialogText();
    assert.equal(/внешн/i.test(text), false, `the wizard must never mention an external browser (${where})`);
  };
  const toSignIn = async (scenario = 'default') => {
    await page.goto(scenario === 'default' ? url : `${url}?scenario=${scenario}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('heading', { name: 'Установим нужные CLI' }).waitFor();
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await page.getByRole('heading', { name: 'Один вход в Portal' }).waitFor();
    await page.waitForFunction(() => window.__kuzmich.calls.some(call => call.method === 'portalSession'));
  };
  const toConnect = async (scenario, stages) => {
    await toSignIn(scenario);
    if (stages) await page.evaluate(value => { window.__kuzmich.connectStages = value; }, stages);
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await page.getByRole('heading', { name: 'Кузьмич подключит CLI' }).waitFor();
  };
  const connectState = provider => page.locator(`[data-connect="${provider}"]`).getAttribute('data-connect-state');
  const codexDone = { state: 'done', message: 'Роутер принял ключ.', configPath: 'C:\\Users\\Fixture\\.codex\\config.toml', backupPath: 'C:\\Users\\Fixture\\.codex\\config.toml.backup-kuzmich' };
  const claudeDone = { state: 'done', configPath: 'C:\\Users\\Fixture\\.claude\\settings.json', backupPath: null };

  // --- Step 0: the CLI step reuses the standard cards and the existing bridge ----------
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Установим нужные CLI' }).waitFor();
  assert.equal(await page.locator('.setup-brand').innerText(), 'Кузьмич');
  assert.deepEqual(await page.locator('.setup-steps li strong').allInnerTexts(), ['CLI', 'Вход', 'Подключение', 'Готово']);

  // --- Тема и шрифты: атрибут на корне документа, Russo One только в словомарке ---------
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'kuzmich');
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['--bg', '--panel', '--line', '--muted', '--text', '--accent', '--green', '--red'].map(name => style.getPropertyValue(name).trim());
  });
  assert.deepEqual(tokens, ['#171a19', '#121514', '#3a413d', '#929d96', '#d5e0d8', '#9bb6a4', '#7fc49a', '#ce8e8e']);
  assert.equal((await fontOf(page.locator('.setup-brand-word'))).includes('Russo One'), true, 'the wordmark must ask for Russo One');
  assert.equal(await fontsReady('21px "Russo One"'), true, 'Russo One must load from the repository');
  for (const selector of ['.setup-description', '.setup-body h1', '.setup-button.is-primary', '.setup-agent-copy strong']) {
    const family = await fontOf(page.locator(selector).first());
    assert.equal(family.includes('IBM Plex Sans'), true, `${selector} must use IBM Plex Sans`);
    assert.equal(family.includes('Russo One'), false, `${selector} must not use the display font`);
  }
  assert.equal(await fontsReady('13px "IBM Plex Sans"'), true, 'IBM Plex Sans must load from the repository');
  // Три статических начертания раздаются по весам, которыми уже пользуется интерфейс.
  assert.deepEqual(await page.evaluate(async () => { await document.fonts.ready; return [400, 550, 620].map(weight => document.fonts.check(`${weight} 13px "IBM Plex Sans"`)); }), [true, true, true]);
  // Мятно-бирюзовый акцент приложения не должен просвечивать сквозь тему ни в одном
  // вычисленном цвете: дизайн-система допускает один серо-зелёный акцент.
  assert.deepEqual(await page.evaluate(() => {
    const hsl = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
      if (!d) return [0, 0];
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
      return [h, (d / (1 - Math.abs(2 * l - 1))) * 100];
    };
    const found = new Set();
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke']) {
        const value = style[property];
        if (typeof value !== 'string' || !value.startsWith('rgb')) continue;
        const [red, green, blue, alpha = 1] = value.match(/[0-9.]+/g).map(Number);
        if (!alpha) continue;
        const [hue, saturation] = hsl(red, green, blue);
        if (saturation >= 15 && hue >= 155 && hue <= 215) found.add(`${value} · ${property} · ${element.className}`);
      }
    }
    return [...found];
  }), [], 'no mint/teal accent may survive under the Kuzmich theme');
  // Клавиатурный фокус обязан оставаться видимым и в новой палитре.
  await page.keyboard.press('Tab');
  assert.deepEqual(await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return [document.activeElement.tagName, style.outlineStyle, style.outlineWidth, style.outlineColor]; }), ['BUTTON', 'solid', '2px', 'rgb(155, 182, 164)']);
  assert.equal(await page.getByRole('checkbox', { name: 'Установить Codex CLI', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Установить Claude Code CLI', exact: true }).isDisabled(), true);
  await assertNoExternalWording('CLI step');
  await page.screenshot({ path: 'artifacts/kuzmich-cli.png' });
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalSession')), false);

  // A failed install keeps the step, reports the error and installs again on retry.
  await page.goto(`${url}?scenario=missing`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => { window.__kuzmich.failClaude = true; });
  await page.getByRole('button', { name: 'Установить и продолжить', exact: true }).click();
  await page.getByText('Не удалось скачать Claude. Попробуйте ещё раз.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'install').map(call => call.id)), ['codex', 'claude']);
  await page.getByRole('button', { name: 'Установить и продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Один вход в Portal' }).waitFor();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Указать путь', exact: true }).first().click();
  await page.waitForFunction(() => window.__kuzmich.calls.some(call => call.method === 'chooseExecutable'));

  // --- Sign-in: signed-out → login → signing-in → signed-in/approved ------------------
  await toSignIn();
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalSession')), [{ method: 'portalSession', options: undefined }]);
  await page.getByText('Требуется вход', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-portal-session]').getAttribute('data-portal-session'), 'signed-out');
  assert.equal(await page.getByRole('button', { name: 'Показать окно входа', exact: true }).count(), 0);
  await assertNoExternalWording('signed out');
  await page.screenshot({ path: 'artifacts/kuzmich-signed-out.png' });

  await page.evaluate(() => { window.__kuzmich.holdLogin = true; });
  await page.getByRole('button', { name: 'Войти в Portal', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.releaseLogin);
  await page.getByText('Завершите вход в открывшемся окне.', { exact: false }).waitFor();
  await assertNoExternalWording('signing in');
  // The sign-in window must stay reachable while the wizard waits, unlike the rest of the footer.
  const showLogin = page.getByRole('button', { name: 'Показать окно входа', exact: true });
  assert.equal(await showLogin.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Настроить позже', exact: true }).isDisabled(), true);
  await showLogin.click();
  await page.waitForFunction(() => window.__kuzmich.focusCalls === 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__kuzmich.closed.length), 0);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalLogin').length), 1);
  await page.screenshot({ path: 'artifacts/kuzmich-signing-in.png' });
  await page.evaluate(() => { window.__kuzmich.holdLogin = false; window.__kuzmich.releaseLogin(); });

  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.getByText('Вход выполнен', { exact: true }).waitFor();
  await page.getByText('Ключ роутера активен', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-portal-session]').getAttribute('data-portal-session'), 'signed-in');
  assert.equal(await page.locator('[data-key-state]').getAttribute('data-key-state'), 'approved');
  // What the portal allows is shown next to what is actually installed.
  assert.deepEqual(await page.locator('[data-product] span').allInnerTexts(), ['Portal разрешает · установлен', 'Portal разрешает · установлен']);
  assert.equal(await page.getByRole('button', { name: 'Получить ключ', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Проверить снова', exact: true }).count(), 0);
  await assertNoExternalWording('signed in');
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.locator('.setup-footer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.locator('.setup-dialog').evaluate(element => element.scrollWidth === element.clientWidth), true);
  await page.screenshot({ path: 'artifacts/kuzmich-signed-in.png' });
  await page.setViewportSize({ width: 1100, height: 800 });

  // --- Подключение: both products, staged working → done ------------------------------
  await page.evaluate(stages => { window.__kuzmich.connectStages = stages; }, [
    { running: true, products: { codex: codexDone, claude: { state: 'working', message: 'Пишем settings.json…' } } },
    { running: false, products: { codex: codexDone, claude: claudeDone } },
  ]);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Кузьмич подключит CLI' }).waitFor();
  assert.deepEqual(await page.locator('.setup-steps li strong').allInnerTexts(), ['CLI', 'Вход', 'Подключение', 'Готово']);
  assert.equal(await page.locator('.setup-steps li').nth(2).innerText(), 'Подключение\nКузьмич настроит сам');
  // Nothing happens until the user asks for it.
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalConnect')), false);
  assert.equal(await connectState('codex'), 'idle');
  assert.equal(await connectState('claude'), 'idle');
  await assertNoExternalWording('connect idle');
  await page.screenshot({ path: 'artifacts/kuzmich-connect-idle.png' });

  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.calls.some(call => call.method === 'portalConnect'));
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnect')), [{ method: 'portalConnect', options: { products: ['codex', 'claude'] } }]);
  await page.getByText('Готовим codex…', { exact: true }).waitFor();
  assert.equal(await connectState('claude'), 'working');
  // A write in progress locks the wizard exactly like the sign-in wait does.
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Настроить позже', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__kuzmich.closed.length), 0);
  await page.screenshot({ path: 'artifacts/kuzmich-connect-working.png' });

  // First poll: codex lands, claude keeps working.
  await page.getByText('Пишем settings.json…', { exact: true }).waitFor();
  assert.equal(await connectState('codex'), 'done');
  await page.getByText('C:\\Users\\Fixture\\.codex\\config.toml', { exact: true }).waitFor();
  await page.getByText('C:\\Users\\Fixture\\.codex\\config.toml.backup-kuzmich', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isDisabled(), true);

  // Second poll: the run finishes and the step unlocks.
  await page.getByText('Подключение завершено', { exact: true }).waitFor();
  assert.equal(await connectState('claude'), 'done');
  assert.equal(await page.getByText('C:\\Users\\Fixture\\.claude\\settings.json', { exact: true }).count(), 1);
  // A product written without a previous file reports no backup line.
  assert.equal((await page.locator('[data-connect="claude"]').innerText()).includes('Резервная копия'), false);
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Подключить', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Подключить снова', exact: true }).count(), 0);
  // Пути к файлам — технический контекст, значит IBM Plex Mono.
  assert.equal((await fontOf(page.locator('[data-connect="codex"] code').first())).includes('IBM Plex Mono'), true, 'config paths must use IBM Plex Mono');
  assert.equal(await fontsReady('11px "IBM Plex Mono"'), true, 'IBM Plex Mono must load from the repository');
  await assertNoExternalWording('connect done');
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.locator('.setup-footer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.locator('.setup-dialog').evaluate(element => element.scrollWidth === element.clientWidth), true);
  await page.screenshot({ path: 'artifacts/kuzmich-connect-done.png' });
  await page.setViewportSize({ width: 1100, height: 800 });

  // Polling stops with the run: no further status reads once running flips false.
  const pollsAfterRun = await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnectStatus').length);
  assert.equal(pollsAfterRun, 2);
  await page.waitForTimeout(3 * 1000);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnectStatus').length), pollsAfterRun);

  // --- Готово: summary and complete with an installed provider ------------------------
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Всё готово к работе' }).waitFor();
  const summary = await page.locator('.setup-result-list').innerText();
  for (const expected of ['Codex CLI', 'Claude Code CLI', 'Вход в Portal', 'Ключ роутера активен', 'fixture@example.test', 'Подключение Codex', 'Подключение Claude']) {
    assert.equal(summary.includes(expected), true, `the summary must report ${expected}`);
  }
  assert.equal(await page.locator('[data-connect-summary="codex"]').getAttribute('data-connect-state'), 'done');
  assert.equal(await page.locator('[data-connect-summary="claude"]').getAttribute('data-connect-state'), 'done');
  assert.equal((await page.locator('[data-connect-summary="codex"]').innerText()).includes('Подключён через роутер'), true);
  await assertNoExternalWording('finish');
  await page.getByRole('radio', { name: 'Claude', exact: true }).check();
  await page.screenshot({ path: 'artifacts/kuzmich-finish.png' });
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.closed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { provider: 'claude', deferred: false } }]);
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.closed), ['claude']);

  // --- Only Codex allowed: Claude is reported skipped and never requested -------------
  await toConnect('codexonly', [{ running: false, products: { codex: codexDone, claude: { state: 'skipped', message: 'Portal не даёт доступ к Claude.' } } }]);
  assert.equal(await connectState('claude'), 'skipped');
  await page.getByText('Portal не даёт доступ к этому агенту', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.calls.some(call => call.method === 'portalConnect'));
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnect')), [{ method: 'portalConnect', options: { products: ['codex'] } }]);
  await page.getByText('Подключение завершено', { exact: true }).waitFor();
  assert.equal(await connectState('codex'), 'done');
  assert.equal(await connectState('claude'), 'skipped');
  await page.getByText('Portal не даёт доступ к Claude.', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/kuzmich-connect-codex-only.png' });
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Всё готово к работе' }).waitFor();
  assert.equal(await page.locator('[data-connect-summary="claude"]').getAttribute('data-connect-state'), 'skipped');
  assert.equal((await page.locator('[data-connect-summary="claude"]').innerText()).includes('Пропущен'), true);

  // --- An error on one product is retried on its own ----------------------------------
  await toConnect('approved', [{ running: false, products: { codex: codexDone, claude: { state: 'error', message: 'Не удалось записать settings.json.' } } }]);
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Не удалось записать settings.json.' }).waitFor();
  assert.equal(await connectState('claude'), 'error');
  assert.equal(await connectState('codex'), 'done');
  // The failure does not block the step, and it offers a per-product retry.
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isEnabled(), true);
  await page.screenshot({ path: 'artifacts/kuzmich-connect-error.png' });
  await page.evaluate(stages => { window.__kuzmich.connectStages = stages; }, [{ running: false, products: { codex: codexDone, claude: claudeDone } }]);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnect').length === 2);
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalConnect').map(call => call.options)), [{ products: ['codex', 'claude'] }, { products: ['claude'] }]);
  await page.getByText('Подключение завершено', { exact: true }).waitFor();
  assert.equal(await connectState('claude'), 'done');
  assert.equal(await page.getByRole('button', { name: 'Повторить', exact: true }).count(), 0);
  await assertNoExternalWording('connect retry');

  // --- The gate: an unapproved key never reaches portalConnect ------------------------
  await toSignIn('pending');
  await page.getByText('Ключ ждёт одобрения администратора портала', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Кузьмич подключит CLI' }).waitFor();
  await page.getByText('Сначала нужен активный ключ роутера', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-connect-gate]').getAttribute('data-connect-gate'), 'pending');
  assert.equal(await page.getByRole('button', { name: 'Подключить', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-connect]').count(), 0);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalConnect')), false);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalConnectStatus')), false);
  await assertNoExternalWording('connect gate');
  await page.screenshot({ path: 'artifacts/kuzmich-connect-gate.png' });
  await page.getByRole('button', { name: 'К шагу «Вход»', exact: true }).click();
  await page.getByRole('heading', { name: 'Один вход в Portal' }).waitFor();

  // The same gate covers a user who skipped the sign-in altogether.
  await toSignIn();
  await page.getByRole('button', { name: 'Войти позже', exact: true }).click();
  await page.getByRole('heading', { name: 'Кузьмич подключит CLI' }).waitFor();
  await page.getByText('Сначала нужен вход в Portal', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-connect-gate]').getAttribute('data-connect-gate'), 'signed-out');
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalConnect')), false);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Всё готово к работе' }).waitFor();
  assert.equal(await page.locator('[data-connect-summary="codex"]').getAttribute('data-connect-state'), 'idle');

  // --- keyState pending: «Проверить снова» asks for a fresh session -------------------
  await toSignIn('pending');
  await page.getByText('Ключ ждёт одобрения администратора портала', { exact: true }).waitFor();
  await page.getByText('Пользователь Фикстуры', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-key-state]').getAttribute('data-key-state'), 'pending');
  assert.equal(await page.getByRole('button', { name: 'Получить ключ', exact: true }).count(), 0);
  await page.screenshot({ path: 'artifacts/kuzmich-key-pending.png' });
  await page.evaluate(() => { window.__kuzmich.holdPortal = true; });
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.releasePortal);
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__kuzmich.session.keyState = 'approved'; window.__kuzmich.holdPortal = false; window.__kuzmich.releasePortal(); });
  await page.getByText('Ключ роутера активен', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalSession').map(call => call.options)), [undefined, { refresh: true }]);

  // --- keyState none: «Получить ключ» can land on the approval pause ------------------
  await toSignIn('nokey');
  await page.getByText('Ключ роутера пока не выдан', { exact: true }).waitFor();
  // The portal may allow one agent and refuse the other; both are reported.
  assert.deepEqual(await page.locator('[data-product] span').allInnerTexts(), ['Portal разрешает · установлен', 'Portal не даёт доступ · установлен']);
  assert.equal(await page.getByRole('button', { name: 'Проверить снова', exact: true }).count(), 0);
  await page.screenshot({ path: 'artifacts/kuzmich-key-none.png' });
  await page.getByRole('button', { name: 'Получить ключ', exact: true }).click();
  await page.getByText('Ключ ждёт одобрения администратора портала', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-key-state]').getAttribute('data-key-state'), 'pending');
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalRequestKey').length), 1);
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).waitFor();
  await assertNoExternalWording('key request');

  // --- keyState held-elsewhere names the account that owns the key --------------------
  await toSignIn('held');
  const held = page.getByRole('alert').filter({ hasText: 'other@example.test' });
  await held.waitFor();
  assert.equal((await held.innerText()).includes('Войдите под ней'), true);
  assert.equal(await page.locator('[data-key-state]').getAttribute('data-key-state'), 'held-elsewhere');
  assert.equal(await page.getByRole('button', { name: 'Получить ключ', exact: true }).count(), 0);
  await page.screenshot({ path: 'artifacts/kuzmich-key-held.png' });
  // Quiet sign-out returns the step to its signed-out state.
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('button', { name: 'Войти в Portal', exact: true }).waitFor();
  await page.getByText('Требуется вход', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalLogout').length), 1);

  // --- A session already signing in shows the waiting state without starting a login --
  await toSignIn('resuming');
  await page.getByText('Ожидаем вход', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Показать окно входа', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.focusCalls === 1);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalLogin')), false);
  await assertNoExternalWording('resuming');

  // --- A cancelled sign-in leaves the wizard usable -----------------------------------
  await toSignIn();
  await page.evaluate(() => { window.__kuzmich.loginResult = { state: 'signed-out', keyState: 'none', products: { codex: false, claude: false }, message: 'Вход не завершён.' }; });
  await page.getByRole('button', { name: 'Войти в Portal', exact: true }).click();
  await page.getByText('Вход не завершён.', { exact: true }).waitFor();
  const loginAgain = page.getByRole('button', { name: 'Войти в Portal', exact: true });
  await loginAgain.waitFor();
  assert.equal(await loginAgain.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Войти позже', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isEnabled(), true);
  // A second attempt still reaches the host, and the wizard still navigates.
  await page.evaluate(() => { window.__kuzmich.loginResult = { state: 'signed-in', email: 'fixture@example.test', keyState: 'approved', products: { codex: true, claude: true } }; });
  await loginAgain.click();
  await page.getByText('Ключ роутера активен', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'portalLogin').length), 2);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Кузьмич подключит CLI' }).waitFor();
  // «Без подключения» keeps the step skippable before any attempt.
  await page.getByRole('button', { name: 'Без подключения', exact: true }).click();
  await page.getByRole('heading', { name: 'Всё готово к работе' }).waitFor();

  // --- «Настроить позже» is preserved -------------------------------------------------
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.setup-footer').getByRole('button', { name: 'Настроить позже', exact: true }).click();
  await page.waitForFunction(() => window.__kuzmich.closed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { deferred: true } }]);
  assert.equal(await page.evaluate(() => window.__kuzmich.progressListeners.size), 0);
  assert.equal(await page.evaluate(() => window.__kuzmich.calls.some(call => call.method === 'portalLogin')), false);

  // Escape on the first step defers as well, and never leaves a sign-in behind.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Установим нужные CLI' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__kuzmich.closed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__kuzmich.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { deferred: true } }]);

  assert.deepEqual(errors, []);
  console.log('Kuzmich wizard browser checks passed: brand theme attribute with the design-system tokens, Russo One wordmark with IBM Plex Sans body text and IBM Plex Mono paths, no mint/teal leftovers, visible keyboard focus, CLI install/retry/choose-path, sign-out → login → waiting → signed-in, key states approved/pending/none/held-elsewhere, portal product access, resumed/cancelled sign-in, sign-out, connect success with staged polling and paths/backups, codex-only skip, per-product error + retry, unapproved-key and signed-out gates with zero connect calls, polling stop, finish summary, deferred completion, no external-browser wording. No real CLI, Portal or model calls.');
} finally {
  await browser?.close();
  await server.close();
}
