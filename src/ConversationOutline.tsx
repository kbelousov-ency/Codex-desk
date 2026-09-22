import { useMemo, useState } from 'react';
import { Check, MessageSquare, Pencil, Search, X } from 'lucide-react';
import type { Item } from './types';
import './conversation-outline.css';

type Labels = Record<string, string>;
function readLabels(key: string): Labels {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([id, label]) => [id, label.slice(0, 160)]));
  } catch { return {}; }
}

export default function ConversationOutline({ items, storageKey, hasEarlier, loading, onLoadEarlier, onJump }: {
  items: Item[]; storageKey: string; hasEarlier: boolean; loading: boolean; onLoadEarlier(): void; onJump(itemId: string): void;
}) {
  const [labels, setLabels] = useState(() => readLabels(storageKey));
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const entries = useMemo(() => items.filter(item => item.type === 'userMessage' && !item.optimistic).map(item => ({
    id: item.id,
    text: (item.content || []).filter((part: any) => part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').trim() || 'Сообщение с вложением',
  })), [items]);
  const visible = entries.filter(entry => `${labels[entry.id] || ''}\n${entry.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const save = (id: string) => {
    const next = { ...labels };
    if (label.trim()) next[id] = label.trim(); else delete next[id];
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setLabels(next); setEditing(null); setError(''); }
    catch { setError('Не удалось сохранить подпись. Проверьте свободное место и повторите.'); }
  };
  return <section className="conversation-outline" aria-label="Оглавление диалога">
    <div className="outline-heading"><strong>Оглавление диалога</strong><span>{entries.length} запросов загружено</span></div>
    <label className="outline-search"><Search size={14} /><input aria-label="Найти запрос в оглавлении" placeholder="Найти запрос или подпись" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {hasEarlier && <button type="button" className="text-button" disabled={loading} onClick={onLoadEarlier}>{loading ? 'Загружаем…' : 'Загрузить предыдущие запросы'}</button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <ol className="outline-list">{visible.map(entry => <li key={entry.id}>
      {editing === entry.id ? <form className="outline-edit" onSubmit={event => { event.preventDefault(); save(entry.id); }}>
        <label>Подпись этапа<input autoFocus maxLength={160} aria-label="Подпись этапа" value={label} placeholder="Например: выбрали оформление" onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }} /></label>
        <div><button type="submit" className="text-button"><Check size={13} />Сохранить</button><button type="button" className="icon-button small" aria-label="Отменить подпись" onClick={() => setEditing(null)}><X size={13} /></button></div>
        <small>Пустая подпись возвращает текст запроса.</small>
      </form> : <><button type="button" className="outline-jump" onClick={() => onJump(entry.id)} data-tooltip={entry.text.slice(0, 1000)}><MessageSquare size={13} /><span>{labels[entry.id] && <strong>{labels[entry.id]}</strong>}<span>{entry.text.replace(/\s+/g, ' ').slice(0, 240)}</span></span></button><button type="button" className="icon-button small outline-rename" aria-label="Подписать этап" data-tooltip="Своя подпись для этого запроса" onClick={() => { setEditing(entry.id); setLabel(labels[entry.id] || ''); setError(''); }}><Pencil size={12} /></button></>}
    </li>)}</ol>
    {!visible.length && <p className="muted">{entries.length ? 'Совпадений нет.' : 'Здесь появятся ваши запросы.'}</p>}
  </section>;
}
