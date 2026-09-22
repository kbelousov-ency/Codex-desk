import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnostics } from '../electron/diagnostics.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desk-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'logs');
  const diagnostics = createDiagnostics({ directory, ...options });
  return { root, directory, diagnostics };
}

function readEntries(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name =>
    fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

test('records only technical allowlisted data; secrets, paths, dynamic payloads and stacks cannot leak', async t => {
  const marker = 'PRIVATE_PAYLOAD_58_e948';
  const { diagnostics, directory, root } = fixture(t, { metadata: {
    appVersion: '0.1.0', codexVersion: '0.154.0-alpha.6.2', chromeVersion: '146.0.7680.179', platform: 'win32', arch: 'x64',
    osRelease: '10.0.26100', buildId: 'abcdef1234567890', builtAt: '2026-09-18T10:20:30.123Z', releaseChannel: 'nightly',
    username: marker, cwd: marker, provider: marker, electronVersion: marker,
  } });
  const error = new Error(`Authorization Bearer ${marker}; message=${marker}; C:\\Users\\${marker}`);
  error.code = marker;
  error.data = { secret: marker };
  error.stack = `Error: ${marker}\n    at ${marker} (C:\\Users\\${marker}\\electron\\main.mjs:20:9)\n    at ${marker} (C:\\Users\\${marker}\\${marker}.mjs:44:8)\n    at handler (https://${marker}/dist/assets/index-${marker}.js:18:14)`;
  diagnostics.record('info', 'rpc.start', {
    method: 'turn/start', sessionId: diagnostics.id(marker), projectId: diagnostics.id(`C:\\${marker}`),
    requestId: 12, durationMs: 34, success: true, generation: 2,
    params: { input: marker }, text: marker, messages: [marker], headers: { Authorization: marker },
    url: `https://${marker}`, config: marker, model: marker,
  });
  diagnostics.error('rpc.failed', error, { method: 'turn/start', threadId: marker, code: marker });
  diagnostics.record('info', marker, { method: marker, state: marker, unknown: marker });
  diagnostics.error('renderer.error', { message: marker, stack: `Error: ${marker}`, name: marker }, { kind: 'react' });
  await diagnostics.flush();
  const target = path.join(root, 'report.json');
  const exported = await diagnostics.exportReport(target, { appVersion: '0.2.0', username: marker, nodeVersion: marker });
  const text = fs.readFileSync(target, 'utf8');
  assert.equal(text.includes(marker), false);
  const report = JSON.parse(text);
  assert.equal(report.environment.appVersion, '0.2.0');
  assert.equal(report.environment.codexVersion, '0.154.0-alpha.6.2');
  assert.equal(report.environment.chromeVersion, '146.0.7680.179');
  assert.equal(report.environment.buildId, 'abcdef1234567890');
  assert.equal(report.environment.builtAt, '2026-09-18T10:20:30.123Z');
  assert.equal(report.environment.releaseChannel, 'nightly');
  assert.equal(report.environment.electronVersion, undefined);
  const failed = report.logs.find(entry => entry.event === 'rpc.failed');
  assert.deepEqual(failed.data.error.frames, [{ file: 'main.mjs', line: 20, column: 9 }]);
  assert.equal(failed.data.error.code, undefined);
  assert.equal(failed.data.threadId, undefined);
  assert.match(failed.data.error.fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(exported.entries, report.logs.length);
  assert.equal(exported.bytes, Buffer.byteLength(text));
  assert.equal(readEntries(directory).some(entry => JSON.stringify(entry).includes(marker)), false);
  assert.equal(report.privacy.contentIncluded, false);
});

test('notification IPC and native failures preserve metadata only without titles or message content', async t => {
  const { diagnostics, directory } = fixture(t);
  const marker = 'PRIVATE_NOTIFICATION_TITLE_2138';
  diagnostics.record('info', 'ipc.start', { channel: 'host:notifySession', title: marker, eventId: marker, sessionId: diagnostics.id(marker) });
  diagnostics.error('notification.failed', new Error(marker), { title: marker, body: marker, command: marker });
  await diagnostics.flush();
  const entries = readEntries(directory);
  assert.equal(JSON.stringify(entries).includes(marker), false);
  assert.equal(entries.find(entry => entry.event === 'ipc.start').data.channel, 'host:notifySession');
  assert.equal(entries.some(entry => entry.event === 'notification.failed'), true);
});

test('classifies supported local and upstream failures without keeping their messages', t => {
  const { diagnostics, directory } = fixture(t);
  const cases = [
    [{ message: 'helper_sandbox_lock_failed SetNamedSecurityInfoW PRIVATE 5' }, 'sandbox_permission'],
    [{ message: 'thread PRIVATE already has an active writer', code: -32600 }, 'writer_conflict'],
    [{ message: 'thread PRIVATE not found' }, 'thread_not_found'],
    [{ message: 'Codex request timed out: PRIVATE' }, 'timeout'],
    [{ message: 'spawn PRIVATE ENOENT', code: 'ENOENT' }, 'not_found'],
    [{ message: 'Codex не найден. PRIVATE' }, 'not_found'],
    [{ message: 'PRIVATE', code: 'EPERM' }, 'permission_denied'],
    [{ message: 'PRIVATE', code: 'ENOSPC' }, 'disk_full'],
    [{ message: 'PRIVATE', code: 'ECONNREFUSED' }, 'connection_failed'],
    [{ message: 'PRIVATE', code: 'ECONNRESET' }, 'connection_closed'],
    [{ message: 'PRIVATE', code: -32601 }, 'unsupported_method'],
    [{ message: 'PRIVATE', codexErrorInfo: 'contextWindowExceeded' }, 'context_limit'],
    [{ message: 'PRIVATE', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502, raw: 'PRIVATE' } } }, 'connection_failed'],
    [{ message: 'PRIVATE', codexErrorInfo: 'unauthorized' }, 'authentication'],
    [{ message: 'PRIVATE', codexErrorInfo: 'serverOverloaded' }, 'server_error'],
    [new SyntaxError('PRIVATE'), 'invalid_json'],
  ];
  for (const [error] of cases) diagnostics.error('rpc.failed', error, { method: 'thread/resume' });
  const entries = readEntries(directory).filter(entry => entry.event === 'rpc.failed');
  assert.deepEqual(entries.map(entry => entry.data.error.category), cases.map(([, category]) => category));
  assert.equal(entries[12].data.error.httpStatusCode, 502);
  assert.equal(JSON.stringify(entries).includes('PRIVATE'), false);
  diagnostics.error('transport.diagnostic', 'WARN connection is closed PRIVATE', { reason: 'stderr' }, 'warn');
  assert.equal(readEntries(directory).at(-1).level, 'warn');
});

test('identifiers are stable within one run and unlinkable between process runs', t => {
  const { root, diagnostics } = fixture(t);
  const second = createDiagnostics({ directory: path.join(root, 'other') });
  assert.match(diagnostics.id('thread-real'), /^[a-f0-9]{16}$/);
  assert.equal(diagnostics.id('thread-real'), diagnostics.id('thread-real'));
  assert.notEqual(diagnostics.id('thread-real'), second.id('thread-real'));
  assert.equal(diagnostics.id(null), undefined);
  assert.equal(diagnostics.id({ toString() { throw new Error('foreign'); } }), undefined);
});

test('rotates bounded per-run files, exports recent history and repeats exact build metadata', async t => {
  const { directory, diagnostics, root } = fixture(t, {
    limits: { maxFileBytes: 1024, maxFiles: 3 }, metadata: { appVersion: '0.1.0', buildId: '1234567890abcdef' },
  });
  diagnostics.record('info', 'codex.version', { codexVersion: '0.154.0-alpha.6.2' });
  for (let i = 0; i < 120; i++) diagnostics.record('info', 'rpc.complete', { requestId: i, method: 'thread/list', durationMs: 5 });
  const names = fs.readdirSync(directory);
  assert.equal(names.length, 3);
  for (const name of names) {
    const filename = path.join(directory, name);
    assert.ok(fs.statSync(filename).size <= 1024);
    const entries = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries[0].event, 'diagnostics.run');
    assert.equal(entries[0].data.buildId, '1234567890abcdef');
    assert.equal(entries[0].data.codexVersion, '0.154.0-alpha.6.2');
    assert.ok(entries.every((entry, index) => index === 0 || entry.sequence > entries[index - 1].sequence));
  }
  assert.equal(diagnostics.status().writeErrors, 0);
  const target = path.join(root, 'rotated.json');
  await diagnostics.exportReport(target);
  const report = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(report.logs.filter(entry => entry.event === 'rpc.complete').at(-1).data.requestId, 119);
  assert.equal(report.limits.maxLogBytes, 3072);
});

test('collects prior-run failures and trims inactive logs to the shared budget', async t => {
  const { directory, diagnostics, root } = fixture(t, { metadata: { buildId: 'aaaaaaaaaaaaaaaa' } });
  diagnostics.error('app.fatal', new Error('previous failure'));
  // A crashed previous process has a different, no longer live PID.
  for (const name of fs.readdirSync(directory)) {
    fs.renameSync(path.join(directory, name), path.join(directory, name.replace(`-${process.pid}-`, '-2000000000-')));
  }
  const next = createDiagnostics({ directory, metadata: { buildId: 'bbbbbbbbbbbbbbbb' } });
  next.record('info', 'app.start');
  const target = path.join(root, 'prior.json');
  await next.exportReport(target);
  let report = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(report.logs.filter(entry => entry.event === 'app.fatal').length, 1);
  assert.equal(report.logs.find(entry => entry.event === 'diagnostics.run').data.buildId, 'aaaaaaaaaaaaaaaa');
  assert.equal(report.environment.buildId, 'bbbbbbbbbbbbbbbb');
  // Closed-run retention is bounded even across many restarts.
  for (let i = 0; i < 8; i++) {
    const run = createDiagnostics({ directory });
    run.record('info', 'app.ready');
    const name = fs.readdirSync(directory).find(file => file.includes(run.status().runId));
    fs.renameSync(path.join(directory, name), path.join(directory, name.replace(`-${process.pid}-`, '-2000000000-')));
  }
  createDiagnostics({ directory });
  assert.ok(fs.readdirSync(directory).length <= 6); // one live next logger plus global 5-file budget
  assert.equal(fs.readdirSync(directory).some(name => name.includes(next.status().runId)), true);
});

test('simultaneous instances use distinct files and cannot prune each other', async t => {
  const { diagnostics, directory, root } = fixture(t, { limits: { maxFileBytes: 1024, maxFiles: 2 } });
  const second = createDiagnostics({ directory, limits: { maxFileBytes: 1024, maxFiles: 2 } });
  for (let i = 0; i < 60; i++) {
    diagnostics.record('info', 'rpc.start', { requestId: i, method: 'thread/list' });
    second.record('info', 'rpc.start', { requestId: i, method: 'thread/read' });
  }
  const entries = readEntries(directory);
  assert.equal(entries.some(entry => entry.runId === diagnostics.status().runId && entry.data.requestId === 59), true);
  assert.equal(entries.some(entry => entry.runId === second.status().runId && entry.data.requestId === 59), true);
  assert.equal(fs.readdirSync(directory).length, 4);
  await diagnostics.exportReport(path.join(root, 'multi.json'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'multi.json'), 'utf8')).storage.exportedFiles <= 2);
});

test('logging failures never throw, expose degraded status and recover when storage becomes writable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desk-diagnostics-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'blocked');
  fs.writeFileSync(directory, 'existing user file');
  const diagnostics = createDiagnostics({ directory });
  assert.equal(diagnostics.status().available, false);
  assert.doesNotThrow(() => diagnostics.record('info', 'app.start'));
  assert.doesNotThrow(() => diagnostics.error('app.fatal', new Error('failure')));
  assert.ok(diagnostics.status().writeErrors > 0);
  assert.equal(fs.readFileSync(directory, 'utf8'), 'existing user file');
  await diagnostics.exportReport(path.join(root, 'storage-failed.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'storage-failed.json'), 'utf8')).logs, []);
  fs.unlinkSync(directory);
  diagnostics.record('info', 'app.ready');
  assert.equal(diagnostics.status().available, true);
  assert.equal(readEntries(directory).at(-1).event, 'app.ready');
  await assert.rejects(diagnostics.exportReport(path.join(root, 'missing-parent', 'report.json')));
  assert.equal(diagnostics.status().available, true);
});

test('export revalidates records, ignores foreign files, hardlinks, truncation and oversized files', async t => {
  const { directory, diagnostics, root } = fixture(t);
  const marker = 'SECRET_FOREIGN_PAYLOAD';
  fs.writeFileSync(path.join(directory, 'config.toml'), marker);
  fs.writeFileSync(path.join(root, 'outside.jsonl'), marker);
  const foreign = `desk-1777777777777-${process.pid}-cccccccccccccccc.000000.jsonl`;
  fs.linkSync(path.join(root, 'outside.jsonl'), path.join(directory, foreign));
  const tampered = `desk-1777777777777-${process.pid}-dddddddddddddddd.000000.jsonl`;
  const entry = { time: new Date().toISOString(), runId: 'dddddddddddddddd', sequence: 1, level: marker,
    event: marker, data: { text: marker, method: marker, error: { message: marker, category: marker, frames: [{ file: marker, line: 1, column: 1 }] } } };
  fs.writeFileSync(path.join(directory, tampered), `${JSON.stringify(entry)}\n{"unfinished":"${marker}`);
  const huge = `desk-1777777777777-${process.pid}-eeeeeeeeeeeeeeee.000000.jsonl`;
  fs.writeFileSync(path.join(directory, huge), marker.repeat(130_000));
  const target = path.join(root, 'safe.json');
  await diagnostics.exportReport(target);
  const output = fs.readFileSync(target, 'utf8');
  assert.equal(output.includes(marker), false);
  assert.equal(JSON.parse(output).logs.some(log => log.runId === 'dddddddddddddddd' && log.event === 'unknown'), true);
  assert.equal(fs.readFileSync(path.join(root, 'outside.jsonl'), 'utf8'), marker);
});

test('diagnostics refuses a linked directory and export never follows a linked log', async t => {
  const { directory, diagnostics, root } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'PRIVATE_LINK_DATA');
  const linkedRoot = path.join(root, 'linked-logs');
  fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createDiagnostics({ directory: linkedRoot });
  linked.record('info', 'app.start');
  assert.equal(linked.status().available, false);
  assert.deepEqual(fs.readdirSync(outside), ['private.txt']);
  const linkedName = `desk-1777777777777-${process.pid}-ffffffffffffffff.000000.jsonl`;
  // Directory junctions do not need Developer Mode on Windows and are also
  // rejected as log candidates, just like symbolic file links.
  fs.symlinkSync(outside, path.join(directory, linkedName), process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(root, 'linked-export.json');
  await diagnostics.exportReport(target);
  assert.equal(fs.readFileSync(target, 'utf8').includes('PRIVATE_LINK_DATA'), false);
});

test('hostile getters and errors with unserializable extra fields do not interrupt logging', t => {
  const { diagnostics, directory } = fixture(t);
  const data = { method: 'turn/start', requestId: 1 };
  Object.defineProperty(data, 'text', { get() { throw new Error('must not run'); } });
  Object.defineProperty(data, 'reason', { get() { throw new Error('must not run'); } });
  const error = { message: 'timeout', data: BigInt(8) };
  Object.defineProperty(error, 'stack', { get() { throw new Error('must not run'); } });
  assert.doesNotThrow(() => diagnostics.record('info', 'rpc.start', data));
  assert.doesNotThrow(() => diagnostics.error('rpc.failed', error));
  assert.equal(readEntries(directory).at(-1).data.error.category, 'timeout');
  assert.equal(diagnostics.status().writeErrors, 0);
});
