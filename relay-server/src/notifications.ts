import type { CommandRow } from './commands.ts';
import type { NotificationSettings, Store } from './store.ts';

export type NoticeKind = 'turn_completed' | 'action_required';
export interface NoticeEvent { tabId: string; noticeKind: NoticeKind; turnId?: string; occurredAt: string; dedupKey?: string }
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Server-only Telegram Bot API delivery. Message bodies are deliberately assembled from metadata only. */
export class NotificationService {
  private readonly store: Store;
  private readonly token: string;
  private readonly sendFetch: FetchLike;
  private readonly enabled: boolean;
  private readonly pending = new Set<string>();
  private readonly offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offlineNotified = new Map<string, number>();
  private readonly presenceGeneration = new Map<string, number>();
  private readonly retryUntil = new Map<string, number>();
  private closed = false;
  constructor(store: Store, token: string, fetchImpl: FetchLike = fetch, enabled = true) {
    this.store = store; this.token = token; this.sendFetch = fetchImpl; this.enabled = enabled;
  }
  settings(user: string): NotificationSettings { return this.store.notificationSettings(user); }
  updateSettings(user: string, value: Partial<NotificationSettings>): NotificationSettings {
    return this.store.updateNotificationSettings(user, value);
  }
  notice(installationId: string, event: NoticeEvent, frameKey?: string): void {
    if (this.closed) return;
    if (event.noticeKind !== 'turn_completed' && event.noticeKind !== 'action_required') return;
    let installation;
    try { installation = this.store.installation(installationId); } catch { return; }
    const tab = this.store.tabs(installationId).find(item => item.tab_id === event.tabId);
    if (!tab) return;
    const settings = this.settings(installation.telegram_id);
    if (!(event.noticeKind === 'turn_completed' ? settings.turnCompleted : settings.actionRequired)) return;
    // Bridge frame IDs are transport IDs and can change on replay; event identity is the payload identity.
    const key = `notice:${installationId}:${event.noticeKind}:${event.tabId}:${event.turnId ?? ''}:${event.occurredAt}`;
    const text = event.noticeKind === 'turn_completed'
      ? `Задача завершена: «${installation.label}» — «${tab.title}».`
      : `Требуется действие на компьютере: «${installation.label}» — «${tab.title}».`;
    void this.deliver(installation.telegram_id, key, text);
  }
  command(row: CommandRow): void {
    if (this.closed) return;
    if (!row.status || (row.status !== 'rejected' && row.status !== 'uncertain' && !(row.status === 'executed' && row.outcome === 'failed'))) return;
    let installation;
    try { installation = this.store.installation(row.installation_id); } catch { return; }
    if (!this.settings(row.telegram_id).commandFailed) return;
    const tab = this.store.tabs(row.installation_id).find(item => item.tab_id === row.tab_id);
    if (!tab) return;
    const uncertain = row.status === 'uncertain';
    const text = uncertain
      ? `Требуется проверка на компьютере: «${installation.label}» — «${tab.title}».`
      : `Команда не выполнена: «${installation.label}» — «${tab.title}».`;
    void this.deliver(row.telegram_id, `command:${row.installation_id}:${row.command_id}:${row.status}:${row.outcome ?? ''}`, text);
  }
  disconnected(installationId: string): void {
    if (this.closed) return;
    if (this.offlineTimers.has(installationId)) return;
    const generation = (this.presenceGeneration.get(installationId) ?? 0) + 1;
    this.presenceGeneration.set(installationId, generation);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(installationId);
      if (this.store.installationOnline(installationId)) return;
      let installation;
      try { installation = this.store.installation(installationId); } catch { return; }
      if (!this.settings(installation.telegram_id).presence) return;
      this.offlineNotified.set(installationId, generation);
      void this.deliver(installation.telegram_id, `presence:${installationId}:offline:${generation}`, `Кузьмич отключился: «${installation.label}».`);
    }, 60_000);
    timer.unref(); this.offlineTimers.set(installationId, timer);
  }
  connected(installationId: string): void {
    if (this.closed) return;
    const timer = this.offlineTimers.get(installationId); if (timer) clearTimeout(timer);
    this.offlineTimers.delete(installationId);
    const generation = this.offlineNotified.get(installationId);
    if (generation === undefined) return;
    this.offlineNotified.delete(installationId);
    let installation;
    try { installation = this.store.installation(installationId); } catch { return; }
    if (this.settings(installation.telegram_id).presence) void this.deliver(installation.telegram_id, `presence:${installationId}:online:${generation}`, `Кузьмич снова на связи: «${installation.label}».`);
  }
  close(): void { this.closed = true; for (const timer of this.offlineTimers.values()) clearTimeout(timer); this.offlineTimers.clear(); this.offlineNotified.clear(); this.presenceGeneration.clear(); }
  private async deliver(user: string, key: string, text: string): Promise<void> {
    if (this.closed) return;
    if (!this.enabled || !this.token || this.pending.has(key) || this.store.notificationClaimed(user, key)) return;
    this.pending.add(key);
    let retryScheduled = false;
    try {
      const waitUntil = this.retryUntil.get(user) ?? 0;
      if (waitUntil > Date.now()) await new Promise<void>(resolve => setTimeout(resolve, waitUntil - Date.now()));
      const response = await this.sendFetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: user, text, disable_web_page_preview: true })
      });
      if (response.status === 429) {
        let retry = 1; try { const body = await response.json() as { parameters?: { retry_after?: number } }; retry = Math.max(1, Number(body.parameters?.retry_after) || 1); } catch { /* default */ }
        this.retryUntil.set(user, Date.now() + retry * 1000);
        retryScheduled = true;
        setTimeout(() => { this.pending.delete(key); void this.deliver(user, key, text); }, retry * 1000).unref(); return;
      }
      if (!response.ok) return;
      this.store.claimNotification(user, key);
    } catch { /* Bot API outages never affect relay or bridge delivery. */ }
    finally { if (!retryScheduled) this.pending.delete(key); }
  }
}
