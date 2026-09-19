import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureWorkspaceState, createWorkspaceState, createWorkspaceSaveHandshake } from '../electron/workspace-state.mjs';
import { captureUpdateCheckpoint, createUpdateCheckpoint } from '../electron/update-checkpoint.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
const image = () => ({ name: 'draft.png', dataUrl: png, path: 'untrusted-path' });
const session = () => ({
  currentCwd: path.resolve('fixture-project'), terminal: { active: true }, activeThreadTurns: new Map([['thread', 'turn']]),
  requests: new Map([[1, {}]]), getSettings: () => ({ executable: 'trusted.exe', access: 'danger-full-access', model: 'configured-model', token: 'secret' }),
});
const snapshot = () => ({ version: 1, activeIndex: 0, tabs: [{
  sessionId: 'session', draft: 'Несохранённый черновик', attachments: [image()], scrollTop: 812.5, scrollAnchor: { itemId: 'old-message', offset: -15 },
  thread: { id: 'thread', cwd: 'untrusted', turns: [{ text: 'transcript-secret' }] },
  settings: { cwd: 'untrusted', executable: 'untrusted.exe', access: 'danger-full-access', model: 'selected-model' },
  preservedDraft: { text: 'Исходный черновик', attachments: [image()] },
  queue: { paused: false, threadId: 'previous-thread', cwd: path.resolve('previous-project'), items: [{ id: 'q1', text: 'Queued work', attachments: [image()], state: 'uncertain', secret: 'discard' }] },
}] });
const capture = value => captureWorkspaceState(value, new Map([['session', session()]]));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createWorkspaceState(directory) };
}

test('ordinary capture retains drafts, queued work, scroll and images while busy, with trusted settings and reduced full access', () => {
  const stored = capture(snapshot());
  const tab = stored.tabs[0];
  assert.equal(tab.settings.executable, 'trusted.exe');
  assert.equal(tab.cwd, session().currentCwd);
  assert.equal(tab.thread.cwd, tab.cwd);
  assert.equal(tab.settings.model, 'selected-model');
  assert.equal(tab.settings.access, 'workspace-write');
  assert.equal(tab.draft, snapshot().tabs[0].draft);
  assert.equal(tab.preservedDraft.text, snapshot().tabs[0].preservedDraft.text);
  assert.equal(tab.scrollTop, 812.5);
  assert.deepEqual(tab.scrollAnchor, { itemId: 'old-message', offset: -15 });
  assert.equal(tab.queue.paused, true);
  assert.equal(tab.queue.items[0].state, 'uncertain');
  assert.equal(tab.queue.threadId, 'previous-thread');
  assert.equal(tab.queue.cwd, path.resolve('previous-project'));
  assert.deepEqual(tab.attachments, [{ name: 'draft.png', dataUrl: png }]);
  const encoded = JSON.stringify(stored);
  for (const secret of ['transcript-secret', 'untrusted', '"token"', '"secret"', '"activeThreadTurns"']) assert.ok(!encoded.includes(secret));
  assert.equal(captureUpdateCheckpoint(snapshot(), new Map([['session', session()]])).tabs[0].settings.access, 'danger-full-access', 'Explicit Nightly handoff retains its original access semantics');
});

test('persistent state round trips and remains separate from Nightly checkpoint', async t => {
  const { store, directory } = await fixture(t);
  const captured = capture(snapshot());
  await store.save(captured);
  await createUpdateCheckpoint(directory).save(captureUpdateCheckpoint(snapshot(), new Map([['session', session()]])));
  assert.deepEqual(await store.read(), captured);
  assert.equal((await createUpdateCheckpoint(directory).read()).tabs[0].settings.access, 'danger-full-access');
  await createUpdateCheckpoint(directory).clear();
  assert.deepEqual(await store.read(), captured, 'Completing an update cannot delete persistent state');
  assert.deepEqual(await readdir(directory), ['workspace-state.json']);
});

test('snapshot queue preserves invocation order and freezes values before asynchronous disk writes', async t => {
  const { store } = await fixture(t);
  const first = capture(snapshot()), second = capture(snapshot());
  first.tabs[0].draft = 'first'; second.tabs[0].draft = 'second';
  const writes = [store.save(first), store.save(second)];
  second.tabs[0].draft = 'mutated after save';
  const read = store.read();
  await Promise.all(writes);
  await store.flush();
  assert.equal((await read).tabs[0].draft, 'second');
});

test('invalid capture or disk payload never overwrites a last good workspace', async t => {
  const { store, directory } = await fixture(t);
  const stored = capture(snapshot());
  await store.save(stored);
  const bad = snapshot(); bad.tabs[0].attachments[0].dataUrl = 'data:image/png;base64,c2VjcmV0';
  assert.throws(() => capture(bad), /изображением/);
  const invalid = structuredClone(stored); invalid.tabs[0].queue.items.push(invalid.tabs[0].queue.items[0]);
  assert.throws(() => store.save(invalid));
  assert.deepEqual(await store.read(), stored);
  await writeFile(path.join(directory, 'workspace-state.json'), '{broken');
  await assert.rejects(store.read(), /Сохранённый снимок оставлен/);
  assert.equal(await readFile(path.join(directory, 'workspace-state.json'), 'utf8'), '{broken');
  const backup = (await readdir(directory)).find(name => name.startsWith('workspace-state.json.invalid-'));
  assert.ok(backup);
  await store.save(stored);
  assert.equal(await readFile(path.join(directory, backup), 'utf8'), '{broken', 'Fallback autosave cannot destroy the original invalid bytes');
});

test('empty, new and archived tabs survive validation without inventing model history', async t => {
  const { store } = await fixture(t);
  const empty = { version: 1, activeIndex: 0, tabs: [] };
  await store.save(captureWorkspaceState(empty, new Map()));
  assert.deepEqual(await store.read(), empty);
  const value = snapshot();
  delete value.tabs[0].thread;
  value.tabs.push({ archivedThread: { id: 'archived', cwd: session().currentCwd, turns: ['ignored'] }, scrollTop: 700, draft: 'ignored', attachments: [image()] });
  value.activeIndex = 1;
  const stored = capture(value);
  await store.save(stored);
  const restored = await store.read();
  assert.equal(restored.tabs[0].thread, undefined);
  assert.deepEqual(restored.tabs[1], { archivedThread: { id: 'archived', cwd: session().currentCwd }, draft: '', attachments: [], scrollTop: 700 });
  assert.equal(restored.activeIndex, 1);
});

test('final close handshake is scoped, deduplicated, and waits for the final save', async () => {
  const record = {}, foreign = {}, sent = [], writes = [];
  let release;
  const writing = new Promise(resolve => { release = resolve; });
  const host = createWorkspaceSaveHandshake({ send: (owner, request) => sent.push({ owner, ...request }), save: async (owner, value) => { writes.push({ owner, value }); await writing; }, timeoutMs: 1000 });
  const first = host.request(record);
  assert.equal(host.request(record), first);
  await assert.rejects(host.complete(foreign, { requestId: sent[0].requestId, snapshot: {} }));
  const value = { version: 1, activeIndex: 0, tabs: [] };
  const completion = host.complete(record, { requestId: sent[0].requestId, snapshot: value });
  await assert.rejects(host.complete(record, { requestId: sent[0].requestId, snapshot: value }));
  assert.deepEqual(writes, [{ owner: record, value }]);
  release(); await completion;
  assert.equal(await first, true);
});

test('missing renderer response, crash and incomplete bootstrap leave previous state untouched', async () => {
  const writes = [], sent = [];
  const host = createWorkspaceSaveHandshake({ send: (_record, request) => sent.push(request), save: (_record, value) => writes.push(value), timeoutMs: 10 });
  const unresponsive = {};
  assert.equal(await host.request(unresponsive), false);
  await assert.rejects(host.complete(unresponsive, { requestId: sent[0].requestId, snapshot: {} }), /завершено/);
  const crashed = {};
  const wait = host.request(crashed);
  host.cancel(crashed); assert.equal(await wait, false);
  const incomplete = {};
  const pending = host.request(incomplete);
  await host.complete(incomplete, { requestId: sent.at(-1).requestId });
  assert.equal(await pending, false);
  assert.deepEqual(writes, []);
});

test('failed write keeps atomic previous bytes and queue recovers on subsequent save', async t => {
  const { store, directory } = await fixture(t);
  const value = capture(snapshot());
  await store.save(value);
  // Replacing a regular target with a directory makes rename fail without truncation.
  const blocker = path.join(directory, 'workspace-state.json');
  await rm(blocker); await mkdir(blocker);
  await assert.rejects(store.save(value));
  await store.flush();
  assert.deepEqual(await readdir(directory), ['workspace-state.json'], 'Failed temporary write is cleaned up');
  await rm(blocker, { recursive: true });
  await store.save(value);
  assert.deepEqual(await store.read(), value);
});

test('failed preservation of invalid state blocks overwriting the original path', async t => {
  const { directory, store } = await fixture(t);
  const filename = path.join(directory, 'workspace-state.json');
  await mkdir(filename);
  await assert.rejects(store.read());
  await assert.rejects(store.save(capture(snapshot())), /не удалось сохранить отдельно/);
  assert.deepEqual(await readdir(directory), ['workspace-state.json']);
});

test('scroll anchors reject invalid numeric values and archived capture preserves valid anchors', () => {
  const value = snapshot();
  value.tabs[0].scrollAnchor = { itemId: 'message', offset: Number.NaN };
  assert.throws(() => capture(value));
  value.tabs[0].scrollAnchor = { itemId: '', offset: 0 };
  assert.throws(() => capture(value));
  const archive = { version: 1, activeIndex: 0, tabs: [{ archivedThread: { id: 'archive' }, scrollTop: 15, scrollAnchor: { itemId: 'earlier-message', offset: -20 } }] };
  assert.deepEqual(captureWorkspaceState(archive, new Map()).tabs[0].scrollAnchor, archive.tabs[0].scrollAnchor);
});
