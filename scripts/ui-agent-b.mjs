import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { composerPlaceholderLibraries } from '../src/composer-placeholders.ts';

const server = await createServer({
  base: '/', server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
  cacheDir: 'artifacts/agent-b/vite-cache', optimizeDeps: { entries: ['index.html'] },
  plugins: [{ name: 'agent-b-fixture', configureServer(vite) {
    vite.middlewares.use('/agent-b-fixture', async (_request, response) => {
      const html = await vite.transformIndexHtml('/agent-b-fixture', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/@id/virtual:agent-b-fixture"></script></body></html>');
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    });
  }, resolveId(id) { return id === 'virtual:agent-b-fixture' ? id : null; }, load(id) {
    if (id !== 'virtual:agent-b-fixture') return null;
    return 'import React from "react"; import { createRoot } from "react-dom/client"; import App from "/src/App.tsx"; import "/src/styles.css"; const root = createRoot(document.getElementById("root")); window.__agentB.mount = (id, existing = false) => root.render(React.createElement(React.StrictMode, null, React.createElement(App, { key: id, sessionId: id, ...(existing ? { initialThread: window.__agentB.thread } : {}) }))); window.__agentB.mount("new");';
  } }],
});
await server.listen();
await mkdir('artifacts/agent-b', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const channel of ['nightly', 'experimental3', 'stable']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.addInitScript(channel => {
      const cwd = 'C:/Fixtures/AgentB';
      const settings = { cwd, model: 'fixture-model', effort: 'high', access: 'workspace-write', connectionSource: 'inherited' };
      const thread = { id: 'existing-thread', cwd, name: 'Сохранённый диалог', turns: [{ id: 'history', status: 'completed', items: [{ id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'Сохранённый вопрос' }] }] }] };
      const fixture = window.__agentB = { settings, thread, calls: [], listeners: new Set() };
      const emit = (method, params) => { for (const listener of fixture.listeners) listener({ type: 'notification', data: { method, params } }); };
      window.codex = {
        async getBuildInfo() { return { channel, version: '0.10.0', buildId: 'a'.repeat(64), builtAt: '2026-10-09T00:00:00.000Z' }; },
        async getSettings() { return { ...settings }; },
        async setSettings(patch) { fixture.calls.push({ method: 'setSettings', patch }); Object.assign(settings, patch); },
        async start() { fixture.calls.push({ method: 'start', source: settings.connectionSource }); return { cwd, provider: 'codex', executable: 'fixture-cli', capabilities: { compact: true, steer: true, terminal: true, mcp: false, archive: true, usage: false }, config: { model: settings.model }, account: null, models: [{ id: settings.model, model: settings.model, displayName: 'Fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }; },
        async request(method, params = {}) {
          fixture.calls.push({ method, params: structuredClone(params), source: settings.connectionSource });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume' || method === 'thread/read') return { thread: structuredClone(thread), model: settings.model, reasoningEffort: settings.effort };
          if (method === 'thread/start') return { thread: { id: 'created-thread', cwd, turns: [] }, model: settings.model, reasoningEffort: settings.effort };
          if (method === 'turn/start') { setTimeout(() => emit('turn/completed', { threadId: params.threadId, turn: { id: 'fixture-turn', status: 'completed', items: [] } }), 20); return { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } }; }
          if (method === 'agent/capabilities') return { commands: [], agents: [], mcpServers: [] };
          if (method === 'usage/read') return { available: false, windows: [] };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async listFiles() { return { path: '', entries: [], nextCursor: null }; },
        async getMcpConfig() { return { configPath: 'C:/Fixtures/AgentB/config.toml', servers: [] }; },
        onEvent(listener) { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
      };
    }, channel);
    await page.goto(`${server.resolvedUrls.local[0]}agent-b-fixture`);
    const input = page.locator('.composer textarea');
    const ready = () => page.waitForFunction(() => document.querySelector('[aria-label="Модель"]')?.getAttribute('data-value') === 'fixture-model' && !document.querySelector('[aria-label="Модель"]')?.disabled);
    await ready();
    const newPhrases = Object.values(composerPlaceholderLibraries.new).flat();
    const continuingPhrases = Object.values(composerPlaceholderLibraries.continuing).flat();
    const first = await input.getAttribute('placeholder');
    assert.ok(newPhrases.includes(first));
    assert.equal(await input.inputValue(), '');
    await input.focus(); await input.blur();
    await input.fill('Черновик для проверки'); await input.fill('');
    await page.setViewportSize({ width: 1000, height: 850 });
    assert.equal(await input.getAttribute('placeholder'), first, 'focus, blur, typing and resize never rotate');
    await input.press('Enter');
    assert.equal(await page.evaluate(() => window.__agentB.calls.filter(call => call.method === 'turn/start').length), 0, 'empty placeholder is never submitted');
    await page.setViewportSize({ width: 1440, height: 950 });
    assert.equal(await page.locator('.composer [aria-label="Источник"]').count(), 0);
    await page.locator('.build-badge').filter({ hasText: channel === 'stable' ? 'RELEASE' : channel === 'nightly' ? 'NIGHTLY' : 'EXPERIMENTAL 3' }).waitFor();
    if (channel === 'stable') {
      assert.equal(await page.locator('.kuzmich-brand-mark').count(), 0);
      assert.equal(await page.locator('html').getAttribute('data-theme'), null);
    } else {
      await page.locator('.brand-product-name').getByText('Кузьмич', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.kuzmich-brand-mark img')?.naturalWidth > 0);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'kuzmich');
    }
    await input.fill('Только пользовательский текст');
    await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await page.waitForFunction(() => window.__agentB.calls.some(call => call.method === 'turn/start'));
    const sent = await page.evaluate(() => window.__agentB.calls.find(call => call.method === 'turn/start').params.input);
    assert.deepEqual(sent, [{ type: 'text', text: 'Только пользовательский текст', text_elements: [] }]);
    assert.equal(await input.getAttribute('placeholder'), first, 'native thread creation does not rotate');
    await page.waitForFunction(() => document.querySelector('[aria-label="Отправить сообщение"]'));
    await page.getByRole('button', { name: /Новый диалог/ }).click();
    assert.notEqual(await input.getAttribute('placeholder'), first);
    assert.ok(newPhrases.includes(await input.getAttribute('placeholder')));
    await page.locator('.history-item').filter({ hasText: 'Сохранённый диалог' }).click();
    await page.locator('.user-message').getByText('Сохранённый вопрос', { exact: true }).waitFor();
    assert.ok(continuingPhrases.includes(await input.getAttribute('placeholder')), 'standalone sidebar history uses continuing work');
    await page.evaluate(() => window.__agentB.mount('existing', true));
    await page.locator('.user-message').getByText('Сохранённый вопрос', { exact: true }).waitFor();
    await ready();
    const existing = await input.getAttribute('placeholder');
    assert.ok(continuingPhrases.includes(existing));
    await input.fill('Сохраняемый черновик');
    const callsBefore = await page.evaluate(() => window.__agentB.calls.filter(call => call.method === 'turn/start').length);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    const source = page.getByRole('combobox', { name: 'Источник', exact: true });
    assert.equal(await source.getAttribute('data-value'), 'inherited');
    for (const value of ['account', 'router', 'inherited']) {
      await source.click();
      await page.getByRole('listbox', { name: 'Источник', exact: true }).locator(`[data-value="${value}"]`).click();
      await page.waitForFunction(value => window.__agentB.settings.connectionSource === value && document.querySelector('[aria-label="Источник"]')?.getAttribute('data-value') === value && !document.querySelector('[aria-label="Источник"]')?.disabled, value).catch(async error => {
        console.error(errors, await page.evaluate(() => ({ settings: window.__agentB.settings, calls: window.__agentB.calls, root: document.getElementById('root')?.innerHTML.slice(0, 1000), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })));
        await page.screenshot({ path: 'artifacts/agent-b/source-failure.png' });
        throw error;
      });
      assert.equal(await input.inputValue(), 'Сохраняемый черновик');
      assert.equal(await input.getAttribute('placeholder'), existing);
    }
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__agentB.calls.filter(call => call.method === 'turn/start').length), callsBefore);
    assert.equal(await page.evaluate(() => window.__agentB.calls.filter(call => call.method === 'thread/resume').every(call => call.params.threadId === 'existing-thread')), true);
    assert.deepEqual(await page.evaluate(() => [window.__agentB.settings.model, window.__agentB.settings.effort]), ['fixture-model', 'high']);
    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 950 });
      const bounds = await page.locator('.composer').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.screenshot({ path: `artifacts/agent-b/${channel}-${width}.png` });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: Nightly/Experimental 3/Release brand separation; actual SVG loading; lifecycle-stable new/existing placeholders; no placeholder submission; composer Source absent; source switching in settings preserves connection, draft, model, effort and history. Fixture bridges only, no model/CLI/config/network calls.');
} finally {
  await browser.close();
  await server.close();
}
