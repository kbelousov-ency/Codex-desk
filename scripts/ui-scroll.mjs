import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with a mock bridge: no Codex process or model requests.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(path); response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const listeners = new Set();
      const history = { id: 'long-history', name: 'Scroll regression history', cwd: 'C:/Fixtures/Scroll', updatedAt: 1789644000 };
      const paragraphs = Array.from({ length: 9 }, (_, index) => `Paragraph ${index + 1}: a long answer keeps the chat scrollable while the input stays visible.`).join('\n\n');
      const turns = Array.from({ length: 35 }, (_, index) => ({ id: `saved-turn-${index}`, status: 'completed', items: [
        { id: `question-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${index + 1}` }] },
        { id: `answer-${index}`, type: 'agentMessage', text: `${paragraphs}\n\n\`\`\`text\n${'wide-code-'.repeat(120)}\n\`\`\`\n\n${'unbroken'.repeat(50)}` },
        { id: `command-${index}`, type: 'commandExecution', command: `Inspect fixture ${index + 1}`, status: 'completed', aggregatedOutput: 'Done', exitCode: 0, durationMs: 1 },
      ] }));
      const emit = (method, params) => { for (const listener of listeners) listener({ type: 'notification', data: { method, params } }); };
      window.__scrollFixture = { emit, requests: [] };
      window.codex = {
        async start() { return { initialize: {}, cwd: history.cwd, executable: 'C:/Fixtures/codex.exe', models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture model', isDefault: true, supportedReasoningEfforts: [] }], account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture' } }; },
        async request(method, params = {}) {
          window.__scrollFixture.requests.push({ method, params });
          if (method === 'thread/list') return { data: Array.from({ length: 50 }, (_, index) => ({ ...history, id: index ? `other-${index}` : history.id, name: index ? `Other history ${index}` : history.name })), nextCursor: null };
          if (method === 'thread/resume') return { model: 'fixture', thread: { ...history, historyMode: 'legacy', status: { type: 'idle' }, turns } };
          if (method === 'turn/start') return { turn: { id: 'stream-turn', status: 'inProgress', items: [] } };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async getSettings() { return {}; },
        async setSettings() {},
        async openPath() {},
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Scroll regression history' }).click();
    await page.locator('.assistant-message').last().waitFor({ state: 'visible' });

    const dimensions = () => page.evaluate(() => {
      const chat = document.querySelector('.chat-scroll');
      const main = document.querySelector('.main-column');
      const composer = document.querySelector('.composer-area');
      const rect = element => { const { top, bottom, width, height } = element.getBoundingClientRect(); return { top, bottom, width, height }; };
      return { viewport: { width: innerWidth, height: innerHeight }, chat: { ...rect(chat), height: chat.clientHeight, scrollHeight: chat.scrollHeight, scrollWidth: chat.scrollWidth, width: chat.clientWidth, scrollTop: chat.scrollTop }, main: rect(main), composer: rect(composer), body: { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth } };
    });
    const layout = await dimensions();
    assert.ok(layout.chat.height > 150, `Usable chat viewport at ${viewport.width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.chat.scrollHeight > layout.chat.height * 3, `History must overflow its own scroller: ${JSON.stringify(layout)}`);
    assert.ok(layout.composer.bottom <= viewport.height + 1, `Composer must stay inside window: ${JSON.stringify(layout)}`);
    assert.ok(layout.chat.bottom <= layout.composer.top + 1, 'Chat must not run under the composer');
    assert.ok(layout.body.height <= viewport.height + 1 && layout.body.width <= viewport.width + 1, 'Document itself must not overflow');
    assert.ok(layout.chat.scrollWidth <= layout.chat.width + 1, 'Wide code and long tokens must not expand chat horizontally');
    await page.waitForFunction(() => { const chat = document.querySelector('.chat-scroll'); return chat.scrollHeight - chat.clientHeight - chat.scrollTop < 2; });
    const sidebarFits = await page.locator('.history-list').evaluate(element => element.scrollHeight > element.clientHeight && element.getBoundingClientRect().bottom < innerHeight);
    assert.ok(sidebarFits, 'Long sidebar history must scroll within the viewport');

    // Appending streamed text follows the bottom until the user wheels upward.
    await page.locator('.composer textarea').fill('Continue the scroll fixture');
    await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await page.waitForFunction(() => window.__scrollFixture.requests.some(request => request.method === 'turn/start'));
    const notify = (method, params) => page.evaluate(({ method, params }) => window.__scrollFixture.emit(method, params), { method, params });
    const context = { threadId: 'long-history', turnId: 'stream-turn' };
    await notify('item/agentMessage/delta', { ...context, itemId: 'stream-answer', delta: Array.from({ length: 15 }, (_, index) => `Streaming paragraph ${index}.`).join('\n\n') });
    await page.waitForFunction(() => { const chat = document.querySelector('.chat-scroll'); return chat.scrollHeight - chat.clientHeight - chat.scrollTop < 2; });
    await page.locator('.chat-scroll').hover();
    await page.mouse.wheel(0, -700);
    await page.getByRole('button', { name: 'К последнему сообщению' }).waitFor({ state: 'visible' });
    // Chromium wheel scrolling is animated; wait until successive frames settle.
    await page.evaluate(() => new Promise(resolve => {
      const chat = document.querySelector('.chat-scroll');
      let previous = chat.scrollTop; let stable = 0;
      const frame = () => { const current = chat.scrollTop; stable = Math.abs(current - previous) < 1 ? stable + 1 : 0; previous = current; if (stable >= 8) resolve(); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    const beforeAppend = (await dimensions()).chat.scrollTop;
    await notify('item/agentMessage/delta', { ...context, itemId: 'stream-answer', delta: '\n\nNew text while reading older messages.'.repeat(25) });
    await page.getByText(/New text while reading older messages/).first().waitFor({ state: 'visible' });
    const afterAppend = await dimensions();
    assert.ok(Math.abs(afterAppend.chat.scrollTop - beforeAppend) < 3, 'Streaming must preserve the reader position after upward wheel input');
    await page.getByRole('button', { name: 'К последнему сообщению' }).click();
    await page.waitForFunction(() => { const chat = document.querySelector('.chat-scroll'); return chat.scrollHeight - chat.clientHeight - chat.scrollTop < 2; });

    // The side panel is independently scrollable, including its narrow overlay.
    if (viewport.width <= 1000) await page.getByRole('button', { name: 'Переключить панель действий' }).click();
    await page.getByRole('button', { name: 'Действия', exact: true }).click();
    const panelFits = await page.locator('.panel-scroll').evaluate(element => element.scrollHeight > element.clientHeight && element.getBoundingClientRect().bottom <= innerHeight);
    assert.ok(panelFits, 'Long activity panel must remain inside its own scroller');
    if (viewport.width <= 1000) await page.getByRole('button', { name: 'Переключить панель действий' }).click();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/scroll-${viewport.width}.png` });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('Scroll regression passed: 1440x900 and 940x640, long history/code, pinned composer, independent panels, stream follow, wheel reading position and return to latest.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
