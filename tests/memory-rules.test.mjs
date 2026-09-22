import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRulesService } from '../electron/memory-rules.mjs';

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desk-memory-test-'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('codex-desk-memory-test-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  const env = {};
  const service = new MemoryRulesService({ home, env, ...options });
  const write = async (relative, bytes) => {
    const filePath = path.join(home, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
    return filePath;
  };
  const apply = async (provider = 'codex', enabled = true) => service.apply({ provider, enabled, revision: (await service.preview(provider)).revision });
  return { home, env, service, write, apply };
}

test('preview is read-only and shows portable bundled policy and full procedure for both agents', async t => {
  const { home, service } = await fixture(t);
  for (const provider of ['codex', 'claude']) {
    const preview = await service.preview(provider);
    assert.equal(preview.provider, provider);
    assert.equal(preview.enabled, false);
    assert.equal(preview.conflict, null);
    assert.equal(preview.instructionPath, path.join(home, provider === 'codex' ? '.codex/AGENTS.md' : '.claude/CLAUDE.md'));
    assert.ok(preview.rulesText.includes(preview.procedurePath.replaceAll('\\', '/')));
    assert.match(preview.rulesText, /110/);
    assert.match(preview.rulesText, /Не запускай полную компакцию автоматически/);
    for (const fact of ['1685', '2306', '977', '101', '10–16', '×2.9', '$0.4–0.85', 'chr(92)', 'tools/repair_cumulative_spend.py --apply', 'меньше чем на треть', 'SQLite']) {
      assert.ok(preview.procedureText.includes(fact), fact);
    }
    assert.doesNotMatch(preview.procedureText + preview.rulesText, /LEGION-PC/);
    assert.match(preview.revision, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(await fs.readdir(home), []);
});

test('enable installs instructions and procedure; repeated apply is a no-op; disable preserves procedure', async t => {
  const { service, apply } = await fixture(t);
  for (const provider of ['codex', 'claude']) {
    const first = await apply(provider);
    assert.equal(first.enabled, true);
    assert.equal(first.changed, true);
    assert.deepEqual(first.backupPaths, []);
    assert.equal(await fs.readFile(first.instructionPath, 'utf8'), first.rulesText);
    assert.equal(await fs.readFile(first.procedurePath, 'utf8'), first.procedureText);
    const second = await service.apply({ provider, enabled: true, revision: first.revision });
    assert.equal(second.changed, false);
    const off = await apply(provider, false);
    assert.equal(off.enabled, false);
    assert.equal((await fs.readFile(off.instructionPath)).length, 0);
    assert.equal(await fs.readFile(off.procedurePath, 'utf8'), first.procedureText);
    assert.equal(off.backupPaths.length, 1);
    assert.equal(await fs.readFile(off.backupPaths[0], 'utf8'), first.rulesText);
    assert.equal((await apply(provider, false)).changed, false);
  }
});

test('roundtrip preserves all original bytes, BOM, Unicode, CRLF and trailing newlines', async t => {
  const { write, apply } = await fixture(t);
  for (const original of ['', '\uFEFF', 'Правило пользователя: café 日本語', 'A\n', 'A\n\n', '\uFEFF# Мои инструкции\r\nстрока\r\n', 'A\r\n\r\n', 'A\n\r\n']) {
    const instructionPath = await write('.codex/AGENTS.md', original);
    const enabled = await apply();
    assert.equal(enabled.backupPaths.length, 1);
    assert.deepEqual(await fs.readFile(enabled.backupPaths[0]), Buffer.from(original));
    const installed = await fs.readFile(instructionPath);
    assert.ok(installed.subarray(0, Buffer.byteLength(original)).equals(Buffer.from(original)));
    await apply('codex', false);
    assert.deepEqual(await fs.readFile(instructionPath), Buffer.from(original));
  }
});

test('disable retains user text appended and prepended around an intact block', async t => {
  const { write, apply, service } = await fixture(t);
  const original = '\uFEFFЛичные правила\r\n';
  const filePath = await write('.claude/CLAUDE.md', original);
  await apply('claude');
  const installed = await fs.readFile(filePath, 'utf8');
  await fs.writeFile(filePath, 'Вступление\n' + installed + 'Новое пользовательское правило\n');
  assert.equal((await service.preview('claude')).conflict, null);
  await apply('claude', false);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Вступление\n' + original + 'Новое пользовательское правило\n');
});

test('native Codex override selection preserves empty overrides and masked original instructions', async t => {
  const { write, service, apply } = await fixture(t);
  const primary = await write('.codex/AGENTS.md', 'Обычные инструкции');
  for (const empty of ['', ' \n\r\n', '\uFEFF\r\n']) {
    const override = await write('.codex/AGENTS.override.md', empty);
    assert.equal((await service.preview('codex')).instructionPath, primary);
    await apply();
    assert.equal(await fs.readFile(override, 'utf8'), empty);
    await apply('codex', false);
  }
  const override = await write('.codex/AGENTS.override.md', '\uFEFFOverride\r\n');
  assert.equal((await service.preview('codex')).instructionPath, override);
  await apply();
  assert.equal(await fs.readFile(primary, 'utf8'), 'Обычные инструкции');
  await apply('codex', false);
  assert.equal(await fs.readFile(override, 'utf8'), '\uFEFFOverride\r\n');
});

test('later override invalidates preview and reports a masked managed block without creating a duplicate', async t => {
  const { write, service, apply } = await fixture(t);
  const oldPreview = await service.preview('codex');
  await write('.codex/AGENTS.override.md', 'Override');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: oldPreview.revision }), /устарел/);
  await write('.codex/AGENTS.override.md', '');
  const installed = await apply();
  const original = await fs.readFile(installed.instructionPath);
  const override = await write('.codex/AGENTS.override.md', 'Новый override');
  const preview = await service.preview('codex');
  assert.equal(preview.enabled, false);
  assert.match(preview.conflict, /перекрытый/);
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /перекрытый/);
  assert.deepEqual(await fs.readFile(installed.instructionPath), original);
  assert.equal(await fs.readFile(override, 'utf8'), 'Новый override');
});

test('absolute custom agent directories work independently; changed environment invalidates preview', async t => {
  const { home, env, service } = await fixture(t);
  env.CODEX_HOME = path.join(home, 'custom codex');
  env.CLAUDE_CONFIG_DIR = path.join(home, 'custom claude');
  const codex = await service.preview('codex');
  const claude = await service.preview('claude');
  assert.equal(codex.instructionPath, path.join(env.CODEX_HOME, 'AGENTS.md'));
  assert.equal(claude.instructionPath, path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'));
  await service.apply({ provider: 'claude', enabled: true, revision: claude.revision });
  env.CODEX_HOME = path.join(home, 'changed codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: codex.revision }), /устарел/);
  await assert.rejects(fs.stat(path.join(home, '.codex')), { code: 'ENOENT' });
  env.CODEX_HOME = 'relative/profile';
  await assert.rejects(service.preview('codex'), /CODEX_HOME.*абсолютный/);
  env.CLAUDE_CONFIG_DIR = 'relative/profile';
  await assert.rejects(service.preview('claude'), /CLAUDE_CONFIG_DIR.*абсолютный/);
});

test('rejects malformed provider, toggle and revision before writes', async t => {
  const { home, service } = await fixture(t);
  for (const provider of ['other', '', null, {}, 1]) await assert.rejects(service.preview(provider), /агент/);
  for (const input of [null, [], {}, { provider: 'codex', enabled: 'true', revision: '0'.repeat(64) }, { provider: 'codex', enabled: true, revision: '../file' }]) {
    await assert.rejects(service.apply(input));
  }
  assert.deepEqual(await fs.readdir(home), []);
});

test('manual block changes, malformed markers and duplicate blocks conflict without overwriting bytes', async t => {
  const { service, apply } = await fixture(t);
  const installed = await apply();
  const pristine = await fs.readFile(installed.instructionPath, 'utf8');
  for (const changed of [
    pristine.replace('110', '125'),
    pristine.replace(':v1:start', ':v2:start'),
    pristine.replace(':v1:end', ':v2:end'),
    pristine.replace('<!-- codex-desk:memory-rules:v1:end -->', ''),
    pristine + pristine,
    pristine.replace('prefix=0', 'prefix=2'),
  ]) {
    await fs.writeFile(installed.instructionPath, changed);
    const preview = await service.preview('codex');
    assert.ok(preview.conflict);
    for (const enabled of [true, false]) await assert.rejects(service.apply({ provider: 'codex', enabled, revision: preview.revision }));
    assert.equal(await fs.readFile(installed.instructionPath, 'utf8'), changed);
  }
});

test('preserves a pre-existing or manually edited full procedure and refuses collision', async t => {
  const { write, service } = await fixture(t);
  const filePath = await write('.codex/codex-desk/memory-compact.md', 'Своя процедура');
  const preview = await service.preview('codex');
  assert.match(preview.conflict, /отличается/);
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /отличается/);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Своя процедура');
  await assert.rejects(fs.stat(preview.instructionPath), { code: 'ENOENT' });
});

test('missing installed procedure can be restored without rewriting instructions or creating a backup', async t => {
  const { service, apply } = await fixture(t);
  const installed = await apply();
  const before = await fs.stat(installed.instructionPath);
  await fs.unlink(installed.procedurePath);
  const preview = await service.preview('codex');
  assert.equal(preview.enabled, true);
  assert.equal(preview.conflict, null);
  const repaired = await apply();
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.backupPaths, []);
  assert.equal((await fs.stat(installed.instructionPath)).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(installed.procedurePath, 'utf8'), installed.procedureText);
});

test('instruction and procedure changes after preview invalidate revision', async t => {
  const { service, write } = await fixture(t);
  const instructionPath = await write('.claude/CLAUDE.md', 'Исходное');
  const first = await service.preview('claude');
  await fs.writeFile(instructionPath, 'Правка в редакторе');
  await assert.rejects(service.apply({ provider: 'claude', enabled: true, revision: first.revision }), /устарел/);
  const second = await service.preview('claude');
  await write('.claude/codex-desk/memory-compact.md', second.procedureText);
  await assert.rejects(service.apply({ provider: 'claude', enabled: true, revision: second.revision }), /устарел/);
  assert.equal(await fs.readFile(instructionPath, 'utf8'), 'Правка в редакторе');
});

test('backup write failure leaves original bytes and procedure absent', async t => {
  const io = { ...fs, writeFile: async (filePath, ...args) => {
    if (filePath.includes('.backup-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return fs.writeFile(filePath, ...args);
  } };
  const { write, service, home } = await fixture(t, { fs: io });
  const filePath = await write('.codex/AGENTS.md', '\uFEFFОригинал\r\n');
  const preview = await service.preview('codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /резервную копию/);
  assert.equal(await fs.readFile(filePath, 'utf8'), '\uFEFFОригинал\r\n');
  await assert.rejects(fs.stat(preview.procedurePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(home, '.codex/codex-desk')), []);
});

test('external edit during staging is preserved and detected before commit', async t => {
  let instructionPath;
  let edited = false;
  const io = { ...fs, writeFile: async (filePath, ...args) => {
    if (!edited && filePath.endsWith('.tmp')) {
      edited = true;
      await fs.appendFile(instructionPath, '\nВнешняя правка');
    }
    return fs.writeFile(filePath, ...args);
  } };
  const { write, service, home } = await fixture(t, { fs: io });
  instructionPath = await write('.codex/AGENTS.md', 'Пользователь');
  const preview = await service.preview('codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /изменились/);
  assert.equal(await fs.readFile(instructionPath, 'utf8'), 'Пользователь\nВнешняя правка');
  await assert.rejects(fs.stat(preview.procedurePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(home, '.codex/codex-desk')), []);
  const backups = (await fs.readdir(path.dirname(instructionPath))).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(instructionPath), backups[0]), 'utf8'), 'Пользователь');
});

test('an external edit after procedure creation is detected before instruction commit', async t => {
  let instructionPath;
  const io = { ...fs, link: async (source, target) => {
    await fs.link(source, target);
    if (target.endsWith('memory-compact.md')) await fs.appendFile(instructionPath, '\nОдновременная правка');
  } };
  const { write, service } = await fixture(t, { fs: io });
  instructionPath = await write('.codex/AGENTS.md', 'Пользователь');
  const preview = await service.preview('codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /изменились/);
  assert.equal(await fs.readFile(instructionPath, 'utf8'), 'Пользователь\nОдновременная правка');
  assert.equal(await fs.readFile(preview.procedurePath, 'utf8'), preview.procedureText);
});

test('two service instances cannot commit the same preview concurrently', async t => {
  const { home, env, service, write } = await fixture(t);
  await write('.claude/CLAUDE.md', 'Пользователь');
  const other = new MemoryRulesService({ home, env });
  const preview = await service.preview('claude');
  const request = { provider: 'claude', enabled: true, revision: preview.revision };
  const results = await Promise.allSettled([service.apply(request), other.apply(request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const installed = await service.preview('claude');
  assert.equal(installed.conflict, null);
  assert.equal(installed.enabled, true);
  assert.equal((await fs.readFile(installed.instructionPath, 'utf8')).match(/:v1:start/g).length, 1);
});

test('existing lock refuses writes and is not removed by this service', async t => {
  const { write, service } = await fixture(t);
  const lockPath = await write('.codex/codex-desk/.memory-rules.lock', 'another process');
  const preview = await service.preview('codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /другим окном/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'another process');
  await assert.rejects(fs.stat(preview.instructionPath), { code: 'ENOENT' });
});

test('rejects non-regular, oversized and non-UTF-8 instructions without writes', async t => {
  const { home, write, service } = await fixture(t);
  const filePath = path.join(home, '.codex/AGENTS.md');
  await fs.mkdir(filePath, { recursive: true });
  assert.match((await service.preview('codex')).conflict, /обычный файл/);
  await fs.rmdir(filePath);
  await write('.codex/AGENTS.md', Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  assert.match((await service.preview('codex')).conflict, /2 МБ/);
  await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0, 0]));
  const preview = await service.preview('codex');
  assert.match(preview.conflict, /UTF-8/);
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /UTF-8/);
  assert.deepEqual(await fs.readFile(filePath), Buffer.from([0xff, 0xfe, 0, 0]));
});

test('rejects symlink instruction and procedure paths', async t => {
  const { home, service, write } = await fixture(t);
  const directory = path.join(home, 'link-target');
  await fs.mkdir(directory);
  await write('.codex/placeholder', '');
  const instructionPath = path.join(home, '.codex/AGENTS.md');
  await fs.symlink(directory, instructionPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await service.preview('codex')).conflict, /символической ссылки/);
  await fs.unlink(instructionPath);
  await fs.mkdir(path.join(home, '.codex/codex-desk'));
  const procedurePath = path.join(home, '.codex/codex-desk/memory-compact.md');
  await fs.symlink(directory, procedurePath, process.platform === 'win32' ? 'junction' : 'dir');
  const preview = await service.preview('codex');
  assert.match(preview.conflict, /символической ссылки/);
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /символической ссылки/);
});


test('staging collision never deletes the pre-existing temporary file', async t => {
  let collided;
  const io = { ...fs, writeFile: async (filePath, ...args) => {
    if (!collided && filePath.endsWith('.tmp')) {
      collided = filePath;
      await fs.writeFile(filePath, 'Чужой временный файл');
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    }
    return fs.writeFile(filePath, ...args);
  } };
  const { service } = await fixture(t, { fs: io });
  const preview = await service.preview('codex');
  await assert.rejects(service.apply({ provider: 'codex', enabled: true, revision: preview.revision }), /подготовить/);
  assert.equal(await fs.readFile(collided, 'utf8'), 'Чужой временный файл');
  await assert.rejects(fs.stat(preview.instructionPath), { code: 'ENOENT' });
});

test('instruction commit failure retains original and exact backup, cleans lock, and allows retry', async t => {
  let fail = true;
  const io = { ...fs, rename: async (...args) => {
    if (fail) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return fs.rename(...args);
  } };
  const { write, service, apply } = await fixture(t, { fs: io });
  const filePath = await write('.claude/CLAUDE.md', 'Оригинал');
  const preview = await service.preview('claude');
  await assert.rejects(service.apply({ provider: 'claude', enabled: true, revision: preview.revision }), { code: 'EACCES' });
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Оригинал');
  const backups = (await fs.readdir(path.dirname(filePath))).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(filePath), backups[0]), 'utf8'), 'Оригинал');
  assert.deepEqual(await fs.readdir(path.dirname(preview.procedurePath)), ['memory-compact.md']);
  fail = false;
  assert.equal((await apply('claude')).enabled, true);
});
