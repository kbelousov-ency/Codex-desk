import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1440, 940]) {
    const page = await browser.newPage({ viewport: { width, height: 940 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const cwd = 'C:/Fixtures/RESULT';
      const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
      const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
      const answer = (id, text) => ({ id, type: 'agentMessage', phase: 'final_answer', text });
      const diff = '@@ -1 +1 @@\n-old\n+new';
      const turns = [
        { id: 'done', status: 'completed', items: [user('request', 'Обнови документ и выполни команды.'),
          { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: 'docs/result.md', kind: { type: 'add' }, diff }] },
          { id: 'ok-command', type: 'commandExecution', status: 'completed', command: 'npm test', exitCode: 0, aggregatedOutput: 'Проверка fixture завершена.' },
          { id: 'bad-command', type: 'commandExecution', status: 'completed', command: 'npm run lint', exitCode: 2, aggregatedOutput: 'Fixture lint failed' },
          answer('answer', 'Первый абзац ответа.\n\n**Выбранный фрагмент** для уточнения.\n\nПоследний абзац.') ] },
        { id: 'unknown', items: [user('unknown-request', 'Старая история'), { id: 'unknown-command', type: 'commandExecution', command: 'old command', complete: true }, answer('unknown-answer', 'Ответ без достоверного статуса хода.')] },
      ];
      const sessions = {};
      const fixture = window.__quoteResults = { sessions, calls: [], reads: [] };
      for (const id of ['session-a', 'session-b']) {
        const thread = { id: `thread-${id}`, name: id, cwd, historyMode: 'legacy', turns: id === 'session-a' ? turns : [{ id: 'other', status: 'completed', items: [user('other-request', 'Вопрос другой вкладки'), answer('other-answer', 'Ответ другой вкладки.')] }] };
        const state = sessions[id] = { id, thread, listeners: new Set() };
        state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
        state.bridge = {
          async start() { return { initialize: {}, cwd, models: [model], executable: 'fixture', account: { account: null, requiresOpenaiAuth: false }, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
          async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'auto' }; }, async setSettings() {},
          async request(method, params = {}) {
            fixture.calls.push({ id, method, params });
            if (method === 'thread/list') return { data: [thread], nextCursor: null };
            if (method === 'thread/resume') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
            throw new Error(`Unexpected fixture request ${method}`);
          },
          async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
          async searchProjectFiles() { return { files: [{ path: 'docs/result.md', name: 'result.md' }], nextCursor: null }; },
          async readProjectFile({ path }) { fixture.reads.push({ id, path }); return { path, kind: 'markdown', text: '# Созданный документ\n\nСодержимое результата.' }; },
          async getGitStatus() { return { available: false, entries: [] }; },
          onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
          async respond() {}, async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {},
        };
      }
      window.codex = {
        ...sessions['session-a'].bridge,
        async getWorkspace() { return { projects: [cwd], sessions: [], restore: { activeIndex: 0, tabs: Object.values(sessions).map(state => ({ id: state.id, cwd, thread: state.thread, draft: state.id === 'session-a' ? 'Мой черновик' : 'Черновик B', attachments: [] })) } }; },
        async completeUpdateRestore() {}, async saveWorkspaceState() {},
        async listProjectThreads() { return { data: Object.values(sessions).map(state => state.thread), nextCursor: null }; },
        forSession(id) { return sessions[id].bridge; },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const view = () => page.locator('.session-view:visible');
    const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
    const card = () => view().locator('[data-result-turn-id="done"]');
    const select = async (first, last = first) => {
      await view().locator(`[data-item-id="${first}"] .message-content`).scrollIntoViewIfNeeded();
      await view().locator(`[data-item-id="${first}"] .message-content`).click();
      await page.evaluate(({ first, last }) => {
        const root = document.querySelector('.session-view:not([hidden])');
        const start = root.querySelector(`[data-item-id="${first}"] .message-content`);
        const end = root.querySelector(`[data-item-id="${last}"] .message-content`);
        const range = document.createRange();
        if (first === last && start.querySelector('strong')) range.selectNodeContents(start.querySelector('strong'));
        else { range.setStart(start, 0); range.setEnd(end, end.childNodes.length); }
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }, { first, last });
    };
    await card().waitFor();
    assert.equal(await view().locator('.task-result').count(), 1, 'Unknown history has no fabricated result');
    assert.match(await card().innerText(), /Код выхода: 0/);
    assert.match(await card().innerText(), /Код выхода: 2/);
    assert.equal(await card().locator('.has-error').count(), 1);
    assert.equal(await card().evaluate(node => node.previousElementSibling?.dataset.itemId), 'answer');

    // Mouse quote preserves the existing draft; it is visible and editable, never sent.
    await select('answer');
    await page.getByRole('button', { name: 'Ответить на выделенное', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) textarea')?.value.includes('> Выбранный фрагмент'));
    assert.match(await composer().inputValue(), /^Мой черновик\n\n> Выбранный фрагмент/);
    assert.equal(await composer().evaluate(node => document.activeElement === node), true);
    await composer().fill('Редактируемый черновик');

    // The keyboard shortcut uses exactly the same selected text.
    await select('answer');
    await page.keyboard.press('Control+Shift+R');
    await page.waitForFunction(() => document.querySelector('.session-view:not([hidden]) textarea')?.value.includes('> Выбранный фрагмент'));
    assert.match(await composer().inputValue(), /^Редактируемый черновик\n\n> Выбранный фрагмент/);

    // A selection spanning two messages cannot silently combine unrelated content.
    await select('answer', 'unknown-answer');
    await page.waitForFunction(() => !document.querySelector('.quote-selection-toolbar'));
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await select('answer');
    await page.getByRole('button', { name: 'Ответить на выделенное', exact: true }).waitFor();
    await page.locator('.session-tab[data-session-id="session-b"]').getByRole('tab').click();
    assert.equal(await page.locator('.quote-selection-toolbar').count(), 0);
    assert.equal(await composer().inputValue(), 'Черновик B');
    await page.locator('.session-tab[data-session-id="session-a"]').getByRole('tab').click();
    assert.match(await composer().inputValue(), /^Редактируемый черновик/);

    // Every command can lead back to its real work event and output.
    await card().getByRole('button', { name: 'Событие команды: npm run lint', exact: true }).click();
    await view().locator('[data-item-id="bad-command"] .work-output').filter({ hasText: 'Fixture lint failed' }).waitFor();
    assert.equal(await view().locator('[data-item-id="bad-command"]').evaluate(node => node.open), true);
    await card().getByRole('button', { name: 'docs/result.md', exact: true }).click();
    await page.waitForFunction(() => window.__quoteResults.reads.length > 0);
    assert.equal((await page.evaluate(() => window.__quoteResults.reads)).at(-1).id, 'session-a');
    await view().getByRole('button', { name: 'Закрыть просмотр файлов', exact: true }).click();
    await card().getByRole('button', { name: 'Посмотреть изменения запроса', exact: true }).click();
    await view().locator('.change-turn-picker').waitFor();
    assert.match(await view().locator('.change-turn-picker').innerText(), /Обнови документ/);

    // Completion, rather than streaming final text, creates a new result.
    await page.evaluate(() => {
      const state = window.__quoteResults.sessions['session-a'];
      const threadId = state.thread.id;
      state.emit('turn/started', { threadId, turn: { id: 'live', status: 'inProgress' } });
      state.emit('item/completed', { threadId, turnId: 'live', item: { id: 'live-command', type: 'commandExecution', command: 'echo done', exitCode: 0, status: 'completed' } });
      state.emit('item/completed', { threadId, turnId: 'live', item: { id: 'live-answer', type: 'agentMessage', phase: 'final_answer', text: 'Живой итог.' } });
    });
    await view().locator('[data-item-id="live-answer"]').waitFor();
    assert.equal(await view().locator('[data-result-turn-id="live"]').count(), 0);
    await page.evaluate(() => {
      const state = window.__quoteResults.sessions['session-a'];
      state.emit('turn/completed', { threadId: state.thread.id, turn: { id: 'live', status: 'completed', items: [] } });
    });
    await view().locator('[data-result-turn-id="live"]').waitFor();
    assert.equal((await page.evaluate(() => window.__quoteResults.calls)).filter(call => /turn\/(start|steer)/.test(call.method)).length, 0);
    assert.deepEqual(errors, []);
    await card().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/quote-results-${width}.png` });
    await page.close();
  }
  console.log('Quote and result UI passed at 1440/940 with fixture events; no model requests.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
