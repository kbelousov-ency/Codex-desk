import { memo, useMemo, useState } from 'react';
import { Check, Copy, ImagePlus, Pencil, Terminal } from 'lucide-react';
import type { Item, TurnWork } from './types';
import Markdown from './Markdown';
import { folderName } from './useCodex';
import { conversationEntries } from './conversation-items';
import WorkLog from './WorkLog';
import PixelAvatar from './PixelAvatar';
import './work-log.css';
import './messenger.css';

function Conversation({ items, turnWork, searchable = false, onEditMessage, editDisabled = false }: { items: Item[]; turnWork: Record<string, TurnWork>; searchable?: boolean; onEditMessage?(item: Item): void; editDisabled?: boolean }) {
  const entries = useMemo(() => conversationEntries(items), [items]);
  return <>{entries.map(entry => entry.type === 'message'
    ? <Message key={entry.key} item={entry.item} onEdit={onEditMessage} editDisabled={editDisabled} />
    : <WorkLog key={entry.key} turnId={entry.turnId} items={entry.items} turn={turnWork[entry.turnId]} hasAnswer={entry.hasAnswer} searchable={searchable} />)}</>;
}

export default memo(Conversation);

function Message({ item, onEdit, editDisabled }: { item: Item; onEdit?(item: Item): void; editDisabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const user = item.type === 'userMessage';
  const content = user ? (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : item.text || '';
  const images = user ? (item.previews?.length ? item.previews : (item.content || []).filter((part: any) => ['image', 'localImage'].includes(part.type)).map((part: any) => ({ name: part.path ? folderName(part.path) : 'Изображение', dataUrl: part.url?.startsWith('data:') ? part.url : undefined }))) : [];
  if (!user && !content) return null;
  return <article className={`message ${user ? 'user-message' : 'assistant-message'}`} data-item-id={item.id}>
    <div className="message-label"><span className={`message-avatar ${user ? 'user-avatar' : ''}`}>{user ? <PixelAvatar /> : <Terminal size={13} />}</span><strong>{user ? 'Вы' : 'Codex'}</strong>{user && onEdit && <button type="button" className="edit-message-button" aria-label="Редактировать сообщение" title="Изменить и отправить новым сообщением" disabled={editDisabled} onClick={() => onEdit(item)}><Pencil size={12} /><span>Редактировать</span></button>}{!user && content && <button className="icon-button copy-button" aria-label="Скопировать сообщение" title="Скопировать сообщение" onClick={() => { void navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}</div>
    <div className="message-content">{images.length > 0 && <div className="message-images">{images.map((image: any, i: number) => image.dataUrl ? <img key={i} src={image.dataUrl} alt={image.name} /> : <span className="image-placeholder" key={i}><ImagePlus size={16} />{image.name}</span>)}</div>}{user ? <p className="user-text">{content}</p> : <Markdown>{content}</Markdown>}</div>
  </article>;
}
