import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRelationGroups, groupsForParent, isServiceRelation, orphanGroups,
  parseThreadSource, relationKindText, relationSupport, serviceCount, subagentCount, threadProvider, threadRelation,
} from '../src/thread-relations.ts';

const cwd = 'E:/My projects/CodexDesk';
// Shapes below are the ones measured on the installed Codex App Server 0.156.1,
// including the mixed-case wire keys (outer `subAgent`, inner `thread_spawn`).
const planner = { id: 'p-1', preview: 'Планировщик', cwd, source: 'vscode', sessionId: 'p-1' };
const spawnChild = (id, parent, nickname, path = '/root/check_design', depth = 1) => ({
  id, cwd, sessionId: id, parentThreadId: parent, forkedFromId: parent, agentNickname: nickname, agentRole: null,
  source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: path, agent_nickname: nickname, agent_role: null } } },
});
const guardianChild = (id, parent) => ({
  id, cwd, sessionId: id, parentThreadId: parent, forkedFromId: null, agentNickname: null, agentRole: null,
  preview: 'The following is the Codex agent history whose request action…',
  source: { subAgent: { other: 'guardian' } }, historyMode: 'legacy',
});

test('source parsing separates spawned executors from Codex service threads', () => {
  assert.deepEqual(parseThreadSource({ subAgent: { thread_spawn: { parent_thread_id: 'p-1', depth: 2, agent_path: '/root/a', agent_nickname: 'Franklin', agent_role: null } } }),
    { kind: 'spawn', parentId: 'p-1', depth: 2, label: 'Franklin', serviceKind: null });
  assert.deepEqual(parseThreadSource({ subAgent: { other: 'guardian' } }), { kind: 'service', parentId: null, depth: null, label: null, serviceKind: 'guardian' });
  assert.deepEqual(parseThreadSource({ subAgent: 'review' }), { kind: 'service', parentId: null, depth: null, label: null, serviceKind: 'review' });
  assert.deepEqual(parseThreadSource({ subAgent: 'compact' }), { kind: 'service', parentId: null, depth: null, label: null, serviceKind: 'compact' });
  // Top-level sources and anything unrecognisable yield no relationship at all.
  assert.equal(parseThreadSource('vscode').kind, null);
  assert.equal(parseThreadSource(null).kind, null);
  assert.equal(parseThreadSource({ custom: 'x' }).kind, null);
});

test('both wire spellings of the source keys are accepted', () => {
  const camel = parseThreadSource({ subAgent: { threadSpawn: { parentThreadId: 'p-9', depth: 1, agentNickname: 'Euler' } } });
  const snake = parseThreadSource({ subagent: { thread_spawn: { parent_thread_id: 'p-9', depth: 1, agent_nickname: 'Euler' } } });
  assert.deepEqual(camel, snake);
  assert.equal(camel.parentId, 'p-9');
  assert.equal(camel.label, 'Euler');
});

test('an unknown subagent kind degrades to a service thread, never to an executor', () => {
  const parsed = parseThreadSource({ subAgent: { memory_consolidation: {} } });
  assert.equal(parsed.kind, 'service');
  assert.equal(parsed.serviceKind, 'memory_consolidation');
});

test('a spawned subagent is proved by parentThreadId and labelled from backend fields', () => {
  const relation = threadRelation(spawnChild('c-1', 'p-1', 'Franklin', '/root/install_docs'));
  assert.deepEqual(relation, { threadId: 'c-1', parentId: 'p-1', kind: 'spawn', evidence: 'parentThreadId', label: 'Franklin', depth: 1, serviceKind: null });
  assert.equal(relationKindText(relation), 'подагент');
});

test('agent_path is used only when no nickname or role was given', () => {
  assert.equal(threadRelation(spawnChild('c-2', 'p-1', null, '/root/shell_ux')).label, '/root/shell_ux');
  assert.equal(threadRelation({ ...spawnChild('c-3', 'p-1', null, '/root/x'), agentRole: 'reviewer' }).label, 'reviewer');
  // Guardian threads carry no label at all, so none is invented.
  assert.equal(threadRelation(guardianChild('g-1', 'p-1')).label, null);
});

test('guardian threads keep their parent but are classified as service', () => {
  const relation = threadRelation(guardianChild('g-1', 'p-1'));
  assert.equal(relation.parentId, 'p-1');
  assert.equal(relation.kind, 'service');
  assert.equal(relation.serviceKind, 'guardian');
  assert.equal(isServiceRelation(relation), true);
  assert.equal(relationKindText(relation), 'служебный диалог');
});

test('a fork is proved by forkedFromId and is not a child', () => {
  const relation = threadRelation({ id: 'f-1', cwd, source: 'vscode', parentThreadId: null, forkedFromId: 'p-1', sessionId: 'f-1' });
  assert.deepEqual(relation, { threadId: 'f-1', parentId: 'p-1', kind: 'fork', evidence: 'forkedFromId', label: null, depth: null, serviceKind: null });
  assert.equal(relationKindText(relation), 'ответвление');
});

test('parentThreadId wins over forkedFromId when a spawn sets both to the parent', () => {
  // Measured: a spawned subagent reports parentThreadId === forkedFromId.
  const relation = threadRelation(spawnChild('c-4', 'p-1', 'Godel'));
  assert.equal(relation.evidence, 'parentThreadId');
  assert.equal(relation.kind, 'spawn');
});

test('a top-level conversation has no relationship, and sessionId is never used as one', () => {
  assert.deepEqual(threadRelation(planner), { threadId: 'p-1', parentId: null, kind: 'root', evidence: null, label: null, depth: null, serviceKind: null });
  // sessionId was measured to always equal id; a shared value must not create a group.
  const a = { id: 'a', cwd, source: 'vscode', sessionId: 'tree-1' };
  const b = { id: 'b', cwd, source: 'vscode', sessionId: 'tree-1' };
  assert.equal(threadRelation(a).parentId, null);
  assert.equal(threadRelation(b).parentId, null);
  assert.equal(buildRelationGroups({ parents: [a, b], children: [], cwd }).length, 0);
});

test('Claude reports no native lineage, and none is guessed from its fields', () => {
  assert.equal(relationSupport('claude'), 'unavailable');
  assert.equal(relationSupport('codex'), 'available');
  assert.equal(threadProvider({ id: 'claude:3f2b' }), 'claude');
  assert.equal(threadProvider({ id: 'p-1' }), 'codex');
  assert.equal(threadProvider({ id: 'p-1', provider: 'claude' }), 'claude');
  // Even if a Claude entry somehow carried the fields, they are not interpreted.
  const relation = threadRelation({ id: 'claude:3f2b', provider: 'claude', parentThreadId: 'claude:aaaa', forkedFromId: 'claude:bbbb' });
  assert.deepEqual(relation, { threadId: 'claude:3f2b', parentId: null, kind: 'unavailable', evidence: null, label: null, depth: null, serviceKind: null });
  // Nothing user-facing is derived from this: a Claude conversation is simply ungrouped
  // until the user puts it in a historical shell-owned group.
  assert.equal(relationKindText(relation), '');
});

test('several planners produce several independent groups in the parents order', () => {
  const second = { id: 'p-2', preview: 'Второй планировщик', cwd, source: 'vscode' };
  const groups = buildRelationGroups({
    parents: [planner, second],
    children: [spawnChild('c-1', 'p-1', 'Franklin'), spawnChild('c-2', 'p-2', 'Euler'), spawnChild('c-3', 'p-1', 'Godel')],
    cwd,
  });
  assert.deepEqual(groups.map(group => group.parentId), ['p-1', 'p-2']);
  assert.deepEqual(groups[0].children.map(child => child.thread.id), ['c-1', 'c-3']);
  assert.deepEqual(groups[1].children.map(child => child.thread.id), ['c-2']);
  assert.equal(groups[0].parent, planner);
  assert.equal(groupsForParent(groups, 'p-2')?.children.length, 1);
  assert.equal(groupsForParent(groups, 'nobody'), undefined);
  assert.equal(groupsForParent(groups, undefined), undefined);
});

test('service threads are counted inside the group, never listed as executors', () => {
  const groups = buildRelationGroups({
    parents: [planner],
    children: [guardianChild('g-1', 'p-1'), spawnChild('c-1', 'p-1', 'Franklin'), guardianChild('g-2', 'p-1')],
    cwd,
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].children.map(child => child.thread.id), ['c-1']);
  assert.deepEqual(groups[0].service.map(child => child.thread.id), ['g-1', 'g-2']);
});

test('a group of only service threads still exists, so nothing is silently dropped', () => {
  const groups = buildRelationGroups({ parents: [planner], children: [guardianChild('g-1', 'p-1')], cwd });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].children.length, 0);
  assert.equal(groups[0].service.length, 1);
});

test('a child whose parent is not loaded keeps its own labelled group instead of being reattached', () => {
  const groups = buildRelationGroups({ parents: [planner], children: [spawnChild('c-1', 'p-1', 'Franklin'), spawnChild('c-9', 'missing-parent', 'Tesla')], cwd });
  assert.deepEqual(groups.map(group => group.parentId), ['p-1', 'missing-parent']);
  const orphans = orphanGroups(groups);
  assert.deepEqual(orphans.map(group => group.parentId), ['missing-parent']);
  assert.equal(orphans[0].parent, null);
  assert.equal(orphans[0].parentCwd, cwd);
  // The only loaded planner must not have absorbed it.
  assert.deepEqual(groups[0].children.map(child => child.thread.id), ['c-1']);
});

test('depth two nests under the direct parent, which may itself be a child', () => {
  const mid = spawnChild('c-1', 'p-1', 'Franklin');
  const leaf = spawnChild('c-2', 'c-1', 'Hooke', '/root/deep', 2);
  const groups = buildRelationGroups({ parents: [planner], children: [mid, leaf], cwd });
  assert.deepEqual(groups.map(group => group.parentId), ['p-1', 'c-1']);
  assert.equal(groupsForParent(groups, 'c-1')?.parent, mid);
  assert.equal(groupsForParent(groups, 'c-1')?.children[0].relation.depth, 2);
  assert.equal(orphanGroups(groups).length, 0);
});

test('a self-referencing or empty parent id cannot create a relationship', () => {
  assert.equal(threadRelation({ id: 'x', parentThreadId: '', forkedFromId: '   ' }).parentId, null);
  assert.equal(threadRelation({ id: 'x', parentThreadId: null }).kind, 'root');
  const groups = buildRelationGroups({ parents: [], children: [{ id: 'x', cwd, parentThreadId: 'x', source: { subAgent: { other: 'guardian' } } }], cwd });
  // A cycle of one is still just a group keyed by that id; no infinite walk happens.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].parentId, 'x');
});

test('children inherit their own cwd when the backend reported one', () => {
  const other = { ...spawnChild('c-1', 'p-1', 'Franklin'), cwd: 'E:/Other' };
  const groups = buildRelationGroups({ parents: [planner], children: [other], cwd });
  assert.equal(groups[0].children[0].cwd, 'E:/Other');
  const noCwd = { ...spawnChild('c-2', 'p-1', 'Euler'), cwd: undefined };
  assert.equal(buildRelationGroups({ parents: [planner], children: [noCwd], cwd })[0].children[0].cwd, cwd);
});

test('Russian counts agree with the number', () => {
  assert.equal(subagentCount(1), '1 подагент');
  assert.equal(subagentCount(2), '2 подагента');
  assert.equal(subagentCount(5), '5 подагентов');
  assert.equal(subagentCount(11), '11 подагентов');
  assert.equal(subagentCount(21), '21 подагент');
  assert.equal(serviceCount(1), '1 служебный диалог');
  assert.equal(serviceCount(3), '3 служебных диалога');
  assert.equal(serviceCount(14), '14 служебных диалогов');
});
