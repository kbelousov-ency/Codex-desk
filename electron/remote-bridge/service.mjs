import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayConnection } from './connection.mjs';
import { collectTabs, diffNotices, diffTabs, resolveTab } from './publisher.mjs';
import { BridgeStore } from './storage.mjs';
import {
  BACKOFF_MS, CLOSE, FATAL_CLOSE, LIMITS, REPLACED_DELAY_MS,
  backoffDelay, buildRequestId, cleanLabel, commandAnswer, commandDetail, commandState, createInstallationKeys, createNonce,
  deviceProof, createTabSalt, endpointFor, events, isTerminalPhase, livenessDeadlineMs, nonceHash,
  outgoing, readChallenge, readCommand, readPairClaimed, readPairComplete, readPairPending, readWelcome,
  statusForPhase, validateRelayUrl,
} from './protocol.mjs';

/**
 * The relay bridge: one outgoing WSS connection from this computer to the relay server.
 *
 * What it publishes is decided here and nowhere else — only conversations the owner explicitly
 * allowed on this computer, and only the eight approved fields of each. It has no method that
 * could grant access, change a model or answer an approval: those belong to the computer, exactly
 * as in the v1 contract. See docs/RELAY_CONTRACT.md.
 *
 * Since stage 3 it also executes the four allowed commands through that same facade. It still has
 * no way to grant anything: `send`, `stop`, `get_state` and `get_last_answer` are the whole set,
 * and each one re-checks the permission against the core immediately before it acts.
 */

const SAFETY_POLL_MS = 15_000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

export function createRemoteBridgeService({
  userData, safeStorage, remote,
  appVersion = '0.0.0', channel = 'release',
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  safetyPollMs = SAFETY_POLL_MS,
  // Test seams, like `safetyPollMs`: a short ladder and a short silence deadline make the
  // reconnect and heartbeat tests take seconds instead of minutes. Production uses the contract's
  // own numbers, and nothing here changes what the relay is told.
  backoffLadder = BACKOFF_MS,
  livenessMs = null,
} = {}) {
  if (!userData) throw new TypeError('createRemoteBridgeService requires userData.');
  if (!remote) throw new TypeError('createRemoteBridgeService requires a RemoteControl.');

  const store = new BridgeStore({
    directory: path.join(userData, 'remote-bridge'),
    encrypt: value => Buffer.from(safeStorage.encryptString(value)),
    decrypt: bytes => safeStorage.decryptString(bytes),
    available: () => safeStorage.isEncryptionAvailable(),
    now,
  });
  const listeners = new Set();

  let started = false;
  let chain = Promise.resolve();
  let generation = 0;              // invalidates in-flight work after a local change
  let connection = null;
  let stage = 'idle';              // challenge → welcome → ready
  let phase = 'disabled';
  let failure = null;
  let epoch = 0;
  let revision = 0;
  let publishing = false;
  let publishAgain = false;
  let publishedTabs = [];
  // Private counterpart of `publishedTabs`: the active turn and whether this computer is needed.
  // It never leaves the process — only the notices derived from its changes do.
  let publishedSignals = new Map();
  let pairing = null;
  let backoff = 0;
  let connectTimer = null;
  let coalesceTimer = null;
  let pollTimer = null;
  let pairingTimer = null;
  let lastResyncAt = 0;
  let unsubscribe = null;

  const run = fn => { const job = chain.catch(() => {}).then(fn); chain = job; return job; };
  const invalidate = () => { generation++; };
  const storageMessage = 'Не удалось сохранить настройки подключения к серверу. Требуется действие на компьютере.';

  const state = () => {
    const record = store.snapshot();
    const credential = store.credential;
    return {
      enabled: Boolean(record?.enabled),
      relayUrl: record?.relayUrl ?? '',
      label: record?.label ?? 'Кузьмич',
      linked: Boolean(credential),
      encryptionAvailable: store.encryptionAvailable,
      connection: phase,
      owner: credential ? { displayName: credential.owner.displayName, telegramUserId: credential.owner.telegramUserId } : null,
      pairing: pairing
        ? {
            pairingId: pairing.pairingId,
            label: pairing.label,
            code: pairing.nonce,
            link: pairing.botUsername ? `https://t.me/${pairing.botUsername}?startapp=${pairing.nonce}` : null,
            expiresAt: new Date(pairing.expiresAt).toISOString(),
            claimant: pairing.claimant,
            confirmExpiresAt: pairing.confirmExpiresAt,
          }
        : null,
      publishedTabs: phase === 'online' ? publishedTabs.length : 0,
      error: failure || store.failure || store.credentialFailure || null,
    };
  };

  const emit = () => {
    const snapshot = state();
    for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* a bad listener cannot break the bridge */ } }
  };

  const setPhase = (next, message = null) => {
    if (phase === next && failure === message) return;
    phase = next; failure = message;
    emit();
  };

  const background = fn => {
    const expected = generation;
    void run(() => (expected === generation ? fn(expected) : undefined)).catch(() => {
      if (expected === generation) setPhase('error', storageMessage);
    });
  };
  const mutate = fn => run(fn).catch(cause => {
    const message = cause?.name === 'BridgeStorageError' ? cause.message : storageMessage;
    setPhase('error', message);
    throw new Error(message);
  });

  // ---------------------------------------------------------------- connection lifecycle

  const current = expected => expected === generation && started;

  function teardown({ code = CLOSE.normal, reason = '' } = {}) {
    const previous = connection;
    connection = null; stage = 'idle';
    clearTimeout(connectTimer); connectTimer = null;
    clearTimeout(coalesceTimer); coalesceTimer = null;
    clearInterval(pollTimer); pollTimer = null;
    previous?.close(code, reason);
  }

  function schedule(delayMs, expected) {
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => { if (current(expected)) void connect(expected); }, delayMs);
    connectTimer.unref?.();
  }

  /** Why the bridge is not connecting right now, as a message for the computer. */
  function blockedReason() {
    const record = store.snapshot();
    if (!record) return { phase: 'error', message: store.failure };
    if (store.credentialFailure) return { phase: 'error', message: store.credentialFailure };
    if (!record.enabled) return { phase: 'disabled', message: null };
    if (!record.relayUrl) return { phase: 'unconfigured', message: null };
    if (!store.credential) return { phase: 'unconfigured', message: null };
    if (!epoch) return { phase: 'error', message: storageMessage };
    return null;
  }

  async function connect(expected = generation) {
    if (!current(expected) || connection || pairing) return;
    const blocked = blockedReason();
    if (blocked) { setPhase(blocked.phase, blocked.message); return; }

    const record = store.snapshot(), credential = store.credential;
    // A credential issued for a different server is not valid here; asking the owner is the only
    // safe resolution, because silently re-pairing would hand the new server an existing identity.
    if (credential.relayUrl && credential.relayUrl !== record.relayUrl) {
      setPhase('error', 'Эта установка связана с другим сервером. Отвяжите её и свяжите заново.');
      return;
    }

    setPhase('connecting', null);
    // `revision` deliberately keeps counting across a reconnect. It is monotone within the epoch,
    // not within the socket: restarting it at 1 would make the resync snapshot look older than the
    // events the relay already applied, and the relay drops anything not strictly greater.
    stage = 'challenge';

    const socket = new RelayConnection({
      url: endpointFor(record.relayUrl),
      WebSocketImpl,
      onFrame: frame => { if (current(expected) && connection === socket) onFrame(frame, expected, socket, credential, record); },
      onClosed: info => { if (connection === socket) onClosed(info, expected); },
    });
    connection = socket;
    socket.open();
  }

  function onFrame(frame, expected, socket, credential, record) {
    if (frame.type === 'error') {
      setPhase('error', safeServerMessage(frame));
      socket.close(CLOSE.normal, 'error');
      return;
    }
    if (frame.type === 'revoked') { void onRevoked(frame, expected); return; }

    if (stage === 'challenge' && frame.type === 'challenge') {
      const challenge = readChallenge(frame);
      socket.send(outgoing.hello({
        now: now(), installationId: credential.installationId, label: record.label, appVersion, channel,
        proof: deviceProof({ privateKey: credential.privateKey, installationId: credential.installationId, nonce: challenge.nonce }),
        resume: { epoch, revision },
      }));
      stage = 'welcome';
      return;
    }
    if (stage === 'welcome' && frame.type === 'welcome') {
      const welcome = readWelcome(frame);
      socket.armWatchdog(livenessMs ?? livenessDeadlineMs(welcome.heartbeatIntervalMs));
      stage = 'ready';
      backoff = 0;
      setPhase('online', null);
      schedulePoll(expected);
      background(() => publishSnapshot(expected, socket));
      return;
    }
    if (stage !== 'ready') return;  // anything before `welcome` is not yet trusted to mean something

    switch (frame.type) {
      case 'ping':
        socket.send(outgoing.pong({ now: now(), nonce: typeof frame.nonce === 'string' ? frame.nonce : '' }));
        break;
      case 'resync_request': {
        if (now() - lastResyncAt < LIMITS.resyncMs) break;   // a resync storm must not become a loop
        lastResyncAt = now();
        background(() => publishSnapshot(expected, socket));
        break;
      }
      case 'command':
        background(() => onCommand(frame, socket));
        break;
      case 'unpaired':
        void onRevoked({ reason: 'owner' }, expected);
        break;
      default:
        break;  // an unknown frame is ignored on purpose: the server may ship ahead of the desktop
    }
  }

  function onClosed({ code, reason }, expected) {
    teardown();
    if (!current(expected)) return;
    if (FATAL_CLOSE.has(code)) {
      if (code === CLOSE.revoked) { background(ex => forgetCredential(ex, 'Сервер отозвал подключение этого компьютера.')); return; }
      setPhase('error', code === CLOSE.unauthorized
        ? 'Сервер не принял эту установку. Отвяжите её и свяжите заново.'
        : 'Сервер использует более новую версию протокола. Обновите Кузьмича.');
      return;
    }
    const delayMs = code === CLOSE.replaced ? REPLACED_DELAY_MS
      : code === CLOSE.rateLimited ? 60_000
        : backoffDelay(backoff++, { ladder: backoffLadder });
    setPhase('connecting', reason === 'timeout' ? 'Сервер не отвечает. Переподключаемся.' : null);
    schedule(delayMs, expected);
  }

  /** Server text is never shown raw: only a fixed sentence plus a short sanitized code. */
  function safeServerMessage(frame) {
    const code = typeof frame.code === 'string' ? frame.code.replace(/[^a-z_]/gi, '').slice(0, 40) : '';
    return code ? `Сервер отклонил подключение (${code}).` : 'Сервер отклонил подключение.';
  }

  // ---------------------------------------------------------------- publishing

  function schedulePoll(expected) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (current(expected) && stage === 'ready') background(() => publishChanges(expected, connection));
    }, safetyPollMs);
    pollTimer.unref?.();
  }

  /**
   * The subscription is used as a bare "something moved" signal. `readEvent` is deliberately not
   * called: it would hand this module the answer text, and the only safe way to keep that text off
   * the wire is never to hold it here at all.
   */
  function schedulePublish() {
    if (stage !== 'ready' || coalesceTimer) return;
    const expected = generation;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      if (current(expected) && stage === 'ready') background(() => publishChanges(expected, connection));
    }, LIMITS.coalesceMs);
    coalesceTimer.unref?.();
  }

  async function publishSnapshot(expected, socket) {
    if (!current(expected) || connection !== socket || stage !== 'ready') return;
    const collected = await collectTabs({ remote, tabSalt: store.credential?.tabSalt, now });
    if (!current(expected) || connection !== socket || stage !== 'ready' || !collected.ok) return;
    const record = store.snapshot();
    revision += 1;
    publishedTabs = collected.tabs;
    // A snapshot only re-seeds the baseline for notices. A reconnect must not turn "what the
    // computer looks like now" into a burst of pushes about things the owner was never told about
    // while the link was down — the snapshot itself already says what the state is.
    publishedSignals = collected.signals;
    socket.send(outgoing.snapshot({
      now: now(), epoch, revision, label: record?.label, appVersion, channel,
      tabs: collected.tabs, truncated: collected.truncated,
    }));
    emit();
  }

  async function publishChanges(expected, socket) {
    if (!current(expected) || !socket || connection !== socket || stage !== 'ready') return;
    if (publishing) { publishAgain = true; return; }
    publishing = true;
    try {
      const collected = await collectTabs({ remote, tabSalt: store.credential?.tabSalt, now });
      if (!current(expected) || connection !== socket || stage !== 'ready' || !collected.ok) return;
      const changes = diffTabs(publishedTabs, collected.tabs);
      // Notices ride the same collection and the same revision counter as the tab updates: one
      // order for everything the bridge publishes, so the relay never has to merge two streams.
      const notices = diffNotices(publishedSignals, collected.signals, new Date(now()).toISOString());
      publishedTabs = collected.tabs;
      publishedSignals = collected.signals;
      for (const event of [...changes, ...notices]) {
        revision += 1;
        socket.send(outgoing.event({ now: now(), epoch, revision, event }));
      }
      if (changes.length) emit();
      // Same signal, same cadence: whatever moved a tab usually moved a command too.
      await pollCommands(expected, socket);
    } finally {
      publishing = false;
      if (publishAgain) { publishAgain = false; schedulePublish(); }
    }
  }

  // ---------------------------------------------------------------- commands

  const answerCommand = (socket, command, { status, outcome = null, detail = null, payload = null }) => socket.send(outgoing.command_result({
    now: now(), commandId: command.commandId, tabId: command.tabId, status, outcome, detail, payload,
  }));

  const reject = (socket, command, code, message, requiresComputer = false) =>
    answerCommand(socket, command, { status: 'rejected', detail: { code, message, requiresComputer } });

  const rejectFromError = (socket, command, error) => answerCommand(socket, command, {
    status: 'rejected',
    detail: commandDetail(error) ?? { code: 'unavailable', message: 'Команда не выполнена. Требуется действие на компьютере.', requiresComputer: true },
  });

  /**
   * Nothing is known about what happened. The contract forbids turning this into a refusal (it
   * might have run) and into a retry (it might run twice); the owner checks the computer.
   */
  const uncertain = (socket, command) => answerCommand(socket, command, {
    status: 'uncertain',
    detail: { code: 'uncertain_delivery', message: 'Не удалось выяснить судьбу команды. Проверьте на компьютере.', requiresComputer: true },
  });

  async function onCommand(frame, socket) {
    let command;
    try { command = readCommand(frame); }
    catch { return; }  // a command without a usable id has nothing to answer to
    if (command.invalid) { reject(socket, command, 'invalid_command', 'Некорректная команда.'); return; }
    // An expired command is refused without ever reaching the core: a late delivery must not turn
    // into a task the owner stopped expecting minutes ago.
    if (command.deadline && Date.parse(command.deadline) < now()) { reject(socket, command, 'expired', 'Команда устарела.'); return; }

    const credential = store.credential;
    if (!credential) { reject(socket, command, 'not_connected', 'Этот компьютер не связан с сервером.', true); return; }

    // The address is resolved against the core's current list, so a permission revoked a second
    // ago has no address at all. An unknown tab is refused without touching the core further.
    const thread = await resolveTab({ remote, tabSalt: credential.tabSalt, tabId: command.tabId }).catch(() => null);
    if (!thread) { reject(socket, command, 'unknown_tab', 'Беседа недоступна. Требуется действие на компьютере.', true); return; }

    let requestId;
    try { requestId = buildRequestId({ userRef: command.userRef, installationId: credential.installationId, commandId: command.commandId }); }
    catch { reject(socket, command, 'invalid_command', 'Некорректная команда.'); return; }

    if (command.action === 'get_state') { await readState(socket, command, thread); return; }
    if (command.action === 'get_last_answer') { await readAnswer(socket, command, thread); return; }
    await runCommand(socket, command, thread, requestId);
  }

  /** Reading state is not an operation: no ledger entry, no journal, nothing to replay. */
  async function readState(socket, command, thread) {
    const at = new Date(now()).toISOString();
    if (!thread.target) {
      // "Unavailable" is an honest answer to "what is the state", not a failure to answer.
      answerCommand(socket, command, { status: 'executed', outcome: 'succeeded', payload: { state: commandState({ thread, state: null, tabId: command.tabId, at }) } });
      return;
    }
    let read;
    try { read = await remote.getThreadState(thread.target); }
    catch { reject(socket, command, 'unavailable', 'Не удалось прочитать состояние беседы.', true); return; }
    if (!read?.ok) { rejectFromError(socket, command, read?.error); return; }
    answerCommand(socket, command, { status: 'executed', outcome: 'succeeded', payload: { state: commandState({ thread, state: read.value, tabId: command.tabId, at }) } });
  }

  /**
   * The only path on which answer text exists in this module at all, and only for the length of
   * one reply the phone explicitly asked for. The permission was re-checked a few lines above and
   * the core checks it again inside `getLastAnswer`.
   */
  async function readAnswer(socket, command, thread) {
    if (!thread.target) { reject(socket, command, 'unavailable', 'Беседа сейчас недоступна на компьютере.', true); return; }
    let read;
    try { read = await remote.getLastAnswer(thread.target); }
    catch { reject(socket, command, 'unavailable', 'Не удалось прочитать последний ответ.', true); return; }
    if (!read?.ok) { rejectFromError(socket, command, read?.error); return; }
    answerCommand(socket, command, { status: 'executed', outcome: 'succeeded', payload: { answer: commandAnswer(read.value) } });
  }

  async function runCommand(socket, command, thread, requestId) {
    if (!thread.target) { reject(socket, command, 'unavailable', 'Беседа сейчас недоступна на компьютере.', true); return; }

    // Durable first. If this write does not land, no RPC happens at all — the journal may run
    // ahead of what was executed, never behind it, and being ahead is what the replay path below
    // is able to reconcile.
    let admitted;
    try { admitted = await store.rememberCommand({ commandId: command.commandId, requestId, tabId: command.tabId, action: command.action }); }
    catch { reject(socket, command, 'persistence_failed', 'Не удалось записать команду на компьютере. Повторите позже.', true); return; }
    if (admitted.conflict) { reject(socket, command, 'request_conflict', 'Этот номер команды уже использован для другого действия.'); return; }

    let result = null;
    if (admitted.replay) {
      // The record proves the command was admitted once, so it may already be running. Only the
      // read-only API may decide; `not_found` is the core's proof that nothing was ever sent, and
      // it is the single reason a second `execute` is allowed to happen.
      let seen;
      try { seen = await remote.getOperation({ target: thread.target, requestId }); }
      catch { uncertain(socket, command); return; }
      if (seen?.ok) result = seen;
      else if (seen?.error?.code !== 'not_found') { rejectFromError(socket, command, seen?.error); return; }
    }

    if (!result) {
      const payload = command.action === 'send'
        ? { requestId, target: thread.target, kind: 'send', text: command.text }
        : { requestId, target: thread.target, kind: 'stop', expectedTurnId: command.expectedTurnId };
      try { result = await remote.execute(payload); }
      // A throw after the call may still have reached the agent, so it is never reported as a
      // refusal: the v1 rule that a lost acknowledgement is not a rejection holds here too.
      catch { uncertain(socket, command); return; }
    }

    if (!result?.ok) { rejectFromError(socket, command, result?.error); return; }
    const operation = result.value;
    answerCommand(socket, command, {
      status: statusForPhase(operation.phase),
      outcome: operation.outcome ?? null,
      detail: commandDetail(operation.error),
    });
    watch(command, thread, requestId, operation);
  }

  // ---------------------------------------------------------------- follow-up of live commands

  /**
   * Commands still moving, watched so the phone sees `queued → accepted → executed` without
   * polling the computer itself.
   *
   * The core's subscription is used as a signal only, and the follow-up is read back through
   * `getOperation`. `readEvent` would be the shorter route and is deliberately not taken: it can
   * hand this module the text of an answer, and the only way to be sure that text never reaches
   * the wire is never to hold it. `getOperation` re-checks the permission on every call anyway.
   */
  const pending = new Map();   // commandId → { tabId, grantId, requestId, status, outcome, at }

  function watch(command, thread, requestId, operation) {
    if (isTerminalPhase(operation.phase)) { pending.delete(command.commandId); return; }
    if (!pending.has(command.commandId) && pending.size >= LIMITS.pending) return;
    pending.set(command.commandId, {
      tabId: command.tabId, grantId: thread.grantId, requestId,
      status: statusForPhase(operation.phase), outcome: operation.outcome ?? null, at: now(),
    });
  }

  async function pollCommands(expected, socket) {
    if (!pending.size || !current(expected) || connection !== socket || stage !== 'ready') return;
    if (!store.credential) { pending.clear(); return; }
    const listed = await remote.listThreads().catch(() => null);
    if (!listed?.ok || !Array.isArray(listed.value)) return;
    const byGrant = new Map(listed.value.filter(thread => thread?.grantId).map(thread => [thread.grantId, thread]));

    for (const [commandId, entry] of [...pending]) {
      if (now() - entry.at > LIMITS.pendingTtlMs) { pending.delete(commandId); continue; }
      const thread = byGrant.get(entry.grantId);
      // The permission is gone: the phone keeps the last status it was given and hears no more.
      if (!thread) { pending.delete(commandId); continue; }
      if (!thread.target) continue;

      let read;
      try { read = await remote.getOperation({ target: thread.target, requestId: entry.requestId }); }
      catch { continue; }
      if (!current(expected) || connection !== socket || stage !== 'ready') return;
      if (!read?.ok) {
        if (['access_denied', 'not_found', 'stale_target'].includes(read?.error?.code)) pending.delete(commandId);
        continue;
      }
      const status = statusForPhase(read.value.phase), outcome = read.value.outcome ?? null;
      if (isTerminalPhase(read.value.phase)) pending.delete(commandId);
      if (status === entry.status && outcome === entry.outcome) continue;
      entry.status = status; entry.outcome = outcome;
      revision += 1;
      socket.send(outgoing.event({
        now: now(), epoch, revision,
        event: events.command_updated({ commandId, tabId: entry.tabId, at: now(), status, outcome, detail: commandDetail(read.value.error) }),
      }));
    }
  }

  // ---------------------------------------------------------------- pairing

  function clearPairing() {
    clearTimeout(pairingTimer); pairingTimer = null;
    pairing = null;
  }

  async function startPairing(expected, label) {
    if (!current(expected)) return;
    const record = store.snapshot();
    const session = {
      pairingId: randomUUID(),
      nonce: createNonce(32),
      // The identity of this installation is born here, on this computer. Only the public half
      // ever reaches the relay, and only inside `pair_start`.
      keys: createInstallationKeys(),
      label: cleanLabel(label ?? record?.label),
      expiresAt: now() + PAIRING_TTL_MS,
      botUsername: null,
      claimant: null,
      confirmExpiresAt: null,
      connection: null,
      stage: 'challenge',
    };
    pairing = session;
    setPhase('pairing', null);

    pairingTimer = setTimeout(() => {
      if (pairing === session) { session.connection?.close(CLOSE.normal, 'expired'); clearPairing(); setPhase('error', 'Время привязки истекло. Создайте код заново.'); }
    }, PAIRING_TTL_MS);
    pairingTimer.unref?.();

    const socket = new RelayConnection({
      url: endpointFor(record.relayUrl),
      WebSocketImpl,
      onFrame: frame => { if (current(expected) && pairing === session) onPairingFrame(frame, session, socket, expected); },
      onClosed: () => {
        if (pairing !== session) return;
        // Closing before a credential arrived means the attempt simply did not finish.
        clearPairing();
        setPhase('error', 'Связь с сервером прервалась до завершения привязки. Попробуйте ещё раз.');
      },
    });
    session.connection = socket;
    socket.open();
  }

  function onPairingFrame(frame, session, socket, expected) {
    if (frame.type === 'error') { session.failed = true; clearPairing(); socket.close(CLOSE.normal, 'error'); setPhase('error', safeServerMessage(frame)); return; }
    if (session.stage === 'challenge' && frame.type === 'challenge') {
      readChallenge(frame);
      socket.send(outgoing.pair_start({
        now: now(), pairingId: session.pairingId, hash: nonceHash(session.nonce),
        publicKey: session.keys.publicKey, label: session.label, appVersion, channel,
      }));
      session.stage = 'pending';
      return;
    }
    if (session.stage === 'pending' && frame.type === 'pair_pending') {
      const pending = readPairPending(frame);
      // The relay cannot build the link: it only ever learned the hash of the code.
      session.botUsername = pending.botUsername;
      if (pending.expiresAt) {
        const parsed = Date.parse(pending.expiresAt);
        if (Number.isFinite(parsed)) session.expiresAt = Math.min(session.expiresAt, parsed);
      }
      session.stage = 'claimed';
      emit();
      return;
    }
    if (frame.type === 'ping') { socket.send(outgoing.pong({ now: now(), nonce: typeof frame.nonce === 'string' ? frame.nonce : '' })); return; }
    if (session.stage === 'claimed' && frame.type === 'pair_claimed') {
      const claimed = readPairClaimed(frame);
      if (claimed.pairingId !== session.pairingId) return;
      session.claimant = claimed.claimant;
      session.confirmExpiresAt = claimed.confirmExpiresAt;
      emit();     // the owner now sees who is asking, and nothing is issued until they decide
      return;
    }
    if (frame.type === 'pair_complete') {
      if (!session.confirmed) { socket.close(CLOSE.protocol, 'unconfirmed'); return; }
      const complete = readPairComplete(frame);
      background(ex => finishPairing(complete, session, socket, ex));
      return;
    }
  }

  async function finishPairing(complete, session, socket, expected) {
    if (!current(expected) || pairing !== session) return;
    const record = store.snapshot();
    try {
      if (session.label !== record.label) await store.update(draft => { draft.label = session.label; });
      await store.saveCredential({
        installationId: complete.installationId,
        privateKey: session.keys.privateKey,
        publicKey: session.keys.publicKey,
        tabSalt: createTabSalt(),
        relayUrl: record.relayUrl,
        owner: complete.owner,
        issuedAt: complete.issuedAt,
      });
    } catch (cause) {
      // The server must not keep a credential this computer cannot use.
      socket.send(outgoing.unpair({ now: now(), reason: 'storage_failed' }));
      socket.close(CLOSE.normal, 'storage');
      clearPairing();
      setPhase('error', cause?.message || 'Не удалось сохранить подключение к серверу.');
      return;
    }
    try { epoch = await store.nextEpoch(); }
    catch { socket.close(CLOSE.normal, 'storage'); clearPairing(); setPhase('error', storageMessage); return; }

    socket.close(CLOSE.normal, 'paired');
    clearPairing();
    revision = 0; publishedTabs = []; publishedSignals = new Map(); pending.clear();
    setPhase('connecting', null);
    schedule(0, expected);
  }

  async function forgetCredential(expected, message) {
    await store.clearCredential();
    teardown();
    if (!current(expected)) return;
    revision = 0; publishedTabs = []; publishedSignals = new Map(); pending.clear();
    setPhase(message ? 'error' : 'unconfigured', message ?? null);
  }

  async function onRevoked(frame, expected) {
    const reason = typeof frame?.reason === 'string' ? frame.reason : 'owner';
    teardown();
    await forgetCredential(expected, reason === 'expired'
      ? 'Срок подключения этого компьютера истёк. Свяжите установку заново.'
      : 'Подключение этого компьютера отозвано. Свяжите установку заново.');
  }

  // ---------------------------------------------------------------- local control

  const local = {
    async getState() { return state(); },

    async setRelayUrl(value) {
      const url = validateRelayUrl(value);
      const record = store.snapshot();
      if (store.credential && record?.relayUrl && record.relayUrl !== url) {
        throw new Error('Сначала отвяжите установку от прежнего сервера.');
      }
      invalidate();
      await mutate(async () => {
        teardown();
        await store.update(draft => { draft.relayUrl = url; });
      });
      background(connect);
      return state();
    },

    async setLabel(value) {
      const label = cleanLabel(value);
      invalidate();
      await mutate(() => store.update(draft => { draft.label = label; }));
      background(expected => {
        if (stage === 'ready' && connection) {
          revision += 1;
          connection.send(outgoing.event({ now: now(), epoch, revision, event: events.installation_updated({ label, appVersion, channel }) }));
        }
        return current(expected) ? undefined : undefined;
      });
      return state();
    },

    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Некорректное состояние подключения к серверу.');
      invalidate();
      if (!enabled) clearPairing();
      await mutate(async () => {
        if (!enabled) teardown();
        await store.update(draft => { draft.enabled = enabled; });
        if (!enabled) setPhase('disabled', null);
      });
      if (enabled) background(connect);
      return state();
    },

    /** `label` is what the owner typed in the pairing card; it defaults to the stored name. */
    async startPairing(label) {
      const record = store.snapshot();
      if (!record) throw new Error(store.failure);
      if (!store.encryptionAvailable) throw new Error('Шифрование недоступно в этой системе. Подключение к серверу сохранить нельзя.');
      if (!record.relayUrl) throw new Error('Сначала укажите адрес сервера.');
      if (!record.enabled) throw new Error('Сначала включите подключение к серверу.');
      if (store.credential) throw new Error('Установка уже связана. Сначала отвяжите её.');
      invalidate();
      clearPairing();
      teardown();
      background(expected => startPairing(expected, label));
      return state();
    },

    /** The owner saw the claimant's name; only now may the relay issue a credential. */
    async confirmPairing() {
      const session = pairing;
      if (!session?.claimant) throw new Error('Пока никто не запросил привязку.');
      if (session.confirmed) return state();
      session.confirmed = true;
      session.connection?.send(outgoing.pair_confirm({
        now: now(), pairingId: session.pairingId, nonce: session.nonce,
        claimantUserId: session.claimant.telegramUserId,
      }));
      emit();
      return state();
    },

    async cancelPairing() {
      const session = pairing;
      if (session) {
        session.connection?.send(outgoing.pair_cancel({ now: now(), pairingId: session.pairingId, reason: session.claimant ? 'declined' : 'local' }));
        session.connection?.close(CLOSE.normal, 'cancelled');
      }
      invalidate();
      clearPairing();
      setPhase(blockedReason()?.phase ?? 'connecting', null);
      background(connect);
      return state();
    },

    async unlink() {
      invalidate();
      const live = connection;
      clearPairing();
      // Tell the server, but never wait for it: local revocation must work with the relay down.
      if (stage === 'ready' && live) live.send(outgoing.unpair({ now: now(), reason: 'owner' }));
      teardown();
      await mutate(() => store.clearCredential());
      revision = 0; publishedTabs = []; publishedSignals = new Map(); pending.clear();
      setPhase(store.snapshot()?.enabled ? 'unconfigured' : 'disabled', null);
      return state();
    },

    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    local,

    /** Reads what was stored. Network work happens afterwards so startup is never held back. */
    async start() {
      started = true;
      await run(async () => {
        await store.load();
        const record = store.snapshot();
        if (!record) { setPhase('error', store.failure); return; }
        try { epoch = await store.nextEpoch(); }
        catch { setPhase('error', storageMessage); return; }
        const blocked = blockedReason();
        setPhase(blocked ? blocked.phase : 'connecting', blocked?.message ?? null);
      });
      unsubscribe ??= remote.subscribe(() => schedulePublish());
      background(connect);
    },

    /** Local permission changes are silent in the core's event stream, so main nudges us here. */
    refresh() { schedulePublish(); },

    /** Idempotent. Persisted settings, the credential and the grants are untouched. */
    async stop() {
      started = false;
      invalidate();
      const live = unsubscribe; unsubscribe = null;
      if (live) { try { live(); } catch { /* ignore */ } }
      await run(async () => {
        clearPairing();
        teardown({ code: CLOSE.normal, reason: 'shutdown' });
        setPhase(store.snapshot()?.enabled ? 'connecting' : 'disabled', null);
      });
      await store.flush();
    },

    _internals: { store, get connection() { return connection; }, get pairing() { return pairing; }, get epoch() { return epoch; }, get revision() { return revision; } },
  };
}
