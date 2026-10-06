/**
 * command-gate — statically recognize a BENIGN shell command, so a rule-based approval can answer it
 * without asking the human and without spending a model call on an auto-review subagent.
 *
 * Ported from the Aurora fleet's `armada/cmd_gate.py` (shared by the repository's author for this purpose).
 * The lists, the refusals and the Windows handling below are its hard-won shape; what changed is the
 * surrounding protocol — Codex's App Server asks the CLIENT for approval, so the verdict is computed here
 * instead of inside a Slack bot — and the parts that named Aurora's own layout (a `/bridge/dbg.py` script
 * allowance, a pytest runner gate, Jenkins jobs) are deliberately absent; see docs/APPROVAL_RULES.md.
 *
 * STRICT AND MONOTONE ON PURPOSE. `isRecognizedBenign` returns true ONLY when it fully understands the
 * command AND every segment is whitelisted; ANYTHING it cannot vet — an unknown binary, a command
 * substitution, a shell-invoking form, a write redirect, an unbalanced quote — returns false and falls back
 * to the ordinary approval card. Enabling it can only ever REMOVE a question, never ADD reach.
 *
 * HARD LIMIT, stated plainly: this is an argv[0] whitelist, not a sandbox. It refuses the constructs it
 * cannot statically resolve (`$(...)`, backticks, `eval`, `bash -c`, subshells, `xargs`) rather than
 * guessing, so it never green-lights a command whose real effect is hidden. It is a politeness filter over
 * a Codex the user already trusts, not a boundary against a hostile one. The sandbox stays the boundary.
 *
 * IT MUST SPEAK WINDOWS, because that is the dialect this host sends. Two habits made the original module
 * inert for a Codex worker: the command arrives wrapped as `powershell.exe -Command "<real command>"` (so
 * argv[0] was the wrapper, never the command under review), and the real command is a PowerShell cmdlet
 * with backslash paths (so neither the POSIX binary list nor the lexer recognized it). Across a whole
 * logged command history not one call was recognized as benign. Hence the wrapper is unwrapped before
 * vetting, backslashes fold to `/` before lexing, and the read-only cmdlets have their own list.
 *
 * The cmdlets are a SEPARATE set from the POSIX binaries because PowerShell is case-INSENSITIVE: the model
 * writes `Get-Content` on one turn and `get-content` on the next and both are the same cmdlet, while a
 * POSIX `Grep` genuinely is not `grep`. Deliberately absent are `Where-Object` and `ForEach-Object`, whose
 * `{ … }` block runs arbitrary code and is the PowerShell twin of `$(...)`, everything that mutates, and
 * everything that invokes.
 *
 * Two lexing details are load-bearing. The refuse-tokens are checked on the RAW string, because some of
 * them — `$(`, a backtick — are exactly what must never be let through. The tolerated redirects are
 * stripped from that raw string BEFORE lexing, because the lexer shreds `2>&1` into `2`, `>&`, `1`; a
 * redirect that is NOT one of them, such as a write to a real file, survives as a stray `>` token and makes
 * its segment un-recognized, which is the intended "ask".
 *
 * The local-git list holds subcommands that WRITE but never reach the network, safe inside the project's
 * own directory; push/pull/fetch/clone stay gated. Its companion list is the git global options that
 * RELOCATE the repo away from cwd — their value has to resolve inside cwd, or the command targets a
 * DIFFERENT repo. Two subcommands are admitted through a second list instead, because the word alone does
 * not say what the command DOES: `stash` covers both reading a stash and deleting every one of them, so the
 * ACTION decides, and `reset` covers both moving a branch pointer and overwriting the tree, so the MODE
 * does. `list`/`show`/`apply` and `--soft`/`--mixed` ask nothing of the user; a bare `git stash` and
 * `reset --hard` sweep a working tree that several open tabs share.
 */
import fs from 'node:fs';
import path from 'node:path';

/** argv[0] binaries that are read-only / side-effect-free enough to auto-approve unconditionally. */
const SAFE_BINARIES = new Set([
  // text / stream inspection
  'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'cat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl',
  'diff', 'cmp', 'column',
  // filesystem inspection (NOT mutation)
  'ls', 'stat', 'file', 'realpath', 'dirname', 'basename', 'du', 'pwd', 'readlink', 'wslpath',
  // trivially safe
  'echo', 'printf', 'true', 'false', 'date', 'which', 'type', 'whoami', 'hostname',
]);

/** PowerShell's read-only cmdlets — the Windows half of the whitelist (see the module docstring). */
const PS_READONLY = new Set([
  // content / object inspection
  'get-content', 'get-childitem', 'get-item', 'get-itemproperty', 'get-member', 'get-filehash',
  'select-string', 'select-object', 'sort-object', 'measure-object', 'group-object', 'compare-object',
  // path questions
  'test-path', 'resolve-path', 'split-path', 'join-path', 'get-location',
  // formatting / sinks — they cannot do anything but render what a previous segment already read
  'format-list', 'format-table', 'out-string', 'out-host', 'out-null',
  'convertfrom-json', 'convertto-json', 'convertfrom-csv',
  // trivially safe
  'get-command', 'get-date', 'write-output', 'write-host',
]);

/** argv[0] shapes carrying the real command as a STRING argument — what runs must be vetted, not the wrapper. */
const SHELL_WRAPPERS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'cmd', 'cmd.exe', 'bash', 'sh', 'zsh']);
const WRAPPER_FLAGS = new Set(['-command', '-c', '/c']);

/** binaries safe ONLY for specific read-only subcommands → argv[1] must be in the allowed set. */
const SUBCOMMAND_SAFE = new Map([
  ['git', new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'remote',
    'ls-files', 'cat-file', 'describe', 'blame', 'shortlog', 'tag'])],
  ['dotnet', new Set(['build', 'test', 'restore', '--version', '--info', '--list-sdks'])],
  // no node/python subcommand is auto-safe (a script does anything) → ask
  ['node', new Set()],
  ['python', new Set()],
  ['python3', new Set()],
]);

/** any of these anywhere in the RAW command → refuse, the effect cannot be resolved statically. */
const DANGER_SUBSTRINGS = ['$(', '`', '<(', '>(', '${'];

/** the redirects tolerated as pure diagnostics plumbing, stripped before lexing (see the module docstring). */
const OK_REDIRECT_RE = /(?:\d*>&\d+|&?\d*>\s*\/dev\/null|2>\s*\/dev\/null|>\s*\/dev\/null)/g;

const SEGMENT_OPS = new Set([';', '|', '&&', '||', '|&', '&']);
const PUNCTUATION = new Set(['(', ')', ';', '<', '>', '|', '&']);

/** git subcommands that WRITE but never reach the network (see the module docstring). */
const GIT_LOCAL_WRITE = new Set(['add', 'commit', 'mv', 'restore']);

/**
 * `git stash` ACTIONS that destroy nothing: two reads and a re-apply onto the tree. Absent on purpose are a
 * bare `git stash` and `push`, which sweep the working tree — uncommitted work in a checkout several open
 * tabs share — and `pop`/`drop`/`clear`, which delete a stash entry outright.
 */
const GIT_STASH_OK = new Set(['list', 'show', 'apply']);

/**
 * `git reset` FLAGS that leave the FILES alone. An allow-list rather than a refusal of `--hard`, so a mode
 * this module has never heard of asks instead of slipping through. `--mixed` is the default, hence a bare
 * `git reset` and `git reset -- <paths>` are the same act: the index moves, the working tree does not.
 * Absent are `--hard`, `--merge` and `--keep`, which write the tree, and `-p`, which wants a human at a
 * prompt. Honest limit: `--mixed` still unstages, so in a checkout several tabs share it can drop a
 * neighbouring tab's `git add`. Their files are untouched and re-staging costs one command.
 */
const GIT_RESET_OK_FLAGS = new Set(['--soft', '--mixed', '-q', '--quiet', '--']);

/** git global options that RELOCATE the repo away from cwd (see the module docstring). */
const GIT_RELOCATE = new Set(['-C', '--git-dir', '--work-tree']);

/**
 * Fold every run of backslashes into one `/`. Called before lexing because the POSIX lexer treats `\` as an
 * ESCAPE, so a Windows path is silently shredded: `blender\render.py` lexes to `blenderrender.py` and
 * `.codex\commands\x.md` to `.codexcommandsx.md`. That mangling once reached a live rule catalog, which then
 * held a rule matching only the exact backslash spelling it was saved from and never the same command
 * written with `/`. A run rather than a single `\` because Codex escapes its paths for PowerShell, so the
 * command text carries `C:\\WINDOWS\\…` (doubled) while a hand-written command carries single ones, and
 * both must fold to the same token.
 *
 * A run standing right before a QUOTE is left alone: there the backslash really is an escape, and it is the
 * only way a quoted executable path can be passed through the wrapper
 * (`-Command "& \"C:/Program Files/nodejs/node.exe\" …"`). Folding it would turn the escaped quote into a
 * stray `/"` and split that path across three tokens.
 */
export function normalizeSeparators(text) {
  return String(text).replace(/\\+(?!["'])/g, '/');
}

/**
 * Tokenize like Python's `shlex(posix=True, punctuation_chars=True, whitespace_split=True)`: quotes and
 * backslash escapes are resolved, and runs of `();<>|&` become their own tokens so control operators split
 * the stream. Throws on an unbalanced quote or a trailing escape, which the caller reads as "cannot vet".
 */
function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (PUNCTUATION.has(char)) {
      let end = index;
      while (end < text.length && PUNCTUATION.has(text[end])) end += 1;
      tokens.push(text.slice(index, end));
      index = end;
      continue;
    }
    let word = '';
    while (index < text.length) {
      const current = text[index];
      if (/\s/.test(current) || PUNCTUATION.has(current)) break;
      if (current === '\\') {
        if (index + 1 >= text.length) throw new Error('No escaped character');
        word += text[index + 1];
        index += 2;
        continue;
      }
      if (current === "'") {
        const close = text.indexOf("'", index + 1);
        if (close < 0) throw new Error('No closing quotation');
        word += text.slice(index + 1, close);
        index = close + 1;
        continue;
      }
      if (current === '"') {
        index += 1;
        let closed = false;
        while (index < text.length) {
          const inner = text[index];
          // inside double quotes only `"` and `\` are escapable; any other backslash stays literal
          if (inner === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
            word += text[index + 1];
            index += 2;
            continue;
          }
          if (inner === '"') { index += 1; closed = true; break; }
          word += inner;
          index += 1;
        }
        if (!closed) throw new Error('No closing quotation');
        continue;
      }
      word += current;
      index += 1;
    }
    tokens.push(word);
  }
  return tokens;
}

/**
 * Split a flat token list into per-command segments on shell control operators. Returns the segments, or
 * null if a bare `&` (backgrounding) appears — a detached command is never auto-approved, because its
 * completion escapes the turn.
 *
 * A `&` that OPENS a segment is PowerShell's call operator (`& 'C:/…/node.exe' --version`), not
 * backgrounding — backgrounding always trails. Refusing it made every quoted-executable invocation on
 * Windows unvettable, which is the shape these tool calls arrive in.
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token === '&' && current.length === 0) continue;   // PowerShell's call operator opens a command
    if (token === '&') return null;                        // backgrounding — refuse
    if (SEGMENT_OPS.has(token)) { segments.push(current); current = []; continue; }
    current.push(token);
  }
  segments.push(current);
  return segments.filter(segment => segment.length > 0);
}

/**
 * Tokenize a compound command into per-segment token lists, or null when it cannot be statically vetted
 * (empty, a danger construct like `$(...)`/backtick/proc-subst/`${...}`, an unbalanced quote, or a
 * backgrounded `&` form). Tolerated diagnostics redirects (`2>&1`, `>/dev/null`) are stripped first so the
 * lexer does not shred `2>&1` into `2`,`>&`,`1`; a REAL write redirect (`> out.txt`) is not matched there
 * and survives as a stray `>` token, so the per-segment checker still refuses it. Never throws.
 */
export function lexSegments(command) {
  const text = String(command ?? '');
  if (!text.trim()) return null;
  if (DANGER_SUBSTRINGS.some(bad => text.includes(bad))) return null;
  const stripped = normalizeSeparators(text).replace(OK_REDIRECT_RE, ' ');
  let tokens;
  try {
    tokens = tokenize(stripped);
  } catch {
    return null;                       // unbalanced quotes / lexing error → ask
  }
  const segments = splitSegments(tokens);
  return segments && segments.length ? segments : null;
}

/**
 * The command a shell wrapper was asked to run, or `command` unchanged. Applied ONCE — a wrapper inside a
 * wrapper is exactly the obfuscation this gate refuses to reason about. Unwrapping is what lets both the
 * whitelist and the rule catalog see `Get-Content x` instead of `powershell.exe`.
 */
export function unwrapShell(command) {
  const text = String(command ?? '');
  const segments = lexSegments(text);
  if (!segments || segments.length !== 1) return text;
  const segment = segments[0];
  if (!SHELL_WRAPPERS.has(path.basename(segment[0]).toLowerCase())) return text;
  for (let index = 1; index < segment.length; index += 1) {
    if (WRAPPER_FLAGS.has(segment[index].toLowerCase()) && index + 1 < segment.length) {
      return segment[index + 1];
    }
  }
  return text;
}

/**
 * Whether a segment starts with a shell environment assignment.
 *
 * Even a read-only-looking argv can execute arbitrary code under variables such as `LD_PRELOAD` or
 * `GIT_EXTERNAL_DIFF`. Refuse every environment-prefixed command instead of maintaining a fragile allowlist
 * of variable names.
 */
function hasEnvironmentPrefix(segment) {
  if (!segment.length) return false;
  const token = segment[0];
  const equals = token.indexOf('=');
  if (equals <= 0) return false;
  const name = token.slice(0, equals);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Whether a redirect operator survived the tolerated-diagnostics strip — a write target like `> out.txt`
 * splits into `>`,`out.txt`, so the operator is still there and the segment writes a file.
 */
function hasStrayRedirect(segment) {
  return segment.some(token => ['>', '>>', '<', '>&', '&>', '1>', '2>', '0<'].includes(token)
    || token.startsWith('>') || token.startsWith('<'));
}

/**
 * A git command with its GLOBAL options stripped — the subcommand and everything the subcommand was given:
 * `git -C <path> stash apply 'stash@{0}'` → ['stash', 'apply', 'stash@{0}']. Empty when the command names no
 * subcommand at all.
 *
 * Only the GLOBAL options take values (-C, -c, --git-dir, --work-tree), so only they consume the next token.
 * Past the subcommand a flag is the subcommand's own — `-c` there means something else entirely, and eating
 * what follows it would read the wrong word as the action.
 */
function gitBody(segment) {
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  let index = 1;
  while (index < segment.length) {
    const token = segment[index];
    if (takesValue.has(token)) { index += 2; continue; }
    if (token.startsWith('-')) { index += 1; continue; }   // a valueless global flag (--no-pager, …)
    return segment.slice(index);                           // the subcommand and its own arguments
  }
  return [];
}

function gitSubcommand(segment) {
  const body = gitBody(segment);
  return body.length ? body[0] : null;
}

/** True if one command segment is a recognized read-only/safe invocation. */
function segmentOk(segment) {
  if (!segment.length || hasEnvironmentPrefix(segment) || hasStrayRedirect(segment)) return false;
  const argv0 = segment[0];

  // a script block: two harmless cmdlets around braces that run whatever they like
  if (segment.some(token => token.includes('{') || token.includes('}'))) return false;

  if (PS_READONLY.has(argv0.toLowerCase())) return true;

  if (SUBCOMMAND_SAFE.has(argv0)) {
    const allowed = SUBCOMMAND_SAFE.get(argv0);
    const sub = argv0 === 'git' ? gitSubcommand(segment) : (segment.length >= 2 ? segment[1] : null);
    return sub !== null && allowed.has(sub);
  }

  if (argv0 === 'find') {
    // listing is safe; anything that RUNS or DELETES is not
    return !segment.some(token => ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fls', '-fprint'].includes(token));
  }

  if (argv0 === 'sed') {
    return !segment.includes('-i') && !segment.some(token => token.startsWith('-i'));   // in-place edit writes
  }

  if (argv0 === 'xargs') return false;   // invokes a command from stdin — the real binary isn't argv[0]

  return SAFE_BINARIES.has(argv0);
}

/** Case folding as the platform folds it, so `C:/Repo` and `c:/repo` are one path on Windows. */
export function foldPath(value) {
  const resolved = path.resolve(String(value));
  const folded = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return folded.replace(/[\\/]+$/, '') || folded;
}

/**
 * Resolve symlinks and junctions as far as the path actually exists, keeping the missing tail. Node's
 * realpath throws on a path that is not there yet, but the very first write that CREATES a file is exactly
 * the call that must be judged correctly.
 */
function realpathTolerant(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return tail.length ? path.join(fs.realpathSync.native(current), ...tail) : fs.realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `target` resolves inside `root` after following existing symlinks and junctions. Missing final
 * components are supported while existing ancestors are resolved. A relative target is interpreted under
 * `relativeTo` (the project cwd by default); malformed and cross-drive inputs fail closed.
 */
export function isPathInside(target, root, relativeTo) {
  if (!target || !root) return false;
  try {
    const base = foldPath(realpathTolerant(String(root)));
    let raw = String(target);
    if (!path.isAbsolute(raw)) raw = path.join(String(relativeTo || root), raw);
    const resolved = foldPath(realpathTolerant(raw));
    if (resolved === base) return true;
    return resolved.startsWith(base + path.sep) || resolved.startsWith(base + '/');
  } catch {
    return false;
  }
}

/**
 * The values of any repo-relocating git global options (-C <dir>, --git-dir=<dir>, --work-tree <dir>).
 * Empty when the command runs in cwd — the project's own repo.
 */
function gitRelocateValues(segment) {
  const values = [];
  let index = 1;
  while (index < segment.length) {
    const token = segment[index];
    if (GIT_RELOCATE.has(token) && index + 1 < segment.length) {
      values.push(segment[index + 1]);
      index += 2;
      continue;
    }
    for (const option of ['--git-dir=', '--work-tree=']) {
      if (token.startsWith(option)) values.push(token.slice(option.length));
    }
    index += 1;
  }
  return values;
}

/**
 * A git segment that WRITES only the local repo AND targets the project's own cwd → true.
 *
 * The subcommand must be in GIT_LOCAL_WRITE (push/pull/fetch are absent → stay gated), or one of the two
 * whose verdict depends on what FOLLOWS it: `stash` has to name an action in GIT_STASH_OK, and `reset` may
 * carry no flag outside GIT_RESET_OK_FLAGS. Either way any -C/--git-dir/--work-tree must resolve inside cwd
 * (a relocation outside = a different repo → ask).
 */
function gitLocalWriteOk(segment, cwd) {
  const body = gitBody(segment);
  const subcommand = body.length ? body[0] : null;
  if (subcommand === 'stash') {
    const action = body.slice(1).find(token => !token.startsWith('-')) ?? null;
    if (!action || !GIT_STASH_OK.has(action)) return false;
  } else if (subcommand === 'reset') {
    if (body.slice(1).some(token => token.startsWith('-') && !GIT_RESET_OK_FLAGS.has(token))) return false;
  } else if (!subcommand || !GIT_LOCAL_WRITE.has(subcommand)) {
    return false;
  }
  return gitRelocateValues(segment).every(value => isPathInside(value, cwd, cwd));
}

/** True if one segment is an explicitly allowed local git write in the project's own repository. */
function localWriteOk(segment, cwd) {
  if (!segment.length || hasEnvironmentPrefix(segment) || hasStrayRedirect(segment)) return false;
  return segment[0] === 'git' ? gitLocalWriteOk(segment, cwd) : false;
}

/**
 * True ONLY if `command` is a compound of exclusively recognized read-only/safe segments — answerable
 * without asking the user. Any unresolvable construct (command substitution, backticks, process
 * substitution, a shell-invoking or backgrounded form, a write redirect, an unknown binary, an unbalanced
 * quote) → false. Never throws.
 *
 * The powershell/cmd/bash wrapper is unwrapped first, so what gets vetted is the command the wrapper runs.
 * This can only ever narrow the verdict: a wrapper whose payload is not fully recognized still returns
 * false, and `bash -c "rm -rf x"` fails on `rm` instead of on the unreadable wrapper.
 */
export function isRecognizedBenign(command) {
  const segments = lexSegments(unwrapShell(command));
  if (!segments) return false;
  return segments.every(segment => segmentOk(segment));
}

/**
 * True ONLY if every segment of `command` is EITHER a recognized read-only/safe invocation OR a WRITE
 * confined to the project's OWN repo at `cwd`: a local git write (add/commit/mv/restore, a stash read, a
 * reset that spares the files — never a network push/pull/fetch). Same strict contract as
 * `isRecognizedBenign`; `cwd` empty → false, because containment cannot be proven. Never throws.
 *
 * WHY a step past benign: the project is the user's own, so local git bookkeeping is routine — a commit is
 * reversible, a push is NOT auto-approved because it leaves the machine. Running a script is deliberately
 * excluded: locating its source under cwd does not constrain where that program can write.
 */
export function isOwnRepoWrite(command, cwd) {
  if (!cwd) return false;
  const segments = lexSegments(unwrapShell(command));
  if (!segments) return false;
  return segments.every(segment => segmentOk(segment) || localWriteOk(segment, cwd));
}

/**
 * Paths a standing rule may never cover, and a file write is never auto-approved into. Carve-outs rather
 * than containment alone, because a write there is a permission change dressed as an edit:
 *   * `.git/` — a file in `hooks/` executes on the next git command, so writing there is running code later;
 *   * `.codex/` and `.claude/settings*`/`.claude/hooks/` — the agents' own permission profiles and hooks.
 * Ordinary content under `.claude/` and `AGENTS.md`/`CLAUDE.md` are NOT carved out: those are what the user
 * asks the agent to maintain, and they are inert until a human invokes them.
 */
function isGuardedRepoPath(relativeParts) {
  if (!relativeParts.length) return true;
  const head = relativeParts[0].toLowerCase();
  if (head === '.git' || head === '.codex') return true;
  if (head === '.claude' && relativeParts.length > 1) {
    const second = relativeParts[1].toLowerCase();
    if (second === 'hooks' || (second.startsWith('settings') && second.endsWith('.json'))) return true;
  }
  return false;
}

/**
 * True when a file write lands inside the project's OWN repo at `cwd` and on nothing that would let the
 * agent widen its own reach. Pure path math (case-folded, junctions resolved), so a not-yet-existing file is
 * judged correctly — the first write that CREATES a file is the common case. `cwd` empty → false.
 *
 * Honest limit: a script REFERENCED by a hook stays writable — the gate can only name paths, not follow
 * indirection. Every such edit is still visible in the tab's file-changes panel.
 */
export function isOwnRepoFileWrite(filePath, cwd) {
  if (!filePath || !cwd || !isPathInside(filePath, cwd, cwd)) return false;
  let relative;
  try {
    const target = path.resolve(String(cwd), String(filePath));
    relative = path.relative(path.resolve(String(cwd)), target);
  } catch {
    return false;
  }
  const parts = relative.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  return !isGuardedRepoPath(parts);
}

export const internals = { tokenize, splitSegments, segmentOk, gitBody, isGuardedRepoPath };
