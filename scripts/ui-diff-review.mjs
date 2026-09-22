import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with deterministic App Server history and scoped bridges.
// No native file opens, Git operations, or real model requests.
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fixture = window.__diffReview = { sessions: {}, requests: [], opens: [], menus: [], failOpen: false, activationListeners: new Set() };
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] });
    const patch = (id, changes) => ({ id, type: 'fileChange', status: 'completed', changes });
    for (const id of ['a', 'b']) {
      const cwd = `C:/Fixtures/REVIEW_${id.toUpperCase()}`;
      const state = fixture.sessions[id] = { cwd, listeners: new Set() };
      const thread = state.thread = {
        id: `thread-${id}`, name: `Проверка правок ${id}`, cwd, historyMode: 'legacy', status: { type: 'idle' },
        turns: id === 'a' ? [
          // Some old histories have readable items without a recorded turn id.
          { status: 'completed', items: [patch('legacy-edit', [{ path: 'src/unknown.txt', kind: { type: 'update' }, diff: '-legacy old\n+legacy new' }])] },
          { id: 'turn-one', status: 'completed', items: [
            user('user-one', 'Обнови обработку файлов'),
            patch('first-alpha', [{ path: `${cwd}/src/alpha.ts`, kind: { type: 'update' }, diff: '@@ -10,2 +10,2 @@ handler\n keep first\n-first version\n+second version\n@@ -50 +52 @@ footer\n-old footer\n+new footer ' + 'long_line_without_spaces_'.repeat(80) }]),
            patch('other-files', [
              { path: 'src/added.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1,2 @@\n+export const added = true;\n+export const count = 2;' },
              { path: 'src/deleted.ts', kind: { type: 'delete' }, diff: '@@ -1,2 +0,0 @@\n-export const removed = true;\n-export const oldCount = 2;' },
              { path: 'docs/до.txt', kind: { type: 'update', move_path: `${cwd}/docs/после.txt` }, diff: '@@ -3 +3 @@\n-old name\n+new name' },
              { path: 'assets/logo.png', kind: { type: 'update' }, diff: 'Binary files a/assets/logo.png and b/assets/logo.png differ' },
              { path: 'src/raw.txt', kind: { type: 'update' }, diff: '-raw old\n+raw new' },
            ]),
            { id: 'answer-one', type: 'agentMessage', phase: 'final_answer', text: 'Первый набор правок готов.' },
          ] },
          { id: 'turn-two', status: 'completed', items: [
            user('user-two', 'Уточни сообщение'),
            patch('second-alpha', [{ path: `${cwd}/src/alpha.ts`.replaceAll('/', '\\'), kind: { type: 'update' }, diff: '@@ -11 +11 @@\n-second version\n+final version' }]),
            { id: 'answer-two', type: 'agentMessage', phase: 'final_answer', text: 'Второй набор правок готов.' },
          ] },
          ...Array.from({ length: 24 }, (_, index) => ({
            id: `history-${index + 1}`, status: 'completed', items: [user(`history-user-${index + 1}`, index === 23
              ? `Пересмотри отображение длинного запроса, сохрани удобный поиск по всей переписке и перенос содержимого в узкой панели. ${'длинное_имя_без_пробелов_'.repeat(12)} маяк_дальнего_поиска`
              : `Обсудим улучшение интерфейса ${index + 1}`)],
          })),
        ] : [{ id: 'turn-other', status: 'completed', items: [user('other-user', 'Правка другого проекта'), patch('other-edit', [{ path: 'src/alpha.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-project b old\n+project b new' }])] }],
      };
      state.emit = (method, params = {}) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params: { threadId: thread.id, ...params } } }); };
      state.bridge = {
        async getSettings() { return { cwd, model: 'fixture', effort: 'high', access: 'workspace-write' }; }, async setSettings() {},
        async start() { return { cwd, models: [model], executable: 'fixture', account: {}, config: { model: 'fixture', model_reasoning_effort: 'high' } }; },
        async request(method, params = {}) {
          fixture.requests.push({ sessionId: id, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/resume' || method === 'thread/read') return { thread: structuredClone(thread), model: 'fixture', reasoningEffort: 'high' };
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; },
        async openPath(path) {
          fixture.opens.push({ sessionId: id, path });
          if (fixture.failOpen) { fixture.failOpen = false; throw new Error('Тестовая ошибка открытия файла'); }
        },
        async showPathMenu(path) { fixture.menus.push({ sessionId: id, path }); },
        async readAttachment() { return null; },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    }
    window.codex = {
      ...fixture.sessions.a.bridge,
      async getWorkspace() { return { projects: Object.values(fixture.sessions).map(state => state.cwd), sessions: [], restore: { kind: 'workspace', activeIndex: 0, tabs: Object.entries(fixture.sessions).map(([id, state]) => ({ id, cwd: state.cwd, thread: state.thread })) } }; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async getBuildInfo() { return { channel: 'nightly', version: '0.1.0' }; },
      async listProjectThreads(cwd) { return { data: Object.values(fixture.sessions).filter(state => state.cwd === cwd).map(state => state.thread), nextCursor: null }; },
      async saveWorkspaceState() {}, async completeUpdateRestore() {},
      onNotificationActivated(listener) { fixture.activationListeners.add(listener); return () => fixture.activationListeners.delete(listener); },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const panel = () => view().locator('.changes-panel');
  const groups = () => panel().locator('details.change-file');
  const group = path => groups().filter({ has: page.locator('.change-path').filter({ hasText: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  const filter = () => panel().getByRole('button', { name: 'Изменения по запросу', exact: true });
  const picker = () => page.getByRole('dialog', { name: 'Выбор запроса', exact: true });
  const turnSearch = () => picker().getByRole('combobox', { name: 'Найти запрос', exact: true });
  const turnList = () => picker().getByRole('listbox', { name: 'Запросы', exact: true });
  const turnOption = value => turnList().locator(`[role="option"][data-value="${value}"]`);
  const chooseTurn = async value => {
    await filter().click();
    await picker().waitFor();
    await turnOption(value).click();
    await picker().waitFor({ state: 'hidden' });
    assert.equal(await filter().getAttribute('data-value'), value);
  };
  const search = () => panel().getByRole('textbox', { name: 'Найти изменённый файл', exact: true });
  const modal = () => page.getByRole('dialog', { name: 'Просмотр изменений', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ready = () => page.waitForFunction(() => {
    const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]');
    return model && !model.disabled;
  });
  const showChanges = async () => {
    if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    await view().locator('.panel-tabs button').filter({ hasText: 'Изменения' }).click();
    await filter().waitFor();
  };
  const expand = async path => {
    if (await group(path).getAttribute('open') === null) await group(path).locator('summary').first().click();
  };
  const openReview = async path => {
    await expand(path);
    await group(path).getByRole('button', { name: `Развернуть сравнение ${path}`, exact: true }).click();
    await modal().waitFor();
  };
  const closeReview = async () => {
    await modal().getByRole('button', { name: 'Закрыть просмотр изменений', exact: true }).click();
    await modal().waitFor({ state: 'hidden' });
  };
  await ready();
  await view().getByText('Второй набор правок готов.', { exact: true }).waitFor();
  await showChanges();
  assert.equal(await filter().getAttribute('data-value'), 'all');
  assert.equal(await groups().count(), 7, 'Repeated edits share a canonical file group without losing legacy files');
  assert.equal(await view().locator('.panel-tabs .count-badge').innerText(), '7');
  await filter().click();
  const options = await turnList().getByRole('option').evaluateAll(nodes => nodes.map(node => ({ value: node.dataset.value, label: node.textContent })));
  assert.match(options.find(option => option.value === 'turn-one')?.label || '', /Обнови обработку файлов/);
  assert.match(options.find(option => option.value === 'turn-two')?.label || '', /Уточни сообщение/);
  const unknownOption = options.find(option => option.value === 'unknown');
  assert.ok(unknownOption, 'Changes lacking a turn id remain selectable as an explicit unknown group');
  assert.ok(options.findIndex(option => option.value === 'history-24') < options.findIndex(option => option.value === 'turn-two'), 'Recent requests appear before older requests');
  assert.match(options.find(option => option.value === 'turn-one')?.label || '', /(?:Запрос\s*|№\s*)1\b/, 'Request numbers retain their conversation order');
  assert.equal(await turnSearch().evaluate(node => node === document.activeElement), true, 'Opening the picker focuses its search field');

  await turnSearch().fill('МАЯК_ДАЛЬНЕГО_ПОИСКА');
  assert.equal(await turnOption('history-24').count(), 1, 'Turn search uses the full message, including text beyond the former 90-character cutoff');
  assert.equal(await turnOption('turn-one').count(), 0, 'Turn search is case insensitive and excludes unrelated requests');
  await turnSearch().fill('запроса_с_таким_текстом_нет');
  assert.equal(await turnList().locator('[role="option"]').evaluateAll(nodes => nodes.filter(node => !['all', 'unknown'].includes(node.dataset.value)).length), 0);
  assert.match(await picker().innerText(), /не найден|ничего не найден/i, 'Empty turn search explains the missing results');
  assert.equal(await filter().getAttribute('data-value'), 'all', 'Searching does not silently change the active filter');
  await turnSearch().press('Escape');
  await picker().waitFor({ state: 'hidden' });
  assert.equal(await filter().evaluate(node => node === document.activeElement), true, 'Escape returns focus to the trigger');

  await filter().press('Enter');
  await picker().waitFor();
  assert.equal(await turnSearch().inputValue(), '', 'A reopened picker starts with the full request list');
  for (let index = 0; index < 24; index++) await turnSearch().press('ArrowDown');
  const keyboardSelection = await turnSearch().evaluate(node => {
    const option = document.getElementById(node.getAttribute('aria-activedescendant'));
    const list = option?.closest('[role="listbox"]');
    if (!option || !list) return null;
    const item = option.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    return { value: option.dataset.value, top: item.top, bottom: item.bottom, listTop: bounds.top, listBottom: bounds.bottom };
  });
  assert.ok(keyboardSelection && keyboardSelection.value !== 'all', 'Arrow navigation exposes the active option to assistive technology');
  assert.ok(keyboardSelection.top >= keyboardSelection.listTop - 1 && keyboardSelection.bottom <= keyboardSelection.listBottom + 1, 'Keyboard navigation scrolls a long request list to keep the active option visible');
  await turnSearch().press('Enter');
  await picker().waitFor({ state: 'hidden' });
  assert.equal(await filter().getAttribute('data-value'), keyboardSelection.value, 'Enter applies the highlighted request');
  await chooseTurn('all');

  await filter().click();
  const composer = view().locator('.composer textarea');
  await composer.click();
  await picker().waitFor({ state: 'hidden' });
  assert.equal(await composer.evaluate(node => node === document.activeElement), true, 'Clicking outside closes the picker without stealing focus');

  await expand('src/alpha.ts');
  assert.equal(await group('src/alpha.ts').locator('.change-patch').count(), 2);
  assert.match(await group('src/alpha.ts').innerText(), /second version/);
  assert.match(await group('src/alpha.ts').innerText(), /final version/);
  await chooseTurn('turn-two');
  assert.equal(await groups().count(), 1);
  await expand('src/alpha.ts');
  assert.equal(await group('src/alpha.ts').locator('.change-patch').count(), 1, 'Turn filter selects patches as well as file cards');
  assert.match(await group('src/alpha.ts').innerText(), /final version/);
  assert.doesNotMatch(await group('src/alpha.ts').innerText(), /first version|old footer/);
  await chooseTurn(unknownOption.value);
  assert.deepEqual(await groups().locator('.change-path').allTextContents(), ['src/unknown.txt']);
  await chooseTurn('turn-one');
  assert.equal(await groups().count(), 6);
  await search().fill('ALPHA');
  assert.deepEqual(await groups().locator('.change-path').allTextContents(), ['src/alpha.ts'], 'File search is case insensitive');
  await search().fill('definitely-missing-file');
  assert.equal(await groups().count(), 0);
  assert.match(await panel().innerText(), /не найден|нет файлов|ничего не найден/i, 'An empty search explains the missing results');
  await search().fill('');
  await expand('src/added.ts');
  await expand('src/deleted.ts');
  await expand('docs/до.txt');
  assert.match(await group('src/added.ts').locator('.change-status').first().innerText(), /Добавлен/);
  assert.match(await group('src/deleted.ts').locator('.change-status').first().innerText(), /Удалён/);
  assert.match(await group('docs/до.txt').innerText(), /Переименован/);
  assert.match(await group('docs/до.txt').innerText(), /docs\/после\.txt/);
  const addedRows = group('src/added.ts').locator('.diff-unified-row');
  assert.deepEqual(await addedRows.first().locator('.diff-line-number').allTextContents(), ['', '1'], 'Added files have only new line numbers');
  assert.deepEqual(await addedRows.last().locator('.diff-line-number').allTextContents(), ['', '2']);
  const deletedRows = group('src/deleted.ts').locator('.diff-unified-row');
  assert.deepEqual(await deletedRows.first().locator('.diff-line-number').allTextContents(), ['1', ''], 'Deleted files have only old line numbers');
  assert.deepEqual(await deletedRows.last().locator('.diff-line-number').allTextContents(), ['2', '']);
  await group('docs/до.txt').getByRole('button', { name: 'Открыть файл', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__diffReview.opens.at(-1)), { sessionId: 'a', path: 'C:/Fixtures/REVIEW_A/docs/после.txt' }, 'Renamed files open their received destination in their own session');

  await openReview('src/alpha.ts');
  assert.equal(await modal().getByRole('button', { name: 'До / после', exact: true }).getAttribute('aria-pressed'), 'true', 'Expanded review starts in side-by-side mode');
  assert.match(await modal().innerText(), /first version/);
  assert.match(await modal().innerText(), /second version/);
  assert.doesNotMatch(await modal().innerText(), /final version/, 'Expanded review obeys the turn filter');
  const changedRow = modal().locator('.diff-split-row').filter({ has: page.locator('.review-code-text', { hasText: 'first version' }) });
  assert.deepEqual(await changedRow.locator('.diff-line-number').allTextContents(), ['11', '11'], 'Split comparison aligns replacement lines from hunk metadata');
  const footerRow = modal().locator('.diff-split-row').filter({ has: page.locator('.review-code-text', { hasText: 'old footer' }) });
  assert.deepEqual(await footerRow.locator('.diff-line-number').allTextContents(), ['50', '52'], 'Later hunk keeps distinct old and new starts');
  assert.equal(await modal().locator('[data-diff-hunk]').count(), 2);
  const focusedHunk = () => page.evaluate(() => document.activeElement?.getAttribute('data-diff-hunk'));
  await modal().getByRole('button', { name: 'Следующий фрагмент', exact: true }).click();
  assert.equal(await focusedHunk(), '0');
  await modal().getByRole('button', { name: 'Следующий фрагмент', exact: true }).click();
  assert.equal(await focusedHunk(), '1');
  assert.match(await modal().locator('.diff-fragment-nav').innerText(), /2 \/ 2/);
  await modal().getByRole('button', { name: 'Предыдущий фрагмент', exact: true }).click();
  assert.equal(await focusedHunk(), '0');
  await modal().getByRole('button', { name: 'Предыдущий фрагмент', exact: true }).click();
  assert.equal(await focusedHunk(), '1', 'Previous fragment wraps to the final hunk');
  await page.screenshot({ path: 'artifacts/diff-review-split-1440.png' });
  await modal().getByRole('button', { name: 'Единый diff', exact: true }).click();
  assert.equal(await modal().getByRole('button', { name: 'Единый diff', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.match(await modal().innerText(), /first version/);
  const removed = modal().locator('.diff-unified-row').filter({ has: page.locator('.review-code-text', { hasText: 'first version' }) });
  const added = modal().locator('.diff-unified-row').filter({ has: page.locator('.review-code-text', { hasText: 'second version' }) });
  assert.deepEqual(await removed.locator('.diff-line-number').allTextContents(), ['11', '']);
  assert.deepEqual(await added.locator('.diff-line-number').allTextContents(), ['', '11']);
  await modal().getByRole('button', { name: 'До / после', exact: true }).click();
  await page.evaluate(() => { window.__diffReview.failOpen = true; });
  await modal().getByRole('button', { name: 'Открыть файл', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Тестовая ошибка открытия файла' }).waitFor();
  assert.equal(await modal().isVisible(), true, 'A file-open failure preserves the review');
  assert.match(await modal().innerText(), /first version/);
  await modal().getByRole('button', { name: 'Открыть файл', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Тестовая ошибка открытия файла' }).waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.__diffReview.opens.slice(-2)), [
    { sessionId: 'a', path: 'C:/Fixtures/REVIEW_A/src/alpha.ts' },
    { sessionId: 'a', path: 'C:/Fixtures/REVIEW_A/src/alpha.ts' },
  ]);
  await closeReview();

  // Pin an immutable comparison beside the live conversation and quote its source rows.
  await openReview('src/alpha.ts');
  await modal().getByRole('button', { name: 'Закрепить сравнение рядом с чатом', exact: true }).click();
  const dock = () => view().getByRole('region', { name: 'Просмотр изменений', exact: true });
  await dock().waitFor();
  assert.equal(await modal().count(), 0);
  assert.equal(await dock().getAttribute('aria-modal'), null);
  await composer.fill('Обсуждение сравнения');
  await composer.press('Tab');
  assert.equal(await dock().evaluate(node => node.contains(document.activeElement)), false, 'Pinned comparison does not trap composer focus');
  await composer.focus(); await composer.press('Escape');
  assert.equal(await dock().isVisible(), true, 'Escape in the composer leaves the pinned comparison open');
  await dock().getByRole('button', { name: 'Единый diff', exact: true }).click();
  await dock().locator('.review-code-text').filter({ hasText: /^second version$/ }).evaluate(code => {
    const range = document.createRange(); range.selectNodeContents(code);
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await dock().getByRole('button', { name: 'Спросить о выделении', exact: true }).click();
  assert.equal(await dock().isVisible(), true, 'Quoting leaves a pinned comparison open');
  assert.match(await composer.inputValue(), /^Обсуждение сравнения/);
  assert.match(await composer.inputValue(), /Сравнение: C:\/Fixtures\/REVIEW_A\/src\/alpha.ts/);
  assert.match(await composer.inputValue(), /```diff\n\+second version\n```/, 'Quote contains source text and diff sign without presentation line numbers');
  await page.evaluate(() => window.__diffReview.sessions.a.emit('item/completed', { turnId: 'turn-one', item: {
    id: 'first-alpha', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/Fixtures/REVIEW_A/src/alpha.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old stream\n+new stream update' }],
  } }));
  await settle();
  assert.match(await dock().innerText(), /first version/);
  assert.doesNotMatch(await dock().innerText(), /new stream update/, 'Pinned comparison remains a snapshot while new file events arrive');
  await page.evaluate(() => {
    const state = window.__diffReview.sessions.a;
    const original = state.thread.turns.find(turn => turn.id === 'turn-one').items.find(item => item.id === 'first-alpha');
    state.emit('item/completed', { turnId: 'turn-one', item: structuredClone(original) });
  });
  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
    const overlap = await view().evaluate(node => {
      const comparison = node.querySelector('.result-dock').getBoundingClientRect();
      const input = node.querySelector('.composer textarea').getBoundingClientRect();
      return Math.min(comparison.right, input.right) - Math.max(comparison.x, input.x) > 1 && Math.min(comparison.bottom, input.bottom) - Math.max(comparison.y, input.y) > 1;
    });
    assert.equal(overlap, false, `Pinned comparison leaves the composer unobscured at ${width}px`);
    await page.screenshot({ path: `artifacts/diff-review-docked-${width}.png` });
  }
  await dock().getByRole('button', { name: 'Развернуть просмотр изменений', exact: true }).click();
  await modal().waitFor();
  assert.equal(await modal().getByRole('button', { name: 'Единый diff', exact: true }).getAttribute('aria-pressed'), 'true');
  await closeReview();
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();

  // Unknown ranges remain raw: the UI must never pretend they have line 1.
  for (const path of ['src/raw.txt', 'assets/logo.png']) {
    await openReview(path);
    assert.match(await modal().innerText(), path === 'src/raw.txt' ? /raw old/ : /Binary files/);
    assert.match(await modal().locator('.diff-number-note').innerText(), /Номера строк.*не предоставлены|не могут быть определены/);
    assert.ok((await modal().locator('.diff-line-number').allTextContents()).every(value => value === ''), 'Raw and binary patches never invent line numbers');
    assert.equal(await modal().getByRole('button', { name: 'Следующий фрагмент', exact: true }).isDisabled(), true, 'Missing hunks disable fragment navigation');
    await closeReview();
  }

  // Native notification activation can switch sessions while a modal is open.
  await openReview('src/alpha.ts');
  await page.evaluate(() => { for (const listener of window.__diffReview.activationListeners) listener({ sessionId: 'b' }); });
  await page.locator('.session-view[data-session-id="b"]:visible').waitFor();
  await modal().waitFor({ state: 'hidden' });
  await ready();
  await showChanges();
  await openReview('src/alpha.ts');
  assert.match(await modal().innerText(), /project b new/);
  assert.doesNotMatch(await modal().innerText(), /first version|final version/);
  await modal().getByRole('button', { name: 'Открыть файл', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__diffReview.opens.at(-1)), { sessionId: 'b', path: 'C:/Fixtures/REVIEW_B/src/alpha.ts' });
  await closeReview();
  await page.locator('.session-tab[data-session-id="a"]').getByRole('tab').click();
  await ready();
  assert.equal(await modal().count(), 0, 'A dismissed inactive review does not reappear after returning');
  assert.equal(await filter().getAttribute('data-value'), 'turn-one', 'Returning keeps the selected turn');

  await filter().click();
  await picker().waitFor();
  await page.evaluate(() => { for (const listener of window.__diffReview.activationListeners) listener({ sessionId: 'b' }); });
  await page.locator('.session-view[data-session-id="b"]:visible').waitFor();
  await picker().waitFor({ state: 'hidden' });
  await page.locator('.session-tab[data-session-id="a"]').getByRole('tab').click();
  await ready();
  assert.equal(await picker().count(), 0, 'An inactive request picker does not reappear when returning to the session');
  assert.equal(await filter().getAttribute('data-value'), 'turn-one', 'Dismissing a picker preserves the selected request');

  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
    await settle();
    if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) {
      await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    }
    await filter().click();
    await picker().waitFor();
    const pickerBounds = await picker().evaluate(node => {
      const r = node.getBoundingClientRect();
      const list = node.querySelector('[role="listbox"]');
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight,
        client: node.clientWidth, scroll: node.scrollWidth, listClient: list.clientHeight, listScroll: list.scrollHeight };
    });
    assert.ok(pickerBounds.left >= 0 && pickerBounds.top >= 0 && pickerBounds.right <= pickerBounds.width + 1 && pickerBounds.bottom <= pickerBounds.height + 1, `Request picker fits ${width}px viewport`);
    assert.ok(pickerBounds.scroll <= pickerBounds.client + 1, 'Long request text does not add horizontal scrolling to the picker');
    assert.ok(pickerBounds.listScroll > pickerBounds.listClient, 'A long request history scrolls inside its bounded list');
    await turnSearch().fill('маяк_дальнего_поиска');
    await settle();
    assert.equal(await turnOption('history-24').isVisible(), true);
    const longBounds = await turnOption('history-24').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(longBounds.scroll <= longBounds.width + 1, `A long unbroken request title fits its option at ${width}px`);
    await turnSearch().fill('');
    await settle();
    await page.screenshot({ path: `artifacts/change-turn-picker-${width}.png` });
    await turnSearch().press('Escape');
    await picker().waitFor({ state: 'hidden' });
    await expand('src/alpha.ts');
    const overflow = await group('src/alpha.ts').evaluate(node => ({
      width: node.clientWidth, scroll: node.scrollWidth,
      diffs: [...node.querySelectorAll('.review-diff-lines')].map(diff => ({ client: diff.clientWidth, scroll: diff.scrollWidth })),
    }));
    assert.ok(overflow.scroll <= overflow.width + 1, `File card fits ${width}px viewport`);
    assert.ok(overflow.diffs.length > 0 && overflow.diffs.every(diff => diff.scroll <= diff.client + 1), 'Long source lines wrap inside the numbered sidebar');
    await openReview('src/alpha.ts');
    const bounds = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, `Expanded review fits ${width}px viewport`);
    await page.screenshot({ path: `artifacts/diff-review-${width}.png` });
    await page.keyboard.press('Escape');
    await modal().waitFor({ state: 'hidden' });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview('src/alpha.ts');
  await page.setViewportSize({ width: 940, height: 640 });
  await settle();
  assert.equal(await modal().isVisible(), true, 'A large comparison stays open when resizing hides the sidebar');
  await closeReview();
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) {
    await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
  }

  // Per-turn summaries must stay attached to their own turn across live updates.
  const emit = (method, params) => page.evaluate(({ method, params }) => window.__diffReview.sessions.a.emit(method, params), { method, params });
  const summaryOne = '@@ -4 +4 @@\n-summary original\n+summary first';
  const summaryTwo = '@@ -9 +9 @@\n-summary previous\n+summary second';
  const summaryLate = '@@ -4 +4 @@\n-summary original\n+summary first final';
  await emit('turn/started', { turn: { id: 'live-one', status: 'inProgress' } });
  await emit('item/completed', { turnId: 'live-one', item: { id: 'live-user-one', type: 'userMessage', content: [{ type: 'text', text: 'Первый сводный diff', text_elements: [] }] } });
  await emit('turn/diff/updated', { turnId: 'live-one', diff: summaryOne });
  await emit('turn/completed', { turn: { id: 'live-one', status: 'completed', error: null } });
  await ready();
  await emit('turn/started', { turn: { id: 'live-two', status: 'inProgress' } });
  await emit('item/completed', { turnId: 'live-two', item: { id: 'live-user-two', type: 'userMessage', content: [{ type: 'text', text: 'Второй сводный diff', text_elements: [] }] } });
  await emit('turn/diff/updated', { turnId: 'live-two', diff: summaryTwo });
  await emit('turn/completed', { turn: { id: 'live-two', status: 'completed', error: null } });
  await ready();
  await emit('turn/diff/updated', { turnId: 'live-one', diff: summaryLate });
  await chooseTurn('all');
  const summary = () => panel().locator('.change-turn-diff');
  await summary().waitFor();
  if (await summary().getAttribute('open') === null) await summary().locator('summary').click();
  assert.match(await summary().innerText(), /summary second/);
  assert.doesNotMatch(await summary().innerText(), /summary first/, 'A delayed older summary does not replace the latest turn');
  await chooseTurn('live-one');
  assert.equal(await groups().count(), 0, 'Summary-only turns do not invent file cards');
  assert.match(await summary().innerText(), /summary first final/);
  assert.doesNotMatch(await summary().innerText(), /summary second/);
  await summary().getByRole('button', { name: 'Развернуть сводное сравнение', exact: true }).click();
  await modal().waitFor();
  assert.match(await modal().innerText(), /summary first final/);
  assert.equal(await modal().getByRole('button', { name: 'Открыть файл', exact: true }).count(), 0, 'A summary without a file path cannot open an invented target');
  await closeReview();
  await chooseTurn('live-two');
  assert.match(await summary().innerText(), /summary second/);

  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__diffReview.requests.filter(call => /^(turn\/start|thread\/start)$/.test(call.method)).length), 0, 'Reviewing history never starts a model request');
  console.log('PASS: production diff review, searchable request picker with full-text search, keyboard selection, Escape/focus and outside dismissal, long history and titles, 1440/940 picker layout, legacy unknown group, canonical repeated files, scoped turn/file filters, empty search, add/delete/rename/binary/raw, split/unified line numbers and fragment navigation, scoped opens and failure recovery, inactive modal/picker dismissal, resize and 1440/940 layout, live per-turn summaries and delayed older updates. Deterministic bridges; no real model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/diff-review-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
