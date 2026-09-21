import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, deterministic native-dialog bridge. No actual model calls.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const projects = ['C:/Fixtures/FILES_A', 'C:/Fixtures/FILES_B'];
    const models = ['vision', 'text-only'].map(model => ({ id: model, model, displayName: model, inputModalities: model === 'vision' ? ['text', 'image'] : ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }));
    const sessions = {}, calls = [];
    const fixture = window.__files = { sessions, calls, image };
    for (const [index, id] of ['session-a', 'session-b'].entries()) {
      const state = sessions[id] = { cwd: projects[index], model: index ? 'text-only' : 'vision', listeners: new Set(), selection: null, mode: 'result', finish: null };
      const thread = number => ({ id: `${id}-thread-${number}`, name: `История ${number}`, cwd: state.cwd, historyMode: 'legacy', turns: [{ id: `old-${number}`, status: 'completed', items: [{ id: `answer-${number}`, type: 'agentMessage', text: `Ответ ${number}` }] }] });
      state.thread = thread(1);
      state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start(options = {}) { if (options.cwd) state.cwd = options.cwd; return { initialize: {}, cwd: state.cwd, models, executable: 'fixture', account: { account: null, requiresOpenaiAuth: false }, config: { model: state.model, model_reasoning_effort: 'high' } }; },
        async getSettings() { return { cwd: state.cwd, model: state.model, effort: 'high', access: 'auto' }; },
        async setSettings(patch) { if (patch.model) state.model = patch.model; },
        async request(method, params = {}) {
          calls.push({ id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread(1), thread(2)], nextCursor: null };
          if (method === 'thread/resume') return { thread: thread(params.threadId.endsWith('-2') ? 2 : 1), model: state.model, reasoningEffort: 'high' };
          if (method === 'thread/start') return { thread: thread(3), model: state.model, reasoningEffort: 'high' };
          if (method === 'turn/start') return { turn: { id: `sent-${calls.filter(call => call.method === 'turn/start').length}`, status: 'inProgress', items: [] } };
          throw new Error(`Unexpected fixture request: ${method}`);
        },
        async chooseComposerFiles(options) {
          calls.push({ id, method: 'chooseComposerFiles', options: structuredClone(options) });
          if (state.mode === 'error') throw new Error('Не удалось открыть выбранные файлы');
          if (state.mode === 'deferred') return await new Promise(resolve => { state.finish = result => { state.finish = null; resolve(result); }; });
          return structuredClone(state.selection);
        },
        async saveImages(images) { calls.push({ id, method: 'saveImages', images: structuredClone(images) }); return images.map((item, index) => ({ ...item, path: `${state.cwd}/saved-${index}.png` })); },
        async readAttachment() { return image; },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async chooseDirectory() { return projects[1]; }, async chooseExecutable() { return null; },
        async respond() {}, async openPath() {}, async showPathMenu() {},
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    }
    window.codex = {
      ...sessions['session-a'].bridge,
      async getWorkspace() { return { projects, sessions: [], restore: { activeIndex: 0, tabs: Object.entries(sessions).map(([id, state]) => ({ id, cwd: state.cwd, thread: state.thread, draft: id === 'session-a' ? 'Посмотри материалы:' : 'Черновик B', attachments: id === 'session-a' ? [{ name: 'draft.png', dataUrl: image }] : [] })) } }; },
      async completeUpdateRestore() {}, async listProjectThreads(cwd) { return { data: Object.values(sessions).filter(state => state.cwd === cwd).map(state => state.thread), nextCursor: null }; },
      forSession(id) { return sessions[id].bridge; },
    };
    if (location.search === '?single') delete window.codex.getWorkspace;
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const view = () => page.locator('.session-view:visible');
  const composer = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const picker = () => view().getByRole('button', { name: 'Добавить файлы', exact: true });
  const send = () => view().getByRole('button', { name: 'Отправить сообщение', exact: true });
  const tab = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return Boolean(model?.getAttribute('data-value')); });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const calls = method => page.evaluate(method => window.__files.calls.filter(call => call.method === method), method);
  const value = expected => page.waitForFunction(expected => document.querySelector('.session-view:not([hidden]) textarea')?.value === expected, expected);
  const selection = (result, id = 'session-a', mode = 'result') => page.evaluate(({ result, id, mode }) => { const state = window.__files.sessions[id]; state.selection = result; state.mode = mode; }, { result, id, mode });
  const finish = (result, id = 'session-a') => page.evaluate(({ result, id }) => window.__files.sessions[id].finish(result), { result, id });
  const pending = (id = 'session-a') => page.waitForFunction(id => Boolean(window.__files.sessions[id].finish), id);
  const png = await page.evaluate(() => window.__files.image);
  const image = name => ({ name, dataUrl: png });
  const picked = (paths, images = []) => ({ paths, images });
  await ready();
  await tab('session-a');
  await view().getByText('Ответ 1', { exact: true }).waitFor();
  await value('Посмотри материалы:');
  assert.match(await picker().getAttribute('data-tooltip'), /файл/i, 'The plus control describes files');
  await picker().click(); await settle();
  await value('Посмотри материалы:');
  await view().getByRole('button', { name: 'Удалить draft.png', exact: true }).waitFor();
  assert.equal((await calls('turn/start')).length, 0, 'Cancelling the file picker preserves the draft and never sends');

  await selection(null, 'session-a', 'error'); await picker().click();
  await view().getByRole('alert').filter({ hasText: 'Не удалось открыть выбранные файлы' }).waitFor();
  await value('Посмотри материалы:');
  await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  const paths = ['C:\\Материалы\\план [1].pdf', 'C:\\Материалы\\исходники.zip', 'C:\\Материалы\\текст `$().txt'];
  await selection(picked(paths, [image('selected.png')])); await picker().click();
  const mixedDraft = `Посмотри материалы:\n${paths.join('\n')}\n`;
  await value(mixedDraft);
  assert.equal(await composer().evaluate(node => node === document.activeElement && node.selectionStart === node.value.length), true, 'Selection returns typing focus to the end of the visible draft');
  for (const name of ['draft.png', 'selected.png']) await view().getByRole('button', { name: `Удалить ${name}`, exact: true }).waitFor();
  assert.deepEqual((await calls('chooseComposerFiles')).at(-1).options, { imageSlots: 9, imagesSupported: true });
  assert.equal((await calls('turn/start')).length, 0, 'Selecting PDF, ZIP, text and image only edits the composer');
  assert.equal(await view().locator('.attachments img').count(), 2, 'Only images become image attachments');
  await page.screenshot({ path: 'artifacts/composer-files-mixed.png' });

  // Native dialogs resolve asynchronously: use the latest draft and do not open twice.
  await selection(null, 'session-a', 'deferred');
  const countBefore = (await calls('chooseComposerFiles')).length;
  await picker().evaluate(node => { node.click(); node.click(); }); await pending();
  assert.equal(await picker().isDisabled(), true);
  assert.equal((await calls('chooseComposerFiles')).length, countBefore + 1, 'Repeated clicks cannot open a second dialog');
  await composer().fill('Дополнение во время выбора');
  assert.equal(await send().isDisabled(), true);
  await composer().press('Enter');
  assert.equal((await calls('turn/start')).length, 0, 'Enter cannot send an incomplete draft while file selection is pending');
  const laterPath = 'C:\\Материалы\\дополнение.md';
  await finish(picked([laterPath]));
  const latestDraft = `Дополнение во время выбора\n${laterPath}\n`;
  await value(latestDraft);
  assert.equal(await view().locator('.attachments img').count(), 2, 'Existing previews survive later selections');
  await send().click();
  await view().getByRole('button', { name: 'Остановить выполнение', exact: true }).waitFor();
  const sent = await calls('turn/start');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.threadId, 'session-a-thread-1');
  assert.equal(sent[0].params.model, 'vision');
  assert.equal(sent[0].params.effort, 'high');
  assert.deepEqual(sent[0].params.input, [{ type: 'text', text: latestDraft.trim(), text_elements: [] }, { type: 'localImage', path: 'C:/Fixtures/FILES_A/saved-0.png' }, { type: 'localImage', path: 'C:/Fixtures/FILES_A/saved-1.png' }], 'Only explicit send transmits the visible text and image paths');

  // Picking remains available while the current task runs and feeds the ordinary queue.
  assert.equal(await picker().isDisabled(), false);
  const busyPath = 'C:\\Материалы\\после завершения.pdf';
  await selection(picked([busyPath])); await picker().click(); await value(`${busyPath}\n`);
  assert.equal((await calls('turn/start')).length, 1);
  await view().getByRole('button', { name: 'Отправить после завершения', exact: true }).click();
  await value('');
  await view().locator('.message-queue').getByText(busyPath, { exact: true }).waitFor();
  assert.equal((await calls('turn/start')).length, 1, 'Enqueue while busy does not start another turn');

  // Leaving a tab cancels delivery of a late selection to that tab and the newly active tab.
  await composer().fill('Оставить в A');
  await selection(null, 'session-a', 'deferred'); await picker().click(); await pending();
  await tab('session-b'); await value('Черновик B'); await composer().fill('Оставить в B');
  await finish(picked(['C:\\wrong-tab.pdf'], [image('wrong-tab.png')])); await settle();
  await value('Оставить в B');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true, 'Late selection does not steal focus from another tab');
  await tab('session-a'); await value('Оставить в A');
  assert.equal(await view().locator('.attachments img').count(), 0);
  assert.equal(await picker().isDisabled(), false, 'A cancelled stale dialog does not leave the original tab locked');

  // Models without image inputs still support ordinary files and selected images as paths.
  await tab('session-b');
  const textImagePath = 'C:\\Материалы\\чертёж.png';
  await selection(picked([textImagePath]), 'session-b'); await picker().click();
  await value(`Оставить в B\n${textImagePath}\n`);
  assert.deepEqual((await calls('chooseComposerFiles')).at(-1).options, { imageSlots: 10, imagesSupported: false });
  assert.equal(await view().locator('.attachments img').count(), 0);
  await composer().fill('Вставка из буфера');
  await view().getByRole('combobox', { name: 'Модель', exact: true }).click();
  await page.getByRole('listbox', { name: 'Модель', exact: true }).locator('[data-value="vision"]').click();
  await composer().evaluate((node, dataUrl) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    data.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await view().getByRole('button', { name: 'Удалить clipboard.png', exact: true }).waitFor();
  await value('Вставка из буфера');
  assert.equal((await calls('turn/start')).length, 1, 'Ctrl+V preserves text and adds an image without sending');

  // Single-session fixture can switch the thread/cwd while a native answer is pending.
  await page.goto(`${url}?single`);
  const singleComposer = () => page.getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const singlePicker = () => page.getByRole('button', { name: 'Добавить файлы', exact: true });
  await page.locator('.history-item').filter({ hasText: 'История 1' }).click();
  await page.getByText('Ответ 1', { exact: true }).waitFor();
  await singleComposer().fill('Старый диалог');
  await selection(null, 'session-a', 'deferred'); await singlePicker().click(); await pending();
  await page.locator('.history-item').filter({ hasText: 'История 2' }).click();
  await page.getByText('Ответ 2', { exact: true }).waitFor();
  await singleComposer().fill('Другой диалог');
  await finish(picked(['C:\\wrong-thread.pdf'], [image('wrong-thread.png')])); await settle();
  assert.equal(await singleComposer().inputValue(), 'Другой диалог');
  assert.equal(await page.locator('.attachments img').count(), 0);
  await selection(null, 'session-a', 'deferred'); await singlePicker().click(); await pending();
  await page.getByRole('button', { name: 'Добавить рабочую папку', exact: true }).click();
  await page.waitForFunction(() => window.__files.sessions['session-a'].cwd === 'C:/Fixtures/FILES_B');
  await page.locator('.connection-pill').filter({ hasText: 'Готов к работе' }).waitFor();
  await singleComposer().fill('Другая папка');
  await finish(picked(['C:\\wrong-cwd.pdf'])); await settle();
  assert.equal(await singleComposer().inputValue(), 'Другая папка');
  assert.equal(await singlePicker().isDisabled(), false);
  assert.equal((await calls('turn/start')).length, 0, 'Changing thread or cwd never sends or installs a late selection');
  assert.deepEqual(errors, []);
  console.log('PASS: native file picker cancel/error/mixed files, literal visible PDF/ZIP/text paths, image previews, exact explicit send, current draft preserved across async selection, duplicate-dialog guard, busy queue, stale tab/thread/cwd isolation, no-image models, and Ctrl+V. Production renderer with fixture bridge only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/composer-files-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
