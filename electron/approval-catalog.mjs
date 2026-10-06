/**
 * ApprovalCatalog — the standing approvals a project carries, so a routine action is asked about once.
 *
 * Ported from the Aurora fleet's `armada/approvals.py`, with its reasoning intact and two deliberate
 * changes: the catalog lives in this app's own userData rather than inside the user's repository (Codex Desk
 * opens arbitrary folders and has never written a file into one — a `.codexdesk/` directory appearing in
 * somebody's `git status` is not ours to create), and a third rule kind was added for network hosts, which
 * is the escalation Codex's sandbox raises most and which Aurora's own sandbox never let through at all.
 * Jenkins job rules are not ported; nothing here presses a build button.
 *
 * WHY a catalog instead of the button's memory: "Allow" remembered by TOOL NAME, in memory, is the broadest
 * grant a gate can give — one click on a `git commit` silences every future shell command — and a restart
 * throws it away, so the same routine command is re-approved daily. A rule that NAMES what was allowed is
 * both narrower and durable.
 *
 * THREE RULE KINDS, because an approval card is about one of three things:
 *   * `commands` — argv[0] plus the argument that names what it acts on, e.g. `node scripts/check.mjs`.
 *     Deliberately NOT the full command: the arguments differ every call, so a verbatim rule would never
 *     match twice. Matching is done on the LEXED command, never by substring, so a rule for
 *     `node scripts/check.mjs` cannot be stretched over `node -e "..."`.
 *   * `paths` — a directory; any file directly in it may be written. `<dir>/**` covers the subtree, and only
 *     a human editing the file can grant that: the button always saves the flat directory, so what was
 *     approved is exactly what the card showed.
 *   * `hosts` — ONE network host the sandbox asked to reach, e.g. `registry.npmjs.org`. `*.example.com`
 *     covers a domain and its subdomains and, like `/**`, only a human editing the file can grant it.
 *
 * THE INVARIANT: a rule removes a QUESTION, never a BOUNDARY. Everything here is reachable by pressing
 * Allow on the card; the catalog only spares the user the twentieth identical click. Two guards keep it
 * that way — a rule is never derived for a drive root, the home directory or a system directory (one
 * mis-aimed Allow would otherwise open the machine), and never for a path the file-write gate itself
 * guards (`.git/`, `.codex/`, the agents' settings and hooks), which is the grant that could let an agent
 * rewrite the rules that bind it.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { foldPath, isPathInside, lexSegments, unwrapShell } from './command-gate.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RULES_PER_KIND = 500;
const KINDS = ['commands', 'paths', 'hosts'];
const SUBTREE = '/**';
const HOST_WILDCARD = '*.';
/** A base64 payload cannot be read, so it can neither be keyed nor vetted — refuse the whole command. */
const OPAQUE_FLAGS = new Set(['-encodedcommand', '-enc']);
/** A token naming a file or directory, rather than the value of some flag. */
const PATH_LIKE_RE = /[/]|\.[A-Za-z0-9]{1,8}$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Compare command rules the way the OS runs them: separators unified, whitespace collapsed, case folded
 * where the platform folds it. `C:\WINDOWS\...\node.exe` and `C:/Windows/.../Node.exe` are one rule.
 * Folding runs of backslashes (not each one) matters for a HAND-WRITTEN rule: a user copying a path out of
 * a Codex command line brings its doubled `\\` along, and that must still be the same rule.
 */
function foldCommand(text) {
  const unified = String(text).replace(/\\+/g, '/').split(/\s+/).filter(Boolean).join(' ');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function foldHost(text) {
  return String(text).trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Directories a rule may never name. Equality, not containment: `C:\Windows\Temp` is an ordinary directory a
 * user may well want to grant — it is `C:\Windows` itself that must stay unreachable.
 */
function unsafeRoots() {
  const roots = new Set([os.homedir()]);
  for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'USERPROFILE']) {
    const value = process.env[name];
    if (value) roots.add(value);
  }
  for (const value of ['/', '/etc', '/usr', '/bin', '/sbin', '/var']) roots.add(value);
  return new Set([...roots].filter(Boolean).map(value => foldPath(value)));
}

/**
 * One segment's rule key as [argv0, the argument that names what it acts on]. argv[0] is kept AS WRITTEN —
 * a full path to an executable is what makes `D:/Program Files/nodejs/node.exe` a different rule from some
 * other node on the machine.
 *
 * The argument is the first PATH-LIKE token, and only then the first non-flag token. A plain
 * `node scripts/check.mjs …` is unaffected (its script comes first either way), but PowerShell passes its
 * arguments by NAME, so the first non-flag token there is whatever value happens to lead: it derived
 * `Get-Content UTF8` from `Get-Content -Raw -Encoding UTF8 'notes.md'` — the value of `-Encoding`! — a rule
 * that names nothing the user read on the card, yet silences the cmdlet for every file. The non-flag
 * fallback stays so a subcommand shape (`git status`) keys exactly as before.
 */
function segmentKey(segment) {
  const args = segment.slice(1).filter(token => !token.startsWith('-'));
  const argument = args.find(token => PATH_LIKE_RE.test(token)) ?? (args.length ? args[0] : '');
  return [segment[0], argument];
}

/**
 * The rule keys a command would match, one per segment, or null when it cannot be statically read (a
 * command substitution, an unbalanced quote, a base64 payload, a backgrounded form). Null means "no rule
 * can ever match this" — the card stands.
 */
export function commandKeys(command) {
  const segments = lexSegments(unwrapShell(command));
  if (!segments) return null;
  if (segments.some(segment => segment.some(token => OPAQUE_FLAGS.has(token.toLowerCase())))) return null;
  return segments.map(segment => segmentKey(segment));
}

export function keyText(key) {
  return key.filter(Boolean).join(' ');
}

const emptyRules = () => ({ commands: [], paths: [], hosts: [] });

/** The standing approvals of every project, in one app-owned file; rules are scoped per project directory. */
export class ApprovalCatalog {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.directory = path.dirname(this.filename);
    this._stamp = null;
    this._projects = new Map();
    this._warned = false;
    this._queue = Promise.resolve();
    this.onWarning = null;
  }

  /**
   * Pick up an edit made outside the app. Keyed on (mtime, size) rather than a watcher because the check
   * rides on an approval decision — a few per turn at most.
   *
   * A half-written file must neither widen nor narrow the gate, so the last good rules are kept and the
   * problem reported once. It is retried on the next decision, so finishing the edit fixes it without a
   * restart.
   */
  _reload() {
    let stat;
    try {
      stat = fs.statSync(this.filename);
    } catch {
      this._stamp = null;                 // absent file = no standing approvals, the default state
      this._projects = new Map();
      return;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this._stamp) return;
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      this._warn('Файл правил подтверждения недоступен для чтения; действуют ранее прочитанные правила.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    } catch {
      this._warn('Файл правил подтверждения повреждён; действуют ранее прочитанные правила.');
      return;
    }
    this._stamp = stamp;
    this._warned = false;
    this._projects = new Map();
    const projects = parsed && typeof parsed === 'object' ? parsed.projects : null;
    if (!projects || typeof projects !== 'object') return;
    for (const [key, value] of Object.entries(projects)) {
      if (!value || typeof value !== 'object') continue;
      const rules = emptyRules();
      for (const kind of KINDS) {
        const list = Array.isArray(value[kind]) ? value[kind] : [];
        rules[kind] = list.map(rule => String(rule)).filter(rule => rule.trim()).slice(0, MAX_RULES_PER_KIND);
      }
      this._projects.set(foldPath(key), rules);
    }
  }

  _warn(message) {
    if (this._warned) return;
    this._warned = true;
    try { this.onWarning?.(message); } catch { /* a warning sink must never break a decision */ }
  }

  _rules(cwd) {
    this._reload();
    return this._projects.get(foldPath(cwd)) ?? emptyRules();
  }

  /** Every rule of one project as [kind, value], commands first — the order a drop-by-number counts in. */
  listing(cwd) {
    const rules = this._rules(cwd);
    return KINDS.flatMap(kind => rules[kind].map(value => [kind, value]));
  }

  // ── deciding ──

  /**
   * Does a standing rule of this project cover the request? `kind` is one of the neutral request kinds the
   * rule engine speaks: `command` (with `command`), `files` (with `paths`), `host` (with `host`).
   */
  allows(cwd, kind, data) {
    if (!cwd) return false;
    const rules = this._rules(cwd);
    if (kind === 'command') {
      const keys = commandKeys(data?.command ?? '');
      if (!keys || !keys.length) return false;
      const allowed = new Set(rules.commands.map(rule => foldCommand(rule)));
      return keys.every(key => allowed.has(foldCommand(keyText(key))));
    }
    if (kind === 'files') {
      const paths = Array.isArray(data?.paths) ? data.paths : [];
      return paths.length > 0 && paths.every(target => this._pathAllowed(cwd, rules, target));
    }
    if (kind === 'host') return this._hostAllowed(rules, data?.host ?? '');
    return false;
  }

  _pathAllowed(cwd, rules, target) {
    if (!target) return false;
    const resolved = path.resolve(String(cwd), String(target));
    const folder = foldPath(path.dirname(resolved));
    for (const rule of rules.paths) {
      if (rule.endsWith(SUBTREE)) {
        const root = path.resolve(String(cwd), rule.slice(0, -SUBTREE.length));
        if (isPathInside(resolved, root, cwd)) return true;
      } else if (foldPath(path.resolve(String(cwd), rule)) === folder) {
        return true;
      }
    }
    return false;
  }

  /**
   * Does a standing rule cover this host? An unreadable request (no host named) is covered by nothing — the
   * card stands, as it does for a command that cannot be lexed.
   */
  _hostAllowed(rules, host) {
    const target = foldHost(host);
    if (!target) return false;
    for (const rule of rules.hosts.map(value => foldHost(value))) {
      if (rule === target) return true;
      if (rule.startsWith(HOST_WILDCARD)) {
        const domain = rule.slice(HOST_WILDCARD.length);
        if (domain && (target === domain || target.endsWith(`.${domain}`))) return true;
      }
    }
    return false;
  }

  // ── deriving a rule from the card in front of the user ──

  /**
   * The rules pressing Allow would save, or [] when this card cannot become a reusable rule. Empty is a
   * normal answer, not a failure: Allow then stands for this one call.
   *
   * A command key whose argument is an ABSOLUTE path describes THIS call and no other, so saving it buys
   * nothing — while dropping the argument would leave a bare `Copy-Item` or `node`, far wider than what the
   * user just read. Neither is honest, so no rule is offered at all.
   */
  derive(cwd, kind, data) {
    if (!cwd) return [];
    if (kind === 'command') {
      const keys = commandKeys(data?.command ?? '');
      if (!keys || !keys.length) return [];
      if (keys.some(([, argument]) => path.isAbsolute(argument) || /^[A-Za-z]:/.test(argument))) return [];
      return unique(keys.map(key => ['commands', keyText(key)]));
    }
    if (kind === 'host') {
      const host = foldHost(data?.host ?? '');
      return host && !host.includes('*') && host.length <= 253 && HOSTNAME_RE.test(host)
        ? [['hosts', host]]
        : [];
    }
    if (kind === 'files') {
      const paths = Array.isArray(data?.paths) ? data.paths : [];
      if (!paths.length || !paths.every(Boolean)) return [];
      const rules = [];
      for (const target of paths) {
        const folder = path.dirname(path.resolve(String(cwd), String(target)));
        if (this._isUnsafeFolder(folder, cwd)) return [];
        rules.push(['paths', folder]);
      }
      return unique(rules);
    }
    return [];
  }

  /**
   * Is this a directory no standing rule may ever cover? A drive root, the home or a system directory, and
   * anything the file-write gate itself guards — granting `.git/` or an agent's settings directory would let
   * the agent arrange never to be asked again.
   */
  _isUnsafeFolder(folder, cwd) {
    if (path.dirname(folder) === folder) return true;      // a drive root / filesystem root — never a rule
    const folded = foldPath(folder);
    if (folded === foldPath(this.directory)) return true;  // the catalog's own directory
    if (unsafeRoots().has(folded)) return true;
    if (!isPathInside(folder, cwd, cwd)) return false;      // outside the project the carve-outs do not apply
    const relative = path.relative(path.resolve(String(cwd)), path.resolve(folder));
    const parts = relative.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    if (!parts.length) return false;                        // the project root itself is an ordinary rule
    const head = parts[0].toLowerCase();
    if (head === '.git' || head === '.codex') return true;
    // A path rule grants every file DIRECTLY INSIDE the directory it names, so a directory is unsafe as soon
    // as a guarded file could live in it — not only when the directory itself is guarded. `.claude` holds
    // `settings.json` right at its top, so granting it would hand over the permission profile; `.claude/
    // commands` holds nothing guarded and stays an ordinary rule. (The module this was ported from carved
    // out the guarded FILES but still derived the containing directory, which granted them back.)
    if (head !== '.claude') return false;
    return parts.length === 1 || parts[1].toLowerCase() === 'hooks';
  }

  // ── writing ──

  _serial(work) {
    const result = this._queue.catch(() => {}).then(work);
    this._queue = result.catch(() => {});
    return result;
  }

  /** Append the rules of one project that are not already covered; resolves with what was actually written. */
  add(cwd, rules) {
    if (!cwd) return Promise.reject(new Error('Правило подтверждения требует папки проекта.'));
    return this._serial(async () => {
      this._reload();
      const key = foldPath(cwd);
      const current = this._projects.get(key) ?? emptyRules();
      const folders = { commands: foldCommand, paths: foldPath, hosts: foldHost };
      const added = [];
      for (const [kind, value] of rules) {
        if (!KINDS.includes(kind)) throw new Error('Неизвестный вид правила подтверждения.');
        const bucket = current[kind];
        if (bucket.some(existing => folders[kind](existing) === folders[kind](value))) continue;
        if (bucket.length >= MAX_RULES_PER_KIND) throw new Error('Достигнут предел 500 правил одного вида.');
        bucket.push(value);
        added.push(value);
      }
      if (added.length) {
        this._projects.set(key, current);
        await this._save();
      }
      return added;
    });
  }

  /** Remove rule `number` (1-based, in `listing()` order) of one project; resolves with the removed value. */
  drop(cwd, number) {
    return this._serial(async () => {
      const rows = this.listing(cwd);
      if (!Number.isInteger(number) || number < 1 || number > rows.length) return null;
      const [kind, value] = rows[number - 1];
      const current = this._projects.get(foldPath(cwd));
      current[kind].splice(current[kind].indexOf(value), 1);
      await this._save();
      return value;
    });
  }

  async _save() {
    const projects = {};
    for (const [key, rules] of this._projects) {
      if (!KINDS.some(kind => rules[kind].length)) continue;
      projects[key] = Object.fromEntries(KINDS.map(kind => [kind, rules[kind]]));
    }
    const serialized = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Правила подтверждения превышают допустимый размер.');
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    try {
      const stat = fs.statSync(this.filename);
      this._stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this._stamp = null;                 // our own write is authoritative; the next read just re-checks
    }
  }
}

function unique(rules) {
  const seen = new Set();
  return rules.filter(([kind, value]) => {
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
