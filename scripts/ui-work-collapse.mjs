import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with isolated history fixtures. No real Codex/model request.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
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
    const cwd = 'C:/Fixtures/PROJECT_A';
    const sessions = {};
    let serial = 0;
    const models = [{ id: 'fixture-alpha', model: 'fixture-alpha', displayName: 'fixture-alpha', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const history = { id: 'saved-history', name: 'Проверка длинного хода работы', cwd, historyMode: 'legacy' };
    const paragraphs = (from, count) => Array.from({ length: count }, (_, index) => `Пояснение ${from + index}: проверяю файлы проекта и сохраняю полученные результаты. Пользователь может читать подробности и свернуть их с текущего места.`).join('\n\n');
    const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] });
    const turns = [
      { id: 'long-history', status: 'completed', durationMs: 302000, items: [
        user('user-long', 'Проверь большой проект'),
        { id: 'reasoning-before', type: 'reasoning', summary: [paragraphs(1, 65)], content: [] },
        { id: 'long-command', type: 'commandExecution', command: 'npm.cmd run build', status: 'completed', commandActions: [], exitCode: 0, aggregatedOutput: Array.from({ length: 200 }, (_, index) => `Вывод команды ${index + 1}: проверка завершена`).join('\n') },
        { id: 'reasoning-after', type: 'reasoning', summary: [paragraphs(66, 65)], content: [] },
        { id: 'final-long', type: 'agentMessage', phase: 'final_answer', text: 'Итог большого запроса: проект проверен, все детали сохранены.' },
      ] },
      { id: 'other-history', status: 'completed', durationMs: 10000, items: [
        user('user-other', 'Проверь ещё один файл'),
        { id: 'reasoning-other', type: 'reasoning', summary: ['Независимое пояснение второго запроса.'], content: [] },
        { id: 'final-other', type: 'agentMessage', phase: 'final_answer', text: 'Итог второго запроса.' },
      ] },
    ];
    const make = () => {
      const id = `session-${++serial}`;
      const state = { id, cwd, settings: { cwd, model: 'fixture-alpha', effort: 'high', access: 'workspace-write' }, listeners: new Set(), closed: false };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture-alpha', model_reasoning_effort: 'high' } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method) {
          if (method === 'thread/list') return { data: [history], nextCursor: null };
          if (method === 'thread/resume') return { thread: { ...history, status: { type: 'idle' }, turns }, model: 'fixture-alpha', reasoningEffort: 'high' };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [{ name: 'README.md', path: 'README.md', type: 'file' }], nextCursor: null }; },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {}, async saveImages() { return []; }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd };
    };
    make();
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: [{ id: 'session-1', cwd }] }; },
      async listProjectThreads() { return { data: [history], nextCursor: null }; }, async createSession() { return make(); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); }, forSession(id) { return sessions[id].bridge; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const chat = () => view().locator('.chat-scroll');
  const log = id => chat().locator(`.work-log[data-turn-id="${id}"]`);
  const summary = id => log(id).locator(':scope > summary');
  const flush = () => page.waitForTimeout(80);
  await view().getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  const project = view().getByRole('button', { name: 'Диалоги папки PROJECT_A', exact: true });
  if (await project.getAttribute('aria-expanded') !== 'true') await project.click();
  await view().locator('.folder-thread[data-thread-id="saved-history"]').click();
  await summary('long-history').waitFor();
  assert.equal(await log('long-history').evaluate(node => node.open), false, 'History initially collapsed');
  assert.equal(await log('other-history').evaluate(node => node.open), false);
  assert.equal(await chat().locator('[data-item-id="final-long"]').evaluate(node => Boolean(node.closest('.work-log'))), false, 'Final answer is outside disclosure');
  await summary('other-history').click();
  const keepOtherOpen = async () => assert.equal(await log('other-history').evaluate(node => node.open), true, 'Collapsing one request preserves the other request');
  const scrollInside = async fraction => {
    await log('long-history').evaluate((node, fraction) => {
      const scroll = node.closest('.chat-scroll');
      const top = node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      scroll.scrollTop = top + node.getBoundingClientRect().height * fraction;
    }, fraction);
    await flush();
  };
  const stickyPoint = async () => {
    const rect = await summary('long-history').boundingBox();
    const area = await chat().boundingBox();
    assert.ok(rect && area && rect.y >= area.y - 1 && rect.y <= area.y + 2, `Collapse header stays at chat top: ${JSON.stringify({ rect, area })}`);
    const point = { x: rect.x + Math.min(rect.width - 16, 90), y: rect.y + rect.height / 2 };
    assert.ok(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.work-log-summary')), point), 'Sticky control is visible and pointer accessible');
    return point;
  };
  const assertCollapsed = async () => {
    await flush();
    assert.equal(await log('long-history').evaluate(node => node.open), false);
    const rect = await summary('long-history').boundingBox();
    const area = await chat().boundingBox();
    const answer = await chat().locator('[data-item-id="final-long"]').boundingBox();
    assert.ok(rect.y >= area.y - 1 && rect.y + rect.height <= area.y + area.height + 1, `Collapsed header stays in view without returning manually: ${JSON.stringify({ rect, area, answer })}`);
    assert.ok(answer.y >= area.y - 1 && answer.y < area.y + area.height, 'Final answer visible after collapse; no blank jump');
    assert.equal(await summary('long-history').evaluate(node => document.activeElement === node), true, 'Keyboard focus returns to collapsed header');
    await keepOtherOpen();
  };
  for (const size of [{ width: 1440, height: 900 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size); await flush();
    await summary('long-history').click(); await flush();
    await scrollInside(0.3);
    const middlePoint = await stickyPoint();
    await page.screenshot({ path: `artifacts/work-collapse-mid-${size.width}.png` });
    // Deliberately avoid Locator.click(): it could auto-scroll a broken header into view.
    await page.mouse.click(middlePoint.x, middlePoint.y);
    await assertCollapsed();
    await page.screenshot({ path: `artifacts/work-collapse-collapsed-${size.width}.png` });
    await summary('long-history').click(); await flush();
    assert.equal(await log('long-history').locator('.work-reasoning .markdown p').count(), 130, 'All reasoning survives collapse/reopen');
    await scrollInside(0.9);
    const lowerPoint = await stickyPoint();
    await page.mouse.click(lowerPoint.x, lowerPoint.y);
    await assertCollapsed();

    await summary('long-history').click(); await flush();
    const command = log('long-history').locator('.work-tool[data-item-id="long-command"]');
    if (await command.evaluate(node => node.open) !== true) await command.locator(':scope > summary').click();
    const output = command.locator('.work-output').filter({ hasText: 'Вывод команды 200:' });
    await output.evaluate(node => node.scrollIntoView({ block: 'center' })); await flush();
    await stickyPoint();
    const chatBefore = await chat().evaluate(node => node.scrollTop);
    await output.evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
    assert.equal(await chat().evaluate(node => node.scrollTop), chatBefore, 'Internal command scrolling is independent');
    const toolPoint = await stickyPoint();
    await page.mouse.click(toolPoint.x, toolPoint.y);
    await assertCollapsed();

    await summary('long-history').click(); await flush();
    const footer = log('long-history').getByRole('button', { name: 'Свернуть ход работы', exact: true });
    await footer.evaluate(node => node.scrollIntoView({ block: 'center' })); await flush();
    assert.equal(await footer.isVisible(), true);
    await page.screenshot({ path: `artifacts/work-collapse-footer-${size.width}.png` });
    // Keyboard path from the bottom must offer the same position/focus recovery.
    await footer.focus(); await page.keyboard.press('Enter');
    await assertCollapsed();
    await summary('long-history').click(); await flush();
    assert.match(await log('long-history').innerText(), /Пояснение 130:/);
    assert.equal(await command.evaluate(node => node.open), true, 'Tool disclosure survives parent collapse');
    assert.match(await output.innerText(), /Вывод команды 200:/);
    await footer.evaluate(node => node.scrollIntoView({ block: 'center' })); await flush();
    const footerBox = await footer.boundingBox();
    await page.mouse.click(footerBox.x + footerBox.width / 2, footerBox.y + footerBox.height / 2);
    await assertCollapsed();
    const documentSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    assert.ok(documentSize.scrollWidth <= documentSize.width + 1 && documentSize.scrollHeight <= documentSize.height + 1, `No page overflow at ${size.width}px`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: long history collapses via physically clicked sticky header from middle, near bottom and inside command output; footer works by Enter and mouse; collapsed header/final/focus remain visible, content and other turn disclosure preserved; 1440/940px. Production renderer, fixture history only, no model requests.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/work-collapse-failure.png' });
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
