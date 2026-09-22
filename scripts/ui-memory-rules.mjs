import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Real React settings against a preload fixture. No user files, CLI or model calls.
const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'memory-rules-fixture', configureServer(vite) {
    vite.middlewares.use('/memory-rules-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/memory-rules-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:memory-rules-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:memory-rules-fixture' ? id : null; }, load(id) {
    if (id === 'virtual:memory-rules-fixture') return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import MemoryRulesSettings from "/src/MemoryRulesSettings.tsx";
      import SettingsDialog from "/src/SettingsDialog.tsx";
      import "/src/styles.css";
      function DialogFixture() {
        const [open, setOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const onBusyChange = value => { window.__memory.busy.push(value); setBusy(value); };
        return React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: () => setOpen(true) }, "Открыть настройки"),
          open && React.createElement(SettingsDialog, { active: true, busy,
            onClose: () => { window.__memory.closeCalls++; setOpen(false); },
            tabs: [
              { id: "agent", label: "Агент", icon: null, content: React.createElement("p", null, "Настройки проверочного агента") },
              { id: "memory", label: "Память", icon: null, content: React.createElement(MemoryRulesSettings, { onBusyChange }) },
            ],
          }),
        );
      }
      const element = new URLSearchParams(location.search).get('scenario') === 'dialog'
        ? React.createElement(DialogFixture)
        : React.createElement("div", { style: { maxWidth: 540, padding: 20 } }, React.createElement(MemoryRulesSettings, { onBusyChange: busy => window.__memory.busy.push(busy) }));
      createRoot(document.getElementById("root")).render(element);
    `;
  } }],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/memory-rules-fixture`;
await mkdir('artifacts', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const fixture = window.__memory = { calls: [], busy: [], closeCalls: 0, failRead: scenario === 'read-error', failWrite: false, hold: false, release: null, states: {} };
    for (const provider of ['codex', 'claude']) fixture.states[provider] = {
      provider, enabled: provider === 'claude', revision: `revision-${provider}-0`,
      conflict: scenario === 'conflict' && provider === 'codex' ? 'Раздел Codex Desk изменён вручную. Проверьте файл.' : null,
      instructionPath: `C:\\Fixture\\.${provider}\\${provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'}`,
      procedurePath: `C:\\Fixture\\.${provider}\\reference\\memory-compact.md`,
      rulesText: `# Правила ${provider}\nСохраняйте решения и причины.\nНе запускайте полное сжатие каждый сеанс.`,
      procedureText: `# Полная процедура ${provider}\nСделайте резервную копию.\nПроверьте ссылки после сжатия.`,
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    window.codex = scenario === 'unavailable' ? {} : { memoryRules: {
      async preview(provider) {
        fixture.calls.push({ method: 'preview', provider });
        if (fixture.failRead && provider === 'codex') { fixture.failRead = false; throw new Error('Не удалось прочитать файл инструкций.'); }
        return clone(fixture.states[provider]);
      },
      async apply(options) {
        fixture.calls.push({ method: 'apply', options: clone(options) });
        if (fixture.hold) await new Promise(resolve => { fixture.release = resolve; });
        if (fixture.failWrite) { fixture.failWrite = false; throw new Error('Инструкции изменились. Проверьте снова.'); }
        const state = fixture.states[options.provider];
        if (state.revision !== options.revision) throw new Error('Устаревший просмотр.');
        state.enabled = options.enabled;
        state.revision += '-next';
        return { ...clone(state), changed: true, backupPaths: [state.instructionPath + '.backup-fixture'] };
      },
    } };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const codex = page.locator('[data-memory-provider="codex"]');
  const claude = page.locator('[data-memory-provider="claude"]');
  await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).waitFor();
  await claude.getByRole('button', { name: 'Отключить для Claude', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__memory.calls.some(call => call.method === 'apply')), false);
  await codex.locator('summary').filter({ hasText: 'Текст правил' }).click();
  await codex.locator('summary').filter({ hasText: 'Полная инструкция' }).click();
  assert.deepEqual(await codex.locator('pre').allTextContents(), await page.evaluate(() => [window.__memory.states.codex.rulesText, window.__memory.states.codex.procedureText]));
  await page.getByText('включая терминал', { exact: false }).waitFor();
  await page.evaluate(() => { window.__memory.hold = true; });
  await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).click();
  await page.waitForFunction(() => window.__memory.release);
  assert.equal(await claude.getByRole('button', { name: 'Отключить для Claude', exact: true }).isDisabled(), true);
  assert.equal(await codex.getByRole('button', { name: 'Проверить правила Codex снова', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__memory.busy), [true]);
  await page.evaluate(() => { window.__memory.hold = false; window.__memory.release(); });
  await codex.getByText('Правила для Codex включены', { exact: true }).waitFor();
  await codex.getByText('C:\\Fixture\\.codex\\AGENTS.md.backup-fixture', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__memory.calls.filter(call => call.method === 'apply')[0].options), { provider: 'codex', enabled: true, revision: 'revision-codex-0' });
  assert.deepEqual(await page.evaluate(() => window.__memory.busy), [true, false]);
  await codex.getByRole('button', { name: 'Отключить для Codex', exact: true }).click();
  await codex.getByText('Правила для Codex отключены', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__memory.states.claude.enabled), true);
  await page.evaluate(() => { window.__memory.failWrite = true; });
  await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).click();
  await codex.getByRole('alert').filter({ hasText: 'Инструкции изменились' }).waitFor();
  assert.equal(await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).count(), 0);
  assert.equal(await codex.getByText('Правила для Codex отключены', { exact: true }).count(), 0);
  await codex.getByRole('button', { name: 'Проверить правила Codex снова', exact: true }).click();
  await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/memory-rules-settings.png', fullPage: true });

  await page.goto(`${url}?scenario=read-error`);
  await codex.getByRole('alert').filter({ hasText: 'Не удалось прочитать' }).waitFor();
  await claude.getByRole('button', { name: 'Отключить для Claude', exact: true }).waitFor();
  await codex.getByRole('button', { name: 'Проверить правила Codex снова', exact: true }).click();
  await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).waitFor();
  await page.goto(`${url}?scenario=conflict`);
  await codex.getByRole('alert').filter({ hasText: 'Раздел Codex Desk изменён' }).waitFor();
  assert.equal(await codex.getByRole('button', { name: 'Включить для Codex', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__memory.calls.some(call => call.method === 'apply')), false);
  await page.goto(`${url}?scenario=unavailable`);
  await page.getByText('Настройка правил доступна в установленном приложении Codex Desk.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-memory-provider]').count(), 0);
  // The same production dialog must keep a memory write alive and block dismissal.
  await page.setViewportSize({ width: 940, height: 700 });
  await page.goto(url + '?scenario=dialog');
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  const tab = name => dialog.getByRole('tab', { name, exact: true });
  await tab('Память').click();
  await claude.getByRole('button', { name: 'Отключить для Claude', exact: true }).waitFor();
  await page.evaluate(() => { window.__memory.hold = true; });
  await claude.getByRole('button', { name: 'Отключить для Claude', exact: true }).click();
  await page.waitForFunction(() => window.__memory.release);
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab from the now-disabled last-provider save button stays inside settings');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Reverse tabbing during a write cannot reach the background');
  await claude.locator('summary').last().focus();
  await page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('tabpanel').evaluate(element => element === document.activeElement), true, 'The last available control wraps to the active settings panel while actions are disabled');
  for (const name of ['Агент', 'Память']) assert.equal(await tab(name).isDisabled(), true, 'Topics cannot be left while memory instructions are being written');
  for (const name of ['Закрыть настройки', 'Готово']) assert.equal(await dialog.getByRole('button', { name, exact: true }).isDisabled(), true);
  await dialog.getByText('Сохраняем правила памяти…', { exact: true }).waitFor();
  await dialog.getByRole('tabpanel').press('Escape');
  await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
  assert.equal(await dialog.isVisible(), true, 'Escape and clicking outside cannot discard an in-flight memory write');
  assert.equal(await page.evaluate(() => window.__memory.closeCalls), 0);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/settings-tabs-memory-busy.png' });
  await page.evaluate(() => { window.__memory.hold = false; window.__memory.release(); });
  await claude.getByText('Правила для Claude отключены', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__memory.busy), [true, false]);
  const previewReads = await page.evaluate(() => window.__memory.calls.filter(call => call.method === 'preview').length);
  await tab('Агент').click();
  await tab('Память').click();
  await claude.getByText('Правила для Claude отключены', { exact: true }).waitFor();
  await claude.getByText('C:\\Fixture\\.claude\\CLAUDE.md.backup-fixture', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__memory.calls.filter(call => call.method === 'preview').length), previewReads, 'Changing topics preserves the write result and backup path without remounting memory rules');
  await dialog.getByRole('tabpanel').press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape closes settings again once the write is complete');
  assert.equal(await page.evaluate(() => window.__memory.closeCalls), 1);
  assert.equal(await page.getByRole('button', { name: 'Открыть настройки', exact: true }).evaluate(element => element === document.activeElement), true, 'Closing settings restores focus to its launcher');
  assert.deepEqual(errors, []);
  console.log('Memory rules UI passed: exact previews, independent provider state, explicit enable/disable, revision/backups, write lock, dialog navigation/Escape/backdrop/close guards, retained result and restored focus, stale/read failures, conflicts, retry, small viewport and absent bridge. No real file, CLI or model calls.');
} finally {
  await browser?.close();
  await server.close();
}