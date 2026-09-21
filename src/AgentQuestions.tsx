import { useRef, useState } from 'react';
import { ArrowUp, Check, LoaderCircle } from 'lucide-react';
import Markdown from './Markdown';
import { questionAnswer, type AgentQuestion } from './agent-questions';
import './agent-questions.css';

export default function AgentQuestions({ questions, disabled, onAnswer }: {
  questions: AgentQuestion[]; disabled?: boolean; onAnswer(answer: string): Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const blocked = disabled || pending || sent;
  const change = (index: number, answer: string) => setAnswers(previous => questions.map((_, i) => i === index ? answer : previous[i] || ''));

  return <form className="agent-questions" aria-label="Ответ на вопросы агента" onSubmit={async event => {
    event.preventDefault();
    if (blocked || submitting.current || !questions.every((_, index) => answers[index]?.trim())) return;
    submitting.current = true; setPending(true); setError('');
    try {
      if (await onAnswer(questionAnswer(questions, answers))) setSent(true);
      else setError('Ответ не отправлен или ожидает подтверждения. Выбор сохранён.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setPending(false); }
  }}>
    {questions.map((question, index) => <fieldset key={index} disabled={blocked}>
      <legend><Markdown>{question.title}</Markdown></legend>
      <div className="agent-question-options">{question.options.map((option, optionIndex) => {
        const selected = !custom[index] && answers[index] === option;
        return <button type="button" className={`agent-question-option ${selected ? 'selected' : ''}`} aria-pressed={selected} key={optionIndex} onClick={() => { setCustom(previous => ({ ...previous, [index]: false })); change(index, option); }}>
          <span className="agent-question-check" aria-hidden="true">{selected && <Check size={12} />}</span><span>{option}</span>
        </button>;
      })}</div>
      <label className="agent-question-custom"><span>{question.options.length ? 'Или свой ответ' : 'Ваш ответ'}</span><textarea rows={1} aria-label={questions.length === 1 ? 'Свой ответ' : `Свой ответ: ${question.title}`} placeholder="Напишите ответ…" value={custom[index] || !question.options.length ? answers[index] || '' : ''} onChange={event => { setCustom(previous => ({ ...previous, [index]: true })); change(index, event.target.value); }} /></label>
    </fieldset>)}
    <div className="agent-question-actions"><span>{sent ? 'Ответ отправлен' : 'Выберите вариант или напишите свой'}</span><button type="submit" className="primary-button" disabled={blocked || !questions.every((_, index) => answers[index]?.trim())}>{pending ? <LoaderCircle className="spin" size={14} /> : sent ? <Check size={14} /> : <ArrowUp size={14} />}Отправить ответ</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}
