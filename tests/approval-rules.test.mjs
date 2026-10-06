/**
 * Unit tests for approval-rules — the layer that answers a Codex App Server approval request from rules.
 *
 * Every case here is about the same contract: a decision is returned only when the request is fully
 * understood and a rule covers it; anything else resolves to null, which means the ordinary approval card
 * is drawn and the user answers. The request shapes follow `protocol/v2/*RequestApprovalParams.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { ApprovalCatalog } from '../electron/approval-catalog.mjs';
import { decideApproval, isRuledRequest, ruleSubject } from '../electron/approval-rules.mjs';

const CWD = path.resolve('project_root');
const EXEC = 'item/commandExecution/requestApproval';
const FILES = 'item/fileChange/requestApproval';
const PERMISSIONS = 'item/permissions/requestApproval';

async function catalog() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rules-'));
  return { store: new ApprovalCatalog(path.join(directory, 'approvals.json')), directory };
}

const decide = (method, params, extra = {}) => decideApproval({ method, params, cwd: CWD, ...extra });

// ── which requests a rule may touch at all ──

test('only the three permission requests are ruled; a question is never auto-answered', () => {
  assert.ok(isRuledRequest(EXEC) && isRuledRequest(FILES) && isRuledRequest(PERMISSIONS));
  for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call',
    'applyPatchApproval', 'execCommandApproval', 'account/chatgptAuthTokens/refresh']) {
    assert.ok(!isRuledRequest(method), method);
    assert.equal(decide(method, { command: 'git status' }), null, method);
  }
});

test('without a project directory nothing is decided', () => {
  assert.equal(decideApproval({ method: EXEC, params: { command: 'git status' }, cwd: '' }), null);
});

// ── commands ──

test('a read-only command is answered without a rule and without a model', () => {
  const decision = decide(EXEC, { command: 'git status --short | head -20' });
  assert.deepEqual(decision.result, { decision: 'accept' });
  assert.match(decision.reason, /только на чтение/);
});

test('local git bookkeeping inside the project is answered', () => {
  assert.deepEqual(decide(EXEC, { command: 'git add .; git commit -m wip' }).result, { decision: 'accept' });
  assert.equal(decide(EXEC, { command: 'git push' }), null);
});

test('an unreadable or mutating command is left to the user', () => {
  for (const command of ['rm -rf build', 'bash -c "x"', 'echo $(whoami)', 'node scripts/package.mjs', '']) {
    assert.equal(decide(EXEC, { command }), null, command);
  }
});

test('a command the server places outside the project is left to the user', () => {
  assert.equal(decide(EXEC, { command: 'git status', cwd: path.resolve('elsewhere') }), null);
  assert.ok(decide(EXEC, { command: 'git status', cwd: path.join(CWD, 'src') }));
});

test('input written into a running terminal is never auto-answered', () => {
  assert.equal(decide(EXEC, { kind: 'writeStdin', command: 'git status' }), null);
  assert.ok(decide(EXEC, { kind: 'command', command: 'git status' }));
});

test('a command given as argv is joined before it is read', () => {
  assert.ok(decide(EXEC, { command: ['git', 'status', '--short'] }));
});

test('a saved command rule answers a call the whitelist does not recognize', async () => {
  const { store, directory } = await catalog();
  try {
    assert.equal(decide(EXEC, { command: 'node scripts/check.mjs' }, { catalog: store }), null);
    await store.add(CWD, [['commands', 'node scripts/check.mjs']]);
    const decision = decide(EXEC, { command: 'node scripts/check.mjs --fast' }, { catalog: store });
    assert.deepEqual(decision.result, { decision: 'accept' });
    assert.match(decision.reason, /сохранённое правило/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── network escalations need both halves ──

test('a network escalation needs the host rule and the command, never just one', async () => {
  const { store, directory } = await catalog();
  const params = { command: 'npm install', networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' } };
  try {
    assert.equal(decide(EXEC, params, { catalog: store }), null, 'no rules at all');

    await store.add(CWD, [['hosts', 'registry.npmjs.org']]);
    assert.equal(decide(EXEC, params, { catalog: store }), null, 'a host rule alone lets any command out');

    await store.add(CWD, [['commands', 'npm install']]);
    const decision = decide(EXEC, params, { catalog: store });
    assert.deepEqual(decision.result, { decision: 'accept' });
    assert.match(decision.reason, /registry\.npmjs\.org/);

    assert.equal(decide(EXEC, { ...params, networkApprovalContext: { host: 'evil.example.com' } },
      { catalog: store }), null, 'a command rule alone lets it reach anywhere');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a read-only command still needs a host rule to reach the network', async () => {
  const { store, directory } = await catalog();
  const params = { command: 'git status', networkApprovalContext: { host: 'github.com', protocol: 'https' } };
  try {
    assert.equal(decide(EXEC, params, { catalog: store }), null);
    await store.add(CWD, [['hosts', 'github.com']]);
    assert.ok(decide(EXEC, params, { catalog: store }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── file changes ──

test('a file change is judged on the paths the host recorded for the item', () => {
  const item = { changes: [{ path: path.join(CWD, 'src/App.tsx'), kind: 'update', diff: '' }] };
  assert.deepEqual(decide(FILES, {}, { item }).result, { decision: 'accept' });
  assert.equal(decide(FILES, {}, { item: { changes: [] } }), null, 'nothing recorded → ask');
  assert.equal(decide(FILES, {}), null, 'no item at all → ask');
});

test('a change outside the project, or into a guarded path, is left to the user', () => {
  for (const target of ['../outside.txt', '.git/hooks/pre-commit', '.codex/config.toml', '.claude/settings.json']) {
    assert.equal(decide(FILES, {}, { item: { changes: [{ path: target }] } }), null, target);
  }
});

test('one guarded path in a change set blocks the whole set', () => {
  const item = { changes: [{ path: 'src/App.tsx' }, { path: '.git/config' }] };
  assert.equal(decide(FILES, {}, { item }), null);
});

test('a grantRoot outside the project is refused, and its absence is not a failed check', () => {
  const item = { changes: [{ path: 'src/App.tsx' }] };
  assert.ok(decide(FILES, {}, { item }), 'no root is the shape Codex actually sends');
  assert.ok(decide(FILES, { grantRoot: path.join(CWD, 'src') }, { item }));
  assert.equal(decide(FILES, { grantRoot: path.resolve('elsewhere') }, { item }), null);
});

test('a saved path rule covers a change the project gate refuses', async () => {
  const { store, directory } = await catalog();
  const outside = path.join(os.tmpdir(), 'handoff');
  const item = { changes: [{ path: path.join(outside, 'report.json') }] };
  try {
    assert.equal(decide(FILES, {}, { item, catalog: store }), null);
    await store.add(CWD, [['paths', outside]]);
    assert.deepEqual(decide(FILES, {}, { item, catalog: store }).result, { decision: 'accept' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── additional permissions ──

test('extra file-system access inside the project is granted for the turn only', () => {
  const decision = decide(PERMISSIONS, {
    cwd: CWD,
    permissions: { network: null, fileSystem: { read: [path.join(CWD, 'docs')], write: null } },
  });
  assert.equal(decision.result.scope, 'turn');
  assert.deepEqual(decision.result.permissions.fileSystem.read, [path.join(CWD, 'docs')]);
});

test('a network permission names no host, so nobody but the user can judge it', () => {
  assert.equal(decide(PERMISSIONS, { permissions: { network: { enabled: true }, fileSystem: null } }), null);
  assert.ok(decide(PERMISSIONS, {
    permissions: { network: { enabled: false }, fileSystem: { read: ['src'], write: null } },
  }));
});

test('both spellings of a file-system profile are read, so no target escapes the check', () => {
  assert.equal(decide(PERMISSIONS, {
    permissions: { fileSystem: { read: [path.join(CWD, 'docs')], write: [path.resolve('elsewhere')] } },
  }), null, 'the superseded arrays are checked');
  assert.equal(decide(PERMISSIONS, {
    permissions: { fileSystem: { read: null, write: null, entries: [{ path: path.resolve('elsewhere') }] } },
  }), null, 'the current entries list is checked');
  assert.ok(decide(PERMISSIONS, {
    permissions: { fileSystem: { read: null, write: null, entries: [{ path: path.join(CWD, 'docs') }] } },
  }));
});

test('a permissions profile with nothing to judge is left to the user', () => {
  assert.equal(decide(PERMISSIONS, { permissions: { network: null, fileSystem: null } }), null);
  assert.equal(decide(PERMISSIONS, {}), null);
});

// ── what the card would save ──

test('the card is told the rule it would save, and told nothing where none exists', () => {
  assert.deepEqual(ruleSubject({ method: EXEC, params: { command: 'npm install' } }),
    { kind: 'command', command: 'npm install' });
  assert.deepEqual(ruleSubject({
    method: EXEC,
    params: { command: 'npm install', networkApprovalContext: { host: 'registry.npmjs.org' } },
  }), { kind: 'command', command: 'npm install', host: 'registry.npmjs.org' });
  assert.deepEqual(ruleSubject({ method: FILES, params: {}, item: { changes: [{ path: 'src/App.tsx' }] } }),
    { kind: 'files', paths: ['src/App.tsx'] });
  assert.equal(ruleSubject({ method: PERMISSIONS, params: {} }), null, 'a turn grant leaves no reusable rule');
  assert.equal(ruleSubject({ method: EXEC, params: { kind: 'writeStdin', command: 'y' } }), null);
});

test('a saved path rule never widens the sandbox, only a file write', async () => {
  const { store, directory } = await catalog();
  const outside = path.join(os.tmpdir(), 'handoff');
  try {
    await store.add(CWD, [['paths', outside]]);
    // the same folder answers a file change…
    assert.ok(decide(FILES, {}, { item: { changes: [{ path: path.join(outside, 'report.json') }] }, catalog: store }));
    // …but never a request to grant the sandbox that folder for the turn
    assert.equal(decide(PERMISSIONS, {
      permissions: { fileSystem: { read: [outside], write: null } },
    }, { catalog: store }), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
