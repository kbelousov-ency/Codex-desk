import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fixture() {
  const ipc = new EventEmitter();
  const calls = [];
  const sends = [];
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve(); };
  ipc.send = (...args) => sends.push(args);
  let bridge;
  runInNewContext(await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    Buffer,
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'codex'); bridge = value; } } };
    },
  });
  return { bridge, ipc, calls, sends };
}

test('preload scopes RPC and colliding approval IDs to the selected session', async () => {
  const { bridge, calls } = await fixture();
  const a = bridge.forSession('a');
  const b = bridge.forSession('b');
  await a.start({ cwd: 'project-a' });
  await b.request('turn/interrupt', { turnId: 'turn-b' });
  await a.respond(1, { decision: 'accept' });
  await b.respond(1, { decision: 'decline' });
  await bridge.getSettings();
  await b.chooseDirectory();
  await a.openPath('src/first.ts:12');
  await b.showPathMenu('src/second.ts');
  await a.showPathMenu('src/first.ts', { askCodex: true });
  await bridge.showPathMenu('src', { askCodex: true });
  await a.listFiles('src', 500);
  await b.listFiles();
  await a.getMcpConfig();
  await b.previewMcpImport('fixture config');
  await b.saveMcpImport({ previewId: 'preview', replaceExisting: true });
  await a.reloadMcp();
  await b.checkMcp();
  await a.openTerminal({ threadId: 'thread-a', model: 'configured-model', effort: 'high', access: 'auto' });
  assert.deepEqual(calls, [
    ['codex:start', { cwd: 'project-a' }, 'a'],
    ['codex:request', 'turn/interrupt', { turnId: 'turn-b' }, 'b'],
    ['codex:respond', 1, { decision: 'accept' }, 'a'],
    ['codex:respond', 1, { decision: 'decline' }, 'b'],
    ['host:getSettings', undefined],
    ['host:chooseDirectory', 'b'],
    ['host:openPath', 'src/first.ts:12', 'a'],
    ['host:showPathMenu', 'src/second.ts', 'b'],
    ['host:showPathMenu', 'src/first.ts', { askCodex: true }, 'a'],
    ['host:showPathMenu', 'src', { askCodex: true }, undefined],
    ['host:listFiles', 'src', 500, 'a'],
    ['host:listFiles', undefined, undefined, 'b'],
    ['host:getMcpConfig', 'a'],
    ['host:previewMcpImport', 'fixture config', 'b'],
    ['host:saveMcpImport', { previewId: 'preview', replaceExisting: true }, 'b'],
    ['host:reloadMcp', 'a'],
    ['host:checkMcp', 'b'],
    ['host:openTerminal', { threadId: 'thread-a', model: 'configured-model', effort: 'high', access: 'auto' }, 'a'],
  ]);
  assert.throws(() => bridge.forSession(null), /Некорректная/);
});

test('Git readers keep file selection and staged area scoped to their session', async () => {
  const { bridge, calls } = await fixture();
  await bridge.forSession('project-a').getGitStatus();
  await bridge.forSession('project-b').getGitDiff({ path: 'src/пример.ts', area: 'staged' });
  assert.deepEqual(calls, [
    ['host:getGitStatus', 'project-a'],
    ['host:getGitDiff', { path: 'src/пример.ts', area: 'staged' }, 'project-b'],
  ]);
});

test('file previews retain session ownership while history and bookmarks use fixed workspace channels', async () => {
  const { bridge, calls } = await fixture();
  await bridge.forSession('a').searchProjectFiles({ query: 'readme', cursor: 'next' });
  await bridge.forSession('b').readProjectFile({ path: 'src/main.ts' });
  await bridge.searchHistory({ query: 'решение', cwd: 'project-a', provider: 'all' });
  await bridge.resolveHistoryTarget({ cwd: 'project-a', provider: 'claude', threadId: 'claude:uuid' });
  await bridge.listBookmarks({ cwd: 'project-b', provider: 'claude' });
  await bridge.saveBookmark({ id: 'bookmark-id', label: 'Моя подпись' });
  await bridge.removeBookmark('bookmark-id');
  assert.deepEqual(calls, [
    ['host:searchProjectFiles', { query: 'readme', cursor: 'next' }, 'a'],
    ['host:readProjectFile', { path: 'src/main.ts' }, 'b'],
    ['host:searchHistory', { query: 'решение', cwd: 'project-a', provider: 'all' }],
    ['host:resolveHistoryTarget', { cwd: 'project-a', provider: 'claude', threadId: 'claude:uuid' }],
    ['host:listBookmarks', { cwd: 'project-b', provider: 'claude' }],
    ['host:saveBookmark', { id: 'bookmark-id', label: 'Моя подпись' }],
    ['host:removeBookmark', 'bookmark-id'],
  ]);
  for (const key of ['searchHistory', 'resolveHistoryTarget', 'listBookmarks', 'saveBookmark', 'removeBookmark']) assert.equal(bridge.forSession('a')[key], undefined);
});

test('composer picker passes only selection preferences and the owning session', async () => {
  const { bridge, calls } = await fixture();
  await bridge.forSession('a').chooseComposerFiles({ imageSlots: 7, imagesSupported: false });
  await bridge.forSession('b').chooseComposerFiles();
  assert.deepEqual(calls, [
    ['host:chooseComposerFiles', { imageSlots: 7, imagesSupported: false }, 'a'],
    ['host:chooseComposerFiles', undefined, 'b'],
  ]);
});

test('rollback preview, apply and undo retain session ownership without generic RPC', async () => {
  const { bridge, calls } = await fixture();
  const a = bridge.forSession('a');
  await a.previewGitRollback({ path: 'src/пример.ts' });
  await a.applyGitRollback({ previewId: 'preview' });
  await a.listGitRollbacks();
  await a.previewUndoGitRollback({ undoId: 'undo' });
  await a.undoGitRollback({ previewId: 'undo-preview' });
  assert.deepEqual(calls, [
    ['host:previewGitRollback', { path: 'src/пример.ts' }, 'a'],
    ['host:applyGitRollback', { previewId: 'preview' }, 'a'],
    ['host:listGitRollbacks', 'a'],
    ['host:previewUndoGitRollback', { undoId: 'undo' }, 'a'],
    ['host:undoGitRollback', { previewId: 'undo-preview' }, 'a'],
  ]);
});

test('preload listeners receive only their tab, root follows the default and unsubscribe is local', async () => {
  const { bridge, ipc } = await fixture();
  const aEvents = [], bEvents = [], rootEvents = [];
  const offA = bridge.forSession('a').onEvent(data => aEvents.push(data.data));
  bridge.forSession('b').onEvent(data => bEvents.push(data.data));
  bridge.onEvent(data => rootEvents.push(data.data));
  const emit = (sessionId, defaultSession, data) => ipc.emit('codex:event', {}, { sessionId, defaultSession, type: 'notification', data });
  emit('a', true, 'first-a');
  emit('b', false, 'first-b');
  offA();
  emit('a', false, 'closed-a');
  emit('b', true, 'new-default-b');
  assert.deepEqual(aEvents, ['first-a']);
  assert.deepEqual(bEvents, ['first-b', 'new-default-b']);
  assert.deepEqual(rootEvents, ['first-a', 'new-default-b']);
});

test('workspace history has its own fixed IPC and is not exposed through a session bridge', async () => {
  const { bridge, calls } = await fixture();
  await bridge.listProjectThreads('project-b', 'page-2');
  await bridge.listProjectThreads('project-a');
  assert.deepEqual(calls, [
    ['host:listProjectThreads', 'project-b', 'page-2'],
    ['host:listProjectThreads', 'project-a', undefined],
  ]);
  assert.equal(bridge.forSession('a').listProjectThreads, undefined);
});

test('project close and update consent use fixed workspace IPC, never a model request', async () => {
  const { bridge, calls } = await fixture();
  await bridge.closeProject('C:/project', { force: true });
  await bridge.getUpdateStatus();
  await bridge.decideUpdate('later');
  await bridge.decideUpdate('close');
  assert.deepEqual(calls, [
    ['host:closeProject', 'C:/project', { force: true }],
    ['host:getUpdateStatus'], ['host:decideUpdate', 'later'], ['host:decideUpdate', 'close'],
  ]);
  assert.equal(bridge.forSession('a').closeProject, undefined);
  assert.equal(bridge.forSession('a').decideUpdate, undefined);
});

test('dialog search has fixed readonly workspace IPC and preserves the archive scope', async () => {
  const { bridge, calls } = await fixture();
  await bridge.searchThreads({ query: 'title', archived: false });
  await bridge.searchThreads({ query: 'archived title', archived: true, cursor: 'page-2' });
  assert.deepEqual(calls, [
    ['host:searchThreads', { query: 'title', archived: false }],
    ['host:searchThreads', { query: 'archived title', archived: true, cursor: 'page-2' }],
  ]);
  assert.equal(bridge.forSession('a').searchThreads, undefined);
});

test('archive lifecycle uses fixed workspace IPC, never generic tab methods', async () => {
  const { bridge, calls } = await fixture();
  await bridge.listArchivedThreads('page-2');
  await bridge.readArchivedThread({ threadId: 'archive', cursor: 'items-2' });
  await bridge.manageThread({ action: 'restore', threadId: 'archive', cwd: 'folder' });
  await bridge.openArchivedPath({ threadId: 'archive', target: 'src/file.ts', menu: true });
  assert.deepEqual(calls, [
    ['host:listArchivedThreads', 'page-2'],
    ['host:readArchivedThread', { threadId: 'archive', cursor: 'items-2' }],
    ['host:manageThread', { action: 'restore', threadId: 'archive', cwd: 'folder' }],
    ['host:openArchivedPath', { threadId: 'archive', target: 'src/file.ts', menu: true }],
  ]);
  assert.equal(bridge.forSession('a').manageThread, undefined);
  assert.equal(bridge.forSession('a').readArchivedThread, undefined);
});

test('diagnostics stay available at workspace scope with fixed IPC and no session arguments', async () => {
  const { bridge, calls } = await fixture();
  await bridge.getDiagnosticsStatus();
  await bridge.exportDiagnostics();
  await bridge.openDiagnosticsFolder();
  assert.deepEqual(calls, [
    ['host:getDiagnosticsStatus'],
    ['host:exportDiagnostics'],
    ['host:openDiagnosticsFolder'],
  ]);
  for (const method of ['getDiagnosticsStatus', 'exportDiagnostics', 'openDiagnosticsFolder', 'reportRendererError']) {
    assert.equal(bridge.forSession('a')[method], undefined, `${method} cannot bind to a stopped or unrelated tab`);
  }
});

test('build identity stays available without an App Server at workspace scope', async () => {
  const { bridge, calls } = await fixture();
  await bridge.getBuildInfo();
  assert.deepEqual(calls, [['host:getBuildInfo']]);
  assert.equal(bridge.forSession('a').getBuildInfo, undefined);
});

test('renderer reports expose only known string fields and enforce UTF-8 byte limits before IPC', async () => {
  const { bridge, sends } = await fixture();
  bridge.reportRendererError({ kind: 'react', name: 'TypeError', message: 'fixture failure', stack: 'fixture stack', componentStack: 'fixture component', secret: 'never transmitted', payload: { content: 'never transmitted' } });
  assert.deepEqual(JSON.parse(JSON.stringify(sends)), [['host:rendererError', {
    kind: 'react', name: 'TypeError', message: 'fixture failure', stack: 'fixture stack', componentStack: 'fixture component',
  }]]);
  bridge.reportRendererError(null);
  bridge.reportRendererError({ kind: 'arbitrary-method', message: 'no' });
  assert.equal(sends.length, 1, 'Unknown report kinds never cross IPC');
  bridge.reportRendererError({ kind: 'error', name: {}, message: 42, stack: [], componentStack: false });
  assert.deepEqual(JSON.parse(JSON.stringify(sends.at(-1))), ['host:rendererError', { kind: 'error' }]);
  bridge.reportRendererError({ kind: 'unhandledrejection', message: 'a'.repeat(5000) });
  assert.equal(sends.at(-1)[1].message.length, 3000, 'Each field is bounded');
  const before = sends.length;
  bridge.reportRendererError({ kind: 'error', message: 'я'.repeat(3000), stack: 'я'.repeat(3000) });
  bridge.reportRendererError({ kind: 'error', message: '\0'.repeat(2000) });
  assert.equal(sends.length, before, 'Oversized multibyte and JSON-escaped payloads are rejected');
  for (const [, payload] of sends) assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 8000);
});

test('workspace autosave and close handshake stay scoped to the window, not a model session', async () => {
  const { bridge, calls, ipc } = await fixture();
  const snapshot = { version: 1, activeIndex: 0, tabs: [] };
  await bridge.saveWorkspaceState(snapshot);
  await bridge.completeWorkspaceSave({ requestId: 'close-1', snapshot });
  assert.deepEqual(calls, [['host:saveWorkspaceState', snapshot], ['host:completeWorkspaceSave', { requestId: 'close-1', snapshot }]]);
  const messages = [];
  const off = bridge.onWorkspaceSave(request => messages.push(request));
  ipc.emit('host:workspaceSave', {}, { requestId: 'close-2' });
  off(); ipc.emit('host:workspaceSave', {}, { requestId: 'close-3' });
  assert.deepEqual(messages, [{ requestId: 'close-2' }]);
  for (const key of ['saveWorkspaceState', 'completeWorkspaceSave', 'onWorkspaceSave']) assert.equal(bridge.forSession('a')[key], undefined);
});

test('notifications and focus use fixed workspace IPC with removable isolated listeners', async () => {
  const { bridge, calls, ipc } = await fixture();
  await bridge.getNotificationSettings();
  await bridge.setNotificationSettings({ sound: true, error: false });
  await bridge.setNotificationContext({ activeSessionId: 'tab-b' });
  const notification = { sessionId: 'tab-b', kind: 'completed', eventId: 'turn-1', title: 'Project' };
  await bridge.notifySession(notification); await bridge.getWindowFocus();
  assert.deepEqual(calls, [
    ['host:getNotificationSettings'], ['host:setNotificationSettings', { sound: true, error: false }],
    ['host:setNotificationContext', { activeSessionId: 'tab-b' }], ['host:notifySession', notification], ['host:getWindowFocus'],
  ]);
  const activations = [], focus = [], secondFocus = [];
  const offActivation = bridge.onNotificationActivated(value => activations.push(value));
  const offFocus = bridge.onWindowFocus(value => focus.push(value));
  bridge.onWindowFocus(value => secondFocus.push(value));
  ipc.emit('host:notificationActivated', {}, { sessionId: 'tab-b' }); ipc.emit('host:windowFocus', {}, false);
  offActivation(); offFocus();
  ipc.emit('host:notificationActivated', {}, { sessionId: 'tab-a' }); ipc.emit('host:windowFocus', {}, true);
  assert.deepEqual(activations, [{ sessionId: 'tab-b' }]); assert.deepEqual(focus, [false]); assert.deepEqual(secondFocus, [false, true]);
  for (const key of ['getNotificationSettings', 'setNotificationSettings', 'setNotificationContext', 'notifySession', 'getWindowFocus', 'onWindowFocus', 'onNotificationActivated']) {
    assert.equal(bridge.forSession('a')[key], undefined);
  }
});
