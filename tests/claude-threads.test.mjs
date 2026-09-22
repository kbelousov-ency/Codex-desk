import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeThreadManagement } from '../electron/claude-threads.mjs';
import { ThreadActionCoordinator } from '../electron/thread-management.mjs';

const id = 'claude:aaaaaaaa-1111-2222-3333-444444444444';
const raw = id.slice(7);
const cwd = process.platform === 'win32' ? 'C:\\Projects\\demo' : '/projects/demo';

function fixture({ sessions = [], readError } = {}) {
  const calls = [];
  const sdk = {
    async renameSession(sessionId, title, options) { calls.push(['rename', sessionId, title, options]); },
    async deleteSession(sessionId, options) { calls.push(['delete', sessionId, options]); },
  };
  const history = {
    async cwd(value) { return value; },
    async read({ threadId, cwd: folder }) {
      calls.push(['read', threadId, folder]);
      if (readError) throw new Error(readError);
      return { thread: { id: threadId, provider: 'claude', cwd: folder, name: '', preview: 'Первый вопрос' } };
    },
    async sdk() { return sdk; },
  };
  const coordinator = new ThreadActionCoordinator();
  const management = new ClaudeThreadManagement({ coordinator, history, getSessions: () => sessions });
  return { calls, coordinator, management, sessions };
}
function session(overrides = {}) {
  const calls = [];
  return { calls, disposed: false, settings: { provider: 'claude' }, currentThreadId: null, terminal: null, pendingBoots: 0, pendingMutations: 0,
    requests: new Map(), activeThreadTurns: new Map(), pendingThreadIds: new Map(), compactingThreads: new Set(), bootstrap: {},
    client: { async request(method, params) { calls.push([method, params]); return { thread: { id: params.threadId, name: params.name } }; }, stop() { calls.push(['stop']); } }, ...overrides };
}

test('validation rejects archive, foreign ids, bad folders and names before touching history', async () => {
  const f = fixture();
  await assert.rejects(f.management.manageThread({ action: 'archive', threadId: id, cwd }), /Архив недоступен/);
  await assert.rejects(f.management.manageThread({ action: 'restore', threadId: id, cwd }), /Архив недоступен/);
  await assert.rejects(f.management.manageThread({ action: 'purge', threadId: id, cwd }), /Неизвестное действие/);
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: raw, cwd }), /идентификатор/);
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: id, cwd: 'relative' }), /папка/);
  await assert.rejects(f.management.manageThread({ action: 'rename', threadId: id, cwd, name: 'a\nb' }), /Название/);
  await assert.rejects(f.management.manageThread({ action: 'rename', threadId: id, cwd, name: 'x'.repeat(201) }), /Название/);
  assert.deepEqual(f.calls, []);
});

test('rename of a closed session appends through the SDK scoped to the project folder', async () => {
  const f = fixture();
  const result = await f.management.manageThread({ action: 'rename', threadId: id, cwd, name: '  План  ' });
  assert.deepEqual(f.calls, [['read', id, cwd], ['rename', raw, 'План', { dir: cwd }]]);
  assert.equal(result.thread.name, 'План'); assert.deepEqual(result.affectedThreadIds, [id]);
  assert.equal(f.coordinator.threads.get(id).name, 'План');
  assert.equal(f.coordinator.locks.size, 0, 'reservation released');
});

test('rename of an open idle tab goes through its CLI control request instead of writing the transcript', async () => {
  const open = session({ currentThreadId: id });
  const other = session({ currentThreadId: 'claude:bbbbbbbb-1111-2222-3333-444444444444' });
  const f = fixture({ sessions: [open, other] });
  await f.management.manageThread({ action: 'rename', threadId: id, cwd, name: 'Новое имя' });
  assert.deepEqual(open.calls, [['thread/name/set', { threadId: id, name: 'Новое имя' }]]);
  assert.deepEqual(other.calls, []);
  assert.ok(!f.calls.some(call => call[0] === 'rename'), 'SDK rename is not used while the CLI holds the session');
});

test('busy, approving or terminal tabs block mutation; history mismatch aborts before any write', async () => {
  const busy = session({ currentThreadId: id, activeThreadTurns: new Map([[id, 'turn']]) });
  let f = fixture({ sessions: [busy] });
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: id, cwd }), /Дождитесь/);
  const approving = session({ currentThreadId: id, requests: new Map([['r', {}]]) });
  f = fixture({ sessions: [approving] });
  await assert.rejects(f.management.manageThread({ action: 'rename', threadId: id, cwd, name: 'x' }), /Дождитесь/);
  const terminal = session({ currentThreadId: id, terminal: { threadId: id } });
  f = fixture({ sessions: [terminal] });
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: id, cwd }), /терминал/);
  assert.deepEqual(f.calls, []);
  f = fixture({ readError: 'Диалог Claude не найден в выбранной папке.' });
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: id, cwd }), /не найден/);
  assert.deepEqual(f.calls.map(call => call[0]), ['read']);
  assert.equal(f.coordinator.locks.size, 0);
});

test('delete stops idle CLI holders first, removes through the SDK and blocks later writers', async () => {
  const open = session({ currentThreadId: id });
  const f = fixture({ sessions: [open] });
  const result = await f.management.manageThread({ action: 'delete', threadId: id, cwd });
  assert.deepEqual(open.calls, [['stop']]);
  assert.deepEqual(f.calls, [['read', id, cwd], ['delete', raw, { dir: cwd }]]);
  assert.deepEqual(result, { affectedThreadIds: [id] });
  assert.throws(() => f.coordinator.assertAllowed(id), /удалён/);
});

test('concurrent operations on one session are serialized by the coordinator reservation', async () => {
  const f = fixture();
  let release;
  f.management.history.read = () => new Promise(resolve => { release = () => resolve({ thread: { id, cwd, name: '' } }); });
  const first = f.management.manageThread({ action: 'rename', threadId: id, cwd, name: 'a' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(f.management.manageThread({ action: 'delete', threadId: id, cwd }), /уже выполняется/);
  release();
  await first;
});
