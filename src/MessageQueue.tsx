import { useState } from 'react';
import { ListOrdered, Paperclip, Pause, Pencil, Play, RotateCcw, X } from 'lucide-react';
import type { Attachment, QueuedMessage } from './types';
import type { useMessageQueue } from './useMessageQueue';
import './message-queue.css';

function QueueEdit({ item, save, cancel }: { item: QueuedMessage; save(text: string, attachments: Attachment[]): void; cancel(): void }) {
  const [text, setText] = useState(item.text);
  const [attachments, setAttachments] = useState(item.attachments);
  return <div className="queue-edit">
    <textarea aria-label="Сообщение в очереди" value={text} rows={3} autoFocus onChange={event => setText(event.target.value)} />
    {attachments.length > 0 && <div className="queue-edit-files">{attachments.map((image, index) => <button type="button" key={index} onClick={() => setAttachments(current => current.filter((_, i) => i !== index))} aria-label={`Убрать из очереди ${image.name}`}><Paperclip size={11} />{image.name} ×</button>)}</div>}
    <div><button type="button" className="queue-text-button" disabled={!text.trim() && !attachments.length} onClick={() => save(text, attachments)}>Сохранить сообщение</button><button type="button" className="queue-text-button" onClick={cancel}>Отменить правку</button></div>
  </div>;
}

/** Compact strip docked to the top of the composer: one row per queued message, icon actions, pause as an icon. */
export default function MessageQueue({ queue, blocked }: { queue: ReturnType<typeof useMessageQueue>; blocked: boolean }) {
  if (!queue.state.items.length) return null;
  const uncertain = queue.state.items.some(item => item.state === 'uncertain');
  const paused = queue.state.paused;
  const status = paused ? 'На паузе' : 'После завершения задачи';
  const pauseDisabled = paused && (blocked || uncertain || Boolean(queue.editing));
  return <section className={`message-queue ${paused ? 'paused' : ''}`} aria-label="Очередь сообщений">
    <div className="queue-header" title={queue.state.reason || status}>
      <ListOrdered size={12} aria-hidden="true" />
      <strong>Очередь · {queue.state.items.length}</strong>
      <span className="queue-status">{status}</span>
      <button type="button" className="queue-icon-button" aria-label={paused ? 'Продолжить очередь' : 'Пауза очереди'} title={paused ? 'Продолжить очередь' : 'Пауза очереди'} disabled={pauseDisabled} onClick={() => paused ? queue.resume() : queue.pause()}>{paused ? <Play size={12} /> : <Pause size={12} />}</button>
    </div>
    {paused && queue.state.reason && <p className="queue-reason" role="status">{queue.state.reason}</p>}
    <ol>{queue.state.items.map((item, index) => <li key={item.id} data-queue-id={item.id} className={item.state === 'uncertain' ? 'uncertain' : ''}>
      {queue.editing === item.id ? <QueueEdit key={item.id} item={item} save={(text, images) => queue.edit(item.id, text, images)} cancel={() => queue.setEditing(null)} /> : <>
        <span className="queue-index" aria-hidden="true">{index + 1}</span>
        <div className="queue-content" title={item.text}>
          <p>{item.text || 'Изображения'}</p>
          {item.attachments.length > 0 && <small className="queue-files" title={item.attachments.map(image => image.name).join(', ')}><Paperclip size={10} />{item.attachments.length}</small>}
          {item.state === 'uncertain' && <small className="queue-uncertain">{queue.inFlight === item.id ? 'Ожидаем подтверждения отправки…' : 'Отправка не подтверждена. Проверьте историю перед повтором.'}</small>}
        </div>
        <div className="queue-item-actions">
          {item.state === 'uncertain' && queue.inFlight !== item.id && <button type="button" className="queue-text-button" onClick={() => queue.markWaiting(item.id)}><RotateCcw size={11} />Проверено: повторить</button>}
          <button type="button" className="queue-icon-button" aria-label="Изменить" title="Изменить сообщение" disabled={Boolean(queue.inFlight)} onClick={() => queue.setEditing(item.id)}><Pencil size={12} /></button>
          <button type="button" className="queue-icon-button" aria-label="Удалить из очереди" title="Удалить из очереди" disabled={queue.inFlight === item.id} onClick={() => queue.remove(item.id)}><X size={13} /></button>
        </div>
      </>}
    </li>)}</ol>
  </section>;
}
