import { useState } from 'react';
import type { Attachment, QueuedMessage } from './types';
import type { useMessageQueue } from './useMessageQueue';
import './message-queue.css';

function QueueEdit({ item, save, cancel }: { item: QueuedMessage; save(text: string, attachments: Attachment[]): void; cancel(): void }) {
  const [text, setText] = useState(item.text);
  const [attachments, setAttachments] = useState(item.attachments);
  return <div className="queue-edit">
    <textarea aria-label="Сообщение в очереди" value={text} rows={3} onChange={event => setText(event.target.value)} />
    {attachments.map((image, index) => <button type="button" key={index} onClick={() => setAttachments(current => current.filter((_, i) => i !== index))} aria-label={`Убрать из очереди ${image.name}`}>{image.name} ×</button>)}
    <div><button type="button" disabled={!text.trim() && !attachments.length} onClick={() => save(text, attachments)}>Сохранить сообщение</button><button type="button" onClick={cancel}>Отменить правку</button></div>
  </div>;
}

export default function MessageQueue({ queue, blocked }: { queue: ReturnType<typeof useMessageQueue>; blocked: boolean }) {
  if (!queue.state.items.length) return null;
  const uncertain = queue.state.items.some(item => item.state === 'uncertain');
  return <section className="message-queue" aria-label="Очередь сообщений">
    <div className="queue-header"><strong>Очередь · {queue.state.items.length}</strong><span>{queue.state.paused ? 'На паузе' : 'После завершения задачи'}</span>
      <button type="button" disabled={queue.state.paused && (blocked || uncertain || Boolean(queue.editing))} onClick={() => queue.state.paused ? queue.resume() : queue.pause()}>{queue.state.paused ? 'Продолжить очередь' : 'Пауза очереди'}</button>
    </div>
    {queue.state.reason && <p className="queue-reason" role="status">{queue.state.reason}</p>}
    <ol>{queue.state.items.map(item => <li key={item.id} data-queue-id={item.id}>
      {queue.editing === item.id ? <QueueEdit key={item.id} item={item} save={(text, images) => queue.edit(item.id, text, images)} cancel={() => queue.setEditing(null)} /> : <>
        <div className="queue-content"><p>{item.text || 'Изображения'}</p>{item.attachments.length > 0 && <small>{item.attachments.map(image => image.name).join(', ')}</small>}
          {item.state === 'uncertain' && <small className="queue-uncertain">{queue.inFlight === item.id ? 'Ожидаем подтверждения отправки…' : 'Отправка не подтверждена. Проверьте историю перед повтором.'}</small>}
        </div><div className="queue-item-actions"><button type="button" disabled={Boolean(queue.inFlight)} onClick={() => queue.setEditing(item.id)}>Изменить</button><button type="button" disabled={queue.inFlight === item.id} onClick={() => queue.remove(item.id)}>Удалить из очереди</button>{item.state === 'uncertain' && queue.inFlight !== item.id && <button type="button" onClick={() => queue.markWaiting(item.id)}>Проверено: повторить</button>}</div>
      </>}
    </li>)}</ol>
  </section>;
}
