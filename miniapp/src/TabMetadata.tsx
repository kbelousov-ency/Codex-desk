import type { TabSummary } from './types';

const activityFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' });

/** Per-tab activity comes from the bridge; it is independent of the installation heartbeat. */
export function TabMetadata({ queueLength, queuePaused, updatedAt }: Pick<TabSummary, 'queueLength' | 'queuePaused' | 'updatedAt'>) {
  const date = new Date(updatedAt);
  const validDate = Number.isFinite(date.getTime());
  return (
    <div className="tab-metadata">
      <span className="tab-queue">В очереди: {queueLength}</span>
      {queuePaused && <span className="tab-queue-paused">Очередь приостановлена</span>}
      {validDate
        ? <time className="tab-activity" dateTime={updatedAt}>Активность: {activityFormat.format(date)}</time>
        : <span className="tab-activity">Нет данных об активности вкладки</span>}
    </div>
  );
}
