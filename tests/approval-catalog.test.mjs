/**
 * Unit tests for ApprovalCatalog — the standing approvals a project carries, so a routine action is asked
 * about once. Ported from the Aurora fleet's `tests/unit/test_approvals.py`, including the two rule-keying
 * failures that module found in production: a PowerShell flag's VALUE becoming the rule, and a backslash
 * path mangled by the lexer into a rule that matched only its own spelling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { ApprovalCatalog, commandKeys, keyText } from '../electron/approval-catalog.mjs';

const CWD = path.resolve('project_root');

async function catalog() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'approvals-'));
  const filename = path.join(directory, 'approvals.json');
  return { store: new ApprovalCatalog(filename), filename, directory };
}

// ── what a command is keyed by ──

test('a rule names the command and what it acts on, not the whole call', () => {
  assert.deepEqual(commandKeys('node scripts/check.mjs --fast').map(keyText), ['node scripts/check.mjs']);
  assert.deepEqual(commandKeys('git status --short').map(keyText), ['git status']);
});

test("a PowerShell flag's value never becomes the rule", () => {
  // `Get-Content -Raw -Encoding UTF8 'notes.md'` once keyed as `Get-Content UTF8` — a rule naming nothing
  // the user read on the card, yet silencing the cmdlet for every file.
  assert.deepEqual(commandKeys("Get-Content -Raw -Encoding UTF8 'notes.md'").map(keyText),
    ['Get-Content notes.md']);
  assert.deepEqual(commandKeys('New-Item -ItemType Directory -Path build/out').map(keyText),
    ['New-Item build/out']);
});

test('a command that cannot be read statically can never match a rule', () => {
  assert.equal(commandKeys('echo $(whoami)'), null);
  assert.equal(commandKeys('echo "unterminated'), null);
  assert.equal(commandKeys('powershell -EncodedCommand ZQBjAGgAbwA='), null);
  assert.equal(commandKeys('sleep 1 & echo bg'), null);
});

test('every segment of a compound needs its own rule', () => {
  assert.deepEqual(commandKeys('git status; node scripts/check.mjs').map(keyText),
    ['git status', 'node scripts/check.mjs']);
});

// ── matching ──

test('a rule matches the lexed command, never a substring of it', async () => {
  const { store, directory } = await catalog();
  try {
    await store.add(CWD, [['commands', 'node scripts/check.mjs']]);
    assert.ok(store.allows(CWD, 'command', { command: 'node scripts/check.mjs --fast' }));
    assert.ok(!store.allows(CWD, 'command', { command: 'node -e "process.exit(1)"' }));
    assert.ok(!store.allows(CWD, 'command', { command: 'node scripts/package.mjs' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a compound matches only when every segment is covered', async () => {
  const { store, directory } = await catalog();
  try {
    await store.add(CWD, [['commands', 'git status']]);
    assert.ok(store.allows(CWD, 'command', { command: 'git status --short' }));
    assert.ok(!store.allows(CWD, 'command', { command: 'git status; rm -rf build' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a hand-written rule spelled with backslashes matches the same command with slashes', async () => {
  const { store, directory, filename } = await catalog();
  try {
    await writeFile(filename, JSON.stringify({
      version: 1,
      projects: { [CWD.toLowerCase()]: { commands: ['node scripts\\\\check.mjs'], paths: [], hosts: [] } },
    }));
    assert.ok(store.allows(CWD, 'command', { command: 'node scripts/check.mjs' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rules of one project do not reach another', async () => {
  const { store, directory } = await catalog();
  try {
    await store.add(CWD, [['commands', 'git status']]);
    assert.ok(!store.allows(path.resolve('other_project'), 'command', { command: 'git status' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── deriving the rule the Allow button would save ──

test('an absolute-path argument describes one call, so no rule is offered', async () => {
  const { store, directory } = await catalog();
  try {
    assert.deepEqual(store.derive(CWD, 'command', { command: 'node C:/tmp/once.mjs' }), []);
    assert.deepEqual(store.derive(CWD, 'command', { command: 'node /tmp/once.mjs' }), []);
    assert.deepEqual(store.derive(CWD, 'command', { command: 'node scripts/check.mjs' }),
      [['commands', 'node scripts/check.mjs']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a path rule is the directory the card showed, and never a dangerous one', async () => {
  const { store, directory } = await catalog();
  try {
    assert.deepEqual(store.derive(CWD, 'files', { paths: [path.join(CWD, 'docs/NEW.md')] }),
      [['paths', path.join(CWD, 'docs')]]);
    assert.deepEqual(store.derive(CWD, 'files', { paths: ['.git/hooks/pre-commit'] }), []);
    assert.deepEqual(store.derive(CWD, 'files', { paths: ['.codex/config.toml'] }), []);
    // a path rule grants every file directly inside the directory, so `.claude` is refused for holding
    // settings.json, while `.claude/commands` holds nothing guarded and stays an ordinary rule
    assert.deepEqual(store.derive(CWD, 'files', { paths: ['.claude/settings.json'] }), []);
    assert.deepEqual(store.derive(CWD, 'files', { paths: ['.claude/hooks/stop.ps1'] }), []);
    assert.deepEqual(store.derive(CWD, 'files', { paths: ['.claude/commands/notes.md'] }),
      [['paths', path.join(CWD, '.claude/commands')]]);
    assert.deepEqual(store.derive(CWD, 'files', { paths: [path.join(os.homedir(), 'secret.txt')] }), []);
    assert.deepEqual(store.derive(CWD, 'files', { paths: [path.join(path.parse(CWD).root, 'x.txt')] }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one change set straddling a guarded directory yields no rule at all', async () => {
  const { store, directory } = await catalog();
  try {
    assert.deepEqual(store.derive(CWD, 'files', {
      paths: [path.join(CWD, 'docs/NEW.md'), path.join(CWD, '.git/config')],
    }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a host rule is saved only for a real hostname, never a wildcard', async () => {
  const { store, directory } = await catalog();
  try {
    assert.deepEqual(store.derive(CWD, 'host', { host: 'registry.npmjs.org' }),
      [['hosts', 'registry.npmjs.org']]);
    assert.deepEqual(store.derive(CWD, 'host', { host: '*.npmjs.org' }), []);
    assert.deepEqual(store.derive(CWD, 'host', { host: 'localhost' }), []);
    assert.deepEqual(store.derive(CWD, 'host', { host: '' }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── paths and hosts in force ──

test('a flat path rule covers its directory, and only a written /** covers the subtree', async () => {
  const { store, directory } = await catalog();
  try {
    await store.add(CWD, [['paths', path.join(CWD, 'artifacts')]]);
    assert.ok(store.allows(CWD, 'files', { paths: [path.join(CWD, 'artifacts/run.json')] }));
    assert.ok(!store.allows(CWD, 'files', { paths: [path.join(CWD, 'artifacts/sub/run.json')] }));
    await store.add(CWD, [['paths', `${path.join(CWD, 'artifacts')}/**`]]);
    assert.ok(store.allows(CWD, 'files', { paths: [path.join(CWD, 'artifacts/sub/run.json')] }));
    assert.ok(!store.allows(CWD, 'files', { paths: [] }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a host rule matches exactly, and a written wildcard covers the domain', async () => {
  const { store, directory, filename } = await catalog();
  try {
    await store.add(CWD, [['hosts', 'registry.npmjs.org']]);
    assert.ok(store.allows(CWD, 'host', { host: 'registry.npmjs.org' }));
    assert.ok(store.allows(CWD, 'host', { host: 'REGISTRY.npmjs.org.' }));
    assert.ok(!store.allows(CWD, 'host', { host: 'evil.registry.npmjs.org' }));
    await writeFile(filename, JSON.stringify({
      version: 1, projects: { [CWD.toLowerCase()]: { commands: [], paths: [], hosts: ['*.github.com'] } },
    }));
    assert.ok(store.allows(CWD, 'host', { host: 'api.github.com' }));
    assert.ok(store.allows(CWD, 'host', { host: 'github.com' }));
    assert.ok(!store.allows(CWD, 'host', { host: 'github.com.evil.net' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ── the file itself ──

test('rules survive a restart and an edit made outside the app', async () => {
  const { store, directory, filename } = await catalog();
  try {
    await store.add(CWD, [['commands', 'git status'], ['hosts', 'registry.npmjs.org']]);
    const reopened = new ApprovalCatalog(filename);
    assert.ok(reopened.allows(CWD, 'command', { command: 'git status' }));

    const saved = JSON.parse(await readFile(filename, 'utf8'));
    const key = Object.keys(saved.projects)[0];
    saved.projects[key].commands.push('node scripts/check.mjs');
    await writeFile(filename, JSON.stringify(saved));
    assert.ok(reopened.allows(CWD, 'command', { command: 'node scripts/check.mjs' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a half-written file keeps the last good rules and reports the problem once', async () => {
  const { store, directory, filename } = await catalog();
  const warnings = [];
  store.onWarning = message => warnings.push(message);
  try {
    await store.add(CWD, [['commands', 'git status']]);
    await writeFile(filename, '{ "projects": ');
    assert.ok(store.allows(CWD, 'command', { command: 'git status' }));
    assert.ok(store.allows(CWD, 'command', { command: 'git status' }));
    assert.equal(warnings.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adding is idempotent and dropping removes by listed position', async () => {
  const { store, directory } = await catalog();
  try {
    assert.deepEqual(await store.add(CWD, [['commands', 'git status']]), ['git status']);
    assert.deepEqual(await store.add(CWD, [['commands', 'git  status']]), []);
    await store.add(CWD, [['hosts', 'registry.npmjs.org']]);
    assert.deepEqual(store.listing(CWD), [['commands', 'git status'], ['hosts', 'registry.npmjs.org']]);
    assert.equal(await store.drop(CWD, 1), 'git status');
    assert.deepEqual(store.listing(CWD), [['hosts', 'registry.npmjs.org']]);
    assert.equal(await store.drop(CWD, 9), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unknown rule kind is refused rather than silently stored', async () => {
  const { store, directory } = await catalog();
  try {
    await assert.rejects(() => store.add(CWD, [['jobs', 'https://ci/job/deploy']]));
    await assert.rejects(() => store.add('', [['commands', 'git status']]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
