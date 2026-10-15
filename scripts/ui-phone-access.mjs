import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// The real React components of the «Телефон» topic against a fixture. No network, no model calls.
// Stage 5 of the plan v2: the personal bot is gone, so this scenario covers what replaced it —
// «Доступ бесед» (the per-tab permission list) and the unchanged per-conversation switch.

const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'phone-access-fixture', configureServer(vite) {
    vite.middlewares.use('/phone-access-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/phone-access-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:phone-access-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:phone-access-fixture' ? id : null; }, load(id) {
    if (id !== 'virtual:phone-access-fixture') return null;
    return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { PhoneAccessSettings } from "/src/PhoneAccessSettings.tsx";
      import { TelegramThreadAccess } from "/src/TelegramThreadAccess.tsx";
      import SettingsDialog from "/src/SettingsDialog.tsx";
      import "/src/styles.css";

      // The workspace owns the tab list; every row carries the state of its own conversation.
      function AccessList() {
        const [rows, setRows] = React.useState(window.__phone.rows);
        window.__phone.apply = next => setRows(next);
        const tabs = rows.map(row => ({
          ...row,
          change: async enabled => {
            window.__phone.calls.push({ sessionId: row.sessionId, enabled, accessRevision: row.state?.accessRevision ?? null });
            if (window.__phone.hold) await new Promise(resolve => { window.__phone.release = resolve; });
            setRows(current => current.map(value => value.sessionId === row.sessionId && value.state
              ? { ...value, state: { ...value.state, enabled, accessRevision: value.state.accessRevision + "-next" } } : value));
          },
        }));
        return React.createElement(PhoneAccessSettings, { tabs });
      }

      function ThreadFixture() {
        const [state, setState] = React.useState(window.__thread.state);
        const [busy, setBusy] = React.useState(false);
        window.__thread.apply = next => setState(next);
        const onChange = async enabled => {
          window.__thread.calls.push(enabled);
          setBusy(true);
          if (window.__thread.hold) await new Promise(resolve => { window.__thread.release = resolve; });
          setState(current => current ? { ...current, enabled, accessRevision: current.accessRevision + "-next" } : current);
          setBusy(false);
        };
        return React.createElement("div", { style: { maxWidth: 420, padding: 20 } },
          React.createElement(TelegramThreadAccess, { state, busy, onChange }));
      }

      function DialogFixture() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: () => setOpen(true) }, "Открыть настройки"),
          open && React.createElement(SettingsDialog, { active: true, busy: false,
            onClose: () => { window.__phone.closeCalls++; setOpen(false); },
            tabs: [
              { id: "agent", label: "Агент", icon: null, content: React.createElement("p", null, "Настройки проверочного агента") },
              { id: "phone", label: "Телефон", icon: null, content: React.createElement(AccessList) },
            ],
          }),
        );
      }

      const scenario = new URLSearchParams(location.search).get("scenario");
      const element = String(scenario).startsWith("thread") ? React.createElement(ThreadFixture)
        : scenario === "dialog" ? React.createElement(DialogFixture)
        : React.createElement("div", { style: { maxWidth: 560, padding: 20 } }, React.createElement(AccessList));
      createRoot(document.getElementById("root")).render(element);
    `;
  } }],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/phone-access-fixture`;
await mkdir('artifacts', { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 940, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.addInitScript(() => {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const access = (patch = {}) => ({ provider: 'codex', threadId: 'thread-1', accessRevision: 'rev-1', enabled: false, canEnable: true, reason: null, target: null, ...patch });
    const rows = scenario === 'empty' ? [] : [
      { sessionId: 'tab-1', title: 'Пульт в Mini App', project: 'CodexDesk', provider: 'codex', busy: false, state: access() },
      { sessionId: 'tab-2', title: 'Разбор отчёта', project: 'CodexDesk', provider: 'claude', busy: false,
        state: access({ provider: 'claude', threadId: 'claude:abc', accessRevision: 'rev-2', enabled: true }) },
      // A tab that has not started a conversation: listed, switched off, explained — never hidden.
      { sessionId: 'tab-3', title: 'Новый диалог', project: 'Другая папка', provider: 'codex', busy: false,
        state: { provider: 'codex', threadId: null, accessRevision: 'rev-3', enabled: false, canEnable: false, reason: 'Сначала откройте существующую беседу.', target: null } },
      { sessionId: 'tab-4', title: 'Беседа в восстановлении', project: 'CodexDesk', provider: 'codex', busy: false,
        state: access({ threadId: 'thread-4', accessRevision: 'rev-4', canEnable: false, reason: 'Беседа ещё восстанавливается. Дождитесь готовности истории.' }) },
    ];
    window.__phone = { calls: [], closeCalls: 0, hold: false, release: null, apply: null, rows };

    window.__thread = {
      calls: [], hold: false, release: null, apply: null,
      state: scenario === 'thread-blocked'
        ? { provider: 'claude', threadId: 'claude:abc', accessRevision: 'rev-1', enabled: false, canEnable: false, reason: 'Беседа ещё восстанавливается. Дождитесь готовности истории.', target: null }
        : { provider: 'codex', threadId: 'thread-1', accessRevision: 'rev-1', enabled: false, canEnable: true, reason: null, target: null },
    };
  });

  // ---------------------------------------------------------------- «Доступ бесед»
  // The first navigation also pays for Vite's cold dependency optimization in this repository.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const panel = page.getByRole('region', { name: 'Доступ бесед', exact: true });
  await panel.waitFor();

  // Every open tab of the window is a row, in tab order, including the one with no conversation.
  assert.deepEqual(await panel.locator('[role="switch"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), [
    'Доступ из Telegram: Пульт в Mini App',
    'Доступ из Telegram: Разбор отчёта',
    'Доступ из Telegram: Новый диалог',
    'Доступ из Telegram: Беседа в восстановлении',
  ]);
  await panel.getByText('Разрешено бесед: 1 из 4', { exact: true }).waitFor();
  await panel.getByText('CodexDesk · Claude Code', { exact: true }).waitFor();

  const row = title => panel.getByRole('switch', { name: `Доступ из Telegram: ${title}`, exact: true });
  const first = row('Пульт в Mini App');
  assert.equal(await first.getAttribute('aria-checked'), 'false', 'access is off by default');
  await panel.getByText('Пока выключено: на телефоне не видно ни названия, ни ответов этой беседы.', { exact: true }).waitFor();
  const described = await first.getAttribute('aria-describedby');
  assert.ok(described && await page.locator(`#${described}`).count() === 1, 'the explanation is linked to the switch');

  // A tab without a conversation stays visible, switched off and explained.
  const unstarted = row('Новый диалог');
  assert.equal(await unstarted.isDisabled(), true);
  assert.equal(await unstarted.getAttribute('aria-checked'), 'false');
  await panel.getByText('Беседа ещё не начата: разрешать пока нечего.', { exact: true }).waitFor();
  await unstarted.click({ force: true });
  assert.deepEqual(await page.evaluate(() => window.__phone.calls), [], 'an unstarted conversation cannot be allowed');

  // A conversation that exists but cannot be allowed yet shows its own local reason.
  const restoring = row('Беседа в восстановлении');
  assert.equal(await restoring.isDisabled(), true);
  await panel.getByText('Беседа ещё восстанавливается. Дождитесь готовности истории.', { exact: true }).waitFor();

  // Granting goes through the same compare-and-set as the switch in «Агент»: the row's own revision.
  await first.click();
  await page.waitForFunction(() => window.__phone.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__phone.calls), [{ sessionId: 'tab-1', enabled: true, accessRevision: 'rev-1' }]);
  await page.waitForFunction(() => document.querySelector('[data-telegram-access="on"]'));
  await panel.getByText('Разрешено бесед: 2 из 4', { exact: true }).waitFor();
  await panel.getByText('Видна на телефоне: выбор, текст, состояние, последний ответ и остановка.', { exact: true }).first().waitFor();

  // Revoking is the same row, and only that row: the other grant is untouched.
  await first.click();
  await page.waitForFunction(() => window.__phone.calls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__phone.calls.at(-1)), { sessionId: 'tab-1', enabled: false, accessRevision: 'rev-1-next' });
  await panel.getByText('Разрешено бесед: 1 из 4', { exact: true }).waitFor();
  assert.equal(await row('Разбор отчёта').getAttribute('aria-checked'), 'true', 'another conversation keeps its permission');

  // Keyboard operation, and a held host call that only disables its own row.
  await row('Разбор отчёта').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__phone.calls.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__phone.calls.at(-1)), { sessionId: 'tab-2', enabled: false, accessRevision: 'rev-2' });

  await page.evaluate(() => { window.__phone.hold = true; });
  await first.click();
  await page.waitForFunction(() => window.__phone.release);
  assert.equal(await first.isDisabled(), true, 'the row is held while the computer applies the change');
  assert.equal(await row('Разбор отчёта').isDisabled(), false, 'waiting on one conversation does not lock the others');
  await page.evaluate(() => { window.__phone.hold = false; window.__phone.release(); });
  await page.waitForFunction(() => document.querySelector('[data-telegram-access="on"]'));
  await page.screenshot({ path: 'artifacts/phone-access-threads.png', fullPage: true });

  // A host that reports a revoked grant wins over what the row last showed.
  await page.evaluate(() => window.__phone.apply(window.__phone.rows.map(row => row.sessionId === 'tab-1'
    ? { ...row, state: { ...row.state, enabled: false, accessRevision: 'rev-1-host' } } : row)));
  await page.waitForFunction(() => document.querySelector('[aria-label="Доступ из Telegram: Пульт в Mini App"]').getAttribute('aria-checked') === 'false');

  // ---------------------------------------------------------------- no tabs at all
  await page.goto(`${url}?scenario=empty`);
  await panel.getByText('Открытых бесед нет', { exact: true }).waitFor();
  assert.equal(await panel.locator('[role="switch"]').count(), 0);

  // ---------------------------------------------------------------- narrow viewport
  await page.goto(url);
  await panel.getByText('Разрешено бесед: 1 из 4', { exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 820 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the panel fits a narrow window');
  await page.screenshot({ path: 'artifacts/phone-access-420.png', fullPage: true });
  await page.setViewportSize({ width: 940, height: 1000 });

  // ---------------------------------------------------------------- inside the production dialog
  await page.goto(`${url}?scenario=dialog`);
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  const tab = name => dialog.getByRole('tab', { name, exact: true });
  await tab('Телефон').click();
  await dialog.getByRole('region', { name: 'Доступ бесед', exact: true }).waitFor();

  // A held host call must not block leaving settings: it is not a local write.
  await page.evaluate(() => { window.__phone.hold = true; });
  await dialog.getByRole('switch', { name: 'Доступ из Telegram: Пульт в Mini App', exact: true }).click();
  await page.waitForFunction(() => window.__phone.release);
  for (const name of ['Агент', 'Телефон']) assert.equal(await tab(name).isDisabled(), false, 'waiting for the host does not lock the settings window');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab stays inside the dialog');
  await page.evaluate(() => { window.__phone.hold = false; window.__phone.release(); });

  await tab('Телефон').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tab('Агент').evaluate(element => element.getAttribute('aria-selected')), 'true', 'arrow keys move between topics');
  await page.keyboard.press('End');
  assert.equal(await tab('Телефон').evaluate(element => element.getAttribute('aria-selected')), 'true');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/phone-access-settings-dialog.png' });
  await dialog.getByRole('tabpanel').press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape closes settings');
  assert.equal(await page.evaluate(() => window.__phone.closeCalls), 1);
  assert.equal(await page.getByRole('button', { name: 'Открыть настройки', exact: true }).evaluate(element => element === document.activeElement), true, 'focus returns to the launcher');

  // ------------------------------------------------- the unchanged switch in the «Агент» topic
  await page.goto(`${url}?scenario=thread`);
  const single = page.getByRole('switch', { name: 'Разрешить доступ из Telegram', exact: true });
  await single.waitFor();
  assert.equal(await single.getAttribute('aria-checked'), 'false', 'access to a conversation is off by default');
  await page.getByText('Пока выключено: бот не покажет ни название этой беседы, ни её ответы.', { exact: true }).waitFor();

  await page.evaluate(() => { window.__thread.hold = true; });
  await single.click();
  await page.waitForFunction(() => window.__thread.release);
  assert.equal(await single.isDisabled(), true, 'the switch is held while the computer applies the change');
  await page.evaluate(() => { window.__thread.hold = false; window.__thread.release(); });
  await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true');
  assert.deepEqual(await page.evaluate(() => window.__thread.calls), [true]);
  assert.equal(await page.locator('[data-telegram-access="on"]').count(), 1);

  await single.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__thread.calls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__thread.calls), [true, false]);
  await page.screenshot({ path: 'artifacts/telegram-thread-access.png' });

  await page.goto(`${url}?scenario=thread-blocked`);
  const blocked = page.getByRole('switch', { name: 'Разрешить доступ из Telegram', exact: true });
  await blocked.waitFor();
  assert.equal(await blocked.isDisabled(), true);
  await page.getByText('Беседа ещё восстанавливается. Дождитесь готовности истории.', { exact: true }).waitFor();
  await blocked.click({ force: true });
  assert.deepEqual(await page.evaluate(() => window.__thread.calls), [], 'a disabled switch cannot be turned on');

  await page.goto(`${url}?scenario=thread`);
  await page.getByRole('switch', { name: 'Разрешить доступ из Telegram', exact: true }).waitFor();
  await page.evaluate(() => window.__thread.apply(null));
  await page.waitForFunction(() => document.querySelectorAll('[role="switch"]').length === 0);

  assert.deepEqual(errors, []);
  console.log('Phone access UI passed: «Доступ бесед» lists every open tab in order with its agent and folder, default off, grant and revoke through each row\'s own accessRevision, an unstarted tab shown as «беседа ещё не начата» instead of hidden, a local block reason, keyboard operation, one held row not locking the others, a host revocation winning, an empty workspace, a narrow viewport, the production settings dialog with arrow/End/Tab/Escape and restored focus; plus the unchanged per-conversation switch of the «Агент» topic. No bot, no network, no model calls.');
} finally {
  await browser?.close();
  await server.close();
}
