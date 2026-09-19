import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { contextFor, git, requireSuccess } from './git-reader.mjs';

const NAME = /^[A-Za-z0-9Ѐ-ӿ][A-Za-z0-9Ѐ-ӿ._-]{0,63}$/u;

/** Branch/folder name for an isolated task: one path component, safe for Git refs and Windows folders. */
export function worktreeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME.test(name) || name.includes('..') || /\.lock$/i.test(name) || /^\.git$/i.test(name) || /[. ]$/.test(name)) {
    throw new Error('Имя задачи: 1–64 символа — буквы, цифры, точка, дефис или подчёркивание; без пробелов, «..» и окончания .lock.');
  }
  return name;
}

async function repository(cwd, assertActive) {
  const ctx = await contextFor(cwd, assertActive);
  if (ctx.unavailable === 'git-unavailable') throw new Error('Git не найден. Установите Git, чтобы создавать изолированные задачи.');
  if (ctx.unavailable) throw new Error('Рабочая папка не является репозиторием Git. Изолированные задачи требуют репозитория.');
  return ctx;
}

/** Container next to the main worktree: `<parent>/<repo>.worktrees/<name>`. Never inside the repository itself. */
export function worktreeContainer(root) { return path.join(path.dirname(root), `${path.basename(root)}.worktrees`); }

/** Creates `git worktree add` for a new (or existing, unattached) branch and returns its folder. */
export async function createWorktree({ cwd, name, assertActive = () => {} }) {
  const branch = worktreeName(name);
  const ctx = await repository(cwd, assertActive);
  const container = worktreeContainer(ctx.cwd);
  const target = path.join(container, branch);
  try { await lstat(target); throw new Error(`Папка для задачи уже существует: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = await git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const created = existing.code !== 0;
  await mkdir(container, { recursive: true });
  ctx.assertActive();
  // A branch already checked out elsewhere is refused by Git itself; the message is shown as is.
  const result = await git(ctx, created ? ['worktree', 'add', '-b', branch, target] : ['worktree', 'add', target, branch]);
  if (result.code !== 0) {
    const detail = result.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1200);
    throw new Error(`Не удалось создать рабочую копию.${detail ? ` ${detail}` : ''}`);
  }
  return { path: target, branch, created, root: ctx.cwd };
}

/** Lists worktrees of the repository containing `cwd` (porcelain parse, read-only). */
export async function listWorktrees({ cwd, assertActive = () => {} }) {
  const ctx = await repository(cwd, assertActive);
  const output = requireSuccess(await git(ctx, ['worktree', 'list', '--porcelain'])).stdout.toString('utf8');
  const items = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9), branch: null, head: null, detached: false, bare: false }; items.push(current); }
    else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
  }
  return { root: ctx.cwd, worktrees: items.map(item => ({ ...item, main: path.resolve(item.path).toLowerCase() === ctx.cwd.toLowerCase() })) };
}
