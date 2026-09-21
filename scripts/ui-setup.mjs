import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Exercise the real wizard against an isolated preload fixture. No CLI installation,
// account login, config write, or model request is performed by this browser test.
const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'setup-fixture', configureServer(vite) {
    vite.middlewares.use('/setup-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/setup-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:setup-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:setup-fixture' ? id : null; }, load(id) {
    if (id === 'virtual:setup-fixture') return 'import React from "react"; import { createRoot } from "react-dom/client"; import SetupWizard from "/src/SetupWizard.tsx"; import "/src/styles.css"; const root = createRoot(document.getElementById("root")); root.render(React.createElement(SetupWizard, { initial: new URLSearchParams(location.search).get("scenario") !== "manual", onClose: provider => { window.__setup.closed.push(provider); root.unmount(); } }));';
  } }],
});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/setup-fixture`;
await mkdir('artifacts', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const fixture = window.__setup = {
      calls: [], closed: [], progressListeners: new Set(), login: {}, authCalls: {},
      failClaude: scenario !== 'missing', holdApply: false, releaseApply: null,
      scan: {
        platformSupported: true,
        components: [
          { id: 'codex', status: scenario === 'missing' ? 'missing' : 'installed', version: 'Codex CLI 1.0', executable: 'C:\\CLI\\codex.exe' },
          { id: 'claude', status: scenario === 'manual' ? 'installed' : 'missing' }, { id: 'git', status: scenario === 'manual' ? 'installed' : 'missing' },
        ],
        config: { targetPath: 'D:\\Codex Home\\config.toml', defaultPath: 'C:\\Users\\Fixture\\.codex\\config.toml', customHome: true, exists: true },
      },
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    window.codex = { setup: {
      async state() { return { show: true, completed: false, deferred: false, preferredProvider: scenario === 'manual' ? 'claude' : undefined }; },
      async scan() { fixture.calls.push({ method: 'scan' }); return clone(fixture.scan); },
      async install(id) {
        fixture.calls.push({ method: 'install', id });
        for (const listener of fixture.progressListeners) listener({ component: id, stage: 'installing', message: 'Устанавливаем выбранную программу…' });
        await new Promise(resolve => setTimeout(resolve, 80));
        if (id === 'claude' && fixture.failClaude) { fixture.failClaude = false; throw new Error('Не удалось скачать Claude. Попробуйте ещё раз.'); }
        Object.assign(fixture.scan.components.find(component => component.id === id), { status: 'installed', executable: `C:\\CLI\\${id}.exe`, version: `${id} 1.0` });
        for (const listener of fixture.progressListeners) listener({ component: id, stage: 'done', message: 'Установка завершена' });
        return clone(fixture.scan);
      },
      async chooseExecutable(id) { fixture.calls.push({ method: 'chooseExecutable', id }); return null; },
      async previewConfig() { fixture.calls.push({ method: 'previewConfig' }); return { ...clone(fixture.scan.config), previewId: 'preview-1', filename: 'portal-config.toml' }; },
      async applyConfig(options) {
        fixture.calls.push({ method: 'applyConfig', options });
        if (fixture.holdApply) await new Promise(resolve => { fixture.releaseApply = resolve; });
        return { configPath: fixture.scan.config.targetPath, backupPath: 'D:\\Codex Home\\config.toml.setup-2026.bak' };
      },
      async authStatus(provider) {
        fixture.calls.push({ method: 'authStatus', provider });
        fixture.authCalls[provider] = (fixture.authCalls[provider] || 0) + 1;
        if (provider === 'codex') return { state: 'provider', message: 'Используется настроенный провайдер.' };
        return fixture.login[provider] === 'done' ? { state: 'signed-in', email: 'fixture@example.test' } : { state: 'signed-out' };
      },
      async login(provider) { fixture.calls.push({ method: 'login', provider }); fixture.login[provider] = 'opened'; return { started: true }; },
      async openPortal() { fixture.calls.push({ method: 'openPortal' }); },
      async openGitWebsite() { fixture.calls.push({ method: 'openGitWebsite' }); },
      async complete(options) { fixture.calls.push({ method: 'complete', options: clone(options) }); },
      onProgress(listener) { fixture.progressListeners.add(listener); return () => fixture.progressListeners.delete(listener); },
    } };
    if (scenario !== 'manual') {
      fixture.memory = { enabled: {}, revision: {}, hold: false, release: null };
      const preview = provider => ({ provider, enabled: Boolean(fixture.memory.enabled[provider]), conflict: null, revision: String(fixture.memory.revision[provider] || 0), instructionPath: 'C:/Fixture/.' + provider + '/' + (provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'), procedurePath: 'C:/Fixture/.' + provider + '/reference/memory-compact.md', rulesText: 'Сохраняйте решения и причины. Не запускайте полное сжатие автоматически.', procedureText: '# Сжатие памяти\nСделайте резервную копию, затем проверьте ссылки.' });
      window.codex.memoryRules = {
        async preview(provider) { fixture.calls.push({ method: 'memoryPreview', provider }); return preview(provider); },
        async apply(options) {
          fixture.calls.push({ method: 'memoryApply', options: clone(options) });
          if (fixture.memory.hold) await new Promise(resolve => { fixture.memory.release = resolve; });
          fixture.memory.enabled[options.provider] = options.enabled;
          fixture.memory.revision[options.provider] = (fixture.memory.revision[options.provider] || 0) + 1;
          return { ...preview(options.provider), changed: true, backupPaths: ['C:/Fixture/AGENTS.md.backup-memory'] };
        },
      };
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Настроим ваше рабочее место' }).waitFor();
  await page.getByRole('checkbox', { name: 'Установить Codex CLI', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Установить Codex CLI', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'artifacts/setup-agents.png' });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.screenshot({ path: 'artifacts/setup-agents-compact.png' });
  assert.equal(await page.locator('.setup-footer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.locator('.setup-dialog').evaluate(element => element.scrollWidth === element.clientWidth), true);
  await page.getByRole('checkbox', { name: 'Установить Git', exact: true }).check();
  await page.getByRole('button', { name: 'Установить и продолжить', exact: true }).click();
  await page.getByText('Не удалось скачать Claude. Попробуйте ещё раз.', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__setup.scan.components.find(component => component.id === 'git').status === 'installed');
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'install').map(call => call.id)), ['claude', 'git']);
  await page.getByRole('button', { name: 'Установить и продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Настройки Codex — из вашего файла' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'install').map(call => call.id)), ['claude', 'git', 'claude']);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', { name: 'Открыть портал', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать файл…', exact: true }).click();
  await page.getByText('portal-config.toml', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Применить файл', exact: true }).isDisabled(), true);
  await page.getByText('У вас задан отдельный каталог Codex', { exact: false }).waitFor();
  await page.getByRole('checkbox', { name: 'Заменить текущую конфигурацию с резервной копией' }).check();
  await page.screenshot({ path: 'artifacts/setup-config.png' });
  await page.evaluate(() => { window.__setup.holdApply = true; });
  await page.getByRole('button', { name: 'Применить файл', exact: true }).click();
  await page.waitForFunction(() => window.__setup.releaseApply);
  assert.equal(await page.getByRole('button', { name: 'Настроить позже', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__setup.closed.length), 0);
  await page.evaluate(() => window.__setup.releaseApply());
  await page.getByText('Конфигурация применена', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.find(call => call.method === 'applyConfig').options), { previewId: 'preview-1', replaceExisting: true });
  await page.getByText('D:\\Codex Home\\config.toml.setup-2026.bak', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Подключите свои аккаунты' }).waitFor();
  await page.getByText('Настроен провайдер', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Войти в Codex', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Войти в Claude', exact: true }).click();
  await page.getByText('Завершите вход в открывшемся окне.', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/setup-auth.png' });
  await page.evaluate(() => { window.__setup.login.claude = 'done'; });
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Память ваших проектов' }).waitFor();
  await page.getByRole('button', { name: 'Включить для Codex', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__setup.calls.some(call => call.method === 'memoryApply')), false);
  const memorySummaries = page.locator('[data-memory-provider="codex"] summary');
  await memorySummaries.nth(0).focus();
  await page.keyboard.press('Tab');
  assert.equal(await memorySummaries.nth(1).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Включить для Codex', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.evaluate(() => { window.__setup.memory.hold = true; });
  await page.getByRole('button', { name: 'Включить для Codex', exact: true }).click();
  await page.waitForFunction(() => window.__setup.memory.release);
  for (const name of ['Продолжить', 'Назад', 'Настроить позже']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__setup.closed.length), 0);
  await page.evaluate(() => { window.__setup.memory.hold = false; window.__setup.memory.release(); });
  await page.getByText('Правила для Codex включены', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Включить для Claude', exact: true }).waitFor();
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await page.locator('.setup-footer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.locator('.setup-dialog').evaluate(element => element.scrollWidth === element.clientWidth), true);
  await page.screenshot({ path: 'artifacts/setup-memory.png' });
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Всё для первого диалога' }).waitFor();
  await page.getByRole('radio', { name: 'Claude', exact: true }).check();
  await page.screenshot({ path: 'artifacts/setup-finish.png' });
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click();
  await page.waitForFunction(() => window.__setup.closed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { provider: 'claude', deferred: false } }]);
  assert.equal(await page.evaluate(() => window.__setup.calls.some(call => call.method === 'openPortal')), true);

  await page.goto(`${url}?scenario=missing`);
  await page.getByRole('button', { name: 'Без установки', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Без установки', exact: true }).click();
  await page.getByText('Сначала установите Codex CLI', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
  await page.getByText('Агенты пока не установлены', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Память ваших проектов' }).waitFor();
  assert.equal(await page.locator('[data-memory-provider]').count(), 0);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('heading', { name: 'Настройка сохранена' }).waitFor();
  assert.equal(await page.getByRole('radio').count(), 0);
  await page.getByRole('button', { name: 'Открыть Codex Desk', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { deferred: false } }]);
  assert.equal(await page.evaluate(() => window.__setup.calls.some(call => ['authStatus', 'install', 'applyConfig'].includes(call.method))), false);

  await page.goto(`${url}?scenario=missing`);
  await page.getByRole('button', { name: 'Без установки', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Установить и продолжить', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Настроить позже', exact: true }).first().evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__setup.closed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: { deferred: true } }]);
  assert.equal(await page.evaluate(() => window.__setup.progressListeners.size), 0);

  for (const changeDefault of [false, true]) {
    await page.goto(`${url}?scenario=manual`);
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await page.getByRole('button', { name: 'Оставить текущую', exact: true }).click();
    await page.getByRole('button', { name: 'Войти позже', exact: true }).click();
    await page.getByRole('heading', { name: 'Память ваших проектов' }).waitFor();
    await page.getByText('Настройка правил доступна в установленном приложении Codex Desk.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await page.getByText('Агент для новых диалогов', { exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Claude', exact: true }).isChecked(), true);
    if (changeDefault) await page.getByRole('radio', { name: 'Codex', exact: true }).check();
    await page.getByRole('button', { name: 'Начать работу', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__setup.calls.filter(call => call.method === 'complete')), [{ method: 'complete', options: changeDefault ? { provider: 'codex', deferred: false } : { deferred: false } }]);
  }
  assert.deepEqual(errors, []);
  console.log('Setup wizard browser checks passed: installation selection/retry, config confirmation, auth polling, explicit memory enable/skip/write lock, responsive layout, focus, skip/defer and preservation of the default agent. No real CLI or model calls.');
} finally {
  await browser?.close();
  await server.close();
}
