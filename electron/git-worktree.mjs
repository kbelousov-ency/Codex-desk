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
  // `git worktree list` prints the main worktree first; `cwd` may itself be a task worktree.
  return { root: ctx.cwd, worktrees: items.map((item, index) => ({ ...item, main: index === 0 })) };
}

const ROOT_KEY = value => path.resolve(value).toLowerCase();
const inWorktree = (ctx, dir) => ({ ...ctx, cwd: dir });
async function statusEntries(ctx, dir) {
  const output = requireSuccess(await git(inWorktree(ctx, dir), ['status', '--porcelain', '-z', '--untracked-files=normal'])).stdout.toString('utf8');
  return output.split('\0').filter(Boolean).length;
}
async function aheadBehind(ctx, base, branch) {
  const result = await git(ctx, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  if (result.code !== 0) return { ahead: null, behind: null };
  const [behind, ahead] = result.stdout.toString('utf8').trim().split(/\s+/).map(Number);
  return { ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null };
}

/** Every worktree of the repository containing `cwd` with dirtiness and ahead/behind relative to the main worktree's branch. */
export async function worktreeSummary({ cwd, assertActive = () => {} }) {
  const ctx = await repository(cwd, assertActive);
  const listed = await listWorktrees({ cwd, assertActive });
  const main = listed.worktrees.find(item => item.main) || listed.worktrees[0];
  const worktrees = [];
  for (const item of listed.worktrees) {
    ctx.assertActive();
    let dirty = null;
    try { dirty = (await statusEntries(ctx, item.path)) > 0; } catch { dirty = null; }
    const counts = !item.main && item.branch && main?.branch ? await aheadBehind(ctx, main.branch, item.branch) : { ahead: null, behind: null };
    worktrees.push({ ...item, dirty, ...counts, current: ROOT_KEY(item.path) === ROOT_KEY(ctx.cwd) });
  }
  return { root: ctx.cwd, mainBranch: main?.branch ?? null, mainPath: main?.path ?? null, worktrees };
}

async function mergeContext(cwd, assertActive) {
  const summary = await worktreeSummary({ cwd, assertActive });
  const source = summary.worktrees.find(item => item.current);
  if (!source) throw new Error('Не удалось определить текущую рабочую копию.');
  if (source.main) throw new Error('Это основная рабочая копия: переносить результат нужно из копии задачи.');
  if (!source.branch) throw new Error('Рабочая копия задачи не на ветке (detached HEAD). Создайте ветку в терминале.');
  if (!summary.mainBranch || !summary.mainPath) throw new Error('Основная рабочая копия не на ветке; перенос в терминале.');
  const main = summary.worktrees.find(item => item.main);
  return { summary, source, main };
}

/** Commits and diff stat that a merge of the task branch into the main worktree's branch would bring. Read-only. */
export async function previewWorktreeMerge({ cwd, assertActive = () => {} }) {
  const { summary, source, main } = await mergeContext(cwd, assertActive);
  const ctx = await repository(summary.mainPath, assertActive);
  const log = requireSuccess(await git(ctx, ['log', '--format=%h%x09%s', '--max-count=200', `${summary.mainBranch}..${source.branch}`])).stdout.toString('utf8');
  const commits = log.split('\n').filter(Boolean).map(line => { const [hash, ...rest] = line.split('\t'); return { hash, subject: rest.join('\t').slice(0, 200) }; });
  const stat = requireSuccess(await git(ctx, ['diff', '--stat=100', `${summary.mainBranch}...${source.branch}`], { limit: 512 * 1024, allowTruncated: true })).stdout.toString('utf8');
  return {
    branch: source.branch, target: summary.mainBranch, mainPath: summary.mainPath, worktreePath: source.path,
    commits, stat: stat.trim(), ahead: source.ahead, behind: source.behind,
    mainDirty: Boolean(main?.dirty), worktreeDirty: Boolean(source.dirty),
    blocked: main?.dirty ? 'В основной рабочей копии есть незафиксированные изменения. Зафиксируйте или отложите их перед переносом.' : !commits.length ? 'В ветке задачи нет новых коммитов относительно основной ветки.' : null,
  };
}

/** `git merge --no-edit <task-branch>` executed in the main worktree; a conflicting merge is aborted and reported. */
export async function mergeWorktree({ cwd, assertActive = () => {} }) {
  const preview = await previewWorktreeMerge({ cwd, assertActive });
  if (preview.blocked) throw new Error(preview.blocked);
  const ctx = await repository(preview.mainPath, assertActive);
  const before = requireSuccess(await git(ctx, ['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
  ctx.assertActive();
  const result = await git(ctx, ['merge', '--no-edit', preview.branch]);
  if (result.code !== 0) {
    const conflicts = (await git(ctx, ['diff', '--name-only', '--diff-filter=U'])).stdout.toString('utf8').split('\n').filter(Boolean);
    await git(ctx, ['merge', '--abort']);
    const detail = result.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 600);
    throw new Error(`Слияние отменено${conflicts.length ? `, конфликты: ${conflicts.slice(0, 10).join(', ')}` : ''}. Основная копия возвращена к прежнему состоянию.${detail ? ` ${detail}` : ''}`);
  }
  const after = requireSuccess(await git(ctx, ['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
  return { branch: preview.branch, target: preview.target, mainPath: preview.mainPath, before, after, commits: preview.commits.length };
}

/** Removes a task worktree (never the main one). Dirty copies need `force`; the branch is deleted only when fully merged. */
export async function removeWorktree({ cwd, force = false, deleteBranch = false, assertActive = () => {} }) {
  const summary = await worktreeSummary({ cwd, assertActive });
  const target = summary.worktrees.find(item => item.current);
  if (!target) throw new Error('Не удалось определить рабочую копию.');
  if (target.main) throw new Error('Основную рабочую копию удалить нельзя.');
  if (target.dirty && !force) throw new Error('В рабочей копии есть незафиксированные изменения. Подтвердите удаление с потерей этих изменений или зафиксируйте их.');
  const ctx = await repository(summary.mainPath, assertActive);
  ctx.assertActive();
  const removed = await git(ctx, ['worktree', 'remove', ...(force ? ['--force'] : []), target.path]);
  if (removed.code !== 0) throw new Error(`Не удалось удалить рабочую копию. ${removed.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 600)}`);
  let branchDeleted = false;
  if (deleteBranch && target.branch) {
    const deleted = await git(ctx, ['branch', '-d', target.branch]);
    branchDeleted = deleted.code === 0;
  }
  return { path: target.path, branch: target.branch, branchDeleted };
}
