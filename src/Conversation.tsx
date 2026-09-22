import { useAgentName } from './AgentContext';
import { Fragment, memo, useMemo, useState } from 'react';
import { Bookmark, Check, Copy, ImagePlus, Pencil, Terminal } from 'lucide-react';
import type { Item, TurnWork } from './types';
import Markdown from './Markdown';
import { folderName } from './useCodex';
import { conversationEntries } from './conversation-items';
import WorkLog from './WorkLog';
import PixelAvatar from './PixelAvatar';
import AgentQuestions from './AgentQuestions';
import { agentQuestions, canAnswerQuestion } from './agent-questions';
import QuoteSelection from './QuoteSelection';
import TaskResult, { type ResultActions } from './TaskResult';
import { taskResults } from './task-result';
import './work-log.css';
import './messenger.css';

type Props = ResultActions & { items: Item[]; turnWork: Record<string, TurnWork>; searchable?: boolean; onEditMessage?(item: Item): void; editDisabled?: boolean; onBookmark?(item: Item): Promise<void>; onAnswerQuestion?(item: Item, answer: string): Promise<boolean>; questionDisabled?: boolean; onQuote?(text: string): void; active?: boolean };

function Conversation({ items, turnWork, searchable = false, onEditMessage, editDisabled = false, onBookmark, onAnswerQuestion, questionDisabled, onQuote, active, onOpenResultFile, onReviewResult, onJumpToItem }: Props) {
  const entries = useMemo(() => conversationEntries(items), [items]);
  const results = useMemo(() => taskResults(items, turnWork), [items, turnWork]);
  return <QuoteSelection onQuote={onQuote} active={active}>{entries.map(entry => entry.type === 'message'
    ? <Fragment key={entry.key}><Message item={entry.item} onEdit={onEditMessage} editDisabled={editDisabled} onBookmark={onBookmark} onAnswerQuestion={canAnswerQuestion(items, entry.item) ? onAnswerQuestion : undefined} questionDisabled={questionDisabled} />{results.has(entry.item.id) && <TaskResult result={results.get(entry.item.id)!} onOpenResultFile={onOpenResultFile} onReviewResult={onReviewResult} onJumpToItem={onJumpToItem} />}</Fragment>
    : <WorkLog key={entry.key} turnId={entry.turnId} items={entry.items} turn={turnWork[entry.turnId]} hasAnswer={entry.hasAnswer} searchable={searchable} />)}</QuoteSelection>;
}

export default memo(Conversation);

function Message({ item, onEdit, editDisabled, onBookmark, onAnswerQuestion, questionDisabled }: { item: Item; onEdit?(item: Item): void; editDisabled?: boolean; onBookmark?(item: Item): Promise<void>; onAnswerQuestion?(item: Item, answer: string): Promise<boolean>; questionDisabled?: boolean }) {
  const engineName = useAgentName();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bookmarkError, setBookmarkError] = useState('');
  const user = item.type === 'userMessage';
  const questions = agentQuestions(item);
  const questionText = questions.map(question => `${question.title}\n\n${question.options.map(option => `- ${option}`).join('\n')}`).join('\n\n');
  const content = user ? (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : item.text || questionText;
  const images = user ? (item.previews?.length ? item.previews : (item.content || []).filter((part: any) => ['image', 'localImage'].includes(part.type)).map((part: any) => ({ name: part.path ? folderName(part.path) : 'Изображение', dataUrl: part.url?.startsWith('data:') ? part.url : undefined }))) : [];
  if (!user && !content) return null;
  return <article className={`message ${user ? 'user-message' : 'assistant-message'}`} data-item-id={item.id}>
    <div className="message-label"><span className={`message-avatar ${user ? 'user-avatar' : ''}`}>{user ? <PixelAvatar /> : <Terminal size={13} />}</span><strong>{user ? 'Вы' : engineName}</strong>{user && onEdit && <button type="button" className="edit-message-button" aria-label="Редактировать сообщение" data-tooltip="Изменить и отправить новым сообщением" disabled={editDisabled} onClick={() => onEdit(item)}><Pencil size={12} /><span>Редактировать</span></button>}{!user && content && <button className="icon-button copy-button" aria-label="Скопировать сообщение" data-tooltip="Скопировать сообщение" onClick={() => { void navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}</div>
    <div className="message-content">{images.length > 0 && <div className="message-images">{images.map((image: any, i: number) => image.dataUrl ? <img key={i} src={image.dataUrl} alt={image.name} /> : <span className="image-placeholder" key={i}><ImagePlus size={16} />{image.name}</span>)}</div>}{user ? <p className="user-text">{content}</p> : questions.length > 0 && onAnswerQuestion ? <>{item.text?.trim() && item.text.trim() !== questionText.trim() && <Markdown>{item.text}</Markdown>}<AgentQuestions key={JSON.stringify(questions)} questions={questions} disabled={questionDisabled} onAnswer={answer => onAnswerQuestion(item, answer)} /></> : <Markdown>{content}</Markdown>}</div>
    {onBookmark && content && !item.optimistic && <button type="button" className={`bookmark-message-button ${saved ? 'saved' : ''}`} aria-label={saved ? 'Закладка сохранена' : 'Сохранить закладку'} disabled={saving} onClick={() => { setSaving(true); setBookmarkError(''); void onBookmark(item).then(() => setSaved(true)).catch(cause => setBookmarkError(String(cause.message || cause))).finally(() => setSaving(false)); }}><Bookmark size={11} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Сохранено' : 'В закладки'}</button>}
    {bookmarkError && <p className="inline-error" role="alert">{bookmarkError}</p>}
  </article>;
}
