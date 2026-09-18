import type { Item } from './types';

export type FileEdit = {
  key: string;
  path: string;
  diff: string;
  status?: string;
  kind?: { type?: string; move_path?: string | null; movePath?: string | null };
};

export type FileEdits = { key: string; path: string; label: string; edits: FileEdit[] };

function normalizePath(path: string) {
  const value = path.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
  const prefix = value.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop();
    else if (part !== '..' || (!prefix && !/^[a-z]:$/i.test(parts.at(-1) || ''))) parts.push(part);
  }
  return prefix + parts.join('/');
}

export function changePath(path: string, cwd = '') {
  const normalized = normalizePath(path);
  return cwd && !/^(?:[a-z]:\/|\/)/i.test(normalized) ? normalizePath(`${cwd}/${normalized}`) : normalized;
}

export function relativeChangePath(path: string, cwd = '') {
  const fullPath = changePath(path, cwd);
  const root = normalizePath(cwd).replace(/\/$/, '');
  return root && fullPath.toLowerCase().startsWith(root.toLowerCase() + '/') ? fullPath.slice(root.length + 1) : fullPath;
}

export function groupFileChanges(items: Item[], cwd = ''): FileEdits[] {
  const groups = new Map<string, FileEdits>();
  for (const item of items) {
    if (item.type !== 'fileChange') continue;
    for (const [index, change] of (item.changes || []).entries()) {
      if (typeof change.path !== 'string' || !change.path) continue;
      const path = changePath(change.path, cwd);
      const key = path.toLowerCase();
      if (!groups.has(key)) groups.set(key, { key, path, label: relativeChangePath(path, cwd), edits: [] });
      groups.get(key)!.edits.push({ ...change, path, diff: typeof change.diff === 'string' ? change.diff : '', key: `${item.id}-${index}`, status: item.status });
    }
  }
  return [...groups.values()];
}

export function changeStatus(edit: FileEdit) {
  if (edit.status === 'failed') return 'Ошибка';
  if (edit.status === 'declined') return 'Отклонено';
  if (['inProgress', 'running', 'pending'].includes(edit.status || '')) return 'Применяется';
  if (edit.kind?.type === 'add') return 'Добавлен';
  if (edit.kind?.type === 'delete') return 'Удалён';
  if (edit.kind?.move_path || edit.kind?.movePath) return 'Переименован';
  return 'Изменён';
}

export function diffLines(text: string) {
  let remaining = 0;
  return text.replace(/\r\n/g, '\n').split('\n').map(line => {
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (range) {
      const oldCount = Number(range[2] ?? 1);
      const newCount = Number(range[4] ?? 1);
      remaining = oldCount + newCount;
      const span = (start: string, count: number) => count > 1 ? `${start}–${Number(start) + count - 1}` : count === 0 ? `после ${start}` : start;
      return { line, kind: 'range', label: `Строки ${span(range[1], oldCount)} → ${span(range[3], newCount)}${range[5]}` };
    }
    if (line.startsWith('diff --git ') || line.startsWith('index ') || (remaining === 0 && (line.startsWith('+++ ') || line.startsWith('--- ')))) return { line, kind: 'header' };
    if (line.startsWith('+')) { remaining = Math.max(0, remaining - 1); return { line, kind: 'add' }; }
    if (line.startsWith('-')) { remaining = Math.max(0, remaining - 1); return { line, kind: 'remove' }; }
    if (line.startsWith(' ')) remaining = Math.max(0, remaining - 2);
    return { line, kind: 'context' };
  });
}

export function diffLineStats(text: string) {
  const lines = diffLines(text);
  return { added: lines.filter(line => line.kind === 'add').length, removed: lines.filter(line => line.kind === 'remove').length };
}
