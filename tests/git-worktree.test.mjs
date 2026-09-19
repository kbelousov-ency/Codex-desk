import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorktree, listWorktrees, worktreeContainer, worktreeName } from '../electron/git-worktree.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const artifacts = path.resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, 'git-worktree-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'Проект');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => exec('git', args, { cwd, env, windowsHide: true });
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgSign', 'false');
  await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n');
  await git('add', '--all'); await git('commit', '-m', 'init', '--no-verify');
  return { base, cwd, git };
}

test('names are one safe path component', () => {
  for (const ok of ['task-1', 'feature.login', 'Задача_2', 'x']) assert.equal(worktreeName(` ${ok} `), ok);
  for (const bad of ['', 'a b', '../x', 'a/b', 'x.lock', '.git', 'ends.', '-lead', 'x'.repeat(65), 'a\\b', null]) assert.throws(() => worktreeName(bad), /Имя задачи/);
});

test('creates a sibling worktree on a new branch, reuses an existing branch, refuses duplicates and non-repositories', async t => {
  const { base, cwd, git } = await fixture(t);
  const indexBefore = await readFile(path.join(cwd, '.git', 'index'));
  const first = await createWorktree({ cwd: path.join(cwd, 'src'), name: 'task-1' });
  assert.equal(first.branch, 'task-1'); assert.equal(first.created, true);
  assert.equal(path.dirname(first.path), worktreeContainer(await realCase(cwd)));
  assert.ok(!first.path.toLowerCase().startsWith(cwd.toLowerCase() + path.sep), 'worktree lives next to the repository, not inside it');
  assert.equal((await stat(path.join(first.path, 'src', 'a.txt'))).isFile(), true);
  assert.equal((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: first.path, windowsHide: true })).stdout.trim(), 'task-1');
  assert.equal((await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main', 'main worktree stays on its branch');
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'index')), indexBefore, 'main index untouched');
  await assert.rejects(createWorktree({ cwd, name: 'task-1' }), /уже существует/);
  await git('branch', 'prepared');
  const second = await createWorktree({ cwd, name: 'prepared' });
  assert.equal(second.created, false);
  assert.equal((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: second.path, windowsHide: true })).stdout.trim(), 'prepared');
  await assert.rejects(createWorktree({ cwd, name: 'main' }), /Не удалось создать рабочую копию/, 'a branch checked out in the main worktree is refused by Git');
  const listed = await listWorktrees({ cwd });
  assert.deepEqual(listed.worktrees.map(item => [item.branch, item.main]).sort(), [['main', true], ['prepared', false], ['task-1', false]].sort());
  // A folder under artifacts/ sits inside this repository; a real non-repository must live in the OS temp dir.
  const plain = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-plain-')); t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(createWorktree({ cwd: plain, name: 'x' }), /не является репозиторием/);
  await assert.rejects(createWorktree({ cwd, name: 'bad name' }), /Имя задачи/);
});

async function realCase(value) { const { realpath } = await import('node:fs/promises'); return realpath(value); }
