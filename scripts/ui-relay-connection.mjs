import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// The real React component against a fixture bridge. No relay, no Telegram, no model calls.
const FIXTURE_CODE = 'qp7Z0sVnK3hGf1LbT9xQe5RcU2mA8dWyJ4oN6vBzS0k';
const FIXTURE_LINK = `https://t.me/kuzmich_fixture_bot?startapp=${FIXTURE_CODE}`;

const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'relay-connection-fixture', configureServer(vite) {
    vite.middlewares.use('/relay-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/relay-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:relay-connection-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:relay-connection-fixture' ? id : null; }, load(id) {
    if (id !== 'virtual:relay-connection-fixture') return null;
    return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { RelayConnectionSettings } from "/src/RelayConnectionSettings.tsx";
      import { PhoneAccessSettings } from "/src/PhoneAccessSettings.tsx";
      import SettingsDialog from "/src/SettingsDialog.tsx";
      import "/src/styles.css";

      const bridge = window.__relay.bridge;

      function DialogFixture() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: () => setOpen(true) }, "Открыть настройки"),
          open && React.createElement(SettingsDialog, { active: true, busy: false,
            onClose: () => { window.__relay.closeCalls++; setOpen(false); },
            tabs: [
              { id: "agent", label: "Агент", icon: null, content: React.createElement("p", null, "Настройки проверочного агента") },
              { id: "phone", label: "Телефон", icon: null, content: React.createElement(React.Fragment, null,
                React.createElement(RelayConnectionSettings, { bridge }),
                React.createElement(PhoneAccessSettings, { tabs: window.__phone.tabs })) },
            ],
          }),
        );
      }

      const scenario = new URLSearchParams(location.search).get("scenario");
      const element = scenario === "dialog" ? React.createElement(DialogFixture)
        : React.createElement("div", { style: { maxWidth: 560, padding: 20 } }, React.createElement(RelayConnectionSettings, { bridge }));
      createRoot(document.getElementById("root")).render(element);
    `;
  } }],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/relay-fixture`;
await mkdir('artifacts', { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 940, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.addInitScript(([code, link]) => {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const fixture = window.__relay = { calls: [], closeCalls: 0, hold: false, release: null, listeners: new Set(), copied: [] };
    fixture.state = {
      enabled: scenario === 'fresh' ? false : true,
      relayUrl: scenario === 'fresh' ? '' : 'wss://relay.example.com',
      label: 'Рабочий ПК',
      linked: scenario === 'linked',
      encryptionAvailable: scenario !== 'no-encryption',
      connection: scenario === 'linked' ? 'online' : scenario === 'fresh' ? 'disabled' : 'unconfigured',
      owner: scenario === 'linked' ? { telegramUserId: '12345678', displayName: 'Иван' } : null,
      pairing: null,
      publishedTabs: scenario === 'linked' ? 3 : 0,
      error: scenario === 'offline' ? 'Сервер не отвечает. Переподключаемся.' : null,
    };
    if (scenario === 'offline') Object.assign(fixture.state, { linked: true, connection: 'connecting' });

    const clone = () => JSON.parse(JSON.stringify(fixture.state));
    const push = () => { for (const listener of fixture.listeners) listener(clone()); };
    fixture.pushState = patch => { Object.assign(fixture.state, patch); push(); };
    const wait = async () => { if (fixture.hold) await new Promise(resolve => { fixture.release = resolve; }); };

    fixture.bridge = {
      async getState() { fixture.calls.push({ method: 'getState' }); return clone(); },
      async setRelayUrl(value) {
        fixture.calls.push({ method: 'setRelayUrl', value });
        await wait();
        if (!String(value).startsWith('wss://')) throw new Error('Адрес должен начинаться с wss://.');
        Object.assign(fixture.state, { relayUrl: value, connection: fixture.state.enabled ? 'unconfigured' : 'disabled', error: null });
        return clone();
      },
      async setLabel(value) { fixture.calls.push({ method: 'setLabel', value }); await wait(); Object.assign(fixture.state, { label: value }); return clone(); },
      async setEnabled(enabled) {
        fixture.calls.push({ method: 'setEnabled', enabled });
        await wait();
        Object.assign(fixture.state, { enabled, connection: enabled ? (fixture.state.relayUrl ? 'unconfigured' : 'disabled') : 'disabled' });
        return clone();
      },
      async startPairing(label) {
        fixture.calls.push({ method: 'startPairing', label });
        await wait();
        if (fixture.failPairing) { fixture.failPairing = false; throw new Error('Установка уже связана. Сначала отвяжите её.'); }
        const chosen = String(label ?? '').trim() || 'Кузьмич';
        Object.assign(fixture.state, {
          label: chosen,
          connection: 'pairing',
          pairing: { pairingId: 'p-1', label: chosen, code, link, expiresAt: new Date(Date.now() + 600_000).toISOString(), claimant: null, confirmExpiresAt: null },
        });
        return clone();
      },
      async confirmPairing() { fixture.calls.push({ method: 'confirmPairing' }); await wait(); return clone(); },
      async cancelPairing() {
        fixture.calls.push({ method: 'cancelPairing' });
        await wait();
        Object.assign(fixture.state, { pairing: null, connection: 'unconfigured' });
        return clone();
      },
      async unlink() {
        fixture.calls.push({ method: 'unlink' });
        await wait();
        Object.assign(fixture.state, { linked: false, owner: null, connection: 'unconfigured', publishedTabs: 0 });
        return clone();
      },
      onState(listener) { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
    };

    // «Доступ бесед» shares the settings topic; its own scenario is scripts/ui-phone-access.mjs.
    window.__phone = { tabs: [{ sessionId: 'tab-1', title: 'Беседа пульта', project: 'CodexDesk', provider: 'codex', busy: false,
      state: { provider: 'codex', threadId: 'thread-1', accessRevision: 'rev-1', enabled: false, canEnable: true, reason: null, target: null },
      change: async () => { throw new Error('нет'); } }] };

    navigator.clipboard.writeText = async value => { fixture.copied.push(value); };
    window.__fixtureCode = code;
  }, [FIXTURE_CODE, FIXTURE_LINK]);

  // ---------------------------------------------------------------- a fresh, unconfigured profile
  // The first navigation also pays for Vite's cold dependency optimization in this repository.
  await page.goto(`${url}?scenario=fresh`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const panel = page.getByRole('region', { name: 'Подключение к серверу', exact: true });
  await panel.waitFor();
  await panel.getByText('Подключение выключено', { exact: true }).waitFor();

  const toggle = panel.getByRole('checkbox', { name: 'Держать связь с сервером', exact: true });
  const urlField = panel.getByRole('textbox', { name: 'Адрес relay-сервера', exact: true });
  const saveUrl = panel.getByRole('button', { name: 'Сохранить адрес', exact: true });
  const createCode = panel.getByRole('button', { name: 'Создать код', exact: true });

  assert.equal(await urlField.inputValue(), '', 'a fresh profile has no address');
  assert.equal(await saveUrl.isDisabled(), true, 'saving needs a value first');
  assert.equal(await createCode.isDisabled(), true, 'a code needs an address and an enabled connection');
  await panel.getByText('Код можно создать после сохранения адреса и включения связи.', { exact: true }).waitFor();

  // A refused address shows the reason and leaves the field editable.
  await urlField.fill('http://relay.example.com');
  await saveUrl.click();
  await panel.getByRole('alert').filter({ hasText: 'wss://' }).waitFor();
  assert.equal(await urlField.inputValue(), 'http://relay.example.com', 'the rejected value is not thrown away');

  await urlField.fill('wss://relay.example.com');
  await saveUrl.click();
  await panel.getByText('Адрес сервера сохранён.', { exact: true }).waitFor();
  await panel.getByText('Подключение выключено', { exact: true }).waitFor();
  assert.equal(await createCode.isDisabled(), true, 'an address alone is not enough to pair');

  await toggle.check();
  await page.waitForFunction(() => window.__relay.calls.some(call => call.method === 'setEnabled' && call.enabled === true));
  // Linked is still false, so the connection reports itself as not yet configured.
  await panel.getByText('Сервер не настроен', { exact: true }).waitFor();

  // A pushed state from the host updates the panel without any further read.
  const before = await page.evaluate(() => window.__relay.calls.length);
  await page.evaluate(() => window.__relay.pushState({ connection: 'connecting' }));
  await panel.getByText('Подключаемся к серверу…', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__relay.calls.length), before, 'a pushed state does not re-read anything');

  // ---------------------------------------------------------------- pairing, shown only here
  await page.evaluate(() => window.__relay.pushState({ connection: 'unconfigured' }));
  assert.equal(await createCode.isDisabled(), false);

  // The installation is named at pairing time, defaulting to «Кузьмич».
  const nameField = panel.getByRole('textbox', { name: 'Имя этой установки', exact: true });
  assert.equal(await nameField.inputValue(), 'Рабочий ПК', 'the stored name is offered as the starting point');
  await nameField.fill('Кабинет дома');
  await createCode.click();
  const code = panel.getByText(FIXTURE_CODE, { exact: true });
  await code.waitFor();
  assert.deepEqual(await page.evaluate(() => window.__relay.calls.filter(call => call.method === 'startPairing').map(call => call.label)), ['Кабинет дома'],
    'the typed name goes to the host with the pairing, not as a separate save');
  assert.ok(Buffer.from(FIXTURE_CODE, 'base64url').length >= 16, 'the fixture code carries at least 128 bits');
  assert.match(await panel.locator('.relay-connection-code small').first().innerText(), /Установка «Кабинет дома»\. Действует до \d\d:\d\d/);
  await panel.getByText('Ждём подтверждения из Telegram', { exact: true }).waitFor();
  assert.equal(await nameField.count(), 0, 'the name field gives way to the code once pairing has started');

  // A real QR of the deep link, rendered locally — the code is not sent anywhere to be drawn.
  const qr = panel.locator('img.relay-connection-qr');
  await qr.waitFor();
  const qrSource = await qr.getAttribute('src');
  assert.ok(qrSource.startsWith('data:image/png;base64,'), 'the QR is a locally produced image');
  assert.ok(qrSource.length > 500, 'the QR actually carries a picture');
  assert.equal(await qr.getAttribute('alt'), 'QR-код для привязки установки «Кабинет дома»');
  assert.deepEqual(await qr.evaluate(element => [element.naturalWidth > 0, element.naturalHeight > 0]), [true, true], 'the browser decoded the QR image');

  await panel.getByRole('button', { name: 'Скопировать ссылку', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__relay.copied), [FIXTURE_LINK], 'the link carries the code to Telegram');
  assert.equal(await panel.getByRole('link', { name: 'Открыть в Telegram', exact: true }).getAttribute('href'), FIXTURE_LINK);

  // Nothing is confirmed while no one has asked.
  assert.equal(await panel.getByRole('button', { name: 'Это я, подтвердить', exact: true }).count(), 0, 'there is nothing to confirm yet');

  // The claimant appears: the owner sees exactly who is asking before anything is issued.
  await page.evaluate(() => window.__relay.pushState({
    pairing: { ...window.__relay.state.pairing, claimant: { telegramUserId: '12345678', displayName: 'Иван', username: 'ivan' }, confirmExpiresAt: new Date(Date.now() + 300_000).toISOString() },
  }));
  await panel.getByText('Привязку запросил: Иван', { exact: true }).waitFor();
  await panel.getByText('@ivan · ID 12345678', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__relay.state.linked), false, 'no credential exists before the owner confirms');
  await page.screenshot({ path: 'artifacts/relay-connection-pairing.png', fullPage: true });

  await panel.getByRole('button', { name: 'Это не я, отменить', exact: true }).click();
  await page.waitForFunction(() => window.__relay.calls.some(call => call.method === 'cancelPairing'));
  assert.equal(await code.count(), 0, 'declining clears the code');

  await createCode.click();
  await code.waitFor();
  await page.evaluate(() => window.__relay.pushState({
    pairing: { ...window.__relay.state.pairing, claimant: { telegramUserId: '12345678', displayName: 'Иван', username: null } },
  }));
  await panel.getByText('ID 12345678', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Это я, подтвердить', exact: true }).click();
  await panel.getByText('Подтверждено. Ждём, пока сервер выдаст ключ этой установке.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__relay.calls.filter(call => call.method === 'confirmPairing').length), 1);

  // Network work must not freeze the panel: a held call only disables actions.
  await page.evaluate(() => { window.__relay.hold = true; });
  await panel.getByRole('button', { name: 'Создать новый код', exact: true }).click();
  await page.waitForFunction(() => window.__relay.release);
  assert.equal(await toggle.isDisabled(), true, 'conflicting actions are blocked while one is in flight');
  assert.equal(await page.evaluate(() => document.body.scrollHeight > 0), true);
  await page.evaluate(() => { window.__relay.hold = false; window.__relay.release(); });
  assert.equal(await toggle.isDisabled(), false);

  // A refused local action shows the reason and leaves the panel usable.
  await page.evaluate(() => { window.__relay.failPairing = true; });
  await panel.getByRole('button', { name: 'Создать новый код', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'уже связана' }).waitFor();

  // ---------------------------------------------------------------- linked, offline, no encryption
  await page.goto(`${url}?scenario=linked`);
  await panel.getByText('Сервер на связи', { exact: true }).waitFor();
  await panel.getByText('Владелец: Иван · ID 12345678', { exact: true }).waitFor();
  await panel.getByText('Серверу видно разрешённых бесед: 3', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Создать код', exact: true }).count(), 0, 'a linked installation is not paired again from here');
  // Renaming stays available once linked, as a separate deliberate save.
  await panel.getByRole('textbox', { name: 'Имя этой установки', exact: true }).fill('Другое имя');
  await panel.getByRole('button', { name: 'Сохранить имя', exact: true }).click();
  await panel.getByText('Имя этого компьютера сохранено.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__relay.calls.filter(call => call.method === 'setLabel').map(call => call.value)), ['Другое имя']);
  await panel.getByText('Сменить сервер можно только после отвязки: существующий ключ установки другому серверу не предлагается.', { exact: true }).waitFor();
  await panel.getByText('Отвязка действует сразу и не ждёт ответа сервера: без ключа установка всё равно не подключится.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.body.innerHTML.includes(window.__fixtureCode)), false, 'no pairing code lingers in a linked panel');

  await panel.getByRole('button', { name: 'Отвязать установку', exact: true }).click();
  await panel.getByText('Установка отвязана. Сервер больше не получает ни названий бесед, ни их состояний.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Создать код', exact: true }).waitFor();

  await page.goto(`${url}?scenario=offline`);
  await panel.getByRole('alert').filter({ hasText: 'Сервер не отвечает' }).waitFor();
  await panel.getByText('Подключаемся к серверу…', { exact: true }).waitFor();

  await page.goto(`${url}?scenario=no-encryption`);
  await panel.getByRole('alert').filter({ hasText: 'Шифрование Windows недоступно' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Создать код', exact: true }).isDisabled(), true, 'without encryption the key could not be stored, so pairing is blocked');

  // ---------------------------------------------------------------- narrow viewport
  await page.goto(`${url}?scenario=fresh`);
  await panel.getByText('Подключение выключено', { exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the panel fits a narrow window');
  await page.screenshot({ path: 'artifacts/relay-connection-420.png', fullPage: true });
  await page.setViewportSize({ width: 940, height: 1000 });

  // ---------------------------------------------------------------- inside the production settings dialog
  await page.goto(`${url}?scenario=dialog`);
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  const tab = name => dialog.getByRole('tab', { name, exact: true });
  await tab('Телефон').click();

  // After stage 5 the topic holds exactly two blocks: the server connection and the per-tab list.
  await dialog.getByRole('region', { name: 'Подключение к серверу', exact: true }).waitFor();
  await dialog.getByRole('region', { name: 'Доступ бесед', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('region', { name: 'Доступ с телефона', exact: true }).count(), 0, 'the personal bot block is gone');
  assert.equal(await dialog.getByRole('textbox', { name: 'Токен бота Telegram', exact: true }).count(), 0, 'no bot token field is left on the computer');

  const dialogUrl = dialog.getByRole('textbox', { name: 'Адрес relay-сервера', exact: true });
  await dialogUrl.fill('wss://relay.example.com/par');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await dialogUrl.inputValue(), 'wss://relay.example.com/par', 'arrow keys edit the field instead of switching topics');
  await tab('Агент').click();
  await tab('Телефон').click();
  assert.equal(await dialogUrl.inputValue(), 'wss://relay.example.com/par', 'a half-typed address survives switching topics');

  // A held network action must not block leaving settings: it is not a local write.
  await page.evaluate(() => { window.__relay.hold = true; });
  await dialog.getByRole('checkbox', { name: 'Держать связь с сервером', exact: true }).click();
  await page.waitForFunction(() => window.__relay.release);
  for (const name of ['Агент', 'Телефон']) assert.equal(await tab(name).isDisabled(), false, 'waiting for the server does not lock the settings window');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab stays inside the dialog');
  await page.evaluate(() => { window.__relay.hold = false; window.__relay.release(); });

  await tab('Телефон').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tab('Агент').evaluate(element => element.getAttribute('aria-selected')), 'true', 'arrow keys move between topics');
  await page.keyboard.press('End');
  assert.equal(await tab('Телефон').evaluate(element => element.getAttribute('aria-selected')), 'true');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/relay-connection-settings-dialog.png' });
  await dialog.getByRole('tabpanel').press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape closes settings');
  assert.equal(await page.evaluate(() => window.__relay.closeCalls), 1);
  assert.equal(await page.getByRole('button', { name: 'Открыть настройки', exact: true }).evaluate(element => element === document.activeElement), true, 'focus returns to the launcher');

  assert.deepEqual(errors, []);
  console.log('Relay connection UI passed: fresh profile with no address, refused address kept for editing, saved address and enabling, pushed host state without extra reads, installation named at pairing time and passed with it, locally rendered QR decoded by the browser, pairing code shown only on the computer with copy and Telegram link, no confirm button before a claimant, claimant named before any key is issued, decline and confirm, non-blocking network waits, refused local action, linked panel with owner, published count and rename, unlink, offline and missing encryption, 420 px without horizontal scrolling, production settings dialog next to «Доступ бесед» with no bot block and no token field left, preserved input, arrow/End/Tab/Escape and restored focus. No relay, Telegram or model calls.');
} finally {
  await browser?.close();
  await server.close();
}
