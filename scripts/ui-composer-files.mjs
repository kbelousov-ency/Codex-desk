import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer, deterministic native-dialog/clipboard bridge. No actual model calls.
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
    const jpegCanvas = document.createElement('canvas');
    jpegCanvas.width = jpegCanvas.height = 1;
    const jpeg = jpegCanvas.toDataURL('image/jpeg');
    const projects = ['C:/Fixtures/FILES_A', 'C:/Fixtures/FILES_B'];
    const models = ['vision', 'text-only'].map(model => ({ id: model, model, displayName: model, inputModalities: model === 'vision' ? ['text', 'image'] : ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }));
    const sessions = {}, calls = [];
    const fixture = window.__files = { sessions, calls, image, jpeg, filePaths: {} };
    for (const [index, id] of ['session-a', 'session-b'].entries()) {
      const state = sessions[id] = { cwd: projects[index], model: index ? 'text-only' : 'vision', listeners: new Set(), selection: null, mode: 'result', finish: null, clipboard: null, clipboardMode: 'result', finishClipboard: null };
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
        getPathForFile(file) { return fixture.filePaths[file.name] || ''; },
        async readClipboardFiles(options) {
          calls.push({ id, method: 'readClipboardFiles', options: structuredClone(options) });
          if (state.clipboardMode === 'error') throw new Error('Не удалось прочитать файлы из буфера обмена');
          if (state.clipboardMode === 'deferred') return await new Promise(resolve => { state.finishClipboard = result => { state.finishClipboard = null; resolve(result); }; });
          return structuredClone(state.clipboard);
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
  const transfer = (kind, files = [], { target = composer(), text } = {}) => target.evaluate((node, { kind, files, text }) => {
    const data = new DataTransfer();
    for (const { name, type, path, bytes, image } of files) {
      if (path) window.__files.filePaths[name] = path;
      const content = image
        ? Uint8Array.from(atob((image === 'jpeg' ? window.__files.jpeg : window.__files.image).split(',')[1]), character => character.charCodeAt(0))
        : new Uint8Array(bytes || 0);
      data.items.add(new File([content], name, { type }));
    }
    if (text !== undefined) data.setData('text/plain', text);
    const event = kind === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      : new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, { kind, files, text });
  const clipboard = (result, id = 'session-b', mode = 'result') => page.evaluate(({ result, id, mode }) => { const state = window.__files.sessions[id]; state.clipboard = result; state.clipboardMode = mode; }, { result, id, mode });
  const clearAttachments = async () => { while (await view().locator('.attachments button').count()) await view().locator('.attachments button').first().click(); };
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

  // Explorer can omit the MIME type or use the nonstandard image/jpg alias.
  await clearAttachments();
  await transfer('paste', [{ name: 'uppercase-no-mime.PNG', type: '', image: true }]);
  await view().getByRole('button', { name: 'Удалить uppercase-no-mime.PNG', exact: true }).waitFor();
  assert.match(await view().locator('.attachments img[alt="uppercase-no-mime.PNG"]').getAttribute('src'), /^data:image\/png;base64,/, 'A PNG with an empty File.type gets a supported image data URL');
  await transfer('drop', [{ name: 'alias-mime.jpg', type: 'image/jpg', image: 'jpeg' }], { target: view().locator('.chat-scroll') });
  await view().getByRole('button', { name: 'Удалить alias-mime.jpg', exact: true }).waitFor();
  assert.match(await view().locator('.attachments img[alt="alias-mime.jpg"]').getAttribute('src'), /^data:image\/jpeg;base64,/, 'The image/jpg alias is normalized before attaching the image');
  await value('Вставка из буфера');
  assert.equal((await calls('turn/start')).length, 1);

  // Drop works throughout the active chat, including the conversation outside the composer.
  await clearAttachments(); await composer().fill('Перетащенные файлы');
  const dropPaths = ['C:\\Материалы\\отчёт [2].pdf', 'C:\\Материалы\\исходник `$().ts', 'C:\\Материалы\\диаграмма.svg'];
  const droppedFiles = [
    { name: 'отчёт [2].pdf', type: 'application/pdf', path: dropPaths[0] },
    { name: 'исходник `$().ts', type: 'text/plain', path: dropPaths[1] },
    { name: 'диаграмма.svg', type: 'image/svg+xml', path: dropPaths[2] },
    { name: 'dropped.png', type: 'image/png', image: true, path: 'C:\\Материалы\\dropped.png' },
  ];
  await page.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'file-transfer-modal-fixture'; container.hidden = true;
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.textContent = 'Fixture modal';
    container.append(modal); document.body.append(container);
  });
  assert.equal(await transfer('dragover', droppedFiles, { target: view().locator('.chat-scroll') }), true, 'File dragover is accepted outside the composer');
  assert.equal(await transfer('drop', droppedFiles, { target: view().locator('.chat-scroll') }), true, 'File drop prevents browser navigation');
  let transferredDraft = `Перетащенные файлы\n${dropPaths.join('\n')}\n`;
  await value(transferredDraft);
  await view().getByRole('button', { name: 'Удалить dropped.png', exact: true }).waitFor();
  assert.equal(await view().locator('.attachments img').count(), 1, 'Only supported images are attached; unsupported image formats become paths');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true, 'Dropping into the conversation focuses the editable draft');
  await page.evaluate(() => { document.getElementById('file-transfer-modal-fixture').hidden = false; });
  assert.equal(await transfer('drop', [{ name: 'blocked-by-modal.pdf', type: 'application/pdf', path: 'C:\\must-not-drop-through-modal.pdf' }], { target: view().locator('.chat-scroll') }), true, 'Visible modal still prevents browser file navigation');
  await settle(); await value(transferredDraft);
  assert.equal(await view().locator('.attachments img').count(), 1, 'Visible modal blocks composer changes; hidden modal did not block the preceding mixed drop');
  await page.evaluate(() => document.getElementById('file-transfer-modal-fixture').remove());
  const nativeCallsBefore = (await calls('readClipboardFiles')).length;

  // Explorer-style FileList paste preserves multiple paths and existing image previews.
  const pastedPaths = ['C:\\Материалы\\договор.docx', 'C:\\Материалы\\архив.zip'];
  assert.equal(await transfer('paste', pastedPaths.map((path, index) => ({ name: `document-${index}`, type: 'application/octet-stream', path }))), true);
  transferredDraft += `${pastedPaths.join('\n')}\n`;
  await value(transferredDraft);
  assert.equal(await view().locator('.attachments img').count(), 1);
  const mixedPastePath = 'C:\\Материалы\\описание.md';
  await transfer('paste', [
    { name: 'описание.md', type: 'text/markdown', path: mixedPastePath },
    { name: 'mixed-paste.png', type: 'image/png', image: true },
  ]);
  transferredDraft += `${mixedPastePath}\n`;
  await value(transferredDraft);
  await view().getByRole('button', { name: 'Удалить mixed-paste.png', exact: true }).waitFor();
  assert.equal(await view().locator('.attachments img').count(), 2);
  assert.equal((await calls('readClipboardFiles')).length, nativeCallsBefore, 'FileList paste needs no second native clipboard read');

  // Ordinary text remains browser-owned even if native clipboard files are present.
  await clipboard(picked(['C:\\should-not-paste.pdf']));
  assert.equal(await transfer('paste', [], { text: 'Обычный текст' }), false, 'Text paste is not intercepted');
  assert.equal(await transfer('drop', [], { text: 'Переносимый текст', target: view().locator('.chat-scroll') }), false, 'Text drop is not intercepted');
  await settle(); await value(transferredDraft);
  assert.equal((await calls('readClipboardFiles')).length, nativeCallsBefore, 'Text paste does not read native clipboard files');
  assert.equal((await calls('turn/start')).length, 1, 'File drops and document/mixed pastes never send automatically');

  // An empty renderer FileList can still represent Windows clipboard file paths.
  await clipboard(null, 'session-b', 'deferred');
  assert.equal(await transfer('paste'), true);
  await page.waitForFunction(() => Boolean(window.__files.sessions['session-b'].finishClipboard));
  assert.deepEqual((await calls('readClipboardFiles')).at(-1).options, { imageSlots: 8, imagesSupported: true });
  await composer().fill('Набрано во время чтения буфера');
  assert.equal(await send().isDisabled(), true, 'Native clipboard reading blocks sending the incomplete batch');
  const nativePath = 'C:\\Материалы\\из буфера.xlsx';
  await page.evaluate(result => window.__files.sessions['session-b'].finishClipboard(result), picked([nativePath], [image('native-clipboard.png')]));
  transferredDraft = `Набрано во время чтения буфера\n${nativePath}\n`;
  await value(transferredDraft);
  await view().getByRole('button', { name: 'Удалить native-clipboard.png', exact: true }).waitFor();
  assert.equal(await view().locator('.attachments img').count(), 3);
  await clipboard(null);
  await transfer('paste'); await settle(); await value(transferredDraft);
  assert.equal(await send().isDisabled(), false, 'Empty native clipboard leaves the composer unlocked');

  // Validation rejects the entire mixed batch, including otherwise valid path additions.
  const rejectBatch = async files => {
    const previousImages = await view().locator('.attachments img').count();
    await transfer('paste', files);
    await view().getByRole('alert').waitFor();
    await value(transferredDraft);
    assert.equal(await view().locator('.attachments img').count(), previousImages, 'Rejected batch preserves all existing image previews');
    await view().getByRole('button', { name: 'Скрыть ошибку', exact: true }).click();
  };
  await rejectBatch(Array.from({ length: 21 }, (_, index) => ({ name: `too-many-${index}.txt`, type: 'text/plain', path: `C:\\Материалы\\too-many-${index}.txt` })));
  await rejectBatch([
    { name: 'partial-path.txt', type: 'text/plain', path: 'C:\\must-not-be-added.txt' },
    { name: 'oversized.png', type: 'image/png', bytes: 20 * 1024 * 1024 + 1 },
  ]);
  await rejectBatch([
    { name: 'valid-before-missing.pdf', type: 'application/pdf', path: 'C:\\must-not-be-partially-added.pdf' },
    { name: 'image-before-missing.png', type: 'image/png', image: true },
    { name: 'missing-native-path.bin', type: 'application/octet-stream' },
  ]);
  await selection(picked([], Array.from({ length: 7 }, (_, index) => image(`slot-${index}.png`))), 'session-b'); await picker().click();
  await page.waitForFunction(() => document.querySelectorAll('.session-view:not([hidden]) .attachments img').length === 10);
  await rejectBatch([
    { name: 'partial-slot-path.txt', type: 'text/plain', path: 'C:\\must-not-be-added-either.txt' },
    { name: 'eleventh.png', type: 'image/png', image: true },
  ]);
  await clearAttachments();

  // A text-only model receives even a supported dropped image as a visible path.
  await view().getByRole('combobox', { name: 'Модель', exact: true }).click();
  await page.getByRole('listbox', { name: 'Модель', exact: true }).locator('[data-value="text-only"]').click();
  await composer().fill('Картинка как путь');
  const textOnlyDropPath = 'C:\\Материалы\\text-model.png';
  await transfer('drop', [{ name: 'text-model.png', type: 'image/png', image: true, path: textOnlyDropPath }], { target: view().locator('.chat-scroll') });
  await value(`Картинка как путь\n${textOnlyDropPath}\n`);
  assert.equal(await view().locator('.attachments img').count(), 0);
  const modelNotice = view().getByRole('button', { name: 'Скрыть ошибку', exact: true });
  if (await modelNotice.count()) await modelNotice.click();

  // A late native clipboard result belongs to neither the hidden tab nor the newly active one.
  await composer().fill('Буфер остаётся в B');
  await clipboard(null, 'session-b', 'deferred'); await transfer('paste');
  await page.waitForFunction(() => Boolean(window.__files.sessions['session-b'].finishClipboard));
  await tab('session-a'); await value('Оставить в A'); await composer().fill('Активный черновик A');
  await page.evaluate(result => window.__files.sessions['session-b'].finishClipboard(result), picked(['C:\\wrong-clipboard-tab.pdf']));
  await settle(); await value('Активный черновик A');
  assert.equal(await composer().evaluate(node => node === document.activeElement), true, 'Stale clipboard delivery does not move focus');
  await tab('session-b'); await value('Буфер остаётся в B');
  assert.equal(await picker().isDisabled(), false, 'Stale clipboard delivery releases its pending operation');
  assert.equal((await calls('turn/start')).length, 1);
  await page.screenshot({ path: 'artifacts/composer-files-transfer.png' });

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
  console.log('PASS: native file picker cancel/error/mixed files, literal visible PDF/ZIP/text paths, image previews, exact explicit send, current draft preserved across async selection, duplicate-dialog guard, busy queue, stale tab/thread/cwd isolation, no-image models, whole-chat file drop, document/mixed/image paste, normalized image MIME, visible/hidden modal isolation, untouched text transfer, native clipboard fallback, atomic batch limits, and stale clipboard tab isolation. Production renderer with fixture bridge only.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/composer-files-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
