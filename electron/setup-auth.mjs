import os from 'node:os';
import { findCodex, findClaude } from './host-utils.mjs';
import { CodexClient } from './codex-client.mjs';
import { readClaudeAuthStatus } from './claude-auth.mjs';
import { launchCodexAuthTerminal } from './terminal-launcher.mjs';

export function setupProvider(value) {
  if (!['codex', 'claude'].includes(value)) throw new Error('Неизвестный агент.');
  return value;
}

/** Public setup status only: no raw CLI output, config or credentials cross IPC. */
export class SetupAuth {
  constructor({ getSettings, getClaudeEnvironment, loginClaude, assertMutable, onCodexState = () => {},
    resolveCodex = findCodex, resolveClaude = findClaude, readClaude = readClaudeAuthStatus,
    createCodex = options => new CodexClient(options), launchCodex = launchCodexAuthTerminal, cwd = os.homedir() }) {
    Object.assign(this, { getSettings, getClaudeEnvironment, loginClaude, assertMutable, onCodexState,
      resolveCodex, resolveClaude, readClaude, createCodex, launchCodex, cwd });
    this.activeProvider = null;
    this.checking = new Map();
    this.disposed = false;
  }

  async status(provider) {
    setupProvider(provider);
    if (this.disposed) throw new Error('Приложение закрывается.');
    if (this.checking.has(provider)) return this.checking.get(provider);
    const pending = this._status(provider);
    this.checking.set(provider, pending);
    try { return await pending; }
    finally { if (this.checking.get(provider) === pending) this.checking.delete(provider); }
  }

  async _status(provider) {
    try {
      const settings = await this.getSettings(provider);
      if (provider === 'claude') {
        const executable = await this.resolveClaude(settings.executable);
        const auth = await this.readClaude({ executable, cwd: this.cwd, env: await this.getClaudeEnvironment() });
        return { state: auth.loggedIn ? 'signed-in' : 'signed-out', ...(auth.email ? { email: auth.email } : {}),
          ...(auth.authMethod === 'oauth_token' ? { message: 'Используется настроенный токен Claude.' } : {}) };
      }
      const executable = await this.resolveCodex(settings.executable);
      const client = this.createCodex({ executable, cwd: this.cwd, requestTimeoutMs: 15_000 });
      try {
        await client.start();
        const result = await client.request('account/read', { refreshToken: false });
        if (result?.account) return { state: 'signed-in' };
        if (result?.requiresOpenaiAuth === false) return { state: 'provider', message: 'Настроен провайдер Codex. Отдельный вход в ChatGPT не требуется.' };
        if (result?.requiresOpenaiAuth === true) return { state: 'signed-out' };
        return { state: 'unknown', message: 'Codex не сообщил состояние входа.' };
      } finally { client.stop(); }
    } catch {
      return { state: 'unknown', message: 'Не удалось проверить вход. Проверьте CLI и конфигурацию, затем повторите.' };
    }
  }

  async login(provider, record) {
    setupProvider(provider);
    if (this.disposed) throw new Error('Приложение закрывается.');
    if (this.checking.size) throw new Error('Дождитесь завершения проверки входа.');
    if (provider === 'claude') return this.loginClaude(record);
    if (this.activeProvider) throw new Error('Завершите вход в открытом окне авторизации.');
    this.assertMutable(provider);
    this.activeProvider = provider;
    try {
      const status = await this.status(provider);
      if (status.state === 'provider') throw new Error('Для настроенного провайдера вход в ChatGPT не требуется.');
      const settings = await this.getSettings(provider);
      const executable = await this.resolveCodex(settings.executable);
      if (this.disposed) throw new Error('Приложение закрывается.');
      this.assertMutable(provider);
      this.onCodexState({ state: 'opened' });
      const child = this.launchCodex({ executable, cwd: this.cwd, env: { ...process.env } });
      this.child = child;
      return await new Promise((resolve, reject) => {
        let spawned = false, ended = false;
        const finish = error => {
          if (ended) return;
          ended = true;
          this.activeProvider = null;
          this.child = null;
          if (!spawned) reject(new Error('Не удалось открыть окно авторизации Codex.'));
          if (!this.disposed) this.onCodexState({ state: 'closed', ...(error ? { error: 'Вход прерван. Проверьте авторизацию или повторите.' } : {}), message: 'Окно входа закрыто. Проверьте авторизацию.' });
        };
        child.once('error', () => finish(true));
        child.once('close', code => finish(Boolean(code)));
        child.once('spawn', () => { spawned = true; child.unref?.(); resolve({ started: true }); });
      });
    } catch (error) {
      this.activeProvider = null;
      this.onCodexState({ state: 'closed' });
      throw error;
    }
  }

  dispose() { this.disposed = true; /* The visible login window remains user-owned. */ }
}
