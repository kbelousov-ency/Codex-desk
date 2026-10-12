import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export async function fixtureServer() {
  const root = resolve('dist'), mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
export const sampleSnapshot = (provider = 'codex') => ({
  available: true, provider, fetchedAt: '2026-10-12T09:00:00.000Z', overview: { email: 'fixture@example.test', last_24h: { credits: 9999, requests: 20 } },
  limits: [{ name: provider === 'claude' ? 'Claude' : 'Codex', key: 'fixture-secret-key-name', available: true, tier: 'TierA', state: 'ACTIVE', resetAt: '2026-10-19T03:00:00Z', limitCredits: 32000, usedCredits: 6400, remainingCredits: 25600, usedPercent: 20, left: 80, bands: [{ name: 'Fable', left: 60, resetAt: '2026-10-19T03:00:00Z', blocked: false }] }],
  spend: { session: { credits: 125.5, threadCount: 3 }, today: { credits: 345.67, since: '2026-10-11T21:00:00Z' } },
});
/** Production renderer, isolated bridge: no CLI, credential or model request. */
export async function installFixture(page, { provider = 'codex', connectionSource = 'router', routed = true, secondTab = false, snapshot = sampleSnapshot(provider) } = {}) {
  await page.addInitScript(({ provider, connectionSource, routed, secondTab, snapshot }) => {
    const cwd = 'C:/Fixtures/LIMITS', model = { id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Fixture' }] }, sessions = {};
    const make = id => {
      const thread = { id: (provider === 'claude' ? 'claude:' : '') + '11111111-1111-4111-8111-' + String(Object.keys(sessions).length + 1).padStart(12, '0'), name: 'Проверка лимитов', provider, cwd, historyMode: 'legacy', status: { type: 'idle' }, turns: [] };
      const state = { id, thread, calls: 0, usage: 0, current: structuredClone(snapshot), pending: null, defer: false, requests: [], listeners: new Set(), settings: { cwd, provider, connectionSource, model: model.id, effort: 'high', access: 'workspace-write' } };
      state.bridge = {
        async start() { return { initialize: {}, cwd, models: [model], executable: `C:/Fixtures/${provider}.exe`, account: null, provider, routerSource: routed, capabilities: { compact: true, steer: true, terminal: false, mcp: false, archive: true, usage: provider === 'claude' }, config: { model: model.id, model_reasoning_effort: 'high', ...(routed && provider === 'codex' ? { model_provider: 'router' } : {}) } }; },
        async getSettings() { return { ...state.settings }; }, async setSettings(patch) { Object.assign(state.settings, patch); },
        async getRouterUsage(options) { state.calls++; state.requests.push(options); const value = structuredClone(state.current); if (state.defer) { state.defer = false; return new Promise(resolve => { state.pending = () => { state.pending = null; resolve(value); }; }); } return value; },
        async request(method, params = {}) {
          if (method === 'thread/list') return { data: [], nextCursor: null };
          if (method === 'thread/resume' || method === 'thread/read') { if (params.threadId !== thread.id) throw new Error('Fixture received another thread ID'); return { thread: structuredClone(thread), model: model.id, reasoningEffort: 'high' }; }
          if (method === 'thread/start') return { thread: { id: (provider === 'claude' ? 'claude:' : '') + '11111111-1111-4111-8111-111111111111', cwd, turns: [] }, model: params.model };
          if (method === 'usage/read') { state.usage++; return { available: false, windows: [], message: 'Fixture: no personal plan' }; }
          throw new Error(`Unexpected fixture request ${method}`);
        },
        async respond() {}, onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
        async listFiles(path = '') { return { path, entries: [], nextCursor: null }; }, async chooseDirectory() { return cwd; }, async chooseExecutable() { return null; }, async openPath() {}, async showPathMenu() {}, async saveImages(images) { return images; }, async readAttachment() { return null; },
      }; sessions[id] = state; return state;
    };
    const first = make('limits-a'); if (secondTab) make('limits-b'); window.__limits = { sessions, first };
    window.codex = { ...first.bridge, async getWorkspace() { return { projects: [cwd], sessions: Object.values(sessions).map(({ id }) => ({ id, cwd, provider })), restore: { kind: 'workspace', activeIndex: 0, tabs: Object.values(sessions).map(({ id, thread, settings }) => ({ id, cwd, provider, thread, settings, draft: '', attachments: [] })) } }; }, async listProjectThreads() { return { data: [], nextCursor: null }; }, async createSession() { const state = make(`limits-${Object.keys(sessions).length}`); return { id: state.id, cwd, provider }; }, async closeSession() {}, forSession(id) { return sessions[id].bridge; } };
  }, { provider, connectionSource, routed, secondTab, snapshot });
}
export const activeView = page => page.locator('.session-view:visible');
export const limitsDialog = page => page.getByRole('dialog', { name: 'Лимиты', exact: true });
export async function ready(page) {
  await activeView(page).getByRole('combobox', { name: 'Модель', exact: true }).waitFor();
  await page.waitForFunction(() => { const model = document.querySelector('.session-view:not([hidden]) [role="combobox"][aria-label="Модель"]'); return model && !model.disabled; });
}
export async function updateSnapshot(page, snapshot) {
  await page.evaluate(value => { window.__limits.first.current = value; }, snapshot);
  const before = await page.evaluate(() => window.__limits.first.calls);
  await limitsDialog(page).getByRole('button', { name: 'Обновить лимиты', exact: true }).click();
  await page.waitForFunction(before => window.__limits.first.calls > before, before);
  await page.waitForFunction(() => !document.querySelector('.router-usage-popover button[aria-label="Обновить лимиты"]')?.disabled);
}
