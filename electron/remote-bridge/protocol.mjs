import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';

/**
 * Wire protocol of the relay transport — docs/RELAY_CONTRACT.md.
 *
 * Pure functions only: no sockets, no files, no clock beyond what the caller passes in. Every
 * outgoing frame is built here by an explicit builder, so the set of fields that can ever leave
 * this computer is the set written below and nothing else. A test asserts exactly that.
 */

export const PROTOCOL = 2;
export const BRIDGE_PROTOCOL = '2.3';
export const SUBPROTOCOL = 'kuzmich-bridge.v2';
export const ENDPOINT = '/bridge/v2';

export const LIMITS = Object.freeze({
  outgoingFrame: 256 * 1024,
  incomingFrame: 512 * 1024,
  tabs: 200,
  text: 32_000,          // UTF-16 code units, the v1 contract limit
  commandId: 64,
  userRef: 64,
  requestId: 200,        // the core's own limit on requestId
  label: 64,
  title: 120,
  project: 80,
  answer: 100_000,       // characters of the final answer, the v1 contract limit
  detail: 300,
  coalesceMs: 250,
  resyncMs: 5_000,
  heartbeatMs: 25_000,
  pongMs: 10_000,
  livenessGraceMs: 10_000,          // the contract's slack on top of two heartbeat intervals
  backoffJitter: 0.2,               // ±20 %, so a server coming back does not meet a thundering herd
  pending: 50,                      // commands watched at once for `command_updated`
  pendingTtlMs: 30 * 60 * 1000,     // after this the phone keeps its last status and we stop asking
});

export const CLOSE = Object.freeze({
  normal: 1000, unauthorized: 4001, revoked: 4002, protocol: 4003,
  version: 4004, replaced: 4005, rateLimited: 4006, shutdown: 4009,
});
/** Repeating these is pointless and, with a rejected secret, looks like brute force. */
export const FATAL_CLOSE = new Set([CLOSE.unauthorized, CLOSE.revoked, CLOSE.version]);
export const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000]);
export const REPLACED_DELAY_MS = 30_000;

/**
 * One rung of the reconnect ladder, spread by ±20 % as the contract requires.
 *
 * The spread matters for the server, not for us: without it every installation that lost the same
 * relay would come back in the same second and knock it over again. The rung itself never goes
 * backwards, so a long outage still ends up waiting a minute between attempts.
 */
export function backoffDelay(attempt, { ladder = BACKOFF_MS, random = Math.random } = {}) {
  const rung = ladder[Math.min(Math.max(Number(attempt) || 0, 0), ladder.length - 1)];
  const spread = rung * LIMITS.backoffJitter;
  return Math.max(0, Math.round(rung - spread + random() * spread * 2));
}

/**
 * How long silence from the relay is allowed to last. Any frame counts as a sign of life, not just
 * `ping`: a half-open socket otherwise looks alive forever, because the WebSocket client built into
 * Node and Electron cannot send a protocol-level ping.
 */
export const livenessDeadlineMs = intervalMs => intervalMs * 2 + LIMITS.livenessGraceMs;

const DEVICE_DOMAIN = 'kuzmich-bridge-v2';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const NUMERIC_ID = /^-?[0-9]{1,20}$/;

const b64url = buffer => buffer.toString('base64url');
const utf8 = value => Buffer.from(value, 'utf8');

/** A damaged or hostile frame, told apart from a network failure. */
export class ProtocolError extends Error {
  constructor(message, { close = CLOSE.protocol } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.close = close;
  }
}

// ---------------------------------------------------------------- addresses

/**
 * The owner types this. `ws://` survives only for localhost because the plan's test ladder runs
 * the relay on the same machine; for anything else an unencrypted socket would carry the device
 * proof and every conversation title in clear text.
 *
 * What is stored is the **origin**, because `endpointFor` appends `/bridge/v2` to it. A live run on
 * 2026-10-14 showed why that has to be enforced here: the owner pasted the full address printed by
 * the tunnel, the path was kept as typed, and the bridge then dialled `/bridge/v2/bridge/v2` and
 * was dropped. Pasting the full address is the natural thing to do, so the known tail is accepted
 * and trimmed; any other path is refused with a sentence that says what to type instead.
 */
export function validateRelayUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Укажите адрес сервера.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Адрес сервера не похож на ссылку. Ожидается wss://имя-сервера.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Адрес должен начинаться с wss://.');
  if (url.protocol === 'ws:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Незашифрованный ws:// допустим только для этого же компьютера. Для сервера укажите wss://.');
  }
  if (url.username || url.password) throw new Error('Логин и пароль в адресе не используются.');
  if (url.search || url.hash) throw new Error('Адрес не должен содержать параметров: секрет никогда не передаётся в ссылке.');
  const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const rest = pathname.endsWith(ENDPOINT) ? pathname.slice(0, -ENDPOINT.length) : pathname;
  if (rest) throw new Error(`Укажите только адрес сервера, без пути: хвост ${ENDPOINT} приложение добавляет само.`);
  if (url.origin.length > 300) throw new Error('Адрес сервера слишком длинный.');
  return url.origin;
}

export const endpointFor = base => `${base}${ENDPOINT}`;

// ---------------------------------------------------------------- secrets and identifiers

export const createNonce = (bytes = 32) => b64url(randomBytes(bytes));

/** Hash of the ASCII nonce, not of its decoded bytes: the relay receives the string from the phone. */
export const nonceHash = nonce => b64url(createHash('sha256').update(utf8(nonce)).digest());

/**
 * Ed25519 identity of the installation, created on this computer during pairing.
 *
 * The earlier shared-secret scheme was wrong and agent B caught it: a relay that keeps only a
 * hash of the credential cannot recompute an HMAC for a fresh challenge, so a correct hash-only
 * server could never verify `hello`. A key pair removes the dilemma instead of weakening either
 * side — the server stores a public key, which is not a secret at all, and the private key never
 * leaves this machine, not even once at pairing time.
 *
 * `privateKey`: base64 of PKCS#8 DER, kept only inside the encrypted credential file.
 * `publicKey`: base64url of SPKI DER (44 bytes; the raw 32-byte key is its last 32 bytes).
 */
export function createInstallationKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: b64url(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

const proofMessage = (installationId, nonce) => utf8(`${DEVICE_DOMAIN}\n${installationId}\n${nonce}`);

/** Signs the server's one-time challenge. Nothing secret crosses the wire, ever. */
export function deviceProof({ privateKey, installationId, nonce }) {
  if (!privateKey || !installationId || !nonce) throw new Error('Недостаточно данных для подтверждения установки.');
  let key;
  try { key = createPrivateKey({ key: Buffer.from(String(privateKey), 'base64'), format: 'der', type: 'pkcs8' }); }
  catch { throw new Error('Ключ установки повреждён.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ключ установки повреждён.');
  return b64url(sign(null, proofMessage(installationId, nonce), key));
}

/** The relay's half, kept here so the contract has exactly one definition of the check. */
export function verifyDeviceProof({ publicKey, installationId, nonce, proof }) {
  if (!publicKey || !installationId || !nonce || !proof) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(String(publicKey), 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, proofMessage(installationId, nonce), key, Buffer.from(String(proof), 'base64url'));
  } catch { return false; }
}

export const createTabSalt = () => b64url(randomBytes(32));

/**
 * `tabId` is derived from the core's `grantId` rather than being it. `grantId` already survives a
 * closed tab, a restart and a revoke/re-grant, which is exactly the stability a phone address
 * needs — but it is also an internal ledger key and part of `requestId`, so the server gets a
 * salted digest instead. No reverse table is stored: resolving an incoming id re-derives it over
 * the current (small) list of allowed conversations.
 */
export function tabIdFor(tabSalt, grantId) {
  if (!tabSalt || !grantId) throw new Error('Недостаточно данных для адреса вкладки.');
  const digest = createHmac('sha256', Buffer.from(String(tabSalt), 'base64url')).update(utf8(String(grantId))).digest();
  return `t_${b64url(digest).slice(0, 22)}`;
}

/**
 * `ma:<user>:<installation>:<command_id>` — the namespace the plan fixed. No component may contain
 * `:`, so the core's immutable requestId parses back without ambiguity, and the budget stays inside
 * the core's 200-character limit: 3 + 64 + 1 + 36 + 1 + 64 = 169.
 */
export function buildRequestId({ userRef, installationId, commandId }) {
  if (!ID_PATTERN.test(String(userRef ?? '')) || String(userRef).length > LIMITS.userRef) throw new ProtocolError('userRef');
  if (!UUID_PATTERN.test(String(installationId ?? ''))) throw new ProtocolError('installationId');
  if (!ID_PATTERN.test(String(commandId ?? '')) || String(commandId).length > LIMITS.commandId) throw new ProtocolError('commandId');
  const requestId = `ma:${userRef}:${installationId}:${commandId}`;
  if (requestId.length > LIMITS.requestId) throw new ProtocolError('requestId');
  return requestId;
}

// ---------------------------------------------------------------- ordering

/** Lexicographic over (epoch, revision). `epoch` is durable, `revision` counts inside it. */
export function compareSequence(a, b) {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------- projection to the wire

const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);

export const cleanLabel = value => clean(value, LIMITS.label) || 'Кузьмич';

/**
 * The eight approved fields and nothing else. Everything the core knows and the plan forbids —
 * cwd, blockers, model, access, answer text, pending approvals — simply has no slot here.
 *
 * `queuePaused` was added by the owner after acceptance: without it the Mini App cannot explain
 * why a queue is standing still. It says that the queue is paused, never why — the core's
 * `blockers` stay on this computer.
 */
export function tabSummary({ thread, state, tabId, at }) {
  const status = thread.availability === 'ambiguous' ? 'ambiguous'
    : thread.availability === 'unavailable' || !state ? 'unavailable'
      : ['idle', 'running', 'blocked', 'unavailable'].includes(state.phase) ? state.phase : 'unavailable';
  const count = Number.isSafeInteger(state?.queue?.count) && state.queue.count >= 0 ? Math.min(state.queue.count, 50) : 0;
  return {
    tabId,
    title: clean(thread.title, LIMITS.title) || 'Беседа',
    agent: thread.provider === 'claude' ? 'claude' : 'codex',
    project: clean(thread.projectLabel, LIMITS.project),
    status,
    queueLength: status === 'unavailable' || status === 'ambiguous' ? 0 : count,
    queuePaused: status === 'unavailable' || status === 'ambiguous' ? false : state?.queue?.paused === true,
    updatedAt: typeof state?.updatedAt === 'string' && state.updatedAt.length <= 64 ? state.updatedAt : at,
  };
}

export const sameTab = (a, b) => a && b && ['tabId', 'title', 'agent', 'project', 'status', 'queueLength', 'queuePaused'].every(key => a[key] === b[key]);

// ---------------------------------------------------------------- payloads of the reading actions

/**
 * `get_state`: the tab summary the phone already knows, plus the two things it cannot guess —
 * which turn is running (so `stop` can name it) and which of the two wire actions are offered.
 *
 * `blockers` are absent by contract and `requiresComputer` with them: *why* a conversation is
 * blocked is exactly the kind of detail that stays on this computer. The phone learns `blocked`,
 * and that `send` is not available, which is all it needs to render an honest card.
 */
export function commandState({ thread, state, tabId, at }) {
  const summary = tabSummary({ thread, state, tabId, at });
  return {
    ...summary,
    activeTurnId: str(state?.activeTurnId, 256),
    actions: { send: state?.actions?.send === true, stop: state?.actions?.stop === true },
  };
}

/**
 * `get_last_answer`: the finished assistant text and nothing around it. It exists on the server
 * only as a transient payload on its way to the Mini App — never in a snapshot, an event or a
 * durable queue.
 */
export function commandAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const text = typeof answer.text === 'string' ? answer.text : '';
  return {
    answerId: String(answer.answerId ?? ''),
    turnId: String(answer.turnId ?? ''),
    text: text.slice(0, LIMITS.answer),
    truncated: answer.truncated === true || text.length > LIMITS.answer,
    completedAt: str(answer.completedAt, 64),
  };
}

/** The safe half of a core error. The core guarantees the text carries no stack and no command. */
export const commandDetail = error => (error
  ? { code: clean(error.code, 40) || 'unavailable', message: clean(error.message, LIMITS.detail) || 'Команда не выполнена.', requiresComputer: error.requiresComputer === true }
  : null);

// ---------------------------------------------------------------- outgoing frames

const envelope = (type, now) => ({ protocol: PROTOCOL, type, frameId: randomUUID(), sentAt: new Date(now).toISOString() });

const clientBlock = ({ appVersion, channel }) => ({
  app: 'kuzmich',
  appVersion: clean(appVersion, 32) || '0.0.0',
  channel: clean(channel, 32) || 'release',
  bridge: BRIDGE_PROTOCOL,
  features: [],
});

/**
 * One builder per outgoing frame. Values are copied field by field — an object handed in from the
 * core or from storage can never carry an extra key onto the wire by accident.
 */
export const outgoing = {
  hello: ({ now, installationId, proof, label, appVersion, channel, resume }) => ({
    ...envelope('hello', now),
    installationId: String(installationId),
    proof: String(proof),
    client: clientBlock({ appVersion, channel }),
    installation: { label: cleanLabel(label) },
    resume: resume ? { epoch: Number(resume.epoch) || 0, revision: Number(resume.revision) || 0 } : null,
  }),

  pair_start: ({ now, pairingId, hash, publicKey, label, appVersion, channel }) => ({
    ...envelope('pair_start', now),
    pairingId: String(pairingId),
    nonceHash: String(hash),
    publicKey: String(publicKey),
    client: clientBlock({ appVersion, channel }),
    installation: { label: cleanLabel(label) },
  }),

  pair_confirm: ({ now, pairingId, nonce, claimantUserId }) => ({
    ...envelope('pair_confirm', now),
    pairingId: String(pairingId),
    nonce: String(nonce),
    claimantUserId: String(claimantUserId),
  }),

  pair_cancel: ({ now, pairingId, reason }) => ({
    ...envelope('pair_cancel', now),
    pairingId: String(pairingId),
    reason: ['declined', 'timeout', 'local'].includes(reason) ? reason : 'local',
  }),

  unpair: ({ now, reason }) => ({
    ...envelope('unpair', now),
    reason: ['owner', 'storage_failed', 'relay_changed'].includes(reason) ? reason : 'owner',
  }),

  pong: ({ now, nonce }) => ({ ...envelope('pong', now), nonce: String(nonce ?? '') }),

  snapshot: ({ now, epoch, revision, label, appVersion, channel, tabs, truncated }) => ({
    ...envelope('snapshot', now),
    epoch, revision,
    installation: { label: cleanLabel(label), appVersion: clean(appVersion, 32) || '0.0.0', channel: clean(channel, 32) || 'release' },
    tabs: tabs.map(tab => ({ ...tab })),
    truncated: truncated === true,
  }),

  event: ({ now, epoch, revision, event }) => ({ ...envelope('event', now), epoch, revision, event }),

  command_result: ({ now, commandId, tabId, status, outcome = null, detail = null, payload = null }) => ({
    ...envelope('command_result', now),
    commandId: String(commandId),
    tabId: tabId ? String(tabId) : null,
    at: new Date(now).toISOString(),
    status,
    outcome,
    detail: detail ? { code: String(detail.code), message: String(detail.message), requiresComputer: detail.requiresComputer === true } : null,
    payload,
  }),
};

/**
 * Notices of 2.3. Two kinds and no third: the model's turn finished, or the turn stopped and the
 * computer has to do something about it. A receiver that does not know a kind ignores it, exactly
 * as it ignores an unknown `kind` — that is what lets this list grow later.
 *
 * «Кузьмич отключился» is deliberately **not** here: that is the relay observing presence, and an
 * event about it would have to be sent by a bridge that is, by definition, no longer connected.
 */
export const NOTICE_KINDS = Object.freeze(['turn_completed', 'action_required']);

/** Event bodies, also field by field. */
export const events = {
  tab_updated: tab => ({ kind: 'tab_updated', tab: { ...tab } }),
  tab_removed: tabId => ({ kind: 'tab_removed', tabId: String(tabId) }),
  installation_updated: ({ label, appVersion, channel }) => ({
    kind: 'installation_updated',
    installation: { label: cleanLabel(label), appVersion: clean(appVersion, 32) || '0.0.0', channel: clean(channel, 32) || 'release' },
  }),

  /**
   * A command that moved on after its first answer — queued became accepted, accepted became
   * executed, an uncertain one was resolved by a late ACK.
   *
   * There is deliberately no `payload` slot here at all. Answer text reaches the server only as the
   * transient payload of a `command_result` the phone asked for; an event stream the relay stores
   * must never be able to carry it, and the absence of the field is what guarantees that.
   */
  /**
   * Something happened in an allowed conversation that is worth a push to the phone.
   *
   * The body is four fields and has room for nothing else: no answer text, no reason for the
   * block, no path, no outcome of the turn. `turnId` is `null` rather than absent when the bridge
   * does not know which turn is meant — the key is always present so the shape never varies.
   */
  notice: ({ tabId, noticeKind, turnId = null, occurredAt }) => {
    if (!NOTICE_KINDS.includes(noticeKind)) throw new ProtocolError(`Неизвестный вид уведомления: ${noticeKind}`);
    return {
      kind: 'notice',
      tabId: String(tabId),
      noticeKind,
      turnId: turnId ? String(turnId).slice(0, 256) : null,
      occurredAt: new Date(occurredAt).toISOString(),
    };
  },

  command_updated: ({ commandId, tabId, at, status, outcome = null, detail = null }) => ({
    kind: 'command_updated',
    commandId: String(commandId),
    tabId: tabId ? String(tabId) : null,
    at: new Date(at).toISOString(),
    status,
    outcome: outcome ?? null,
    detail: detail ? { code: String(detail.code), message: String(detail.message), requiresComputer: detail.requiresComputer === true } : null,
  }),
};

export function encodeFrame(frame) {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > LIMITS.outgoingFrame) throw new ProtocolError('Исходящий фрейм превышает предел.');
  return text;
}

// ---------------------------------------------------------------- incoming frames

/**
 * Envelope validation only. Unknown fields of a known frame are ignored and an unknown `type` is
 * left for the caller to drop — that is what lets the server ship ahead of the desktop.
 */
export function parseFrame(raw) {
  if (typeof raw !== 'string') throw new ProtocolError('Ожидался текстовый фрейм.');
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.incomingFrame) throw new ProtocolError('Входящий фрейм превышает предел.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError('Фрейм не является JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Фрейм не является объектом.');
  if (value.protocol !== PROTOCOL) throw new ProtocolError('Версия протокола сервера не поддерживается.', { close: CLOSE.version });
  if (typeof value.type !== 'string' || !value.type || value.type.length > 64) throw new ProtocolError('Фрейм без вида.');
  return value;
}

const str = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;

export function readChallenge(frame) {
  const nonce = str(frame.nonce, 512);
  if (!nonce) throw new ProtocolError('Сервер прислал challenge без nonce.');
  return { nonce, serverProtocol: str(frame.serverProtocol, 16) || '2.0' };
}

export function readWelcome(frame) {
  const heartbeat = Number(frame.heartbeatIntervalMs);
  return {
    sessionId: str(frame.sessionId, 128) || '',
    serverProtocol: str(frame.serverProtocol, 16) || '2.0',
    heartbeatIntervalMs: Number.isFinite(heartbeat) && heartbeat >= 5_000 && heartbeat <= 300_000 ? heartbeat : LIMITS.heartbeatMs,
    features: Array.isArray(frame.features) ? frame.features.filter(value => str(value, 64)).slice(0, 32) : [],
  };
}

export function readPairPending(frame) {
  const pairingId = str(frame.pairingId, 64);
  if (!pairingId) throw new ProtocolError('Сервер не подтвердил начало привязки.');
  return {
    pairingId,
    expiresAt: str(frame.expiresAt, 64),
    attemptLimit: Number.isSafeInteger(frame.attemptLimit) ? frame.attemptLimit : 5,
    botUsername: str(frame.botUsername, 64),
  };
}

export function readPairClaimed(frame) {
  const pairingId = str(frame.pairingId, 64), claimant = frame.claimant;
  const telegramUserId = claimant && NUMERIC_ID.test(String(claimant.telegramUserId ?? '')) ? String(claimant.telegramUserId) : null;
  if (!pairingId || !telegramUserId) throw new ProtocolError('Сервер прислал заявку на привязку без пользователя.');
  return {
    pairingId,
    claimant: {
      telegramUserId,
      displayName: clean(claimant.displayName, 120) || `ID ${telegramUserId}`,
      username: str(clean(claimant.username, 64), 64),
    },
    confirmExpiresAt: str(frame.confirmExpiresAt, 64),
  };
}

/**
 * Since 2.1 this frame carries **no secret**: the installation already holds its own private key,
 * so the relay only has to name the installation and its owner.
 */
export function readPairComplete(frame) {
  const installationId = str(frame.installationId, 64);
  const owner = frame.owner;
  const telegramUserId = owner && NUMERIC_ID.test(String(owner.telegramUserId ?? '')) ? String(owner.telegramUserId) : null;
  if (!installationId || !UUID_PATTERN.test(installationId)) throw new ProtocolError('Сервер не выдал идентификатор установки.');
  if (!telegramUserId) throw new ProtocolError('Сервер не назвал владельца установки.');
  return {
    installationId,
    owner: { telegramUserId, displayName: clean(owner.displayName, 120) || `ID ${telegramUserId}` },
    issuedAt: str(frame.issuedAt, 64) || new Date().toISOString(),
  };
}

const ACTIONS = new Set(['send', 'stop', 'get_state', 'get_last_answer']);

/** Stage 3 executes these; the shape is fixed now so the backend can be built against it. */
export function readCommand(frame) {
  const commandId = str(frame.commandId, LIMITS.commandId);
  if (!commandId || !ID_PATTERN.test(commandId)) throw new ProtocolError('Команда без корректного идентификатора.');
  const tabId = str(frame.tabId, 64), userRef = str(frame.userRef, LIMITS.userRef), action = str(frame.action, 32);
  const command = { commandId, tabId, userRef, action, text: null, expectedTurnId: null, deadline: str(frame.deadline, 64) };
  if (!tabId || !userRef || !ID_PATTERN.test(userRef) || !action || !ACTIONS.has(action)) return { ...command, invalid: true };
  if (action === 'send') {
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (!text.trim() || text.length > LIMITS.text || text.trim().startsWith('/')) return { ...command, invalid: true };
    command.text = text;
  }
  if (action === 'stop') {
    const expected = str(frame.expectedTurnId, 256);
    if (!expected) return { ...command, invalid: true };
    command.expectedTurnId = expected;
  }
  return { ...command, invalid: false };
}

/** Core operation phase → wire status. `uncertain` is never an error and never a retry. */
export function statusForPhase(phase) {
  if (['received', 'queued'].includes(phase)) return 'queued';
  if (phase === 'accepted') return 'accepted';
  if (phase === 'completed') return 'executed';
  if (phase === 'uncertain') return 'uncertain';
  return 'rejected';
}

/**
 * Whether a command has stopped moving and can be forgotten by the watcher.
 *
 * `uncertain` is **not** on the list, and that is the point: the core resolves an uncertain
 * delivery later through a late ACK or live echo, and the phone deserves to hear about it instead
 * of being left with "check the computer" forever.
 */
const TERMINAL_PHASES = new Set(['completed', 'blocked', 'stale', 'rejected', 'cancelled']);
export const isTerminalPhase = phase => TERMINAL_PHASES.has(phase);
