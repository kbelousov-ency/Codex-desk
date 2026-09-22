import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_NOTIFICATION_SETTINGS, NotificationService, NotificationSettingsStore } from '../electron/notification-service.mjs';

function fixture(options = {}) {
  const toasts = [], sent = [], actions = [], errors = [];
  let focused = false, minimized = false, destroyed = false, time = 1_000;
  let current = { ...DEFAULT_NOTIFICATION_SETTINGS };
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(value) { super(); this.options = value; this.closed = false; toasts.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  const window = {
    isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => minimized,
    restore() { minimized = false; actions.push('restore'); },
    show() { actions.push('show'); }, focus() { focused = true; actions.push('focus'); service.focusChanged(record); },
    webContents: { isDestroyed: () => destroyed, send: (...message) => sent.push(message) },
  };
  const record = { window, sessions: new Map([['a', {}], ['b', {}]]) };
  const settings = options.settings ?? {
    snapshot: async () => ({ ...current }),
    update: async patch => { current = { ...current, ...patch }; },
  };
  const service = new NotificationService({ Notification: FakeNotification, settings, now: () => time,
    diagnostics: { error: (...args) => errors.push(args) }, ...options });
  service.registerWindow(record);
  const notify = (patch = {}) => service.notify(record, { sessionId: 'a', eventId: 'turn-1', kind: 'completed', title: 'Проект', ...patch });
  return { service, record, toasts, sent, actions, errors, notify, FakeNotification,
    focus: value => { focused = value; }, minimize: value => { minimized = value; }, destroy: () => { destroyed = true; },
    advance: () => { time += 2_001; },
  };
}

test('notification settings persist atomic independent boolean patches and normalize older files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-notification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'notifications.json');
  const store = new NotificationSettingsStore(filename);
  assert.deepEqual(await store.snapshot(), DEFAULT_NOTIFICATION_SETTINGS);
  await Promise.all([store.update({ sound: true }), store.update({ completed: false }), store.update({ error: false })]);
  await store.flush();
  assert.deepEqual(await new NotificationSettingsStore(filename).snapshot(), {
    ...DEFAULT_NOTIFICATION_SETTINGS, sound: true, completed: false, error: false,
  });
  assert.deepEqual(await readdir(directory), ['notifications.json']);
  for (const bad of [null, [], { text: 'private' }, { enabled: 'yes' }, { sound: 1 }, JSON.parse('{"__proto__":true}')]) {
    assert.throws(() => store.update(bad), /Некорректные/);
  }
  await writeFile(filename, JSON.stringify({ enabled: false, sound: 'invalid', ignored: 'discard' }));
  assert.deepEqual(await store.snapshot(), { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false });
  await store.update({ question: false });
  assert.equal((await readFile(filename, 'utf8')).includes('discard'), false);
});

test('focused active tab is silent while background tab and unfocused window receive native metadata', async () => {
  const f = fixture();
  f.focus(true); f.service.setContext(f.record, { activeSessionId: 'a' });
  await f.notify(); assert.equal(f.toasts.length, 0);
  await f.notify({ sessionId: 'b' }); assert.equal(f.toasts.length, 1);
  assert.deepEqual(f.toasts[0].options, { title: 'Задача завершена', body: 'Проект', silent: true });
  f.focus(false); await f.notify({ eventId: 'turn-2' }); assert.equal(f.toasts.length, 2);
  await f.service.setSettings({ sound: true });
  await f.notify({ kind: 'approval', eventId: 'permission-1', title: '' });
  assert.deepEqual(f.toasts[2].options, { title: 'Нужно разрешение', body: 'Codex Desk', silent: false });
});

test('click activates the matching session before restoring and focusing its owning window', async () => {
  const f = fixture();
  f.service.setContext(f.record, { activeSessionId: 'a' });
  f.minimize(true); await f.notify(); await f.notify({ sessionId: 'b', kind: 'question' });
  f.toasts[1].emit('click');
  assert.deepEqual(f.actions, ['restore', 'show', 'focus']);
  assert.deepEqual(f.sent, [['host:notificationActivated', { sessionId: 'b' }], ['host:windowFocus', true]]);
  assert.equal(f.service.windows.get(f.record).activeSessionId, 'b');
  assert.equal(f.toasts[0].closed, false, 'the previously active unread session was never read');
  assert.equal(f.toasts[1].closed, true);
  f.toasts[1].emit('click'); assert.equal(f.actions.length, 3);
});

test('reading the active tab dismisses its outstanding notifications and reports native focus', async () => {
  const f = fixture();
  await f.notify(); await f.notify({ sessionId: 'b' });
  f.service.setContext(f.record, { activeSessionId: 'a' });
  assert.equal(f.toasts[0].closed, false);
  f.focus(true); f.service.focusChanged(f.record);
  assert.deepEqual(f.sent, [['host:windowFocus', true]]);
  assert.equal(f.toasts[0].closed, true); assert.equal(f.toasts[1].closed, false);
  f.service.setContext(f.record, { activeSessionId: 'b' });
  assert.equal(f.toasts[1].closed, true);
  f.service.setContext(f.record, {});
  f.focus(false); f.service.focusChanged(f.record);
  assert.deepEqual(f.sent.at(-1), ['host:windowFocus', false]);
});

test('duplicates, floods and retained native objects are bounded per owning window', async () => {
  const f = fixture();
  await Promise.all([f.notify(), f.notify()]); assert.equal(f.toasts.length, 1);
  await f.notify({ eventId: 'turn-2' }); assert.equal(f.toasts.length, 1, 'same kind throttles rapid distinct events');
  f.advance(); await f.notify(); assert.equal(f.toasts.length, 1, 'past throttle still deduplicates');
  await f.notify({ eventId: 'turn-3' }); assert.equal(f.toasts.length, 2); assert.equal(f.toasts[0].closed, true);
  for (let index = 0; index < 600; index++) await f.notify({ eventId: `turn-${index}` });
  assert.equal(f.service.windows.get(f.record).seen.size, 512);
  for (let index = 0; index < 40; index++) {
    const id = `session-${index}`; f.record.sessions.set(id, {}); await f.notify({ sessionId: id });
  }
  assert.equal(f.service.windows.get(f.record).visible.size, 32);
});

test('event settings and unsupported platforms suppress delivery; disabling dismisses existing notifications', async () => {
  const f = fixture();
  await f.service.setSettings({ completed: false }); await f.notify();
  await f.notify({ kind: 'error' }); assert.equal(f.toasts.length, 1);
  await f.service.setSettings({ error: false }); assert.equal(f.toasts[0].closed, true);
  await f.notify({ kind: 'question' }); assert.equal(f.toasts.length, 2);
  await f.service.setSettings({ enabled: false }); assert.equal(f.toasts[1].closed, true);
  await f.notify({ kind: 'approval' }); assert.equal(f.toasts.length, 2);
  const unsupported = fixture({ Notification: null });
  assert.equal((await unsupported.service.getSettings()).supported, false);
  await unsupported.notify(); assert.equal(unsupported.toasts.length, 0);
});

test('strict payload and active-session validation reject foreign sessions and arbitrary content', async () => {
  const f = fixture();
  for (const bad of [null, [], {}, { sessionId: 'a', kind: 'completed', eventId: 'one', title: 'x', body: 'private answer' }]) {
    await assert.rejects(f.service.notify(f.record, bad), /Некорректное/);
  }
  for (const patch of [{ sessionId: 'foreign' }, { kind: 'arbitrary' }, { eventId: 'x'.repeat(257) }, { eventId: 'a\nb' },
    { title: 'x'.repeat(161) }, { title: 'private\ncommand' }]) await assert.rejects(f.notify(patch), /Некорректное|Недопустимая/);
  for (const bad of [null, [], { activeSessionId: null }, { activeSessionId: 'foreign' }, { unknown: 1 }]) {
    assert.throws(() => f.service.setContext(f.record, bad), /Некорректная|Недопустимая/);
  }
  assert.equal(f.toasts.length, 0);
});

test('closed sessions, windows, renderer crashes and handoff never reactivate stale native clicks', async () => {
  for (const close of ['session', 'window', 'renderer', 'closing', 'destroyed', 'disposed', 'terminal']) {
    const f = fixture(); await f.notify();
    if (close === 'session') { f.service.closeSession(f.record, 'a'); f.record.sessions.delete('a'); }
    if (close === 'window') f.service.closeWindow(f.record);
    if (close === 'renderer') f.record.rendererGone = true;
    if (close === 'closing') f.record.workspaceClosing = true;
    if (close === 'destroyed') f.destroy();
    if (close === 'disposed') f.record.sessions.get('a').disposed = true;
    if (close === 'terminal') f.record.sessions.get('a').terminal = {};
    f.toasts[0].emit('click'); assert.equal(f.actions.length, 0, close);
  }
  const frozen = fixture({ available: () => false }); await frozen.notify(); assert.equal(frozen.toasts.length, 0);
  const terminal = fixture(); terminal.record.sessions.get('a').terminal = {};
  await terminal.notify(); assert.equal(terminal.toasts.length, 0);
});

test('closing a session during a queued settings read prevents stale delivery', async () => {
  let resolve;
  const f = fixture({ settings: { snapshot: () => new Promise(done => { resolve = done; }) } });
  const pending = f.notify();
  f.record.sessions.delete('a'); f.service.closeSession(f.record, 'a');
  resolve(DEFAULT_NOTIFICATION_SETTINGS); await pending;
  assert.equal(f.toasts.length, 0);
});

test('focus changes during a queued settings read suppress a notification that became visible', async () => {
  let resolve;
  const f = fixture({ settings: { snapshot: () => new Promise(done => { resolve = done; }) } });
  const pending = f.notify();
  f.focus(true); f.service.setContext(f.record, { activeSessionId: 'a' });
  resolve(DEFAULT_NOTIFICATION_SETTINGS); await pending;
  assert.equal(f.toasts.length, 0);
});

test('identical event IDs in separate windows stay independent and target their own web contents', async () => {
  const f = fixture();
  const otherSent = [], otherActions = [];
  const other = { sessions: new Map([['other', {}]]), window: {
    isDestroyed: () => false, isMinimized: () => false, isFocused: () => false,
    show: () => otherActions.push('show'), focus: () => otherActions.push('focus'),
    webContents: { isDestroyed: () => false, send: (...args) => otherSent.push(args) },
  } };
  f.service.registerWindow(other);
  await f.notify();
  await assert.rejects(f.service.notify(other, { sessionId: 'a', eventId: 'turn-1', kind: 'completed', title: 'foreign' }), /Недопустимая/);
  await f.service.notify(other, { sessionId: 'other', eventId: 'turn-1', kind: 'completed', title: 'second' });
  assert.equal(f.toasts.length, 2);
  f.toasts[1].emit('click');
  assert.deepEqual(otherActions, ['show', 'focus']);
  assert.deepEqual(otherSent, [['host:notificationActivated', { sessionId: 'other' }]]);
  assert.equal(f.actions.length, 0); assert.equal(f.sent.length, 0);
  f.service.closeWindow(other);
  assert.equal(f.toasts[0].closed, false);
});

test('native failures are handled without exposing content or interrupting the dialog', async () => {
  const f = fixture(); await f.notify({ title: 'PRIVATE_TITLE' });
  f.toasts[0].emit('failed', {}, 'PRIVATE_NATIVE_ERROR');
  assert.equal(f.toasts[0].closed, true); assert.equal(f.errors[0][0], 'notification.failed');
  assert.equal(f.errors[0][1].message.includes('PRIVATE'), false);
  assert.equal(f.service.windows.get(f.record).visible.size, 0);
});
