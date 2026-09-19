import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitRollbackService, ROLLBACK_FILE_LIMIT, ROLLBACK_PREVIEW_MS } from '../electron/git-rollback.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const artifacts = path.resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, 'git-rollback-'));
  assert.equal(path.dirname(base), artifacts);
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'Проект с пробелами');
  const directory = path.join(base, 'backups');
  await mkdir(cwd);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => exec('git', args, { cwd, env, windowsHide: true });
  await git('init', '--initial-branch=fixture');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'commit.gpgSign', 'false');
  const write = async (name, bytes) => { await mkdir(path.dirname(path.join(cwd, name)), { recursive: true }); await writeFile(path.join(cwd, name), bytes); };
  const commit = async () => { await git('add', '--all'); await git('commit', '-m', 'fixture', '--no-verify'); };
  const service = new GitRollbackService({ directory });
  return { base, cwd, directory, git, write, commit, service };
}

test('rollback previews current→index and restores only unstaged bytes; durable undo survives restart and keeps index/config intact', async t => {
  const { cwd, directory, git, write, commit, service } = await fixture(t);
  const relative = 'Файл [1].txt';
  await write(relative, 'HEAD\n'); await commit();
  await write(relative, 'staged\n'); await git('add', '--', relative);
  const original = Buffer.from('unstaged\r\nextra\nno final newline');
  await write(relative, original);
  const index = await readFile(path.join(cwd, '.git/index'));
  const config = await readFile(path.join(cwd, '.git/config'));
  const indexStat = await stat(path.join(cwd, '.git/index'));
  const preview = await service.preview({ cwd, path: relative });
  assert.equal(preview.operation, 'restore');
  assert.match(preview.diff, /-unstaged\r?\n/); assert.match(preview.diff, /\+staged\n/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(cwd, relative)), original);
  const result = await service.apply({ cwd, previewId: preview.previewId });
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), 'staged\n');
  assert.deepEqual(await readFile(path.join(directory, `${result.undoId}.before`)), original);
  const restarted = new GitRollbackService({ directory });
  assert.deepEqual(await restarted.list({ cwd }), [result]);
  const undo = await restarted.previewUndo({ cwd, undoId: result.undoId });
  assert.equal(undo.operation, 'undo');
  assert.match(undo.diff, /-staged/);
  await restarted.applyUndo({ cwd, previewId: undo.previewId });
  assert.deepEqual(await readFile(path.join(cwd, relative)), original);
  assert.deepEqual(await restarted.list({ cwd }), []);
  assert.deepEqual(await readFile(path.join(cwd, '.git/index')), index);
  assert.equal((await stat(path.join(cwd, '.git/index'))).mtimeMs, indexStat.mtimeMs);
  assert.deepEqual(await readFile(path.join(cwd, '.git/config')), config);
  assert.deepEqual(await readFile(path.join(directory, `${result.undoId}.before`)), original);
});

test('rollback deleted file and undo returns exact absence without creating missing parent folders', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  await write('sub/gone.txt', 'saved\n'); await commit();
  await rm(path.join(cwd, 'sub/gone.txt'));
  const preview = await service.preview({ cwd, path: 'sub/gone.txt' });
  assert.match(preview.diff, /new file mode/);
  const result = await service.apply({ cwd, previewId: preview.previewId });
  assert.equal(await readFile(path.join(cwd, 'sub/gone.txt'), 'utf8'), 'saved\n');
  const undo = await service.previewUndo({ cwd, undoId: result.undoId });
  assert.match(undo.diff, /deleted file mode/);
  await service.applyUndo({ cwd, previewId: undo.previewId });
  await assert.rejects(stat(path.join(cwd, 'sub/gone.txt')), { code: 'ENOENT' });
  await rmdir(path.join(cwd, 'sub'));
  await assert.rejects(service.preview({ cwd, path: 'sub/gone.txt' }), /Родительская папка/);
});

test('rollback respects built-in CRLF Git checkout conversion and undo preserves original mixed newlines', async t => {
  const { cwd, git, write, commit, service } = await fixture(t);
  await write('.gitattributes', '*.txt text eol=crlf\n');
  await write('file.txt', 'one\ntwo\n'); await commit();
  const original = Buffer.from('user\r\nthree\n');
  await write('file.txt', original);
  const result = await service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId });
  assert.deepEqual(await readFile(path.join(cwd, 'file.txt')), Buffer.from('one\r\ntwo\r\n'));
  await service.applyUndo({ cwd, previewId: (await service.previewUndo({ cwd, undoId: result.undoId })).previewId });
  assert.deepEqual(await readFile(path.join(cwd, 'file.txt')), original);
  await git('config', 'core.autocrlf', 'true');
  await write('.gitattributes', '');
  const second = await service.preview({ cwd, path: 'file.txt' });
  await service.apply({ cwd, previewId: second.previewId });
  assert.deepEqual(await readFile(path.join(cwd, 'file.txt')), Buffer.from('one\r\ntwo\r\n'));
});

test('rollback rejects stale working bytes, inode replacement, changed index and changed newline configuration', async t => {
  const { cwd, git, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit();
  for (const mutation of ['working', 'inode', 'index', 'config']) {
    await write('file.txt', `original ${mutation}\n`);
    const preview = await service.preview({ cwd, path: 'file.txt' });
    if (mutation === 'working') await write('file.txt', 'new user bytes\n');
    if (mutation === 'inode') { await write('replacement.txt', `original ${mutation}\n`); await rename(path.join(cwd, 'replacement.txt'), path.join(cwd, 'file.txt')); }
    if (mutation === 'index') await git('add', '--', 'file.txt');
    if (mutation === 'config') await git('config', 'core.autocrlf', 'true');
    const before = await readFile(path.join(cwd, 'file.txt'));
    await assert.rejects(service.apply({ cwd, previewId: preview.previewId }), /изменились/);
    assert.deepEqual(await readFile(path.join(cwd, 'file.txt')), before);
  }
});

test('undo refuses user modifications after rollback and after its own preview', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit();
  await write('file.txt', 'first\n');
  const result = await service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId });
  const undo = await service.previewUndo({ cwd, undoId: result.undoId });
  await write('file.txt', 'newer user edits\n');
  await assert.rejects(service.previewUndo({ cwd, undoId: result.undoId }), /После отката файл изменился/);
  await assert.rejects(service.applyUndo({ cwd, previewId: undo.previewId }), /изменились/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'newer user edits\n');
});

test('preview capabilities expire, cannot be reused or used from a different selected cwd', async t => {
  const { cwd, directory, write, commit } = await fixture(t);
  await write('sub/file.txt', 'base\n'); await commit(); await write('sub/file.txt', 'work\n');
  let now = Date.now();
  const service = new GitRollbackService({ directory, now: () => now });
  const preview = await service.preview({ cwd, path: 'sub/file.txt' });
  await assert.rejects(service.apply({ cwd: path.join(cwd, 'sub'), previewId: preview.previewId }), /другой рабочей папке/);
  now += ROLLBACK_PREVIEW_MS;
  await assert.rejects(service.apply({ cwd, previewId: preview.previewId }), /истёк/);
  const next = await service.preview({ cwd, path: 'sub/file.txt' });
  const result = await service.apply({ cwd, previewId: next.previewId });
  await assert.rejects(service.apply({ cwd, previewId: next.previewId }), /использован/);
  await assert.rejects(service.previewUndo({ cwd: path.join(cwd, 'sub'), undoId: result.undoId }), /другой рабочей папке/);
  assert.deepEqual(await service.list({ cwd: path.join(cwd, 'sub') }), []);
});

test('backup and journal failure leave worktree intact; failed final journal remains recoverable after restart', async t => {
  const { cwd, base, directory, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit(); await write('file.txt', 'user\n');
  const blocked = path.join(base, 'not-a-directory'); await writeFile(blocked, 'blocked');
  const bad = new GitRollbackService({ directory: blocked });
  await assert.rejects(bad.apply({ cwd, previewId: (await bad.preview({ cwd, path: 'file.txt' })).previewId }));
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'user\n');
  const originalJournal = service.journal.bind(service);
  service.journal = async () => { throw new Error('backup disk full'); };
  await assert.rejects(service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId }), /backup disk full/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'user\n');
  let writes = 0;
  service.journal = async record => { if (++writes === 2) throw new Error('final journal failed'); return originalJournal(record); };
  await assert.rejects(service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId }), /final journal failed.*Резервная копия сохранена/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'base\n');
  const restarted = new GitRollbackService({ directory });
  const records = await restarted.list({ cwd }); assert.equal(records.length, 1);
  await restarted.applyUndo({ cwd, previewId: (await restarted.previewUndo({ cwd, undoId: records[0].undoId })).previewId });
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'user\n');
});

test('binary bytes restore and undo exactly, while oversized input is rejected', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  const original = Buffer.from([0, 255, 1, 2]);
  await write('file.bin', original); await commit();
  const work = Buffer.from([0, 255, 5, 6]); await write('file.bin', work);
  const preview = await service.preview({ cwd, path: 'file.bin' });
  assert.equal(preview.binary, true); assert.equal(preview.diff, '');
  const result = await service.apply({ cwd, previewId: preview.previewId });
  assert.deepEqual(await readFile(path.join(cwd, 'file.bin')), original);
  await service.applyUndo({ cwd, previewId: (await service.previewUndo({ cwd, undoId: result.undoId })).previewId });
  assert.deepEqual(await readFile(path.join(cwd, 'file.bin')), work);
  await write('file.bin', Buffer.alloc(ROLLBACK_FILE_LIMIT + 1));
  await assert.rejects(service.preview({ cwd, path: 'file.bin' }), /8 МиБ/);
});

test('rollback rejects untracked/staged-only/renamed paths, hardlinks, unsafe paths and external filters without invoking helper', async t => {
  const { base, cwd, git, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit();
  await write('new.txt', 'new\n');
  await assert.rejects(service.preview({ cwd, path: 'new.txt' }), /Не подготовлено/);
  await write('file.txt', 'staged\n'); await git('add', '--', 'file.txt');
  await assert.rejects(service.preview({ cwd, path: 'file.txt' }), /Не подготовлено/);
  await commit();
  await git('mv', 'file.txt', 'renamed.txt'); await write('renamed.txt', 'work\n');
  await assert.rejects(service.preview({ cwd, path: 'renamed.txt' }), /переименований/);
  await git('mv', 'renamed.txt', 'file.txt');
  await link(path.join(cwd, 'file.txt'), path.join(cwd, 'hardlink.txt'));
  await assert.rejects(service.preview({ cwd, path: 'file.txt' }), /жёстких ссылок/);
  await rm(path.join(cwd, 'hardlink.txt'));
  for (const relative of ['../file.txt', '.git/config', 'sub/../file.txt', 'C:\\file.txt', './file.txt']) await assert.rejects(service.preview({ cwd, path: relative }));
  const marker = path.join(base, 'HELPER-WAS-RUN');
  const helper = path.join(base, 'helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1);`);
  const command = `node "${helper.replaceAll('\\', '/')}"`;
  for (const key of ['filter.fixture.clean', 'filter.fixture.smudge', 'filter.fixture.process', 'core.fsmonitor']) await git('config', key, command);
  await write('.gitattributes', '*.txt filter=fixture\n');
  await assert.rejects(service.preview({ cwd, path: 'file.txt' }), /внешними фильтрами/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('parent junction swaps after preview are rejected and do not write outside project', async t => {
  const { base, cwd, write, commit, service } = await fixture(t);
  await write('sub/file.txt', 'base\n'); await commit(); await write('sub/file.txt', 'work\n');
  const preview = await service.preview({ cwd, path: 'sub/file.txt' });
  const outside = path.join(base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'file.txt'), 'private\n');
  await rename(path.join(cwd, 'sub'), path.join(cwd, 'saved-sub'));
  try { await symlink(outside, path.join(cwd, 'sub'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Links unavailable: ${error.code}`); return; } throw error; }
  await assert.rejects(service.apply({ cwd, previewId: preview.previewId }), /ссылки|junction/);
  assert.equal(await readFile(path.join(outside, 'file.txt'), 'utf8'), 'private\n');
  assert.deepEqual(await readdir(outside), ['file.txt']);
});

test('session invalidation before replacement aborts and retains worktree', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit(); await write('file.txt', 'user\n');
  const preview = await service.preview({ cwd, path: 'file.txt' });
  let active = true;
  const originalJournal = service.journal.bind(service);
  service.journal = async record => { await originalJournal(record); active = false; };
  await assert.rejects(service.apply({ cwd, previewId: preview.previewId, assertActive: () => { if (!active) throw new Error('session changed'); } }), /session changed/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'user\n');
});

test('last-moment external edit during backup is checked again and preserved', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit(); await write('file.txt', 'user\n');
  const preview = await service.preview({ cwd, path: 'file.txt' });
  const originalJournal = service.journal.bind(service);
  service.journal = async record => { await originalJournal(record); await write('file.txt', 'concurrent editor\n'); };
  await assert.rejects(service.apply({ cwd, previewId: preview.previewId }), /изменились/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'concurrent editor\n');
});

test('corrupted original backup cannot overwrite a restored file', async t => {
  const { cwd, directory, write, commit, service } = await fixture(t);
  await write('file.txt', 'base\n'); await commit(); await write('file.txt', 'user\n');
  const result = await service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId });
  await writeFile(path.join(directory, `${result.undoId}.before`), 'corrupted');
  await assert.rejects(service.previewUndo({ cwd, undoId: result.undoId }), /целостности/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'base\n');
});

test('backup directory ancestor junction is refused before any worktree write', async t => {
  const { base, cwd, write, commit } = await fixture(t);
  await write('file.txt', 'base\n'); await commit(); await write('file.txt', 'user\n');
  const outside = path.join(base, 'outside-backups'); await mkdir(outside);
  const linked = path.join(base, 'linked');
  try { await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Links unavailable: ${error.code}`); return; } throw error; }
  const service = new GitRollbackService({ directory: path.join(linked, 'backups') });
  await assert.rejects(service.apply({ cwd, previewId: (await service.preview({ cwd, path: 'file.txt' })).previewId }), /через ссылку/);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'user\n');
  assert.deepEqual(await readdir(outside), []);
});

test('multi-hunk preview lists fragments; a partial restore keeps unselected edits byte-exact and stays undoable', async t => {
  const { cwd, git, write, commit, service } = await fixture(t);
  const relative = 'src/partial.ts';
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
  await write(relative, '﻿' + base); await commit();
  const edited = ('﻿' + base).replace('line 3\r\n', 'line 3 edited\r\n').replace('line 15\r\n', 'line 15 inserted\r\nline 15\r\n').replace('line 28\r\n', '');
  await write(relative, edited);
  const preview = await service.preview({ cwd, path: relative });
  assert.equal(preview.hunks.length, 3);
  assert.deepEqual(preview.hunks.map(h => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.removed, h.added]), [[1, 6, 1, 6, 1, 1], [12, 7, 12, 6, 1, 0], [26, 5, 25, 6, 0, 1]]);
  assert.equal(preview.hunks[0].excerpt, 'line 3 edited');
  assert.equal((preview.diff.match(/^@@ /gm) || []).length, 3, 'three hunks in the unified diff');
  assert.match(preview.diff, /^@@ -12,7 \+12,6 @@$/m);
  // Malformed selections are rejected before the one-shot preview is consumed; out-of-range consumes it but changes nothing.
  const selected = await service.preview({ cwd, path: relative });
  for (const hunks of [[], [0, 0], [-1], ['0']]) await assert.rejects(service.apply({ cwd, previewId: selected.previewId, hunks }), /фрагмент/i);
  const stale = await service.preview({ cwd, path: relative });
  await assert.rejects(service.apply({ cwd, previewId: stale.previewId, hunks: [3] }), /фрагмент/i);
  await assert.rejects(service.apply({ cwd, previewId: stale.previewId, hunks: [0] }), /истёк|использован/);
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), edited);
  const result = await service.apply({ cwd, previewId: selected.previewId, hunks: [2, 0] });
  const expected = ('﻿' + base).replace('line 15\r\n', 'line 15 inserted\r\nline 15\r\n');
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), expected, 'first and last hunks return to the index; the middle insertion, BOM and CRLF stay');
  const again = await service.preview({ cwd, path: relative });
  assert.equal(again.hunks, undefined, 'one remaining hunk offers no fragment selection');
  assert.match(again.diff, /-line 15 inserted/);
  const undo = await service.previewUndo({ cwd, undoId: result.undoId });
  await service.applyUndo({ cwd, previewId: undo.previewId });
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), edited, 'undo restores the exact pre-rollback bytes');
  // Selecting every hunk is the exact full restore.
  const full = await service.preview({ cwd, path: relative });
  await service.apply({ cwd, previewId: full.previewId, hunks: [0, 1, 2] });
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), '﻿' + base);
  const deleted = await service.preview({ cwd, path: 'missing.txt' }).catch(() => null);
  assert.equal(deleted, null);
  await git('status');
});

test('deleted files and undo previews never offer fragments; no-newline endings survive a partial restore', async t => {
  const { cwd, write, commit, service } = await fixture(t);
  const base = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  await write('gone.txt', 'a\nb\n'); await write('tail.txt', base); await commit();
  await rm(path.join(cwd, 'gone.txt'));
  const gone = await service.preview({ cwd, path: 'gone.txt' });
  assert.equal(gone.hunks, undefined);
  await write('tail.txt', base.replace('l1\n', 'l1 changed\n').replace('l3\n', 'l3 changed\n'));
  const tail = await service.preview({ cwd, path: 'tail.txt' });
  assert.equal(tail.hunks, undefined, 'two edits within context distance form a single hunk');
  const edited = base.replace('l1\n', 'l1 changed\n') + 'tail';
  await write('tail.txt', edited);
  const spaced = await service.preview({ cwd, path: 'tail.txt' });
  assert.equal(spaced.hunks.length, 2);
  assert.match(spaced.diff, /\ No newline at end of file/);
  const result = await service.apply({ cwd, previewId: spaced.previewId, hunks: [1] });
  assert.equal(await readFile(path.join(cwd, 'tail.txt'), 'utf8'), base.replace('l1\n', 'l1 changed\n'), 'the tail hunk returns to the index; the first edit stays');
  const undo = await service.previewUndo({ cwd, undoId: result.undoId });
  assert.equal(undo.hunks, undefined);
  await service.applyUndo({ cwd, previewId: undo.previewId });
  assert.equal(await readFile(path.join(cwd, 'tail.txt'), 'utf8'), edited);
});
