import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSkillsService, readFrontmatter } from '../electron/agent-skills.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desk-skills-test-'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('codex-desk-skills-test-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  const env = {};
  const service = new AgentSkillsService({ home, env });
  const skill = async (relative, frontmatter, body = '# Заголовок\n') => {
    const file = path.join(home, relative, 'SKILL.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${frontmatter}${body}`);
    return file;
  };
  const named = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
  return { home, env, service, skill, named };
}

test('front matter reader keeps quoted values and folded continuations', () => {
  const fields = readFrontmatter('---\nname: "pdf"\ndescription: Читает PDF\n  и собирает отчёт\nother: \'x\'\n---\n# Тело\n');
  assert.equal(fields.name, 'pdf');
  assert.equal(fields.description, 'Читает PDF и собирает отчёт');
  assert.equal(fields.other, 'x');
  assert.deepEqual(readFrontmatter('# Без заголовка\nname: нет\n'), {});
});

test('each agent reads its own home, the shared folder and the project', async t => {
  const { home, service, skill, named } = await fixture(t);
  const project = path.join(home, 'project');
  await skill('.codex/skills/codex-only', named('codex-only', 'Только для Codex'));
  await skill('.claude/skills/claude-only', named('claude-only', 'Только для Claude'));
  await skill('.agents/skills/shared-skill', named('shared-skill', 'Общий навык'));
  await skill('project/.codex/skills/project-codex', named('project-codex', 'Проектный Codex'));
  await skill('project/.claude/skills/project-claude', named('project-claude', 'Проектный Claude'));
  await skill('project/.agents/skills/project-shared', named('project-shared', 'Проектный общий'));

  const codex = await service.list({ provider: 'codex', cwd: project });
  assert.deepEqual(codex.skills.map(item => item.name), ['project-codex', 'project-shared', 'codex-only', 'shared-skill']);
  assert.deepEqual(codex.skills.map(item => item.source), ['project', 'project', 'user', 'shared']);
  assert.equal(codex.skills[0].description, 'Проектный Codex');
  assert.equal(codex.skills[2].path, path.join(home, '.codex', 'skills', 'codex-only', 'SKILL.md'));
  assert.ok(codex.skills[2].updatedAt);
  assert.equal(codex.truncated, false);
  assert.deepEqual(codex.errors, []);

  const claude = await service.list({ provider: 'claude', cwd: project });
  assert.deepEqual(claude.skills.map(item => item.name), ['project-claude', 'project-shared', 'claude-only', 'shared-skill']);
  assert.ok(!claude.skills.some(item => item.name === 'codex-only'));
});

test('without a working folder only the user-level roots are read', async t => {
  const { home, service, skill, named } = await fixture(t);
  await skill('.claude/skills/user-skill', named('user-skill', 'Пользовательский'));
  await skill('project/.claude/skills/project-skill', named('project-skill', 'Проектный'));
  const snapshot = await service.list({ provider: 'claude' });
  assert.deepEqual(snapshot.skills.map(item => item.name), ['user-skill']);
  assert.deepEqual(snapshot.roots.map(root => root.source), ['user', 'shared', 'plugin']);
  assert.equal(snapshot.roots.find(root => root.source === 'user').count, 1);
  assert.equal(snapshot.roots.find(root => root.source === 'shared').exists, false);
  assert.equal(path.dirname(path.dirname(snapshot.skills[0].path)), path.join(home, '.claude', 'skills'));
});

test('CODEX_HOME and CLAUDE_CONFIG_DIR replace the default agent folders', async t => {
  const { home, env, service, skill, named } = await fixture(t);
  env.CODEX_HOME = path.join(home, 'portable-codex');
  env.CLAUDE_CONFIG_DIR = path.join(home, 'portable-claude');
  await skill('portable-codex/skills/portable', named('portable', 'Переносимый Codex'));
  await skill('.codex/skills/default', named('default', 'Обычный каталог'));
  const snapshot = await service.list({ provider: 'codex' });
  assert.deepEqual(snapshot.skills.map(item => item.name), ['portable']);
  assert.equal(snapshot.roots[0].path, path.join(home, 'portable-codex', 'skills'));
  const claude = await service.list({ provider: 'claude' });
  assert.equal(claude.roots[0].path, path.join(home, 'portable-claude', 'skills'));
});

test('synced buckets, plugins and nameless skills are listed with their origin', async t => {
  const { home, service, skill, named } = await fixture(t);
  await skill('.claude/skills/synced/bucket-1/pptx', named('pptx', 'Презентации'));
  await skill('.claude/plugins/marketplaces/shop/helper/skills/plugin-skill', named('plugin-skill', 'Из плагина'));
  await skill('.claude/skills/no-frontmatter', '');
  const snapshot = await service.list({ provider: 'claude' });
  const byName = Object.fromEntries(snapshot.skills.map(item => [item.name, item]));
  assert.equal(byName.pptx.source, 'synced');
  assert.equal(byName['plugin-skill'].source, 'plugin');
  assert.equal(byName['plugin-skill'].plugin, 'helper');
  assert.equal(byName['no-frontmatter'].description, '');
  assert.equal(byName['no-frontmatter'].source, 'user');
  assert.equal(snapshot.roots.find(root => root.source === 'plugin').count, 1);
});

test('a folder without SKILL.md, a dot folder and an unknown agent are rejected or skipped', async t => {
  const { home, service, skill, named } = await fixture(t);
  await fs.mkdir(path.join(home, '.claude', 'skills', 'empty'), { recursive: true });
  await skill('.claude/skills/.hidden', named('hidden', 'Скрытый'));
  await skill('.claude/skills/real', named('real', 'Настоящий'));
  const snapshot = await service.list({ provider: 'claude' });
  assert.deepEqual(snapshot.skills.map(item => item.name), ['real']);
  await assert.rejects(service.list({ provider: 'gemini' }), /Неизвестный агент навыков/);
});

test('the front matter name wins over the folder and long text is cut', async t => {
  const { service, skill } = await fixture(t);
  await skill('.codex/skills/folder-name', `---\nname: ${'и'.repeat(200)}\ndescription: ${'о'.repeat(900)}\n---\n`);
  const snapshot = await service.list({ provider: 'codex' });
  assert.equal(snapshot.skills[0].name.length, 120);
  assert.equal(snapshot.skills[0].description.length, 600);
});

test('the same skill written to two folders is shown once with its copies', async t => {
  const { home, service, skill, named } = await fixture(t);
  await skill('.claude/skills/synced/bucket-1/pdf', named('pdf', 'Работа с PDF'));
  await skill('.agents/skills/synced/bucket-1/pdf', named('pdf', 'Работа с PDF'));
  await skill('.claude/skills/pdf', named('pdf', 'Своя версия'));
  const snapshot = await service.list({ provider: 'claude' });
  const synced = snapshot.skills.filter(item => item.source === 'synced');
  assert.equal(synced.length, 1);
  assert.deepEqual(synced[0].duplicates, [path.join(home, '.agents', 'skills', 'synced', 'bucket-1', 'pdf', 'SKILL.md')]);
  // A personal skill with the same name is a different row: it is what actually shadows the synced one.
  assert.equal(snapshot.skills.filter(item => item.source === 'user' && item.name === 'pdf').length, 1);
});
