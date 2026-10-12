import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { BoatswainClient } from './boatswain-client.mjs';

function homeDirectory(env = process.env) { return env.USERPROFILE || os.homedir(); }
function boatswainDirectory(env = process.env) { return path.join(env.LOCALAPPDATA || path.join(homeDirectory(env), 'AppData', 'Local'), 'Boatswain'); }
function settingsPath(env = process.env) { return path.join(boatswainDirectory(env), 'boatswain.json'); }
function claudeSettingsPath(env = process.env) { return path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDirectory(env), '.claude'), 'settings.json'); }

/**
 * Read-only status of the existing Boatswain installation and CLI connections.
 */
export class BoatswainSetupService {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, client } = {}) {
    this.env = env;
    this.client = client;
    this.fetchImpl = fetchImpl;
  }

  async _settings() {
    try {
      const value = JSON.parse(await readFile(settingsPath(this.env), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.portal !== 'string' || typeof value.key !== 'string'
        || !value.portal.trim() || !value.key.trim() || /[\r\n\0]/.test(value.portal) || /[\r\n\0]/.test(value.key)) return null;
      return { portal: value.portal.replace(/\/+$/, ''), key: value.key, machine: typeof value.machine === 'string' && value.machine.trim() ? value.machine : os.hostname() };
    } catch { return null; }
  }

  async _online(settings) {
    if (!settings) return false;
    try {
      let portalOrigin;
      try {
        const url = new URL(settings.portal);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') portalOrigin = url.origin;
      } catch {}
      const client = this.client || new BoatswainClient({ fetchImpl: this.fetchImpl, portalOrigin });
      const rows = await client.machines(settings.key);
      return Array.isArray(rows) && rows.some(row => row && row.machine === settings.machine);
    } catch { return false; }
  }

  async _configuredProducts() {
    const result = [];
    try {
      const codexHome = this.env.CODEX_HOME || path.join(homeDirectory(this.env), '.codex');
      const parsed = TOML.parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8'));
      if (parsed?.model_provider === 'router' && parsed?.model_providers?.router?.experimental_bearer_token) result.push('codex');
    } catch { /* Codex is optional. */ }
    try {
      const parsed = JSON.parse(await readFile(claudeSettingsPath(this.env), 'utf8'));
      const env = parsed?.env;
      if (env?.ANTHROPIC_BASE_URL && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) result.push('claude');
    } catch { /* Claude is optional. */ }
    return result;
  }

  async readClaudeConnection() {
    try {
      const parsed = JSON.parse(await readFile(claudeSettingsPath(this.env), 'utf8'));
      const env = parsed?.env;
      if (typeof env?.ANTHROPIC_BASE_URL !== 'string' || typeof env?.ANTHROPIC_AUTH_TOKEN !== 'string'
        || !env.ANTHROPIC_BASE_URL.trim() || !env.ANTHROPIC_AUTH_TOKEN.trim()) return null;
      const url = new URL(env.ANTHROPIC_BASE_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
      // Carry the model slots across too, so a tab offers the same models as the terminal CLI.
      const modelAliases = {}; const modelNames = {};
      for (const family of ['opus', 'fable', 'sonnet', 'haiku']) {
        const slot = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
        if (typeof env[slot] === 'string' && env[slot]) modelAliases[family] = env[slot];
        if (typeof env[`${slot}_NAME`] === 'string' && env[`${slot}_NAME`]) modelNames[family] = env[`${slot}_NAME`];
      }
      return { apiKey: env.ANTHROPIC_AUTH_TOKEN, baseUrl: url.href.replace(/\/$/, ''), authScheme: 'bearer', providerName: 'Router',
        ...(Object.keys(modelAliases).length ? { modelAliases } : {}), ...(Object.keys(modelNames).length ? { modelNames } : {}) };
    } catch { return null; }
  }

  async status() {
    const settings = await this._settings();
    return {
      installed: Boolean(settings), online: await this._online(settings),
      configuredProducts: await this._configuredProducts(),
      machine: settings?.machine,
      portal: settings?.portal,
    };
  }
}

export { boatswainDirectory, settingsPath };
