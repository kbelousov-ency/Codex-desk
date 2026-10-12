import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// «Отправить агенту» and the navigation around executor agents, in the production renderer with
// a fake scoped bridge. The owner works as a conductor: the agent of the parent conversation
// writes prompts for its executors as fenced code blocks, and the header of such a block offers
// one click that creates an executor and carries the prompt over as a composer draft.
//
// This run asserts the button's scope (a live parent only, agent messages only, never in the
// archive and never at depth one), that nothing is sent automatically, the parent breadcrumb of
// an executor, the sub-tab context menu (rename, unlink, archive, close tab) and the nesting of
// executors under their parent in the project tree.
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
let page;
const PROMPT = 'Проверь парсер отчётов и добавь тест на пустой ввод.';
await mkdir('artifacts', { recursive: true });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(prompt => {
    const cwd = 'C:/Fixtures/CONDUCTOR';
    let serial = 0;
    let threads = 0;
    const sessions = {};
    const calls = [];
    const models = ['fixture-alpha'].map(model => ({ id: model, model, displayName: model, inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high'].map(reasoningEffort => ({ reasoningEffort })) }));
    // Every answer of the fixture agent carries a prompt for an executor as a fenced block,
    // exactly the shape the conductor writes in.
    const answer = id => `План для ${id}.\n\n\`\`\`\n${prompt}\n\`\`\`\n\nДалее — отправь агенту.`;
    const store = { links: [], titles: {}, known: [], archived: {} };
    const create = (folder, settings = {}) => {
      const id = `session-${++serial}`;
      const state = { id, cwd: folder, settings: { cwd: folder, model: 'fixture-alpha', effort: 'high', access: 'workspace-write', ...settings }, requests: [], listeners: new Set(), closed: false, threadId: null };
      const emit = (type, data) => { if (!state.closed) for (const listener of state.listeners) listener({ type, data }); };
      state.emit = emit;
      const visible = () => store.known.filter(thread => !store.archived[thread.id]).map(thread => ({ ...thread, name: store.titles[thread.id] || thread.name }));
      state.bridge = {
        async start() { return { initialize: {}, models, cwd: folder, executable: 'C:/Codex/codex.exe', account: { account: null, requiresOpenaiAuth: false }, config: { model: state.settings.model, model_reasoning_effort: state.settings.effort } }; },
        async getSettings() { return { ...state.settings }; },
        async setSettings(patch) { Object.assign(state.settings, patch); },
        async request(method, params = {}) {
          state.requests.push({ method, params });
          if (method === 'thread/list') return { data: visible(), nextCursor: null };
          if (method === 'thread/start') {
            const thread = { id: `thread-${++threads}`, cwd: folder, historyMode: 'legacy', turns: [] };
            state.threadId = thread.id;
            store.known.push({ id: thread.id, cwd: folder, name: `Диалог ${threads}`, historyMode: 'legacy' });
            return { thread, model: params.model };
          }
          if (method === 'thread/resume') {
            const thread = store.known.find(item => item.id === params.threadId) || { id: params.threadId, cwd: folder, historyMode: 'legacy' };
            state.threadId = thread.id;
            return { thread: { ...thread, name: store.titles[thread.id] || thread.name, status: { type: 'idle' }, turns: [{ id: `${thread.id}-turn`, status: 'completed', items: [{ id: `${thread.id}-item`, type: 'agentMessage', text: answer(thread.id) }] }] }, model: state.settings.model, reasoningEffort: state.settings.effort };
          }
          if (method === 'turn/start') return { turn: { id: `${state.threadId}-turn`, status: 'inProgress', items: [] } };
          if (method === 'turn/interrupt') return {};
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return null; }, async chooseExecutable() { return null; }, async openPath() {},
        async saveImages(images) { return images.map(image => ({ ...image, path: `C:/Fixtures/${image.name}` })); }, async readAttachment() { return null; },
      };
      sessions[id] = state;
      return { id, cwd: folder };
    };
    create(cwd);
    window.__nav = { sessions, store, calls };
    const named = thread => ({ ...thread, name: store.titles[thread.id] || thread.name });
    window.codex = {
      ...sessions['session-1'].bridge,
      async getWorkspace() { return { projects: [cwd], sessions: Object.values(sessions).filter(state => !state.closed).map(({ id, cwd: folder }) => ({ id, cwd: folder })) }; },
      async listProjectThreads() { return { data: store.known.filter(thread => !store.archived[thread.id]).map(named), nextCursor: null }; },
      async listArchivedThreads() { return { data: store.known.filter(thread => store.archived[thread.id]).map(named), nextCursor: null }; },
      async readArchivedThread(params) {
        calls.push({ method: 'readArchivedThread', params });
        const thread = store.known.find(item => item.id === params.threadId);
        return { thread: named(thread), items: [{ id: `${thread.id}-item`, type: 'agentMessage', phase: 'final_answer', turnId: `${thread.id}-turn`, complete: true, text: answer(thread.id) }], turns: [], nextCursor: null };
      },
      async listThreadChildLinks() { return store.links.map(link => ({ ...link })); },
      async createThreadChildLink(options) {
        const link = { id: `link-${store.links.length + 1}`, createdAt: new Date().toISOString(), ...options };
        store.links.push(link);
        return { link };
      },
      async manageThreadChildLink(options) {
        calls.push({ method: 'manageThreadChildLink', options });
        if (window.__nav.holdLink) await new Promise(resolve => { window.__nav.releaseLink = resolve; });
        if (options.action === 'unlink') {
          const before = store.links.length;
          store.links = store.links.filter(link => link.childThreadId !== options.childThreadId);
          return { changed: store.links.length !== before, link: null };
        }
        for (const link of store.links) if (link.childThreadId === options.childThreadId) link.label = options.label;
        return { changed: true, link: store.links.find(link => link.childThreadId === options.childThreadId) || null };
      },
      async manageThread(options) {
        calls.push({ method: 'manageThread', options });
        if (options.action === 'rename') store.titles[options.threadId] = options.name;
        else if (options.action === 'archive') store.archived[options.threadId] = true;
        else throw new Error(`Unexpected fixture action ${options.action}`);
        return { thread: { id: options.threadId, cwd: options.cwd, name: store.titles[options.threadId] || '' }, affectedThreadIds: [] };
      },
      async createSession({ cwd: folder, fromSessionId, settings } = {}) { return create(folder || cwd, { ...sessions[fromSessionId]?.settings, ...settings, cwd: folder || cwd }); },
      async closeSession(id) { sessions[id].closed = true; sessions[id].listeners.clear(); },
      forSession(id) { return sessions[id].bridge; },
    };
  }, PROMPT);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const sidebar = () => page.locator('.sidebar:visible');
  const input = () => view().getByRole('textbox', { name: 'Сообщение Codex', exact: true });
  const stop = () => view().getByRole('button', { name: 'Остановить выполнение', exact: true });
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
  const flush = () => page.waitForTimeout(120);
  const activeId = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]')?.dataset.sessionId || '');
  const notify = (id, method, params) => page.evaluate(({ id, method, params }) => window.__nav.sessions[id].emit('notification', { method, params }), { id, method, params });
  const row = () => view().locator('.child-tabs-row');
  const rowTabs = () => row().locator('.child-tab:not(.child-tab-create)');
  const sendButton = () => view().locator('.markdown-code-header button[aria-label="Отправить агенту"]');
  const copyButton = () => view().locator('.markdown-code-header button[aria-label="Скопировать код"]');
  const links = () => page.evaluate(() => window.__nav.store.links.map(link => [link.parentThreadId, link.childThreadId, link.label]));
  const requests = id => page.evaluate(id => window.__nav.sessions[id].requests.map(request => request.method), id);
  const threadOf = id => page.evaluate(id => window.__nav.sessions[id].threadId, id);
  const treeRow = id => sidebar().locator(`.folder-thread-row:has(> .folder-thread[data-thread-id="${id}"])`);
  const badge = id => treeRow(id).locator('> .child-count-badge');
  const nestedRow = id => sidebar().locator(`.folder-thread-children .folder-thread[data-thread-id="${id}"]`);
  const menu = () => page.getByRole('menu', { name: /^Агент-исполнитель: / });
  const item = name => menu().getByRole('menuitem', { name, exact: true });
  const openMenu = async threadId => { await rowTabs().and(page.locator(`[data-thread-id="${threadId}"]`)).click({ button: 'right' }); await menu().waitFor(); };
  const toParent = async () => {
    const parent = await page.locator('.session-tab').first().getAttribute('data-session-id');
    await page.locator(`.session-tab[data-session-id="${parent}"] [role="tab"]`).click();
    await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parent);
    await flush();
  };
  /** Sends one message and runs the turn to completion, so the conversation gets its id and goes idle. */
  const turn = async (id, text) => {
    if (text !== undefined) await input().fill(text);
    await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await stop().waitFor();
    const threadId = await threadOf(id);
    await notify(id, 'turn/started', { threadId, turn: { id: `${threadId}-turn`, status: 'inProgress', items: [] } });
    await notify(id, 'item/agentMessage/delta', { threadId, turnId: `${threadId}-turn`, itemId: `${threadId}-answer`, delta: `План для ${threadId}.\n\n\`\`\`\n${PROMPT}\n\`\`\`\n\nДалее — отправь агенту.` });
    await notify(id, 'turn/completed', { threadId, turn: { id: `${threadId}-turn`, status: 'completed', items: [], error: null } });
    await stop().waitFor({ state: 'hidden' });
    await flush();
    return threadId;
  };

  await ready();
  const parentId = await activeId();
  const parentThread = await turn(parentId, 'Распиши задачи исполнителям');

  // (1) The prompt block of an agent message offers «Отправить агенту» next to «Копировать».
  await sendButton().waitFor();
  assert.equal(await copyButton().count(), 1, 'the existing copy action stays');
  assert.equal(await sendButton().count(), 1, 'exactly the one prompt block of the answer offers it');
  assert.equal(await view().locator('.markdown-code-header .markdown-code-actions button').count(), 2);
  assert.deepEqual(await view().locator('.markdown-code-header .markdown-code-actions button').allInnerTexts(), ['Отправить агенту', 'Копировать']);
  // The user's own message is plain text: it is never a prompt for an executor.
  assert.equal(await view().locator('.user-message .markdown-code-header').count(), 0);
  await page.screenshot({ path: 'artifacts/executor-send.png' });

  // (2) One click creates the executor and carries the block over as a draft. Nothing is sent.
  await sendButton().click();
  await ready();
  const agentA = await activeId();
  assert.notEqual(agentA, parentId);
  assert.equal((await input().inputValue()).trim(), PROMPT, 'the prompt arrives as a composer draft');
  assert.deepEqual((await requests(agentA)).filter(method => method !== 'thread/list'), [], 'no turn is started and no fork or resume is requested');
  assert.equal(await stop().count(), 0, 'there is no automatic send');
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A']);
  assert.equal(await rowTabs().first().getAttribute('aria-selected'), 'true');

  // (3) The breadcrumb of an executor names its parent and steps back to it.
  const crumb = view().locator('.breadcrumb-parent');
  assert.equal(await crumb.innerText(), 'Диалог 1');
  await crumb.click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  assert.equal(await activeId(), parentId, 'the parent tab is activated, not reopened');
  assert.deepEqual((await requests(parentId)).filter(method => method === 'thread/resume'), [], 'the open parent is not resumed again');
  assert.equal(await view().locator('.breadcrumb-parent').count(), 0, 'a parent has no parent crumb');

  // (4) Depth one: the executor's own answers offer no button of their own.
  await rowTabs().first().click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, agentA);
  const threadA = await turn(agentA);
  assert.equal(await view().locator('.markdown-code-header').count(), 1, 'the executor answer is rendered as a prompt block');
  assert.equal(await sendButton().count(), 0, 'an executor agent has no executors of its own');
  assert.deepEqual(await links(), [[parentThread, threadA, 'Агент A']]);

  // A second executor, so the row and the tree hold two of them.
  await page.locator(`.session-tab[data-session-id="${parentId}"] [role="tab"]`).click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  await row().locator('.child-tab-create').click();
  await ready();
  const agentB = await activeId();
  const threadB = await turn(agentB, 'Задача второго исполнителя');
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B']);

  // (5) The context menu of a sub-tab, with the ThreadMenu blocks. An executor that has not
  // sent anything has no conversation yet: only its tab can be closed.
  await toParent();
  await row().locator('.child-tab-create').click();
  await ready();
  const agentC = await activeId();
  await openMenu(`session:${agentC}`);
  assert.deepEqual(await menu().getByRole('menuitem').allInnerTexts(), ['Переименовать', 'Отвязать от родителя', 'В архив', 'Закрыть вкладку']);
  for (const name of ['Переименовать', 'Отвязать от родителя', 'В архив']) assert.equal(await item(name).isDisabled(), true, `${name} needs a conversation`);
  assert.equal(await item('Закрыть вкладку').isDisabled(), false);
  await item('Закрыть вкладку').click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`), agentC);
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Агент A', 'Агент B']);
  // Closing a tab activates a neighbour, so state the view the rest of the run observes.
  await toParent();

  // A started executor has a real navigation link. Closing its running session keeps that
  // named row entry, with a different cross that only unlinks the saved conversation.
  await row().locator('.child-tab-create').click(); await ready();
  const runningAgent = await activeId();
  await input().fill('Длительная задача для проверки закрытия');
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await stop().waitFor();
  const runningThread = await threadOf(runningAgent);
  await notify(runningAgent, 'turn/started', { threadId: runningThread, turn: { id: `${runningThread}-turn`, status: 'inProgress', items: [] } });
  const runningEntry = () => row().locator(`.child-tab-wrap:has(.child-tab[data-thread-id="${runningThread}"])`);
  await runningEntry().locator('.spin').waitFor();
  await runningEntry().locator('.child-tab-close').click();
  const closeModal = page.getByRole('alertdialog').filter({ has: page.locator('#close-session-title') });
  await closeModal.waitFor();
  assert.equal(await closeModal.getByRole('button', { name: 'Дождаться и закрыть', exact: true }).isEnabled(), true);
  await closeModal.getByRole('button', { name: 'Остановить и закрыть', exact: true }).click();
  await page.waitForFunction(id => window.__nav.sessions[id].closed && !document.querySelector(`.session-view[data-session-id="${id}"]`), runningAgent);
  await toParent();
  await runningEntry().locator('.child-tab-state.closed').waitFor();
  assert.equal(await runningEntry().locator('.child-tab span').first().innerText(), 'Агент C');
  assert.equal(await runningEntry().locator('.child-tab-close').getAttribute('data-tooltip'), 'Убрать из ряда (диалог останется в папке)');
  const mutationsBefore = await page.evaluate(() => window.__nav.calls.filter(call => call.method === 'manageThread').length);
  await page.evaluate(() => { window.__nav.holdLink = true; });
  await runningEntry().locator('.child-tab-close').click();
  await page.waitForFunction(() => Boolean(window.__nav.releaseLink));
  assert.equal(await runningEntry().locator('.child-tab-close').isDisabled(), true, 'unlink shares the menu operation lock');
  assert.match(await runningEntry().locator('.child-tab-close').getAttribute('data-tooltip'), /операци|выполня|Дождитесь/i, 'the disabled saved-entry cross explains its lock');
  await page.evaluate(() => { window.__nav.holdLink = false; window.__nav.releaseLink(); });
  await runningEntry().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(threadId => window.__nav.store.known.some(thread => thread.id === threadId), runningThread), true);
  assert.equal(await page.evaluate(() => window.__nav.calls.filter(call => call.method === 'manageThread').length), mutationsBefore, 'the closed-entry cross never archives or deletes the conversation');
  assert.deepEqual(await links(), [[parentThread, threadA, 'Агент A'], [parentThread, threadB, 'Агент B']]);

  // (6) The project tree nests executors under their parent behind the counter badge.
  const folder = sidebar().getByRole('button', { name: 'Диалоги папки CONDUCTOR', exact: true });
  if (await folder.getAttribute('aria-expanded') !== 'true') { await folder.click(); await flush(); }
  await treeRow(parentThread).waitFor();
  assert.equal(await sidebar().locator('.folder-thread-row').count(), 2, 'linked executors are nested; the removed saved entry is a normal dialog');
  assert.equal(await badge(parentThread).innerText(), '2');
  assert.equal(await badge(parentThread).getAttribute('aria-expanded'), 'false');
  assert.equal(await badge(parentThread).getAttribute('aria-label'), 'Развернуть 2 агента-исполнителя диалога Диалог 1');
  await badge(parentThread).click(); await flush();
  assert.equal(await badge(parentThread).getAttribute('aria-expanded'), 'true');
  await nestedRow(threadA).waitFor();
  assert.equal(await nestedRow(threadB).count(), 1);
  assert.ok(await sidebar().locator('.folder-thread-children').evaluate(node => parseFloat(getComputedStyle(node).marginLeft) > 0), 'children are indented');
  await page.screenshot({ path: 'artifacts/executor-tree.png' });
  await badge(parentThread).click(); await flush();
  assert.equal(await nestedRow(threadA).count(), 0, 'the badge collapses the children again');
  await badge(parentThread).click(); await flush();

  // (7) Rename goes through the usual manageThread and updates the name stored in the link.
  await openMenu(threadA);
  await item('Переименовать').click();
  const modal = () => page.getByRole('dialog', { name: 'Переименовать диалог', exact: true });
  await modal().waitFor();
  await modal().getByRole('textbox').fill('Парсер отчётов');
  await modal().getByRole('button', { name: 'Сохранить', exact: true }).click();
  await modal().waitFor({ state: 'hidden' }); await flush();
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Парсер отчётов', 'Агент B']);
  assert.deepEqual(await links(), [[parentThread, threadA, 'Парсер отчётов'], [parentThread, threadB, 'Агент B']]);
  assert.match(await nestedRow(threadA).innerText(), /Парсер отчётов/);

  // (8) Unlinking drops the navigation link alone: the conversation stays in the folder as a
  // plain dialog, leaves the row at once and stops being nested in the tree.
  await openMenu(threadB);
  await item('Отвязать от родителя').click(); await flush();
  assert.deepEqual(await rowTabs().allInnerTexts(), ['Парсер отчётов']);
  assert.deepEqual(await links(), [[parentThread, threadA, 'Парсер отчётов']]);
  assert.equal(await badge(parentThread).innerText(), '1');
  assert.equal(await nestedRow(threadB).count(), 0);
  await treeRow(threadB).waitFor();
  assert.equal(await page.locator('.session-tab').count(), 2, 'the unlinked dialog becomes a root tab');
  assert.deepEqual((await page.evaluate(() => window.__nav.calls.filter(call => call.method === 'manageThread').map(call => call.options.action))), ['rename', 'rename', 'rename'], 'unlinking never touches the conversation itself');

  // (9) «В архив» runs the usual archive and takes the executor out of the row and the tree.
  await openMenu(threadA);
  await item('В архив').click();
  await page.waitForFunction(() => !document.querySelector('.session-view:not([hidden]) .child-tabs-row'));
  assert.equal(await badge(parentThread).count(), 0, 'no counter is left on the parent');
  assert.equal(await treeRow(threadA).count(), 0);
  assert.deepEqual(await links(), [], 'the archived executor keeps no navigation link');

  // (10) The archive is read-only: a prompt block is rendered there, but never with the button.
  await sidebar().getByRole('button', { name: 'Архив', exact: true }).click();
  await sidebar().locator(`.archive-thread[data-thread-id="${threadA}"]`).click();
  await page.locator('.archive-view .markdown-code-header').waitFor();
  assert.equal(await page.locator('.archive-view .markdown-code-header button[aria-label="Отправить агенту"]').count(), 0, 'the archive offers no executor creation');
  assert.equal(await page.locator('.archive-view .markdown-code-header button[aria-label="Скопировать код"]').count(), 1, 'copying still works in the archive');

  // (11) The navigation tab of a missing parent. Archiving the parent conversation closes its
  // tab while an open executor stays: its place is taken by a navigation tab that starts no CLI
  // process until it is pressed. Closing the parent tab itself closes its executors instead.
  await sidebar().getByRole('button', { name: 'Архив', exact: true }).click();
  await page.locator(`.session-tab[data-session-id="${parentId}"] [role="tab"]`).click();
  await page.waitForFunction(id => !document.querySelector(`.session-view[data-session-id="${id}"]`).hidden, parentId);
  await page.locator(`.session-tab[data-session-id="${parentId}"] .session-tab-child`).click(); await ready();
  const orphan = await activeId();
  const sessionsBeforeArchive = await page.evaluate(() => Object.keys(window.__nav.sessions).length);
  await sidebar().locator(`.folder-thread-row:has(> .folder-thread[data-thread-id="${parentThread}"]) .thread-menu-trigger`).click();
  await page.getByRole('menu', { name: 'Действия диалога', exact: true }).getByRole('menuitem', { name: 'В архив', exact: true }).click();
  await page.waitForFunction(id => !document.querySelector(`.session-tab[data-session-id="${id}"]`), parentId);
  const placeholder = page.locator(`.session-tab.child-active[data-parent-thread-id="${parentThread}"]`);
  await placeholder.waitFor();
  assert.equal(await page.locator('.session-tab.active, .session-tab.child-active').count(), 1, 'exactly one root entry stays highlighted');
  assert.equal(await placeholder.locator('.session-executor-badge').count(), 1);
  assert.equal(await page.evaluate(() => Object.keys(window.__nav.sessions).length), sessionsBeforeArchive, 'showing the missing parent never starts a CLI session');
  await page.screenshot({ path: 'artifacts/executor-missing-parent.png' });
  await placeholder.getByRole('tab').click(); await ready();
  const reopenedParent = await activeId();
  assert.notEqual(reopenedParent, parentId);
  assert.deepEqual((await requests(reopenedParent)).filter(method => method !== 'thread/list'), ['thread/resume'], 'the parent is reopened by a plain resume');
  assert.equal(await page.locator('.session-tab[data-parent-thread-id]').count(), 0, 'the navigation tab gives way to the real parent');
  assert.equal(await page.locator(`.session-tab[data-session-id="${orphan}"]`).count(), 0, 'the executor stays in the row, not in the root one');

  assert.deepEqual(errors, []);
  console.log(`PASS: «Отправить агенту» in the prompt-block header (${parentThread} → ${threadA}/${threadB}) as a draft without any send, parent-only scope and breadcrumb, context menu with rename/unlink/archive/close, started executor close with both choices, saved-entry cross unlink preserving history and sharing operation locks with an explanation, tree nesting, unlink/archive updates, navigation tab of a parent archived under an open executor (no implicit startup, plain resume). Fake bridge only; no Electron IPC or model requests.`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/executor-nav-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
