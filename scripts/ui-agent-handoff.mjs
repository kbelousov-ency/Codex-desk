import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Production renderer and independent provider fixtures. No real CLI or model requests.
const root = resolve('dist');
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
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
    const cwd = 'C:/Fixtures/HANDOFF';
    const fixture = window.__handoff = { sessions: {}, calls: [], created: [], saved: [], failHistory: false, repeatCursor: false, failCreate: false, serial: 0 };
    const defaults = provider => ({ provider, cwd, model: `${provider}-default`, effort: provider === 'codex' ? 'high' : 'medium', access: provider === 'codex' ? 'workspace-write' : 'auto' });
    const history = provider => ({ id: `${provider}:source`, provider, cwd, name: `Исходная задача ${provider}`, historyMode: provider === 'codex' ? 'paginated' : 'legacy' });
    const turns = provider => [
      { id: `${provider}-early`, status: 'completed', items: [
        { id: `${provider}-early-user`, type: 'userMessage', content: [{ type: 'text', text: `EARLY_REQUIREMENT_${provider}: сохранить совместимость настроек.` }] },
        { id: `${provider}-early-answer`, type: 'agentMessage', phase: 'final_answer', text: `EARLY_DECISION_${provider}: использовать существующий CLI.` },
      ] },
      { id: `${provider}-recent`, status: 'completed', items: [
        { id: `${provider}-recent-user`, type: 'userMessage', content: [{ type: 'text', text: `RECENT_TASK_${provider}: продолжить реализацию.` }] },
        { id: `${provider}-commentary`, type: 'agentMessage', phase: 'commentary', text: `PUBLIC_COMMENTARY_${provider}: проверяю настройки.` },
        { id: `${provider}-reasoning`, type: 'reasoning', summary: [`PUBLIC_SUMMARY_${provider}`], content: [`PRIVATE_REASONING_${provider}`], encryptedContent: `PRIVATE_ENCRYPTED_${provider}` },
        { id: `${provider}-hook`, type: 'hookPrompt', text: `PRIVATE_HOOK_${provider}` },
        { id: `${provider}-command`, type: 'commandExecution', command: 'npm.cmd run check', cwd, status: 'completed', aggregatedOutput: `PUBLIC_OUTPUT_${provider}: check passed`, exitCode: 0 },
        { id: `${provider}-change`, type: 'fileChange', status: 'completed', changes: [{ path: 'src/transfer.ts', kind: { type: 'update' }, diff: `@@ -1 +1 @@\n-old\n+PUBLIC_DIFF_${provider}` }] },
        { id: `${provider}-answer`, type: 'agentMessage', phase: 'final_answer', text: `PUBLIC_FINAL_${provider}: основа готова.` },
      ] },
    ];
    const make = (provider, options = {}) => {
      const id = `session-${++fixture.serial}`;
      const settings = { ...defaults(provider), ...options.settings };
      const state = fixture.sessions[id] = { id, provider, settings, listeners: new Set(), closed: false };
      const emit = state.emit = (method, params) => { for (const listener of state.listeners) listener({ type: 'notification', data: { method, params } }); };
      state.bridge = {
        async start() {
          return { provider, cwd, capabilities: { usage: false }, initialize: {}, executable: `${provider}.exe`, account: null, config: {}, models: ['default', 'custom'].map(suffix => ({ id: `${provider}-${suffix}`, model: `${provider}-${suffix}`, displayName: `${provider}-${suffix}`, inputModalities: ['text', 'image'], defaultReasoningEffort: defaults(provider).effort, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) })) };
        },
        async getSettings() { return { ...settings }; },
        async setSettings(patch) { Object.assign(settings, patch); },
        async request(method, params = {}) {
          fixture.calls.push({ sessionId: id, provider, method, params: structuredClone(params) });
          if (method === 'thread/list') return { data: [history(provider)], nextCursor: null };
          if (method === 'agent/capabilities') return { commands: [], agents: [], mcpServers: [] };
          if (method === 'usage/read') return { available: false, windows: [] };
          if (method === 'thread/resume') return { thread: { ...history(provider), id: params.threadId, turns: provider === 'codex' ? [] : turns(provider).slice(-1), status: { type: 'idle' } }, model: settings.model, reasoningEffort: settings.effort };
          if (method === 'thread/items/list') {
            if (params.cursor === 'earlier' && fixture.failHistory) { fixture.failHistory = false; throw new Error('Проверочная ошибка полной истории'); }
            const selected = params.cursor === 'earlier' ? turns(provider).slice(0, 1) : turns(provider).slice(-1);
            return { data: selected.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), nextCursor: params.cursor === 'earlier' && !fixture.repeatCursor ? null : 'earlier' };
          }
          if (method === 'thread/turns/list') return { data: [...turns(provider)].reverse().map(turn => ({ ...turn, items: [] })), nextCursor: null };
          if (method === 'thread/read') return { thread: { ...history(provider), turns: turns(provider), status: { type: 'idle' } } };
          if (method === 'thread/start') return { thread: { id: `${provider}:new-${id}`, provider, cwd, turns: [] }, model: settings.model };
          if (method === 'turn/start') {
            const turnId = `turn-${id}`;
            const item = { id: `user-${id}`, clientId: params.clientUserMessageId, type: 'userMessage', content: params.input };
            emit('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
            emit('item/completed', { threadId: params.threadId, turnId, item });
            state.complete = () => {
              emit('item/completed', { threadId: params.threadId, turnId, item: { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: 'FIXTURE_HANDOFF_ACCEPTED' } });
              emit('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed', items: [], error: null } });
            };
            return { turn: { id: turnId, status: 'inProgress' } };
          }
          throw new Error(`Unexpected request ${method}`);
        },
        onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async chooseDirectory() { return cwd; }, async chooseExecutable() { return null; }, async readAttachment() { return null; }, async openPath() {},
      };
      return { id, cwd, provider };
    };
    const initial = [make('codex', { settings: { model: 'codex-custom', effort: 'low', access: 'read-only' } }), make('claude', { settings: { model: 'claude-custom', effort: 'high', access: 'workspace-write' } })];
    window.codex = {
      ...fixture.sessions[initial[0].id].bridge,
      async getWorkspace() {
        const saved = JSON.parse(localStorage.getItem('agent-handoff-workspace') || 'null');
        const tabs = saved
          ? saved.tabs.map(tab => ({ ...tab, ...make(tab.provider || tab.settings?.provider || 'codex', tab), sessionId: undefined }))
          : initial.map(session => ({ ...session, thread: history(session.provider), settings: { ...fixture.sessions[session.id].settings }, draft: `SOURCE_DRAFT_${session.provider}` }));
        return { projects: [cwd], sessions: tabs.map(({ id, cwd, provider }) => ({ id, cwd, provider })), restore: { kind: 'workspace', activeIndex: saved?.activeIndex ?? 0, tabs } };
      },
      async listProjectThreads() { return { data: [history('codex'), history('claude')], nextCursor: null }; },
      async createSession(options) {
        fixture.created.push(structuredClone(options));
        if (fixture.failCreate) { fixture.failCreate = false; throw new Error('Проверочная ошибка создания вкладки'); }
        return make(options.provider || options.settings?.provider || 'codex', options);
      },
      async closeSession(id) { fixture.sessions[id].closed = true; },
      forSession(id) { return fixture.sessions[id].bridge; },
      async saveWorkspaceState(snapshot) { fixture.saved.push(structuredClone(snapshot)); localStorage.setItem('agent-handoff-workspace', JSON.stringify(snapshot)); },
      async completeUpdateRestore() {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const view = () => page.locator('.session-view:visible');
  const draft = () => view().locator('.composer textarea');
  const dialog = () => page.getByRole('dialog', { name: 'Передать задачу другому агенту', exact: true });
  const preview = () => dialog().getByRole('textbox', { name: 'Сообщение для нового диалога', exact: true });
  const transfer = () => view().getByRole('button', { name: 'Передать задачу другому агенту', exact: true });
  const active = () => page.getByRole('tab', { selected: true }).evaluate(el => el.closest('[data-session-id]').dataset.sessionId);
  const ready = () => page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [aria-label="Модель"]'); return model && !model.disabled; });
  const activate = async id => { await page.locator(`.session-tab[data-session-id="${id}"]`).getByRole('tab').click(); await ready(); };
  const waitCount = count => page.waitForFunction(count => document.querySelectorAll('.session-tab').length === count, count);
  const calls = method => page.evaluate(method => window.__handoff.calls.filter(call => call.method === method), method);
  const waitPreview = marker => page.waitForFunction(marker => [...document.querySelectorAll('[role="dialog"] textarea')].some(input => input.value.includes(marker)), marker);
  const state = id => page.evaluate(id => ({ ...window.__handoff.sessions[id].settings }), id);
  const submit = provider => dialog().getByRole('button', { name: `Создать черновик в ${provider === 'claude' ? 'Claude Code' : 'Codex'}`, exact: true });

  await ready(); await view().getByText('PUBLIC_FINAL_codex: основа готова.', { exact: true }).waitFor();
  const codexSource = await active();
  const sourceSettings = await state(codexSource);
  assert.equal(await view().getByText(/EARLY_REQUIREMENT_codex/).count(), 0, 'Source renderer initially contains only the recent page');
  const initialPageCalls = (await calls('thread/items/list')).length;
  await transfer().click(); await waitPreview('EARLY_REQUIREMENT_codex');
  const fullPrompt = await preview().inputValue();
  for (const marker of ['EARLY_REQUIREMENT', 'EARLY_DECISION', 'RECENT_TASK', 'PUBLIC_COMMENTARY', 'PUBLIC_OUTPUT', 'PUBLIC_DIFF', 'PUBLIC_FINAL']) assert.ok(fullPrompt.includes(`${marker}_codex`), `Full handoff contains ${marker}`);
  assert.ok(fullPrompt.indexOf('EARLY_REQUIREMENT_codex') < fullPrompt.indexOf('RECENT_TASK_codex'), 'History is chronological across pages');
  assert.doesNotMatch(fullPrompt, /PRIVATE_(REASONING|ENCRYPTED|HOOK)_|PUBLIC_SUMMARY_/);
  const handoffPages = (await calls('thread/items/list')).slice(initialPageCalls);
  assert.deepEqual(handoffPages.map(call => [call.params.cursor ?? null, call.params.sortDirection, call.params.threadId]), [[null, 'desc', 'codex:source'], ['earlier', 'desc', 'codex:source']], 'Full-history read starts at the first page and follows its cursor');
  await page.screenshot({ path: 'artifacts/agent-handoff-dialog.png' });
  await page.setViewportSize({ width: 650, height: 700 });
  const compactGeometry = await dialog().evaluate(element => {
    const box = element.getBoundingClientRect();
    const footer = element.querySelector('.handoff-footer').getBoundingClientRect();
    const body = element.querySelector('.handoff-body');
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, footerBottom: footer.bottom, footerTop: footer.top, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(compactGeometry.x >= 0 && compactGeometry.y >= 0 && compactGeometry.right <= compactGeometry.viewportWidth + 1 && compactGeometry.bottom <= compactGeometry.viewportHeight + 1, `The handoff dialog fits a 650×700 window: ${JSON.stringify(compactGeometry)}`);
  assert.ok(compactGeometry.footerTop >= 0 && compactGeometry.footerBottom <= compactGeometry.viewportHeight + 1, 'Transfer actions remain inside the compact viewport');
  assert.ok(compactGeometry.bodyScrollWidth <= compactGeometry.bodyWidth + 1, 'The compact handoff body does not overflow horizontally');
  await page.screenshot({ path: 'artifacts/agent-handoff-dialog-compact.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog().getByRole('radio', { name: 'Переписка', exact: true }).check();
  await page.waitForFunction(() => { const input = document.querySelector('.handoff-preview'); return input?.value.includes('EARLY_REQUIREMENT_codex') && !input.value.includes('PUBLIC_OUTPUT_codex'); });
  const conversationPrompt = await preview().inputValue();
  assert.doesNotMatch(conversationPrompt, /PUBLIC_(COMMENTARY|OUTPUT|DIFF)_codex/);
  const manualPreview = `${conversationPrompt}\nMANUAL_PREVIEW_728`;
  await preview().fill(manualPreview);
  await dialog().getByRole('radio', { name: 'Переписка и ход работы', exact: true }).check();
  await dialog().getByRole('textbox', { name: 'Задача для Claude Code', exact: true }).fill('UPDATED_TASK_728');
  assert.equal(await preview().inputValue(), manualPreview, 'Changing the task and scope preserves a manually edited message');
  await dialog().getByRole('button', { name: 'Обновить текст', exact: true }).click(); await waitPreview('PUBLIC_OUTPUT_codex');
  const regeneratedPrompt = await preview().inputValue();
  assert.ok(regeneratedPrompt.includes('UPDATED_TASK_728'), 'Explicit regeneration applies the edited task');
  assert.equal(regeneratedPrompt.includes('MANUAL_PREVIEW_728'), false, 'Explicit regeneration replaces prior manual edits');
  await dialog().getByRole('button', { name: 'Отмена', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' }); await waitCount(2);
  assert.equal((await page.evaluate(() => window.__handoff.created)).length, 0, 'Cancel does not create a session');
  assert.equal((await calls('turn/start')).length, 0); assert.equal((await calls('thread/start')).length, 0);
  assert.equal(await draft().inputValue(), 'SOURCE_DRAFT_codex');

  await transfer().click(); await waitPreview('EARLY_REQUIREMENT_codex');
  await page.evaluate(id => window.__handoff.sessions[id].emit('turn/started', { threadId: 'codex:source', turn: { id: 'external-source-turn', status: 'inProgress', items: [] } }), codexSource);
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(await transfer().isDisabled(), true, 'A source turn invalidates the prepared context and disables transfer');
  await page.evaluate(id => window.__handoff.sessions[id].emit('turn/completed', { threadId: 'codex:source', turn: { id: 'external-source-turn', status: 'completed', items: [], error: null } }), codexSource);
  await page.waitForFunction(() => [...document.querySelectorAll('.session-view:not([hidden]) button')].some(button => button.getAttribute('aria-label') === 'Передать задачу другому агенту' && !button.disabled));
  assert.equal(await dialog().count(), 0, 'Completing a source turn does not reopen the invalidated preview');
  assert.equal(await draft().inputValue(), 'SOURCE_DRAFT_codex');
  await waitCount(2); assert.equal((await calls('turn/start')).length, 0, 'Injected lifecycle events do not submit a model request');

  await page.evaluate(() => { window.__handoff.repeatCursor = true; });
  await transfer().click(); await dialog().getByText(/Агент повторил страницу истории/).waitFor();
  assert.equal(await submit('claude').isDisabled(), true, 'A repeated cursor stops full-history loading');
  await dialog().getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.evaluate(() => { window.__handoff.repeatCursor = false; window.__handoff.failHistory = true; });
  await transfer().click(); await dialog().getByText(/Проверочная ошибка полной истории/).waitFor();
  assert.equal(await submit('claude').isDisabled(), true, 'A failed later page cannot produce a partial draft');
  await dialog().getByRole('button', { name: 'Повторить загрузку', exact: true }).click(); await waitPreview('EARLY_REQUIREMENT_codex');
  await dialog().getByRole('textbox', { name: 'Задача для Claude Code', exact: true }).fill('Продолжить разработку передачи контекста.');
  await waitPreview('Продолжить разработку передачи контекста.');
  const editedPrompt = `${await preview().inputValue()}\nРучное уточнение: HANDOFF_EDIT_728`;
  await preview().fill(editedPrompt);
  await page.evaluate(() => { window.__handoff.failCreate = true; });
  await submit('claude').click(); await page.getByText(/Проверочная ошибка создания вкладки/).waitFor();
  await dialog().getByText('Черновик не создан. Повторите попытку.', { exact: true }).waitFor();
  await waitCount(2); assert.equal(await preview().inputValue(), editedPrompt, 'Failed opening preserves the reviewed message');
  await submit('claude').click(); await waitCount(3); await ready();
  const claudeTarget = await active();
  assert.equal(await draft().inputValue(), editedPrompt, 'Receiving composer gets the exact reviewed text');
  assert.deepEqual(await state(claudeTarget), { provider: 'claude', cwd: 'C:/Fixtures/HANDOFF', model: 'claude-default', effort: 'medium', access: 'auto' });
  assert.equal((await calls('turn/start')).length, 0); assert.equal((await calls('thread/start')).length, 0);
  assert.equal((await calls('thread/resume')).some(call => call.sessionId === claudeTarget), false, 'The source thread is never resumed by the other agent');
  await activate(codexSource);
  assert.equal(await dialog().count(), 0, 'Returning to the source does not reopen the completed transfer');
  assert.equal(await draft().inputValue(), 'SOURCE_DRAFT_codex'); assert.deepEqual(await state(codexSource), sourceSettings);
  assert.equal(await view().getByText(/EARLY_REQUIREMENT_codex/).count(), 0, 'Preparing full context does not mutate the source renderer history');

  await activate('session-2');
  const claudeSource = await active(); const claudeSettings = await state(claudeSource);
  assert.equal(await view().getByText(/EARLY_REQUIREMENT_claude/).count(), 0);
  const initialReads = (await calls('thread/read')).length;
  await transfer().click(); await waitPreview('EARLY_REQUIREMENT_claude');
  const reversePrompt = await preview().inputValue();
  for (const marker of ['EARLY_REQUIREMENT', 'PUBLIC_COMMENTARY', 'PUBLIC_OUTPUT', 'PUBLIC_DIFF']) assert.ok(reversePrompt.includes(`${marker}_claude`));
  assert.doesNotMatch(reversePrompt, /PRIVATE_(REASONING|ENCRYPTED|HOOK)_|PUBLIC_SUMMARY_/);
  assert.deepEqual((await calls('thread/read')).slice(initialReads).map(call => [call.provider, call.params.threadId, call.params.includeTurns]), [['claude', 'claude:source', true]], 'Legacy history is read completely without resuming it');
  await submit('codex').click(); await waitCount(4); await ready();
  const codexTarget = await active();
  assert.equal(await draft().inputValue(), reversePrompt);
  assert.deepEqual(await state(codexTarget), { provider: 'codex', cwd: 'C:/Fixtures/HANDOFF', model: 'codex-default', effort: 'high', access: 'workspace-write' });
  await activate(claudeSource); assert.equal(await draft().inputValue(), 'SOURCE_DRAFT_claude'); assert.deepEqual(await state(claudeSource), claudeSettings);
  await activate(codexTarget);
  await page.waitForFunction(prompt => { const snapshot = window.__handoff.saved.at(-1); return snapshot?.tabs.length === 4 && snapshot.tabs[snapshot.activeIndex]?.draft === prompt; }, reversePrompt);
  assert.equal((await calls('turn/start')).length, 0, 'Both directions create drafts without model calls');
  await page.screenshot({ path: 'artifacts/agent-handoff-drafts.png' });
  await page.reload(); await ready(); await waitCount(4);
  assert.equal(await draft().inputValue(), reversePrompt, 'The receiving draft survives workspace restart');
  assert.equal(await view().getByRole('combobox', { name: 'Агент', exact: true }).getAttribute('data-value'), 'codex');
  const restoredTarget = await active();
  await view().getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await page.waitForFunction(() => window.__handoff.calls.filter(call => call.method === 'turn/start').length === 1);
  assert.equal(await transfer().isDisabled(), true, 'An active turn cannot be handed off');
  const sent = (await calls('turn/start'))[0];
  assert.equal(sent.sessionId, restoredTarget); assert.equal(sent.provider, 'codex');
  assert.equal(sent.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n'), reversePrompt.trim());
  assert.equal(sent.params.model, 'codex-default'); assert.equal(sent.params.effort, 'high');
  assert.equal((await calls('thread/start')).length, 1);
  await page.evaluate(id => window.__handoff.sessions[id].complete(), restoredTarget);
  await view().getByText('FIXTURE_HANDOFF_ACCEPTED', { exact: true }).waitFor();
  assert.equal((await calls('turn/start')).length, 1, 'Explicit send is one ordinary request');
  assert.deepEqual(errors, []);
  console.log('PASS: Codex ↔ Claude handoff with complete paginated/legacy history, public work/diff/output, scope and retained manual edits, compact dialog, cancel, source lifecycle invalidation, history/create retry, separate provider defaults, preserved source, persisted target draft and exactly one explicit fixture send. 0 real model requests.');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'artifacts/agent-handoff-failure.png' }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
