import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { launchClaudeAuthTerminal, launchClaudeSetupTokenTerminal } from './terminal-launcher.mjs';
import { claudeConnectionProfile, createClaudeSettingsFile } from './connection-source.mjs';

const execFileAsync = promisify(execFile);
const loginBusy = 'Дождитесь завершения входа в Claude Code в открытом терминале.';
const statusFailed = 'Не удалось проверить авторизацию через Claude Code CLI. Проверьте установленный claude.exe и повторите.';

/** Only documented public account fields may leave the auth command. Never forward stderr/errors. */
export function publicClaudeAuthStatus(stdout, secrets = []) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error(statusFailed); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.loggedIn !== 'boolean') throw new Error(statusFailed);
  const result = { loggedIn: value.loggedIn };
  for (const key of ['authMethod', 'email', 'subscriptionType', 'apiProvider']) {
    if (typeof value[key] === 'string' && value[key].length <= 320 && !/[\x00-\x1f\x7f]/.test(value[key])
      && !secrets.some(secret => secret && value[key].includes(secret))) result[key] = value[key];
  }
  return result;
}

export async function readClaudeAuthStatus({ executable, cwd, env = process.env, settingsOverrides, settingsFile }, run = execFileAsync) {
  let ownedFile;
  const secrets = Object.entries(env).filter(([key]) => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|REFRESH_TOKEN)$/i.test(key)).map(([, value]) => value).filter(value => typeof value === 'string' && value);
  try {
    if (settingsOverrides) ownedFile = await createClaudeSettingsFile(settingsOverrides);
    const filename = ownedFile?.path || settingsFile;
    if (filename !== undefined && (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\r\n\0]/.test(filename))) throw new Error(statusFailed);
    const args = [...(filename ? ['--settings', filename] : []), 'auth', 'status'];
    let stdout;
    try {
      ({ stdout } = await run(executable, args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      // Exit 1 can mean a valid signed-out status. Raw errors may contain credentials.
      if (error.code !== 1 || error.killed || error.signal) throw new Error(statusFailed);
      const signedOut = publicClaudeAuthStatus(error.stdout, secrets);
      if (signedOut.loggedIn) throw new Error(statusFailed);
      return signedOut;
    }
    return publicClaudeAuthStatus(stdout, secrets);
  } catch { throw new Error(statusFailed); }
  finally {
    if (ownedFile) await ownedFile.cleanup().catch(() => {});
  }
}

/** App-wide reservation: no owned Claude process may refresh old credentials during login. */
export class ClaudeAuthService {
  constructor({ getSessions = () => [], readStatus = readClaudeAuthStatus, launchTerminal = launchClaudeAuthTerminal, launchSetupToken = launchClaudeSetupTokenTerminal,
    getEnvironment = () => ({ ...process.env }), getLoginEnvironment = getEnvironment, assertAvailable = () => {} } = {}) {
    // Status sees the same environment as Claude tabs, including a host-managed token. The browser login and
    // setup-token consoles get the plain environment so the CLI performs a real sign-in instead of reporting the token.
    Object.assign(this, { getSessions, readStatus, launchTerminal, launchSetupToken, getEnvironment, getLoginEnvironment, assertAvailable });
    this.active = null;
    this.disposed = false;
    // Timed-out stops must remain owned across reconnects and subsequent login attempts.
    this.stoppingClients = new Set();
  }

  assertClaude(session) {
    if (this.disposed) throw new Error('Приложение закрывается.');
    session.assertActive();
    if (session.settings.provider !== 'claude') throw new Error('Авторизация доступна в настройках Claude Code.');
  }

  assertLocalControl(session) {
    if (!this.active || session.settings.provider !== 'claude' || session.settings.connectionSource === 'router') return;
    this.active.sessions.add(session);
    // A tab created while login is already open may have missed the original event.
    // Re-deliver before rejecting its bootstrap, so its renderer can wait for closed.
    session.send('auth', { state: 'opened' });
    throw new Error(loginBusy);
  }

  async context(session, { login = false } = {}) {
    this.assertClaude(session);
    const settings = session.getSettings();
    const cwd = await session.resolveDirectory(session.currentCwd || settings.cwd || session.fallbackCwd);
    const executable = await session.resolveClaudeExecutable(settings.executable);
    this.assertClaude(session);
    const profile = claudeConnectionProfile(await (login ? this.getLoginEnvironment(settings) : this.getEnvironment(settings)));
    const env = profile.env || { ...process.env };
    // A native sign-in must use its own flow, not a saved application or shell OAuth token.
    if (login) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[key];
      if (profile.settingsOverrides) {
        profile.settingsOverrides = { ...profile.settingsOverrides, env: { ...profile.settingsOverrides.env, CLAUDE_CODE_OAUTH_TOKEN: '' } };
        env.CLAUDE_CODE_OAUTH_TOKEN = '';
      }
    }
    const configDirectory = path.resolve(cwd, env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    return { executable, cwd, env, configDirectory, ...(profile.settingsOverrides ? { settingsOverrides: profile.settingsOverrides } : {}), ...(profile.settingsFile ? { settingsFile: profile.settingsFile } : {}) };
  }

  /** Visible `claude setup-token` console. Nothing is stopped: the command only prints a token for the user to copy. */
  async setupToken(session) {
    this.assertClaude(session);
    if (session.settings.connectionSource === 'router') throw new Error('Для входа в личный Claude выберите источник «Аккаунт» в диалоге.');
    this.assertAvailable();
    if (this.active) throw new Error(loginBusy);
    const context = await this.context(session, { login: true });
    let child;
    try { const launched = this.launchSetupToken(context); child = launched?.then ? await launched : launched; }
    catch { throw new Error('Не удалось открыть терминал Claude Code.'); }
    return await new Promise((resolve, reject) => {
      let settled = false;
      child.once('error', () => { if (!settled) { settled = true; reject(new Error('Не удалось открыть терминал Claude Code.')); } });
      child.once('close', () => { if (!settled) { settled = true; reject(new Error('Терминал Claude Code закрылся до запуска.')); } });
      child.once('spawn', () => { child.unref?.(); if (!settled) { settled = true; resolve({ started: true }); } });
    });
  }

  async status(session) {
    const context = await this.context(session);
    const result = await this.readStatus(context);
    this.assertClaude(session);
    return { ...result, configDirectory: context.configDirectory, loginInProgress: Boolean(this.active) && session.settings.connectionSource !== 'router' };
  }

  sessions() {
    return [...this.getSessions()].filter(session => !session.disposed && session.settings.provider === 'claude' && session.settings.connectionSource !== 'router');
  }

  async login(session) {
    this.assertClaude(session);
    if (session.settings.connectionSource === 'router') throw new Error('Для входа в личный Claude выберите источник «Аккаунт» в диалоге.');
    this.assertAvailable();
    if (this.active) throw new Error(loginBusy);
    const sessions = new Set([...this.sessions(), session]);
    for (const owned of sessions) {
      if (owned.terminal || owned.pendingBoots || owned.pendingMutations || owned.requests.size || owned.activeThreadTurns.size || owned.compactingThreads.size || owned.mcpRefreshing) {
        throw new Error('Дождитесь завершения задач и подтверждений во всех вкладках Claude Code и закройте их терминалы.');
      }
    }
    const reservation = { sessions, child: null, finished: false, context: null, reject: null };
    // Reserve synchronously, before resolving paths or stopping any transport.
    this.active = reservation;
    try {
      for (const owned of sessions) owned.send('auth', { state: 'opened' });
      for (const owned of sessions) {
        const client = owned.client;
        if (client?.stopAndWait) this.stoppingClients.add(client);
        owned.stop();
      }
      const stops = [...this.stoppingClients].map(async client => {
        await client.stopAndWait();
        this.stoppingClients.delete(client);
      });
      // Even when one stop or path lookup fails, await every owned process before
      // releasing the reservation and asking renderers to reconnect.
      const settled = await Promise.allSettled([this.context(session, { login: true }), ...stops]);
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const context = settled[0].value;
      reservation.context = context;
      if (this.disposed || this.active !== reservation) throw new Error('Приложение закрывается.');
      this.assertClaude(session);
      let child;
      try { const launched = this.launchTerminal(context); child = launched?.then ? await launched : launched; }
      catch { throw new Error('Не удалось открыть терминал авторизации Claude Code.'); }
      reservation.child = child;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const fail = error => { if (!settled) { settled = true; reject(error); } };
        reservation.reject = fail;
        child.once('error', () => {
          const error = new Error('Не удалось открыть терминал авторизации Claude Code.');
          fail(error);
          void this.finish(reservation, error.message);
        });
        child.once('close', (code, signal) => {
          const error = code || signal ? 'Терминал авторизации Claude Code завершился с ошибкой. Повторите вход.' : undefined;
          fail(new Error(error || 'Терминал авторизации закрылся до запуска.'));
          void this.finish(reservation, error);
        });
        child.once('spawn', () => {
          child.unref?.();
          if (settled) return;
          if (this.disposed || this.active !== reservation) { fail(new Error('Приложение закрывается.')); return; }
          settled = true;
          resolve({ started: true });
        });
      });
    } catch (error) {
      if (!reservation.child) await this.finish(reservation, error.message);
      throw error;
    }
  }

  async finish(reservation, error) {
    if (reservation.finished || this.active !== reservation) return;
    reservation.finished = true;
    let loggedIn;
    if (reservation.context && !this.disposed) {
      try { loggedIn = (await this.readStatus(reservation.context)).loggedIn; }
      catch { error ||= statusFailed; }
    }
    if (this.active !== reservation) return;
    this.active = null;
    if (this.disposed) return;
    for (const session of new Set([...reservation.sessions, ...this.sessions()])) {
      if (!session.disposed && session.settings.connectionSource !== 'router') session.send('auth', { state: 'closed', ...(loggedIn === undefined ? {} : { loggedIn }), ...(error ? { error } : {}) });
    }
  }

  dispose() {
    this.disposed = true;
    // An interactive login belongs to the user once launched; quitting never kills it.
    this.active?.child?.unref?.();
    this.active?.reject?.(new Error('Приложение закрывается.'));
    this.active = null;
  }
}
