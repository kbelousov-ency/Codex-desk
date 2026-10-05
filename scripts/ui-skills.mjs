import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Real React settings against a preload fixture: no user files, CLI or model calls.
const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  plugins: [{ name: 'skills-fixture', configureServer(vite) {
    vite.middlewares.use('/skills-fixture', async (_request, response) => {
      try {
        const html = await vite.transformIndexHtml('/skills-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:skills-fixture"></script></body></html>');
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  }, resolveId(id) { return id === 'virtual:skills-fixture' ? id : null; }, load(id) {
    if (id === 'virtual:skills-fixture') return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import SkillsSettings from "/src/SkillsSettings.tsx";
      import SettingsDialog from "/src/SettingsDialog.tsx";
      import "/src/styles.css";
      const search = new URLSearchParams(location.search);
      const provider = search.get('provider') || 'codex';
      function ConnectingFixture() {
        const [cwd, setCwd] = React.useState('');
        return React.createElement(React.Fragment, null,
          React.createElement('button', { onClick: () => setCwd('C:\\\\Fixture\\\\project') }, 'Подключение готово'),
          React.createElement(SkillsSettings, { provider, cwd, active: true }),
        );
      }
      function DialogFixture() {
        const [open, setOpen] = React.useState(false);
        return React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: () => setOpen(true) }, "Открыть настройки"),
          open && React.createElement(SettingsDialog, { active: true, busy: false, onClose: () => setOpen(false), tabs: [
            { id: "agent", label: "Агент", icon: null, content: React.createElement("p", null, "Настройки проверочного агента") },
            { id: "skills", label: "Навыки", icon: null, content: React.createElement(SkillsSettings, { provider, cwd: "C:\\\\Fixture\\\\project", active: true }) },
            { id: "memory", label: "Память", icon: null, content: React.createElement("p", null, "Правила памяти") },
          ] }),
        );
      }
      const element = search.get('scenario') === 'dialog'
        ? React.createElement(DialogFixture)
        : search.get('scenario') === 'cwd-race' ? React.createElement(ConnectingFixture)
        : React.createElement("div", { style: { maxWidth: 560, padding: 20 } }, React.createElement(SkillsSettings, { provider, cwd: "C:\\\\Fixture\\\\project", active: true }));
      createRoot(document.getElementById("root")).render(element);
    `;
  } }],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/skills-fixture`;
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
    const fixture = window.__skills = { calls: [], fail: scenario === 'read-error' ? ['codex'] : [] };
    const skill = (name, source, description, extra = {}) => ({
      id: `${source}:${name}`, name, description, source, root: `C:\\Fixture\\${source}`,
      path: `C:\\Fixture\\${source}\\${name}\\SKILL.md`, directory: `C:\\Fixture\\${source}\\${name}`, updatedAt: '2026-09-30T10:00:00.000Z', ...extra,
    });
    const snapshots = {
      codex: {
        provider: 'codex', cwd: 'C:\\Fixture\\project', readAt: '2026-10-02T09:00:00.000Z', truncated: false,
        roots: [
          { source: 'project', path: 'C:\\Fixture\\project\\.codex\\skills', exists: true, count: 1 },
          { source: 'user', path: 'C:\\Fixture\\.codex\\skills', exists: true, count: 2 },
          { source: 'plugin', path: 'C:\\Fixture\\.codex\\plugins', exists: false, count: 0 },
        ],
        skills: [
          skill('project-rules', 'project', 'Правила этого проекта'),
          skill('changelog-generator', 'user', 'Готовит записи выпуска'),
          skill('pdf', 'user', 'Читает и собирает PDF', { duplicates: ['C:\\Fixture\\shared\\pdf\\SKILL.md'] }),
        ],
        errors: [],
      },
      claude: {
        provider: 'claude', cwd: 'C:\\Fixture\\project', readAt: '2026-10-02T09:00:00.000Z', truncated: false,
        roots: [{ source: 'user', path: 'C:\\Fixture\\.claude\\skills', exists: true, count: 2 }],
        skills: [skill('docx', 'synced', 'Документы Word'), skill('plugin-helper', 'plugin', 'Навык плагина', { plugin: 'helper' })],
        errors: [{ path: 'C:\\Fixture\\.claude\\skills\\broken\\SKILL.md', message: 'Не удалось прочитать файл (EACCES).' }],
      },
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    window.codex = scenario === 'unavailable' ? {} : { skills: {
      async list(options) {
        fixture.calls.push(clone(options));
        if (scenario === 'cwd-race') {
          const snapshot = { ...clone(snapshots.codex), cwd: options.cwd,
            skills: [skill(options.cwd ? 'current-project' : 'previous-read', 'project', '')] };
          if (!options.cwd) return new Promise(resolve => { fixture.finishPrevious = () => resolve(snapshot); });
          return snapshot;
        }
        if (fixture.fail.includes(options.provider)) {
          fixture.fail = fixture.fail.filter(item => item !== options.provider);
          throw new Error("Error invoking remote method 'skills:list': Error: Не удалось прочитать каталог навыков.");
        }
        return clone(snapshots[options.provider]);
      },
    } };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const panel = page.locator('.skills-panel');
  // Only the tab's own agent is read until the other one is opened.
  await panel.getByText('Найдено навыков: 3', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__skills.calls), [{ provider: 'codex', cwd: 'C:\\Fixture\\project' }]);
  assert.deepEqual(await panel.locator('.skills-group h4').allInnerTexts(), ['Проектные\n1', 'Пользовательские\n2']);
  await panel.getByText('C:\\Fixture\\user\\pdf\\SKILL.md · копий ещё: 1', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-skills-root="missing"]').isVisible(), false);
  await panel.getByRole('group').getByText('Где искали', { exact: false }).click();
  await panel.locator('[data-skills-root="missing"]').getByText('каталога нет', { exact: true }).waitFor();

  // Filtering never re-reads the disk; it narrows the already loaded snapshot.
  await panel.getByRole('searchbox', { name: 'Поиск по навыкам', exact: true }).fill('pdf');
  await panel.getByText('Найдено навыков: 3, показано 1', { exact: false }).waitFor();
  assert.deepEqual(await panel.locator('.skills-group h4').allInnerTexts(), ['Пользовательские\n1']);
  assert.equal(await page.evaluate(() => window.__skills.calls.length), 1);
  await panel.getByRole('searchbox', { name: 'Поиск по навыкам', exact: true }).fill('');

  // Arrow keys move between the agent sub-tabs, and each agent is read once.
  await page.locator('[data-skills-agent="codex"]').focus();
  await page.keyboard.press('ArrowRight');
  await panel.getByText('Навык плагина', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__skills.calls.map(call => call.provider)), ['codex', 'claude']);
  assert.deepEqual(await panel.locator('.skills-group h4').allInnerTexts(), ['Синхронизированные\n1', 'Из плагинов\n1']);
  await panel.getByText('плагин: helper', { exact: true }).waitFor();
  await panel.getByText('Не удалось прочитать файл (EACCES).', { exact: true }).waitFor();
  await page.keyboard.press('ArrowLeft');
  await panel.getByText('Правила этого проекта', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__skills.calls.length), 2);
  assert.deepEqual(await page.locator('.skills-count').allInnerTexts(), ['3', '2']);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.waitForFunction(() => window.__skills.calls.length === 3);
  await page.setViewportSize({ width: 420, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/skills-settings.png', fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });

  // A failed read shows the reason and keeps the retry available.
  await page.goto(`${url}?scenario=read-error`);
  await panel.getByRole('alert').filter({ hasText: 'Не удалось прочитать каталог навыков.' }).waitFor();
  assert.equal(await panel.getByRole('alert').innerText(), 'Не удалось прочитать каталог навыков.');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await panel.getByText('Найдено навыков: 3', { exact: false }).waitFor();

  // Settings can open before bridge.start supplies cwd. Its old disk read must not replace the new one.
  await page.goto(`${url}?scenario=cwd-race`);
  await page.waitForFunction(() => typeof window.__skills.finishPrevious === 'function');
  await page.getByRole('button', { name: 'Подключение готово', exact: true }).click();
  await panel.getByText('current-project', { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.__skills.finishPrevious();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await panel.getByText('current-project', { exact: true }).count(), 1);
  assert.equal(await panel.getByText('previous-read', { exact: true }).count(), 0);

  // The tab of a Claude session opens on Claude.
  await page.goto(`${url}?provider=claude`);
  await panel.getByText('Документы Word', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__skills.calls.map(call => call.provider)), ['claude']);

  await page.goto(`${url}?scenario=unavailable`);
  await page.getByText('Список навыков доступен в установленном приложении Codex Desk.', { exact: true }).waitFor();
  assert.equal(await page.locator('.skills-group').count(), 0);

  // The production settings dialog keeps its own tab navigation and focus trap around the inner tabs.
  await page.setViewportSize({ width: 940, height: 620 });
  await page.goto(`${url}?scenario=dialog`);
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ваше рабочее пространство', exact: true });
  await dialog.getByRole('tab', { name: 'Навыки', exact: true }).click();
  await dialog.getByText('Правила этого проекта', { exact: true }).waitFor();
  await dialog.locator('[data-skills-agent="claude"]').click();
  await dialog.getByText('Документы Word', { exact: true }).waitFor();
  // Arrow keys inside the agent sub-tabs must not change the settings tab.
  await dialog.locator('[data-skills-agent="claude"]').focus();
  await page.keyboard.press('ArrowLeft');
  await dialog.getByText('Правила этого проекта', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('tab', { name: 'Навыки', exact: true }).getAttribute('aria-selected'), 'true');
  await dialog.getByRole('tab', { name: 'Навыки', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await dialog.getByRole('tab', { name: 'Память', exact: true }).getAttribute('aria-selected'), 'true');
  await dialog.getByRole('tab', { name: 'Навыки', exact: true }).click();
  await dialog.getByText('Правила этого проекта', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  assert.deepEqual(errors, []);
  console.log('ui-skills: сценарии списка навыков пройдены');
} finally {
  await browser?.close();
  await server.close();
}
