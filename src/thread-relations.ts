import type { AgentProvider, Thread } from './types';

/** How a conversation is related to another one, as stated by the backend — never inferred.
 * Measured on Codex App Server 0.156.1 and Claude Agent SDK 0.3.278; see docs/SUBAGENTS.md. */
export type RelationKind =
  | 'root'        // no parent: `source` is not a subagent and both id fields are empty
  | 'spawn'       // `source.subAgent.thread_spawn` — an executor created by spawnAgent
  | 'service'     // `source.subAgent.{other|review|compact|memory_consolidation}` — Codex's own threads
  | 'fork'        // `forkedFromId` without `parentThreadId` — a copy of another conversation
  | 'unavailable';// the provider does not report relationships at all (Claude Code)
/** Which field proved the edge. Nothing else may be used as a source of a relationship. */
export type RelationEvidence = 'parentThreadId' | 'forkedFromId' | 'source' | null;

export type ThreadRelation = {
  threadId: string;
  /** Only ever `parentThreadId`, or `forkedFromId` when there is no parent. */
  parentId: string | null;
  kind: RelationKind;
  evidence: RelationEvidence;
  /** `agentNickname`, else `agentRole`, else `agent_path` — backend values only. */
  label: string | null;
  depth: number | null;
  serviceKind: string | null;
};

export const threadProvider = (thread: Thread): AgentProvider =>
  thread.provider || (typeof thread.id === 'string' && thread.id.startsWith('claude:') ? 'claude' : 'codex');
/** Claude's SDKSessionInfo carries no parent, fork or session-tree field, so there is nothing to read. */
export const relationSupport = (provider: AgentProvider): 'available' | 'unavailable' =>
  provider === 'claude' ? 'unavailable' : 'available';

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const id = (value: unknown): string | null => typeof value === 'string' && /\S/.test(value) ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The wire mixes cases: the outer key arrives as `subAgent`, the inner one as `thread_spawn`.
 * The generated protocol types say `subagent`/`thread_spawn`, so both spellings are accepted. */
const field = (source: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) if (name in source) return source[name];
  return undefined;
};

type ParsedSource = { kind: 'spawn' | 'service' | null; parentId: string | null; depth: number | null; label: string | null; serviceKind: string | null };
const emptySource: ParsedSource = { kind: null, parentId: null, depth: null, label: null, serviceKind: null };

/** Reads `Thread.source`. This is the only reliable discriminator of the relationship kind:
 * `sourceKinds: ['subAgent']` and `['subAgentOther']` were measured to return identical sets. */
export function parseThreadSource(source: unknown): ParsedSource {
  const outer = record(source);
  if (!outer) return emptySource;
  const inner = field(outer, 'subAgent', 'subagent');
  if (inner === undefined) return emptySource;
  if (typeof inner === 'string') return { ...emptySource, kind: 'service', serviceKind: inner };
  const detail = record(inner);
  if (!detail) return emptySource;
  const spawn = record(field(detail, 'thread_spawn', 'threadSpawn'));
  if (spawn) {
    const depth = field(spawn, 'depth');
    return {
      kind: 'spawn',
      parentId: id(field(spawn, 'parent_thread_id', 'parentThreadId')),
      depth: typeof depth === 'number' && Number.isFinite(depth) ? depth : null,
      label: text(field(spawn, 'agent_nickname', 'agentNickname')) || text(field(spawn, 'agent_role', 'agentRole')) || text(field(spawn, 'agent_path', 'agentPath')),
      serviceKind: null,
    };
  }
  const other = field(detail, 'other');
  if (other !== undefined) return { ...emptySource, kind: 'service', serviceKind: text(other) || 'other' };
  // A subagent of a kind this build does not know yet is still a service thread, not an executor.
  const [name] = Object.keys(detail);
  return { ...emptySource, kind: 'service', serviceKind: name || 'other' };
}

/** Builds the relationship of one conversation from backend fields only.
 * Titles, timestamps, cwd and list order are never consulted. */
export function threadRelation(thread: Thread): ThreadRelation {
  const threadId = String(thread.id ?? '');
  if (relationSupport(threadProvider(thread)) === 'unavailable') {
    return { threadId, parentId: null, kind: 'unavailable', evidence: null, label: null, depth: null, serviceKind: null };
  }
  const parsed = parseThreadSource(thread.source);
  const parentThreadId = id(thread.parentThreadId);
  const forkedFromId = id(thread.forkedFromId);
  // `sessionId` is deliberately unused: it was measured to always equal `id` in both
  // thread/list and thread/read, so grouping by it would invent relationships.
  const label = text(thread.agentNickname) || text(thread.agentRole) || parsed.label;
  if (parentThreadId) {
    const kind: RelationKind = parsed.kind === 'spawn' ? 'spawn' : parsed.kind === 'service' ? 'service' : 'spawn';
    return { threadId, parentId: parentThreadId, kind, evidence: 'parentThreadId', label, depth: parsed.depth, serviceKind: parsed.serviceKind };
  }
  if (parsed.kind && parsed.parentId) {
    return { threadId, parentId: parsed.parentId, kind: parsed.kind, evidence: 'source', label, depth: parsed.depth, serviceKind: parsed.serviceKind };
  }
  if (forkedFromId) {
    return { threadId, parentId: forkedFromId, kind: 'fork', evidence: 'forkedFromId', label, depth: null, serviceKind: null };
  }
  return { threadId, parentId: null, kind: 'root', evidence: null, label: null, depth: null, serviceKind: null };
}

export const isServiceRelation = (relation: ThreadRelation) => relation.kind === 'service';
export const hasParent = (relation: ThreadRelation) => Boolean(relation.parentId);

export const relationKindText = (relation: ThreadRelation) => ({
  spawn: 'подагент', fork: 'ответвление', service: 'служебный диалог', root: '', unavailable: '',
}[relation.kind]);

export type RelationChild = { thread: Thread; cwd: string; relation: ThreadRelation };
export type RelationGroup = {
  parentId: string;
  /** The parent conversation when it is in the loaded lists; null means it is not loaded. */
  parent: Thread | null;
  parentCwd: string;
  /** Executors shown as children, in the order the backend listed them. */
  children: RelationChild[];
  /** Codex's own review/compact threads: kept, counted, collapsed — never shown as executors. */
  service: RelationChild[];
};

/** Groups loaded children under their **direct** parent. Several planners therefore produce
 * several independent groups: the key is `parentId` and groups are never merged.
 * A child whose parent is not loaded keeps its own group with `parent: null`. */
export function buildRelationGroups({ parents, children, cwd }: { parents: Thread[]; children: Thread[]; cwd: string }): RelationGroup[] {
  const known = new Map<string, Thread>();
  for (const thread of [...parents, ...children]) if (typeof thread.id === 'string') known.set(thread.id, thread);
  const groups = new Map<string, RelationGroup>();
  const order: string[] = [];
  const ensure = (parentId: string) => {
    let group = groups.get(parentId);
    if (!group) {
      const parent = known.get(parentId) ?? null;
      group = { parentId, parent, parentCwd: parent?.cwd || cwd, children: [], service: [] };
      groups.set(parentId, group);
      order.push(parentId);
    }
    return group;
  };
  // Seed in the parents' own order so the tree keeps the folder history order.
  for (const parent of parents) if (typeof parent.id === 'string' && children.some(child => threadRelation(child).parentId === parent.id)) ensure(parent.id);
  for (const thread of children) {
    const relation = threadRelation(thread);
    if (!relation.parentId) continue;
    const entry: RelationChild = { thread, cwd: thread.cwd || cwd, relation };
    const group = ensure(relation.parentId);
    (isServiceRelation(relation) ? group.service : group.children).push(entry);
  }
  return order.map(parentId => groups.get(parentId)!).filter(group => group.children.length || group.service.length);
}

export const groupsForParent = (groups: RelationGroup[], parentId?: string) =>
  parentId ? groups.find(group => group.parentId === parentId) : undefined;
/** Groups whose parent is missing from the loaded lists. Shown separately and labelled, not reattached. */
export const orphanGroups = (groups: RelationGroup[]) => groups.filter(group => !group.parent);

export function subagentCount(count: number) {
  const tail = count % 100 > 10 && count % 100 < 20 ? 0 : count % 10;
  return `${count} ${tail === 1 ? 'подагент' : tail >= 2 && tail <= 4 ? 'подагента' : 'подагентов'}`;
}
export function serviceCount(count: number) {
  const tail = count % 100 > 10 && count % 100 < 20 ? 0 : count % 10;
  return `${count} ${tail === 1 ? 'служебный диалог' : tail >= 2 && tail <= 4 ? 'служебных диалога' : 'служебных диалогов'}`;
}
