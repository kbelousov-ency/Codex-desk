import { CodexClient } from './codex-client.mjs';
import { McpConfigManager } from './mcp-config.mjs';

/** Config requests use a private connection: raw config/parser diagnostics never
 * enter the chat, renderer diagnostic feed, or the user's model conversation. */
export class McpConfigService {
  constructor(session) {
    this.session = session;
    this.generation = session.generation;
    this.client = null;
    this.starting = null;
    this.disposed = false;
    this.manager = new McpConfigManager({ assertActive: () => this.check(), request: (method, params) => this.request(method, params) });
  }
  check() {
    if (this.disposed) throw new Error('Подключение изменилось. Откройте настройки MCP заново.');
    this.session.assertActive(this.generation);
  }
  async request(method, params) {
    this.check();
    if (!this.starting) this.starting = this.connect().catch(() => {
      this.client?.stop(); this.client = null; this.starting = null;
      throw new Error('Не удалось подключиться к конфигурации Codex.');
    });
    await this.starting;
    this.check();
    const result = await this.client.request(method, params);
    this.check();
    return result;
  }
  async connect() {
    const executable = this.session.executable || await this.session.resolveExecutable(this.session.getSettings().executable);
    this.check();
    let cwd;
    try { cwd = await this.session.resolveDirectory(this.session.currentCwd || this.session.fallbackCwd); }
    catch { cwd = await this.session.resolveDirectory(this.session.fallbackCwd); }
    this.check();
    this.client = new CodexClient({ executable, cwd, diagnostics: this.session.diagnostics,
      diagnosticContext: { ...this.session.diagnosticContext, projectId: this.session.diagnostics?.id(cwd) } });
    await this.client.start();
  }
  dispose() { this.disposed = true; this.manager.dispose(); this.client?.stop(); }
}
