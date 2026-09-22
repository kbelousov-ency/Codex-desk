import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer with deterministic scoped Git bridges. Reading Git in this
// script never starts a shell, changes a repository, or sends a model request.
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
    const fixture = window.__gitPanel = { sessions: {}, requests: [], statuses: [], diffs: [], opens: [], activationListeners: new Set() };
    const model = { id: 'fixture', model: 'fixture', displayName: 'fixture', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
    const entry = (path, indexStatus, worktreeStatus, extra = {}) => ({ path, status: `${indexStatus}${worktreeStatus}`, indexStatus, worktreeStatus, staged: ![' ', '?', 'U'].includes(indexStatus), unstaged: ![' ', '?', 'U'].includes(worktreeStatus), untracked: indexStatus === '?', conflicted: indexStatus === 'U', ...extra });
    for (const id of ['a', 'b']) {
      const cwd = `C:/Fixtures/GIT_${id.toUpperCase()}`;
      const state = fixture.sessions[id] = { cwd, listeners: new Set(), deferStatus: false, deferDiff: false, failStatus: false, failDiff: false, pendingStatuses: [], pendingDiffs: [] };
      const thread = state.thread = {
        id: `thread-${id}`, name: `Проверка Git ${id}`, cwd, historyMode: 'legacy', status: { type: 'idle' },
        turns: [{ id: `turn-${id}`, status: 'completed', items: [
          { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: `Проверь проект ${id}`, text_elements: [] }] },
          { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Проект ${id} готов к проверке.` },
        ] }],
      };
      state.baseStatus = {
        available: true, root: cwd, branch: `feature/project-${id}`, detached: false, unborn: false, head: '1234567890abcdef1234567890abcdef12345678',
        entries: id === 'a' ? [
          entry('src/shared.ts', 'M', 'M'),
          entry('docs/новое имя.txt', 'R', ' ', { originalPath: 'docs/старое имя.txt' }),
          entry('src/deleted.ts', ' ', 'D'),
          entry('assets/logo.png', ' ', 'M'),
          entry('notes/new file.md', '?', '?'),
          entry('src/conflict.ts', 'U', 'U'),
        ] : [entry('src/shared.ts', ' ', 'M')],
      };
      state.status = structuredClone(state.baseStatus);
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
        async getGitStatus() {
          fixture.statuses.push({ sessionId: id });
          if (state.failStatus) { state.failStatus = false; throw new Error('Тестовая ошибка чтения Git'); }
          const snapshot = structuredClone(state.status);
          if (state.deferStatus) { state.deferStatus = false; return new Promise(resolve => state.pendingStatuses.push(value => resolve(value || snapshot))); }
          return snapshot;
        },
        async getGitDiff(options) {
          fixture.diffs.push({ sessionId: id, ...structuredClone(options) });
          if (state.failDiff) { state.failDiff = false; throw new Error('Тестовая ошибка сравнения Git'); }
          const found = state.status.entries.find(item => item.path === options.path);
          const content = `${id} ${options.area}`;
          const result = {
            available: true, root: cwd, path: options.path, area: options.area, entry: structuredClone(found),
            binary: options.path === 'assets/logo.png', truncated: false,
            ...(found?.conflicted ? { message: 'В файле есть конфликт слияния. Сначала разрешите конфликт в редакторе.' } : {}),
            diff: options.path === 'assets/logo.png' ? 'Binary files a/assets/logo.png and b/assets/logo.png differ'
              : found?.conflicted ? ''
                : options.area === 'untracked' ? '@@ -0,0 +1,2 @@\n+# Новый файл\n+Текст нового файла'
                  : options.path === 'src/deleted.ts' ? '@@ -1 +0,0 @@\n-deleted content'
                    : options.path === 'docs/новое имя.txt' ? 'diff --git a/docs/старое имя.txt b/docs/новое имя.txt\nsimilarity index 100%\nrename from docs/старое имя.txt\nrename to docs/новое имя.txt'
                      : `@@ -3 +3 @@\n-${content} before\n+${content} after`,
          };
          if (state.deferDiff) { state.deferDiff = false; return new Promise(resolve => state.pendingDiffs.push(value => resolve(value || result))); }
          return result;
        },
        async openPath(path) { fixture.opens.push({ sessionId: id, path }); },
        async showPathMenu() {}, async readAttachment() { return null; },
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
  const panel = () => view().locator('.git-panel');
  const modal = () => page.getByRole('dialog', { name: 'Просмотр изменений', exact: true });
  const refresh = () => panel().getByRole('button', { name: 'Обновить Git', exact: true });
  const search = () => panel().getByRole('textbox', { name: 'Найти файл Git', exact: true });
  const row = (path, section) => panel().getByRole('button', { name: `Сравнить ${path} — ${section}`, exact: true });
  const ready = () => page.waitForFunction(() => {
    const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]');
    return model && !model.disabled;
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const showGit = async () => {
    await view().locator('.panel-tabs button').filter({ hasText: 'Изменения' }).click();
    await view().getByRole('button', { name: 'Git', exact: true }).click();
    await panel().waitFor();
  };
  const closeReview = async () => {
    await modal().getByRole('button', { name: 'Закрыть просмотр изменений', exact: true }).click();
    await modal().waitFor({ state: 'hidden' });
  };
  const activate = async id => {
    await page.evaluate(id => { for (const listener of window.__gitPanel.activationListeners) listener({ sessionId: id }); }, id);
    await page.locator(`.session-view[data-session-id="${id}"]:visible`).waitFor();
    await ready();
  };
  const resetStatus = async (id = 'a') => page.evaluate(id => { const state = window.__gitPanel.sessions[id]; state.status = structuredClone(state.baseStatus); }, id);
  const reload = async () => {
    const before = await page.evaluate(() => window.__gitPanel.statuses.length);
    await refresh().click();
    await page.waitForFunction(before => window.__gitPanel.statuses.length > before, before);
    await page.waitForFunction(() => { const button = document.querySelector('.session-view:not([hidden]) [aria-label="Обновить Git"]'); return button && !button.disabled; });
    await settle();
  };
  await ready();
  await view().getByText('Проект a готов к проверке.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__gitPanel.statuses.length), 0, 'History does not eagerly start Git reads');
  await view().locator('.panel-tabs button').filter({ hasText: 'Изменения' }).click();
  assert.equal(await view().getByRole('button', { name: 'Из диалога', exact: true }).getAttribute('aria-pressed'), 'true', 'Changes from the conversation remain the default source');
  await page.evaluate(() => { window.__gitPanel.sessions.a.failStatus = true; });
  await showGit();
  await panel().getByRole('alert').filter({ hasText: 'Тестовая ошибка чтения Git' }).waitFor();
  assert.equal(await panel().getByRole('button', { name: /^Сравнить / }).count(), 0, 'Initial status failure has no invented file list');
  await panel().getByRole('button', { name: 'Повторить', exact: true }).click();
  await row('src/shared.ts', 'Подготовлено к коммиту').waitFor();
  assert.match(await panel().innerText(), /feature\/project-a/);
  assert.equal(await row('src/shared.ts', 'Не подготовлено').count(), 1, 'One file appears in both its staged and unstaged areas');
  assert.equal(await row('notes/new file.md', 'Новые файлы').count(), 1);
  assert.equal(await row('src/conflict.ts', 'Конфликты').count(), 1);

  for (const [area, section] of [['staged', 'Подготовлено к коммиту'], ['unstaged', 'Не подготовлено']]) {
    await row('src/shared.ts', section).click();
    await modal().waitFor();
    assert.deepEqual(await page.evaluate(() => window.__gitPanel.diffs.at(-1)), { sessionId: 'a', path: 'src/shared.ts', area });
    assert.match(await modal().innerText(), new RegExp(`a ${area} before`));
    assert.match(await modal().innerText(), new RegExp(`a ${area} after`));
    assert.match(await modal().locator('.diff-review-footer').innerText(), /Git/);
    assert.deepEqual(await modal().locator('.diff-column-headings span').allTextContents(), area === 'staged' ? ['До · HEAD', 'После · индекс'] : ['До · индекс', 'После · рабочий файл']);
    const changed = modal().locator('.diff-split-row').filter({ has: page.locator('.review-code-text', { hasText: `a ${area} before` }) });
    assert.deepEqual(await changed.locator('.diff-line-number').allTextContents(), ['3', '3']);
    await closeReview();
  }

  await search().fill('SHARED');
  assert.equal(await panel().getByRole('button', { name: /^Сравнить / }).count(), 2, 'Case-insensitive search keeps both areas of the same file');
  await search().fill('старое имя');
  assert.equal(await row('docs/новое имя.txt', 'Подготовлено к коммиту').count(), 1, 'Rename can be found by its original path');
  await search().fill('missing-file');
  assert.equal(await panel().getByRole('button', { name: /^Сравнить / }).count(), 0);
  assert.match(await panel().innerText(), /не найден|нет файлов/i);
  await search().fill('');

  await row('docs/новое имя.txt', 'Подготовлено к коммиту').click();
  await modal().waitFor();
  assert.match(await modal().innerText(), /старое имя/);
  await modal().getByRole('button', { name: 'Открыть файл', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__gitPanel.opens.at(-1)), { sessionId: 'a', path: 'docs/новое имя.txt' });
  await closeReview();
  await row('notes/new file.md', 'Новые файлы').click();
  await modal().waitFor();
  assert.equal(await page.evaluate(() => window.__gitPanel.diffs.at(-1).area), 'untracked');
  assert.match(await modal().innerText(), /Текст нового файла/);
  assert.deepEqual(await modal().locator('.diff-split-row').first().locator('.diff-line-number').allTextContents(), ['', '1']);
  await closeReview();
  await row('src/deleted.ts', 'Не подготовлено').click();
  await modal().waitFor();
  assert.match(await modal().innerText(), /deleted content/);
  assert.deepEqual(await modal().locator('.diff-split-row').first().locator('.diff-line-number').allTextContents(), ['1', '']);
  assert.equal(await modal().getByRole('button', { name: 'Открыть файл', exact: true }).count(), 0, 'Deleted file does not offer to open a missing working file');
  await closeReview();
  for (const [path, section, text] of [['assets/logo.png', 'Не подготовлено', /Binary files|двоичн/i], ['src/conflict.ts', 'Конфликты', /конфликт|<<<<<<<|combined/i]]) {
    await row(path, section).click();
    await modal().waitFor();
    assert.match(await modal().innerText(), text);
    assert.ok((await modal().locator('.diff-line-number').allTextContents()).every(value => value === ''), 'Binary and combined diff never invent line numbers');
    await closeReview();
  }

  await page.evaluate(() => { window.__gitPanel.sessions.a.failDiff = true; });
  await row('src/shared.ts', 'Не подготовлено').click();
  await page.getByRole('alert').filter({ hasText: 'Тестовая ошибка сравнения Git' }).waitFor();
  assert.equal(await modal().count(), 0, 'A failed diff does not display a previous file as the new selection');
  assert.equal(await row('src/shared.ts', 'Не подготовлено').isDisabled(), true, 'A failed diff requires a fresh status before retry');
  await reload();
  await row('src/shared.ts', 'Не подготовлено').click();
  await modal().waitFor();
  assert.match(await modal().innerText(), /a unstaged after/);
  await closeReview();

  // Refresh failure must preserve a clearly stale list and block stale comparisons.
  await page.evaluate(() => { window.__gitPanel.sessions.a.failStatus = true; });
  await reload();
  await page.getByRole('alert').filter({ hasText: 'Тестовая ошибка чтения Git' }).waitFor();
  assert.equal(await row('src/shared.ts', 'Не подготовлено').count(), 1, 'Refresh errors retain the last successful list');
  assert.match(await panel().innerText(), /устарел|предыдущ|не обновл/i, 'Retained results are clearly identified as stale');
  assert.equal(await row('src/shared.ts', 'Не подготовлено').isDisabled(), true, 'A stale list cannot open a misleading diff');
  await reload();
  assert.equal(await row('src/shared.ts', 'Не подготовлено').isDisabled(), false);

  // A pending diff from a hidden session must never open a portal over another tab.
  await page.evaluate(() => { window.__gitPanel.sessions.a.deferDiff = true; });
  await row('src/shared.ts', 'Не подготовлено').click();
  await page.waitForFunction(() => window.__gitPanel.sessions.a.pendingDiffs.length === 1);
  await activate('b');
  await showGit();
  await row('src/shared.ts', 'Не подготовлено').waitFor();
  await page.evaluate(() => window.__gitPanel.sessions.a.pendingDiffs.shift()());
  await settle();
  assert.equal(await modal().count(), 0, 'Late inactive diff is discarded');
  assert.match(await panel().innerText(), /feature\/project-b/);
  await row('src/shared.ts', 'Не подготовлено').click();
  await modal().waitFor();
  assert.match(await modal().innerText(), /b unstaged after/);
  assert.doesNotMatch(await modal().innerText(), /a unstaged/);
  await modal().getByRole('button', { name: 'Открыть файл', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__gitPanel.opens.at(-1)), { sessionId: 'b', path: 'src/shared.ts' });
  await activate('a');
  await modal().waitFor({ state: 'hidden' });
  assert.equal(await modal().count(), 0, 'Returning does not resurrect a stale comparison');
  await row('src/shared.ts', 'Не подготовлено').waitFor();

  await page.evaluate(() => { window.__gitPanel.sessions.a.deferStatus = true; });
  await refresh().click();
  await page.waitForFunction(() => window.__gitPanel.sessions.a.pendingStatuses.length === 1);
  assert.match(await panel().innerText(), /читаем|загруз|обновл|провер/i, 'Status loading is visible');
  await activate('b');
  await page.evaluate(() => {
    const state = window.__gitPanel.sessions.a;
    state.pendingStatuses.shift()({ ...structuredClone(state.baseStatus), branch: 'STALE_STATUS_SHOULD_NOT_APPEAR' });
  });
  await settle();
  assert.doesNotMatch(await panel().innerText(), /STALE_STATUS/);
  await activate('a');
  await row('src/shared.ts', 'Не подготовлено').waitFor();
  assert.doesNotMatch(await panel().innerText(), /STALE_STATUS/, 'Returning reloads rather than publishing the inactive status');

  // The source switch also cancels a pending comparison within the same tab.
  await page.evaluate(() => { window.__gitPanel.sessions.a.deferDiff = true; });
  await row('src/shared.ts', 'Не подготовлено').click();
  await page.waitForFunction(() => window.__gitPanel.sessions.a.pendingDiffs.length === 1);
  await view().getByRole('button', { name: 'Из диалога', exact: true }).click();
  await panel().waitFor({ state: 'hidden' });
  await page.evaluate(() => window.__gitPanel.sessions.a.pendingDiffs.shift()());
  await settle();
  assert.equal(await modal().count(), 0, 'Late Git diff cannot replace the selected conversation source');
  await view().getByRole('button', { name: 'Git', exact: true }).click();
  await row('src/shared.ts', 'Не подготовлено').waitFor();
  assert.equal(await modal().count(), 0);

  for (const [reason, expected] of [['not-repository', /не.*репозитори|нет.*репозитори|Git.*не найден/i], ['git-unavailable', /Git.*не найден|Git.*недоступен|установ.*Git/i], ['bare', /bare|рабоч.*копи|рабоч.*каталог|рабоч.*папк/i]]) {
    await page.evaluate(reason => { window.__gitPanel.sessions.a.status = { available: false, reason, entries: [] }; }, reason);
    await reload();
    assert.match(await panel().innerText(), expected);
    assert.equal(await panel().getByRole('button', { name: /^Сравнить / }).count(), 0);
  }
  await resetStatus();
  await page.evaluate(() => { Object.assign(window.__gitPanel.sessions.a.status, { detached: true, branch: null, entries: [] }); });
  await reload();
  assert.match(await panel().innerText(), /1234567|отдел.*HEAD|detached|без ветки/i);
  assert.match(await panel().innerText(), /нет изменений|нет изменённых|чист/i);
  await resetStatus();
  await page.evaluate(() => { Object.assign(window.__gitPanel.sessions.a.status, { unborn: true, head: null, branch: 'main' }); });
  await reload();
  assert.match(await panel().innerText(), /перв.*коммит|нет коммит|без коммит|ещё нет/i);
  await resetStatus();
  await page.evaluate(() => { window.__gitPanel.sessions.a.status.truncated = true; });
  await reload();
  assert.match(await panel().innerText(), /огранич|не все|часть|обрезан/i);

  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
    await settle();
    if (await view().locator('.app-shell').evaluate(node => node.classList.contains('panel-hidden'))) {
      await view().getByRole('button', { name: 'Переключить панель действий', exact: true }).click();
    }
    await panel().waitFor();
    const bounds = await panel().evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.client + 1, `Git panel fits ${width}px viewport`);
    await page.screenshot({ path: `artifacts/git-panel-${width}.png` });
    await row('src/shared.ts', 'Не подготовлено').click();
    await modal().waitFor();
    const modalBounds = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(modalBounds.left >= 0 && modalBounds.top >= 0 && modalBounds.right <= modalBounds.width + 1 && modalBounds.bottom <= modalBounds.height + 1, `Git review fits ${width}px viewport`);
    await page.screenshot({ path: `artifacts/git-review-${width}.png` });
    await closeReview();
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__gitPanel.requests.filter(call => !['thread/list', 'thread/read', 'thread/resume'].includes(call.method)).length), 0, 'Git review only uses read bridges, never a model request or repository mutation');
  console.log('PASS: Git renderer staged/unstaged isolation, rename/delete/new/binary/conflict, scoped opens, search, errors/retry and stale-state protection, deferred status/diff across tabs, no repository/missing Git/bare/detached/unborn/truncated states, 1440/940 layouts. Deterministic bridges; no repository mutations or model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/git-panel-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
