import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Read-only listing of the SKILL.md files the installed agents discover. The shell never writes, enables
// or disables a skill here: the list mirrors what is on disk, the agents keep deciding what to load.
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILLS = 500;
const MAX_ERRORS = 50;
const MAX_ENTRIES_PER_DIRECTORY = 1000;
const PLUGIN_DEPTH = 4;
const NAME_LIMIT = 120;
const DESCRIPTION_LIMIT = 600;
const SOURCE_ORDER = ['project', 'user', 'shared', 'synced', 'plugin'];

function providerName(provider) {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('Неизвестный агент навыков.');
  return provider;
}

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value) || !path.isAbsolute(value)) {
    throw new Error(`${label} должен содержать абсолютный путь к каталогу.`);
  }
  return path.resolve(value);
}

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length > 1 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Minimal front matter reader: `key: value`, quoted values and folded/indented continuations. */
export function readFrontmatter(content) {
  const body = content.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match) return {};
  const fields = {};
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (pair) {
      key = pair[1].toLowerCase();
      const value = pair[2].trim();
      fields[key] = value === '|' || value === '>' || value === '|-' || value === '>-' ? '' : unquote(value);
      continue;
    }
    if (key && /^[ \t]+\S/.test(line)) {
      fields[key] = `${fields[key]} ${unquote(line.trim())}`.trim();
      continue;
    }
    if (line.trim()) key = null;
  }
  return fields;
}

async function readBounded(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SKILL_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listDirectories(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const directories = [];
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isSymbolicLink()) {
      try { if ((await fs.stat(path.join(directory, entry.name))).isDirectory()) directories.push(entry.name); }
      catch { /* a broken link is not a skill */ }
    }
  }
  return directories.sort((left, right) => left.localeCompare(right, 'en'));
}

export class AgentSkillsService {
  constructor({ env = process.env, home } = {}) {
    this.env = env;
    this.home = home;
  }

  /** Directories each agent reads skills from, in the order the UI groups them. */
  roots(provider, cwd) {
    providerName(provider);
    const key = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const configured = this.env[key];
    const home = absoluteDirectory(this.home ?? this.env.USERPROFILE ?? os.homedir(), 'Домашний каталог');
    const agentHome = configured === undefined || configured === ''
      ? path.join(home, provider === 'codex' ? '.codex' : '.claude')
      : absoluteDirectory(configured, key);
    const project = typeof cwd === 'string' && cwd && !/[\r\n\0]/.test(cwd) && path.isAbsolute(cwd) ? path.resolve(cwd) : null;
    return [
      ...(project ? [
        { source: 'project', path: path.join(project, provider === 'codex' ? '.codex' : '.claude', 'skills') },
        { source: 'project', path: path.join(project, '.agents', 'skills') },
      ] : []),
      { source: 'user', path: path.join(agentHome, 'skills') },
      { source: 'shared', path: path.join(home, '.agents', 'skills') },
      { source: 'plugin', path: path.join(agentHome, 'plugins'), kind: 'plugins' },
    ];
  }

  async _skill({ directory, source, root, plugin, order = 0 }, state) {
    const file = path.join(directory, 'SKILL.md');
    let content;
    try { content = await readBounded(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      if (state.errors.length < MAX_ERRORS) state.errors.push({ path: file, message: `Не удалось прочитать файл (${error.code || 'ошибка чтения'}).` });
      return null;
    }
    const fields = readFrontmatter(content);
    let updatedAt = null;
    try { updatedAt = (await fs.stat(file)).mtime.toISOString(); } catch { /* the list works without a timestamp */ }
    return {
      id: `${source}:${file}`,
      name: text(fields.name, NAME_LIMIT) || path.basename(directory).slice(0, NAME_LIMIT),
      description: text(fields.description, DESCRIPTION_LIMIT),
      source, root, path: file, directory, updatedAt, order,
      ...(plugin ? { plugin } : {}),
    };
  }

  async _collectSkillsRoot(root, state, { source = root.source, plugin, order = root.order || 0 } = {}) {
    let names;
    try { names = await listDirectories(root.path); }
    catch (error) {
      if (error.code !== 'ENOENT' && state.errors.length < MAX_ERRORS) {
        state.errors.push({ path: root.path, message: `Не удалось прочитать каталог (${error.code || 'ошибка чтения'}).` });
      }
      return false;
    }
    for (const name of names) {
      if (state.skills.length >= MAX_SKILLS) { state.truncated = true; return true; }
      const directory = path.join(root.path, name);
      const skill = await this._skill({ directory, source, root: root.path, plugin, order }, state);
      if (skill) { state.skills.push(skill); continue; }
      // `synced/<bucket>/<name>` holds the skills synchronised from the account; a plain folder without
      // SKILL.md is not a skill and is left alone.
      if (name !== 'synced') continue;
      let buckets;
      try { buckets = await listDirectories(directory); } catch { continue; }
      for (const bucket of buckets) {
        const bucketPath = path.join(directory, bucket);
        let inner;
        try { inner = await listDirectories(bucketPath); } catch { continue; }
        for (const child of inner) {
          if (state.skills.length >= MAX_SKILLS) { state.truncated = true; return true; }
          const synced = await this._skill({ directory: path.join(bucketPath, child), source: 'synced', root: bucketPath, plugin, order }, state);
          if (synced) state.skills.push(synced);
        }
      }
    }
    return true;
  }

  /** Plugin layouts differ by marketplace, so look for `skills` directories within a bounded depth. */
  async _collectPlugins(root, state, directory = root.path, depth = 0) {
    let names;
    try { names = await listDirectories(directory); }
    catch (error) {
      if (error.code !== 'ENOENT' && depth === 0 && state.errors.length < MAX_ERRORS) {
        state.errors.push({ path: directory, message: `Не удалось прочитать каталог (${error.code || 'ошибка чтения'}).` });
      }
      return false;
    }
    for (const name of names) {
      if (state.skills.length >= MAX_SKILLS) { state.truncated = true; break; }
      const child = path.join(directory, name);
      if (name === 'skills') {
        await this._collectSkillsRoot({ source: 'plugin', path: child }, state, { source: 'plugin', plugin: path.basename(directory), order: root.order || 0 });
        continue;
      }
      if (depth < PLUGIN_DEPTH) await this._collectPlugins(root, state, child, depth + 1);
    }
    return true;
  }

  async list({ provider, cwd } = {}) {
    const agent = providerName(provider);
    const roots = this.roots(agent, cwd);
    const state = { skills: [], errors: [], truncated: false };
    const reported = [];
    for (const [order, root] of roots.entries()) {
      root.order = order;
      const before = state.skills.length;
      const exists = root.kind === 'plugins' ? await this._collectPlugins(root, state) : await this._collectSkillsRoot(root, state);
      reported.push({ source: root.source, path: root.path, exists, count: state.skills.length - before });
    }
    state.skills.sort((left, right) => SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
      || left.name.localeCompare(right.name, 'en') || left.order - right.order || left.path.localeCompare(right.path, 'en'));
    // The same skill is often written to two folders at once (an account sync keeps `.claude` and `.agents`
    // in step). Keep one row per name within a source and remember the other copies.
    const folded = [];
    const seen = new Map();
    for (const skill of state.skills) {
      const key = `${skill.source}|${skill.name.toLowerCase()}`;
      const first = seen.get(key);
      if (first) { (first.duplicates ??= []).push(skill.path); continue; }
      const { order, ...row } = skill;
      seen.set(key, row);
      folded.push(row);
    }
    return {
      provider: agent,
      cwd: typeof cwd === 'string' ? cwd : '',
      readAt: new Date().toISOString(),
      roots: reported,
      skills: folded,
      errors: state.errors,
      truncated: state.truncated,
    };
  }
}
