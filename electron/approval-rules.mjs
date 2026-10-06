/**
 * approval-rules — answer a Codex App Server approval request from rules, without a model call.
 *
 * Codex's own «Одобрять за меня» routes every sandbox escape to the `auto_review` subagent, which is a
 * carefully prompted model that receives a compressed transcript on every single request. That is a real
 * recurring cost. The App Server hands these requests to the CLIENT, so a shell that understands them can
 * answer the routine ones itself: read-only commands, local git bookkeeping inside the project, and the
 * exact shapes the user already pressed Allow on. Everything else still goes to the user.
 *
 * THE CONTRACT, inherited from the gate this is built on: every path below FAILS CLOSED. A missing input, an
 * unreadable command, an unknown method, a request about another project — all of them return null, which
 * means «draw the ordinary approval card». Turning this mode on can remove a question; it can never widen
 * what Codex is able to do, because the sandbox, not this file, is the boundary.
 *
 * The decisions are deliberately the NARROW ones the protocol offers. A command is accepted for this call
 * (`accept`), never `acceptForSession`; extra permissions are granted with `scope: 'turn'`, never
 * `'session'`; a network escalation is answered with a plain accept rather than the network-policy amendment
 * the server proposes, which would open the host for the rest of the session. Rules make the user's answer
 * repeatable — they do not make it broader than the card it came from.
 *
 * A network escalation needs TWO standing rules, not one: the host AND the command. A host rule alone would
 * let any command at all reach an approved host, and a command rule alone would let an approved command
 * reach anywhere. Pressing Allow on such a card saves both, so the pair is written once and matches after.
 */
import { isOwnRepoFileWrite, isOwnRepoWrite, isPathInside, isRecognizedBenign } from './command-gate.mjs';

/** The approval requests a rule may answer. Everything else — questions, elicitations, dynamic tool calls,
 * account and attestation requests — is a question FOR the user, not a permission, and is never auto-answered. */
export const RULED_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

/** Can this request even be considered, before any rule is consulted? Cheap and synchronous, so the caller
 * can decide whether to hold the request back from the user interface for the length of one decision. */
export function isRuledRequest(method) {
  return RULED_METHODS.has(method);
}

function commandText(params) {
  const value = params?.command;
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : '';
}

/** The file paths one `item/fileChange` approval is about, taken from the item the host recorded for it. */
function changedPaths(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.map(change => (change && typeof change.path === 'string' ? change.path : '')).filter(Boolean);
}

/**
 * The permission profile's file-system targets, in both the current and the superseded spellings. Codex is
 * migrating `read`/`write` arrays to `entries`, and a profile that names a path in only one of them must
 * still be judged on all of it — a target this reader missed would be granted without ever being checked.
 */
function permissionPaths(permissions) {
  const fileSystem = permissions?.fileSystem;
  if (!fileSystem || typeof fileSystem !== 'object') return [];
  const targets = [];
  for (const key of ['read', 'write']) {
    if (Array.isArray(fileSystem[key])) targets.push(...fileSystem[key]);
  }
  if (Array.isArray(fileSystem.entries)) {
    for (const entry of fileSystem.entries) {
      if (entry && typeof entry === 'object') {
        for (const key of ['path', 'root']) {
          if (typeof entry[key] === 'string') targets.push(entry[key]);
        }
      } else if (typeof entry === 'string') {
        targets.push(entry);
      }
    }
  }
  return targets.filter(target => typeof target === 'string' && target);
}

/**
 * Decide one approval request from rules, or return null to ask the user.
 *
 * `cwd` is the project directory the tab is working in and the containment root every path proof uses.
 * `catalog` is the standing-approvals catalog, or null when none is configured. `item` is the recorded
 * thread item the request refers to, needed only for a file change — Codex sends the changed paths on the
 * item, not on the approval, and a decision that demanded them on the approval would never fire.
 *
 * Resolves to `{ result, reason }`, where `result` is the JSON-RPC response payload to send back and
 * `reason` is the short Russian line the work log shows, so an automatic answer is never silent.
 */
export function decideApproval({ method, params = {}, cwd, catalog = null, item = null }) {
  if (!isRuledRequest(method) || !cwd) return null;
  try {
    if (method === 'item/commandExecution/requestApproval') return decideCommand(params, cwd, catalog);
    if (method === 'item/fileChange/requestApproval') return decideFileChange(params, cwd, catalog, item);
    if (method === 'item/permissions/requestApproval') return decidePermissions(params, cwd);
  } catch {
    return null;                 // a rule that throws has not decided anything — ask
  }
  return null;
}

function decideCommand(params, cwd, catalog) {
  // `writeStdin` feeds input to a terminal that is already running; what that terminal then does is not in
  // the request and cannot be vetted from it.
  if (params.kind && params.kind !== 'command') return null;
  const command = commandText(params);
  if (!command) return null;

  // The command must run in the project. A command the server places elsewhere is about another directory
  // than the one every rule below is scoped to.
  if (params.cwd && !isPathInside(params.cwd, cwd, cwd)) return null;

  const host = typeof params.networkApprovalContext?.host === 'string' ? params.networkApprovalContext.host : '';
  const byCatalog = catalog?.allows(cwd, 'command', { command }) ?? false;

  if (host) {
    // see the module docstring: a network escalation needs the host AND the command, never just one
    if (!catalog?.allows(cwd, 'host', { host })) return null;
    if (!byCatalog && !isRecognizedBenign(command)) return null;
    return { result: { decision: 'accept' }, reason: `сеть: правило для «${host}»` };
  }
  if (byCatalog) return { result: { decision: 'accept' }, reason: 'команда: сохранённое правило' };
  if (isRecognizedBenign(command)) return { result: { decision: 'accept' }, reason: 'команда только на чтение' };
  if (isOwnRepoWrite(command, cwd)) return { result: { decision: 'accept' }, reason: 'git внутри проекта' };
  return null;
}

function decideFileChange(params, cwd, catalog, item) {
  const paths = changedPaths(item);
  if (!paths.length) return null;        // nothing recorded to judge — ask

  // A grantRoot asks for writes under that root for the rest of the session, so it has to stay inside the
  // project. Its ABSENCE is not a failed check: Codex sends the changed paths and, in practice, no root at
  // all — demanding one would keep this gate from ever firing.
  if (params.grantRoot && !isPathInside(params.grantRoot, cwd, cwd)) return null;

  if (paths.every(target => isOwnRepoFileWrite(target, cwd))) {
    return { result: { decision: 'accept' }, reason: 'правка файлов внутри проекта' };
  }
  if (catalog?.allows(cwd, 'files', { paths })) {
    return { result: { decision: 'accept' }, reason: 'файлы: сохранённое правило каталога' };
  }
  return null;
}

/**
 * A permissions profile asks to WIDEN the sandbox, not to touch one file, so the catalog is deliberately
 * not consulted here: a `paths` rule means «files directly in this folder may be written», which is a
 * narrower thing than granting the sandbox that folder for the rest of the turn. Containment in the
 * project is the only proof accepted; anything else is the user's to answer.
 */
function decidePermissions(params, cwd) {
  const permissions = params.permissions && typeof params.permissions === 'object' ? params.permissions : null;
  if (!permissions) return null;

  // A network grant names no host, so no host rule can cover it and nothing here can judge how far it
  // reaches. It is exactly the question the user should answer.
  if (permissions.network && permissions.network.enabled !== false) return null;

  const targets = permissionPaths(permissions);
  if (!targets.length) return null;
  if (params.cwd && !isPathInside(params.cwd, cwd, cwd)) return null;

  if (!targets.every(target => isPathInside(target, cwd, cwd))) return null;

  // the narrow grant: exactly what was asked, for this turn only
  return { result: { permissions, scope: 'turn' }, reason: 'доступ к путям внутри проекта' };
}

/**
 * What a request is about in the catalog's own vocabulary, so the approval card can show — and the Allow
 * button can save — the exact rule this decision would have used. Returns null for a request no rule can
 * ever cover.
 */
export function ruleSubject({ method, params = {}, item = null }) {
  if (method === 'item/commandExecution/requestApproval') {
    if (params.kind && params.kind !== 'command') return null;
    const command = commandText(params);
    if (!command) return null;
    const host = typeof params.networkApprovalContext?.host === 'string' ? params.networkApprovalContext.host : '';
    return host ? { kind: 'command', command, host } : { kind: 'command', command };
  }
  if (method === 'item/fileChange/requestApproval') {
    const paths = changedPaths(item);
    return paths.length ? { kind: 'files', paths } : null;
  }
  return null;                 // a permissions profile is granted per turn and leaves no reusable rule
}
