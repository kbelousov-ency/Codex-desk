import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_GROUPS = 200, MAX_MEMBERS = 500, MAX_NAME = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_ID = /^g-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const directoryKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Accepts a Codex UUID or a namespaced `claude:UUID`; the exact string is kept so it
 * matches the id the history list already gave the renderer. */
export function groupThreadId(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Некорректный идентификатор диалога.');
  const bare = value.startsWith('claude:') ? value.slice('claude:'.length) : value;
  if (!UUID.test(bare)) throw new Error('Некорректный идентификатор диалога.');
  return value;
}
export function groupName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_NAME || /[\r\n\0]/.test(name)) throw new Error(`Название группы должно содержать от 1 до ${MAX_NAME} символов в одной строке.`);
  return name;
}
function groupFolder(value) {
  if (typeof value !== 'string' || !value || value.length >= 4096 || !path.isAbsolute(value)) throw new Error('Некорректная рабочая папка группы.');
  return path.resolve(value);
}
const moment = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();

/**
 * Kuzmich's own grouping of conversations. This is **presentation metadata owned by the
 * shell**, not a claim about the agent's native lineage: it never touches CLI transcripts,
 * SQLite, native Claude data or the Codex configuration, and the agents themselves know
 * nothing about it. Native Codex `parentThreadId` relationships stay separate and are still
 * shown where the backend reports them.
 *
 * One conversation belongs to at most one group, so «убрать из группы» is unambiguous.
 * Groups are scoped to a project folder, which is how the sidebar already thinks.
 */
export class ThreadGroupStore {
  constructor(userData, { filename = 'thread-groups.json' } = {}) {
    this.userData = path.resolve(userData);
    this.filename = path.join(this.userData, filename);
    this.queue = Promise.resolve();
    this.cache = null;
  }
  serial(work) {
    const result = this.queue.catch(() => {}).then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  entry(value) {
    if (!object(value) || typeof value.id !== 'string' || !GROUP_ID.test(value.id)) throw new Error('Invalid group id');
    const members = Array.isArray(value.members) ? value.members : [];
    if (members.length > MAX_MEMBERS) throw new Error('Too many group members');
    const seen = new Set();
    const normalized = [];
    for (const member of members) {
      if (!object(member)) throw new Error('Invalid group member');
      const threadId = groupThreadId(member.threadId);
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      normalized.push({ threadId, addedAt: moment(member.addedAt) });
    }
    const rootThreadId = value.rootThreadId == null ? null : groupThreadId(value.rootThreadId);
    return {
      id: value.id, name: groupName(value.name), cwd: groupFolder(value.cwd), rootThreadId,
      createdAt: moment(value.createdAt), updatedAt: moment(value.updatedAt), members: normalized,
    };
  }
  async load() {
    if (this.cache) return this.cache;
    let groups = [];
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid group file');
      const value = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!object(value) || value.version !== 1 || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS) throw new Error('Invalid group schema');
      groups = value.groups.map(item => this.entry(item));
      if (new Set(groups.map(item => item.id)).size !== groups.length) throw new Error('Duplicate groups');
    } catch (error) {
      // A damaged or foreign-version file is never silently treated as empty and never
      // overwritten: the user keeps the chance to restore it.
      if (error?.code !== 'ENOENT') throw new Error('Не удалось прочитать thread-groups.json. Восстановите или удалите файл, чтобы пользоваться группами.');
    }
    this.cache = groups;
    return groups;
  }
  async save(groups) {
    const serialized = JSON.stringify({ version: 1, groups });
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Список групп превышает допустимый размер.');
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filename);
    } finally { await unlink(temporary).catch(() => {}); }
    this.cache = groups;
  }
  /** All groups, or only those of one project folder. */
  list(cwd) {
    return this.serial(async () => {
      const groups = await this.load();
      const key = cwd === undefined || cwd === null ? null : directoryKey(groupFolder(cwd));
      return groups.filter(group => key === null || directoryKey(group.cwd) === key)
        .map(group => ({ ...group, members: group.members.map(member => ({ ...member })) }));
    });
  }
  async write(groups, result) {
    await this.save(groups);
    return result;
  }
  manage(options) {
    return this.serial(async () => {
      if (!object(options)) throw new Error('Некорректная операция с группой.');
      const groups = await this.load();
      const now = new Date().toISOString();
      const find = id => {
        const group = groups.find(item => item.id === id);
        if (!group) throw new Error('Группа не найдена. Обновите список.');
        return group;
      };
      const detach = threadId => groups.map(group => group.members.some(member => member.threadId === threadId) || group.rootThreadId === threadId
        ? { ...group, updatedAt: now, rootThreadId: group.rootThreadId === threadId ? null : group.rootThreadId, members: group.members.filter(member => member.threadId !== threadId) }
        : group);
      switch (options.action) {
        case 'create': {
          if (groups.length >= MAX_GROUPS) throw new Error(`Уже создано ${MAX_GROUPS} групп. Удалите ненужные.`);
          const group = this.entry({
            id: `g-${randomUUID()}`, name: options.name, cwd: options.cwd,
            rootThreadId: options.rootThreadId ?? null, createdAt: now, updatedAt: now,
            members: options.rootThreadId ? [{ threadId: options.rootThreadId, addedAt: now }] : [],
          });
          const rest = group.rootThreadId ? detach(group.rootThreadId) : groups;
          return this.write([...rest, group], { group });
        }
        case 'rename': {
          const group = find(options.groupId);
          const name = groupName(options.name);
          const updated = { ...group, name, updatedAt: now };
          return this.write(groups.map(item => item.id === group.id ? updated : item), { group: updated });
        }
        case 'delete': {
          // Removes the grouping only. Conversations, their history and their tabs stay.
          find(options.groupId);
          return this.write(groups.filter(item => item.id !== options.groupId), { removedGroupId: options.groupId });
        }
        case 'assign': {
          const group = find(options.groupId);
          const threadId = groupThreadId(options.threadId);
          const root = Boolean(options.root);
          const rest = detach(threadId);
          const target = rest.find(item => item.id === group.id);
          if (target.members.length >= MAX_MEMBERS) throw new Error(`В группе уже ${MAX_MEMBERS} диалогов.`);
          const updated = {
            ...target, updatedAt: now,
            rootThreadId: root ? threadId : target.rootThreadId,
            members: [...target.members, { threadId, addedAt: now }],
          };
          return this.write(rest.map(item => item.id === group.id ? updated : item), { group: updated });
        }
        case 'unassign': {
          const threadId = groupThreadId(options.threadId);
          const before = JSON.stringify(groups);
          const rest = detach(threadId);
          if (JSON.stringify(rest) === before) return { removedThreadId: threadId };
          return this.write(rest, { removedThreadId: threadId });
        }
        default: throw new Error('Неизвестное действие с группой.');
      }
    });
  }
  /** Called when a conversation is deleted elsewhere, so no group keeps a dead member. */
  forget(threadIds) {
    return this.serial(async () => {
      const ids = new Set((Array.isArray(threadIds) ? threadIds : [threadIds]).filter(value => typeof value === 'string'));
      if (!ids.size) return false;
      const groups = await this.load();
      const now = new Date().toISOString();
      const rest = groups.map(group => group.members.some(member => ids.has(member.threadId)) || (group.rootThreadId && ids.has(group.rootThreadId))
        ? { ...group, updatedAt: now, rootThreadId: group.rootThreadId && ids.has(group.rootThreadId) ? null : group.rootThreadId, members: group.members.filter(member => !ids.has(member.threadId)) }
        : group);
      if (JSON.stringify(rest) === JSON.stringify(groups)) return false;
      await this.save(rest);
      return true;
    });
  }
}
