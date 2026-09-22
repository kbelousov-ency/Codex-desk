import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GIT_OUTPUT_LIMIT, GIT_UNTRACKED_LIMIT, getGitDiff, getGitStatus } from '../electron/git-reader.mjs';

const exec = promisify(execFile);
async function fixture(t, { bare = false, repository = true } = {}) {
  const artifacts = repository ? path.resolve('artifacts') : os.tmpdir();
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, 'git-reader-'));
  assert.equal(path.dirname(base), artifacts);
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'Проект с пробелами');
  await mkdir(cwd);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => exec('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, windowsHide: true });
  if (repository) {
    await git('init', ...(bare ? ['--bare'] : []), '--initial-branch=fixture');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await git('config', 'core.autocrlf', 'false');
    await git('config', 'commit.gpgSign', 'false');
  }
  const write = async (name, contents) => {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), contents);
  };
  const commit = async () => { await git('add', '--all'); await git('commit', '-m', 'fixture', '--no-verify'); };
  return { base, cwd, git, write, commit };
}

test('Git exposes a meaningful unavailable state for plain folders and bare repositories', async t => {
  const plain = await fixture(t, { repository: false });
  assert.deepEqual(await getGitStatus({ cwd: plain.cwd }), { available: false, reason: 'not-repository', entries: [] });
  const bare = await fixture(t, { bare: true });
  assert.deepEqual(await getGitStatus({ cwd: bare.cwd }), { available: false, reason: 'bare', entries: [] });
});

test('Git handles unborn HEAD, ignored files and empty new files', async t => {
  const { cwd, git, write } = await fixture(t);
  await write('.gitignore', 'ignored.txt\n');
  await write('ignored.txt', 'secret');
  await write('new.txt', 'first\nsecond');
  await write('empty.txt', '');
  await write('staged.txt', 'staged\n');
  await git('add', 'staged.txt');
  const status = await getGitStatus({ cwd });
  assert.equal(status.available, true);
  assert.equal(status.unborn, true);
  assert.equal(status.branch, 'fixture');
  assert.equal(status.head, undefined);
  assert.equal(status.entries.find(entry => entry.path === 'staged.txt').staged, true);
  assert.equal(status.entries.some(entry => entry.path === 'ignored.txt'), false);
  const staged = await getGitDiff({ cwd, path: 'staged.txt', area: 'staged' });
  assert.match(staged.diff, /new file mode/);
  assert.match(staged.diff, /\+staged/);
  const untracked = await getGitDiff({ cwd, path: 'new.txt', area: 'untracked' });
  assert.match(untracked.diff, /@@ -0,0 \+1,2 @@\n\+first\n\+second\n\\ No newline at end of file/);
  const empty = await getGitDiff({ cwd, path: 'empty.txt', area: 'untracked' });
  assert.match(empty.diff, /new file mode/);
  assert.doesNotMatch(empty.diff, /@@/);
});

test('Git distinguishes staged and unstaged content, delete, Unicode and detached HEAD without writing the index', async t => {
  const { cwd, git, write, commit } = await fixture(t);
  await write('Русский файл [1].txt', 'before\n');
  await write('deleted.txt', 'gone\n');
  await commit();
  await git('checkout', '--detach');
  await write('Русский файл [1].txt', 'staged\n');
  await git('add', '--', 'Русский файл [1].txt');
  await write('Русский файл [1].txt', 'unstaged\n');
  await rm(path.join(cwd, 'deleted.txt'));
  const indexPath = path.join(cwd, '.git', 'index');
  const configPath = path.join(cwd, '.git', 'config');
  const before = { index: await readFile(indexPath), indexStat: await stat(indexPath), config: await readFile(configPath) };
  const status = await getGitStatus({ cwd });
  assert.equal(status.detached, true);
  assert.match(status.head, /^[a-f\d]{40,64}$/);
  assert.equal(status.branch, undefined);
  const entry = status.entries.find(item => item.path === 'Русский файл [1].txt');
  assert.equal(entry.staged, true);
  assert.equal(entry.unstaged, true);
  assert.equal(entry.indexStatus, 'M');
  assert.equal(entry.worktreeStatus, 'M');
  const staged = await getGitDiff({ cwd, path: entry.path, area: 'staged' });
  assert.match(staged.diff, /-before\n\+staged/);
  assert.doesNotMatch(staged.diff, /unstaged/);
  const unstaged = await getGitDiff({ cwd, path: entry.path, area: 'unstaged' });
  assert.match(unstaged.diff, /-staged\n\+unstaged/);
  const deleted = await getGitDiff({ cwd, path: 'deleted.txt', area: 'unstaged' });
  assert.match(deleted.diff, /deleted file mode/);
  assert.deepEqual(await readFile(indexPath), before.index);
  assert.equal((await stat(indexPath)).mtimeMs, before.indexStat.mtimeMs);
  assert.deepEqual(await readFile(configPath), before.config);
  assert.equal(await readFile(path.join(cwd, entry.path), 'utf8'), 'unstaged\n');
});

test('Git scopes nested cwd and preserves within-scope renames without leaking sibling files', async t => {
  const { cwd, git, write, commit } = await fixture(t);
  await write('sub/старое.txt', 'same\n');
  await write('outside.txt', 'outside\n');
  await commit();
  await git('mv', '--', 'sub/старое.txt', 'sub/новое.txt');
  await write('outside.txt', 'private change\n');
  await write('sub/new.txt', 'inside\n');
  const selected = path.join(cwd, 'sub');
  const status = await getGitStatus({ cwd: selected });
  assert.equal(status.root.toLowerCase(), cwd.toLowerCase());
  assert.deepEqual(status.entries.map(entry => entry.path).sort(), ['new.txt', 'новое.txt']);
  const renamed = status.entries.find(entry => entry.path === 'новое.txt');
  assert.equal(renamed.originalPath, 'старое.txt');
  assert.equal(renamed.indexStatus, 'R');
  const diff = await getGitDiff({ cwd: selected, path: renamed.path, area: 'staged' });
  assert.match(diff.diff, /rename from старое.txt\nrename to новое.txt/);
  assert.doesNotMatch(diff.diff, /outside|private change|sub\//);
  await assert.rejects(getGitDiff({ cwd: selected, path: '../outside.txt', area: 'unstaged' }), /пределами/);
  await assert.rejects(getGitDiff({ cwd: selected, path: 'outside.txt', area: 'unstaged' }), /Состояние файла/);
});

test('Git does not expose an out-of-scope rename source', async t => {
  const { cwd, git, write, commit } = await fixture(t);
  await write('outside.txt', 'source\n');
  await write('sub/existing.txt', 'existing\n');
  await commit();
  await git('mv', '--', 'outside.txt', 'sub/inside.txt');
  const selected = path.join(cwd, 'sub');
  const status = await getGitStatus({ cwd: selected });
  const entry = status.entries.find(entry => entry.path === 'inside.txt');
  assert.equal(entry.originalPath, undefined);
  const diff = await getGitDiff({ cwd: selected, path: entry.path, area: 'staged' });
  assert.doesNotMatch(diff.diff, /outside\.txt/);
  assert.match(diff.diff, /new file mode|\+source/);
});

test('Git treats magic-looking, dash and glob names as literal pathspecs and rejects invalid/stale requests', async t => {
  const { cwd, git, write, commit } = await fixture(t);
  for (const name of ['-file.txt', '[glob].txt', 'normal.txt']) await write(name, 'old\n');
  await commit();
  for (const name of ['-file.txt', '[glob].txt', 'normal.txt']) await write(name, `${name}\n`);
  for (const name of ['-file.txt', '[glob].txt']) {
    const diff = await getGitDiff({ cwd, path: name, area: 'unstaged' });
    assert.ok(diff.diff.includes(`+${name}`));
    assert.doesNotMatch(diff.diff, /\+normal\.txt/);
  }
  for (const name of ['../outside', '/etc/passwd', 'C:\\Windows', '\\server\\share', './normal.txt', 'sub/../normal.txt', 'normal.txt\0']) await assert.rejects(getGitDiff({ cwd, path: name, area: 'unstaged' }));
  await assert.rejects(getGitDiff({ cwd, path: 'normal.txt', area: 'staged' }), /Состояние файла/);
  await assert.rejects(getGitDiff({ cwd, path: 'normal.txt', area: 'anything' }), /область/);
  await git('add', '--', 'normal.txt');
  await assert.rejects(getGitDiff({ cwd, path: 'normal.txt', area: 'unstaged' }), /Состояние файла/);
});

test('Git marks actual merge conflicts and declines misleading ordinary diffs', async t => {
  const { cwd, git, write, commit } = await fixture(t);
  await write('conflict.txt', 'base\n');
  await commit();
  await git('checkout', '-b', 'other');
  await write('conflict.txt', 'other\n');
  await commit();
  await git('checkout', 'fixture');
  await write('conflict.txt', 'main\n');
  await commit();
  await assert.rejects(git('merge', 'other', '--no-edit'));
  const status = await getGitStatus({ cwd });
  const entry = status.entries.find(item => item.path === 'conflict.txt');
  assert.equal(entry.conflicted, true);
  assert.equal(entry.indexStatus, 'U');
  assert.equal(entry.worktreeStatus, 'U');
  const diff = await getGitDiff({ cwd, path: entry.path, area: 'unstaged' });
  assert.equal(diff.diff, '');
  assert.match(diff.message, /конфликт/);
});

test('Git detects binary and oversized new files, and binary tracked changes', async t => {
  const { cwd, write, commit } = await fixture(t);
  await write('tracked.bin', Buffer.from([0, 1, 2, 3]));
  await commit();
  await write('tracked.bin', Buffer.from([0, 1, 2, 4]));
  await write('new.bin', Buffer.from([0, 1, 2]));
  await write('encoding.txt', Buffer.from([0xff, 0xfe, 1, 2]));
  await write('large.txt', Buffer.alloc(GIT_UNTRACKED_LIMIT + 1, 65));
  for (const name of ['new.bin', 'encoding.txt']) {
    const diff = await getGitDiff({ cwd, path: name, area: 'untracked' });
    assert.equal(diff.binary, true);
    assert.equal(diff.diff, '');
  }
  assert.equal((await getGitDiff({ cwd, path: 'tracked.bin', area: 'unstaged' })).binary, true);
  const large = await getGitDiff({ cwd, path: 'large.txt', area: 'untracked' });
  assert.equal(large.truncated, true);
  assert.equal(large.diff, '');
});

test('Git disables external diff, textconv, clean/process filters and fsmonitor without changing config', async t => {
  const { base, cwd, git, write, commit } = await fixture(t);
  await write('tracked.txt', 'old\n');
  await commit();
  await write('tracked.txt', 'new\n');
  await write('.gitattributes', '*.txt diff=fixture filter=fixture\n');
  const marker = path.join(base, 'HELPER-WAS-RUN');
  const helper = path.join(base, 'helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1);`);
  const command = `node "${helper.replaceAll('\\', '/')}"`;
  for (const key of ['diff.external', 'diff.fixture.command', 'diff.fixture.textconv', 'filter.fixture.clean', 'filter.fixture.process', 'core.fsmonitor']) await git('config', key, command);
  await git('config', 'filter.fixture.required', 'true');
  const config = await readFile(path.join(cwd, '.git', 'config'));
  const index = await readFile(path.join(cwd, '.git', 'index'));
  const status = await getGitStatus({ cwd });
  assert.ok(status.entries.some(entry => entry.path === 'tracked.txt'));
  assert.match(status.message, /фильтры Git отключены/);
  const diff = await getGitDiff({ cwd, path: 'tracked.txt', area: 'unstaged' });
  assert.match(diff.diff, /-old\n\+new/);
  assert.match(diff.message, /фильтры Git отключены/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'config')), config);
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'index')), index);
});

test('Git ignores inherited repository and config environment injections', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await a.write('a.txt', 'a\n');
  await b.write('private.txt', 'private\n');
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GIT_DIR: path.join(b.cwd, '.git'), GIT_WORK_TREE: b.cwd, GIT_INDEX_FILE: path.join(b.cwd, '.git', 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
    const status = await getGitStatus({ cwd: a.cwd });
    assert.equal(status.available, true);
    assert.deepEqual(status.entries.map(entry => entry.path), ['a.txt']);
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});

test('Git rejects worktree paths through directory links and late session results', async t => {
  const { base, cwd, write } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'private');
  await write('normal.txt', 'normal');
  try { await symlink(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Links unavailable: ${error.code}`); return; } throw error; }
  const status = await getGitStatus({ cwd });
  const linked = status.entries.find(entry => entry.path === 'link' || entry.path.startsWith('link/'));
  if (linked) {
    const diff = await getGitDiff({ cwd, path: linked.path, area: 'untracked' });
    assert.equal(diff.diff, '');
    assert.match(diff.message, /Ссылки/);
  }
  let checks = 0;
  await assert.rejects(getGitStatus({ cwd, assertActive: () => { if (++checks > 3) throw new Error('session changed'); } }), /session changed/);
  checks = 0;
  await assert.rejects(getGitDiff({ cwd, path: 'normal.txt', area: 'untracked', assertActive: () => { if (++checks > 7) throw new Error('session changed'); } }), /session changed/);
});

test('Git preserves newline and magic filenames on platforms that support them', { skip: process.platform === 'win32' }, async t => {
  const { cwd, write, commit } = await fixture(t);
  const names = [':(top)*', 'line\nname.txt', 'quote"name.txt'];
  for (const name of names) await write(name, 'old\n');
  await commit();
  for (const name of names) await write(name, 'new\n');
  const status = await getGitStatus({ cwd });
  assert.deepEqual(status.entries.map(entry => entry.path).sort(), names.sort());
  for (const name of names) assert.match((await getGitDiff({ cwd, path: name, area: 'unstaged' })).diff, /-old\n\+new/);
});

test('Git bounds tracked diff output at a complete line and reports truncation', async t => {
  const { cwd, write, commit } = await fixture(t);
  await write('large.txt', 'base\n');
  await commit();
  await write('large.txt', 'large line\n'.repeat(Math.ceil(GIT_OUTPUT_LIMIT / 10) + 10));
  const diff = await getGitDiff({ cwd, path: 'large.txt', area: 'unstaged' });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= GIT_OUTPUT_LIMIT);
  assert.ok(diff.diff.endsWith('\n'));
  assert.match(diff.message, /обрезано/);
});

test('Git lists gitlink commit changes but does not invoke nested repository filters or expose its files', async t => {
  const parent = await fixture(t);
  const child = await fixture(t);
  await child.write('file.txt', 'before\n');
  await child.commit();
  await parent.write('main.txt', 'main\n');
  await parent.commit();
  await parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', child.cwd, 'nested');
  await parent.commit();
  await child.write('file.txt', 'new commit\n');
  await child.commit();
  const nested = path.join(parent.cwd, 'nested');
  await parent.git('-C', nested, '-c', 'protocol.file.allow=always', 'fetch');
  await parent.git('-C', nested, 'checkout', 'origin/fixture');
  const marker = path.join(parent.base, 'NESTED-HELPER-WAS-RUN');
  const helper = path.join(parent.base, 'helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1);`);
  const command = `node "${helper.replaceAll('\\', '/')}"`;
  await parent.git('-C', nested, 'config', 'core.fsmonitor', command);
  await parent.git('-C', nested, 'config', 'filter.fixture.clean', command);
  await writeFile(path.join(nested, '.gitattributes'), '*.txt filter=fixture\n');
  await writeFile(path.join(nested, 'file.txt'), 'dirty\n');
  const status = await getGitStatus({ cwd: parent.cwd });
  assert.deepEqual(status.entries.map(entry => entry.path), ['nested']);
  assert.equal(status.entries[0].submodule, true);
  assert.equal(status.entries[0].unstaged, true);
  const diff = await getGitDiff({ cwd: parent.cwd, path: 'nested', area: 'unstaged' });
  assert.equal(diff.diff, '');
  assert.match(diff.message, /вложенный репозиторий/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('Git reports unavailable executable without changing the process environment permanently', async t => {
  const { cwd } = await fixture(t);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const saved = process.env[pathKey];
  try {
    process.env[pathKey] = path.join(cwd, 'empty-path');
    assert.deepEqual(await getGitStatus({ cwd }), { available: false, reason: 'git-unavailable', entries: [] });
  } finally { if (saved === undefined) delete process.env[pathKey]; else process.env[pathKey] = saved; }
});
