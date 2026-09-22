import { useMemo, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';

type Option = { value: string; label: string };
type Field = {
  key: string; title: string; description?: string; required: boolean;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi' | 'unsupported';
  options?: Option[]; format?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  defaultValue?: unknown;
};

const INPUT_TYPES: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

/** Translates an MCP elicitation `requestedSchema` (MCP 2025-11-25 flat object of primitives) into renderable fields. */
export function elicitationFields(schema: any): Field[] | null {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key: unknown) => typeof key === 'string') : []);
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries<any>(schema.properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const base = { key, title: typeof raw.title === 'string' && raw.title ? raw.title : key, description: typeof raw.description === 'string' ? raw.description : undefined, required: required.has(key), defaultValue: raw.default };
    const titled = (list: any[]): Option[] => list.filter(item => item && typeof item.const === 'string').map(item => ({ value: item.const, label: typeof item.title === 'string' && item.title ? item.title : item.const }));
    const plain = (list: any[], names?: any[]): Option[] => list.filter(item => typeof item === 'string').map((value, index) => ({ value, label: Array.isArray(names) && typeof names[index] === 'string' ? names[index] : value }));
    if (raw.type === 'string' && Array.isArray(raw.enum)) fields.push({ ...base, kind: 'enum', options: plain(raw.enum, raw.enumNames) });
    else if (raw.type === 'string' && Array.isArray(raw.oneOf)) fields.push({ ...base, kind: 'enum', options: titled(raw.oneOf) });
    else if (raw.type === 'array' && raw.items && typeof raw.items === 'object') {
      const options = Array.isArray(raw.items.enum) ? plain(raw.items.enum) : Array.isArray(raw.items.anyOf) ? titled(raw.items.anyOf) : null;
      if (options) fields.push({ ...base, kind: 'multi', options, minItems: Number(raw.minItems) || undefined, maxItems: Number(raw.maxItems) || undefined });
      else fields.push({ ...base, kind: 'unsupported' });
    } else if (raw.type === 'string') fields.push({ ...base, kind: 'string', format: typeof raw.format === 'string' ? raw.format : undefined, minLength: raw.minLength, maxLength: raw.maxLength });
    else if (raw.type === 'number' || raw.type === 'integer') fields.push({ ...base, kind: raw.type, minimum: raw.minimum, maximum: raw.maximum });
    else if (raw.type === 'boolean') fields.push({ ...base, kind: 'boolean' });
    else fields.push({ ...base, kind: 'unsupported' });
  }
  return fields;
}

function initialValues(fields: Field[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'boolean') values[field.key] = typeof field.defaultValue === 'boolean' ? field.defaultValue : false;
    else if (field.kind === 'multi') values[field.key] = Array.isArray(field.defaultValue) ? field.defaultValue.filter(v => typeof v === 'string') : [];
    else if (field.defaultValue !== undefined && field.defaultValue !== null) values[field.key] = String(field.defaultValue);
    else values[field.key] = '';
  }
  return values;
}

/** Validates the current values and produces the `content` object for an accepted elicitation. */
export function elicitationContent(fields: Field[], values: Record<string, unknown>): { content?: Record<string, unknown>; errors: Record<string, string> } {
  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === 'unsupported') { if (field.required) errors[field.key] = 'Поле этого типа не поддерживается оболочкой.'; continue; }
    if (field.kind === 'boolean') { content[field.key] = Boolean(value); continue; }
    if (field.kind === 'multi') {
      const chosen = Array.isArray(value) ? value : [];
      if (field.required && !chosen.length) errors[field.key] = 'Выберите хотя бы одно значение.';
      else if (field.minItems && chosen.length < field.minItems) errors[field.key] = `Нужно не меньше ${field.minItems} значений.`;
      else if (field.maxItems && chosen.length > field.maxItems) errors[field.key] = `Не больше ${field.maxItems} значений.`;
      if (chosen.length || field.required) content[field.key] = chosen;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) { if (field.required) errors[field.key] = 'Обязательное поле.'; continue; }
    if (field.kind === 'number' || field.kind === 'integer') {
      const number = Number(text.replace(',', '.'));
      if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) { errors[field.key] = field.kind === 'integer' ? 'Введите целое число.' : 'Введите число.'; continue; }
      if (field.minimum !== undefined && number < field.minimum) { errors[field.key] = `Не меньше ${field.minimum}.`; continue; }
      if (field.maximum !== undefined && number > field.maximum) { errors[field.key] = `Не больше ${field.maximum}.`; continue; }
      content[field.key] = number; continue;
    }
    if (field.kind === 'enum' && !field.options?.some(option => option.value === text)) { errors[field.key] = 'Выберите значение из списка.'; continue; }
    if (field.minLength !== undefined && text.length < field.minLength) { errors[field.key] = `Не короче ${field.minLength} символов.`; continue; }
    if (field.maxLength !== undefined && text.length > field.maxLength) { errors[field.key] = `Не длиннее ${field.maxLength} символов.`; continue; }
    content[field.key] = text;
  }
  return { content: Object.keys(errors).length ? undefined : content, errors };
}

/** Form for `mcpServer/elicitation/request`. Accept sends the typed values; decline and cancel send no content. */
export default function ElicitationForm({ params, pending, onSubmit }: { params: any; pending: boolean; onSubmit(result: { action: 'accept' | 'decline' | 'cancel'; content: Record<string, unknown> | null; _meta: null }): void }) {
  const fields = useMemo(() => params.mode === 'url' ? null : elicitationFields(params.requestedSchema), [params]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields || []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: string, value: unknown) => { setValues(previous => ({ ...previous, [key]: value })); setErrors(previous => { const next = { ...previous }; delete next[key]; return next; }); };
  const decline = <button type="button" className="secondary-button" disabled={pending} onClick={() => onSubmit({ action: 'decline', content: null, _meta: null })}><X size={15} /> Отклонить</button>;
  const cancel = <button type="button" className="text-button" disabled={pending} onClick={() => onSubmit({ action: 'cancel', content: null, _meta: null })}>Отменить</button>;
  const server = typeof params.serverName === 'string' && params.serverName ? params.serverName : 'подключение';
  if (params.mode === 'url' && typeof params.url === 'string') {
    return <>
      <p>{params.message}</p>
      <p className="muted">Подключение <strong>{server}</strong> просит открыть ссылку и завершить действие в браузере. Оболочка не открывает её автоматически; скопируйте адрес и нажмите «Готово», когда закончите.</p>
      <pre className="approval-code elicitation-url">{params.url}</pre>
      <div className="approval-actions">{cancel}{decline}<button type="button" className="primary-button" disabled={pending} onClick={() => onSubmit({ action: 'accept', content: null, _meta: null })}>Готово <ArrowRight size={15} /></button></div>
    </>;
  }
  if (!fields) {
    return <>
      <p>{params.message}</p>
      <p className="muted">Подключение <strong>{server}</strong> запрашивает данные в формате, который оболочка пока не отображает.</p>
      {params.requestedSchema && <pre className="approval-code">{JSON.stringify(params.requestedSchema, null, 2).slice(0, 4000)}</pre>}
      <div className="approval-actions">{cancel}{decline}</div>
    </>;
  }
  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const result = elicitationContent(fields, values);
    setErrors(result.errors);
    if (result.content) onSubmit({ action: 'accept', content: result.content, _meta: null });
  };
  return <form className="elicitation-form" onSubmit={submit} aria-label={`Форма подключения ${server}`}>
    <p>{params.message}</p>
    <p className="muted">Данные запрашивает подключение <strong>{server}</strong>. Они будут переданы только ему после нажатия «Отправить».</p>
    {fields.map(field => {
      const id = `elicit-${field.key}`;
      const error = errors[field.key];
      const label = <span className="elicitation-label">{field.title}{field.required && <b aria-hidden="true"> *</b>}{field.description && <small>{field.description}</small>}</span>;
      if (field.kind === 'boolean') return <label key={field.key} className={`question-option ${values[field.key] ? 'selected' : ''}`}><input type="checkbox" checked={Boolean(values[field.key])} disabled={pending} onChange={event => set(field.key, event.target.checked)} />{label}</label>;
      if (field.kind === 'enum') return <fieldset key={field.key} className="elicitation-field" disabled={pending}><legend>{field.title}{field.required && <b aria-hidden="true"> *</b>}</legend>{field.description && <small className="muted">{field.description}</small>}
        {field.options?.map(option => <label key={option.value} className={`question-option ${values[field.key] === option.value ? 'selected' : ''}`}><input type="radio" name={id} value={option.value} checked={values[field.key] === option.value} onChange={() => set(field.key, option.value)} /><span><strong>{option.label}</strong></span></label>)}
        {error && <p className="inline-error">{error}</p>}</fieldset>;
      if (field.kind === 'multi') return <fieldset key={field.key} className="elicitation-field" disabled={pending}><legend>{field.title}{field.required && <b aria-hidden="true"> *</b>}</legend>{field.description && <small className="muted">{field.description}</small>}
        {field.options?.map(option => { const chosen = Array.isArray(values[field.key]) ? values[field.key] as string[] : []; const checked = chosen.includes(option.value); return <label key={option.value} className={`question-option ${checked ? 'selected' : ''}`}><input type="checkbox" checked={checked} onChange={() => set(field.key, checked ? chosen.filter(v => v !== option.value) : [...chosen, option.value])} /><span><strong>{option.label}</strong></span></label>; })}
        {error && <p className="inline-error">{error}</p>}</fieldset>;
      if (field.kind === 'unsupported') return <div key={field.key} className="elicitation-field"><label htmlFor={id}>{label}</label><p className="muted">Поле этого типа не поддерживается оболочкой{field.required ? '; заполнить форму нельзя' : ' и будет пропущено'}.</p></div>;
      const type = field.kind === 'string' ? INPUT_TYPES[field.format || ''] || 'text' : 'number';
      return <div key={field.key} className="elicitation-field"><label htmlFor={id}>{label}</label>
        <input id={id} className="text-input" type={type} inputMode={field.kind === 'string' ? undefined : 'decimal'} step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={String(values[field.key] ?? '')} disabled={pending} autoComplete="off" aria-invalid={error ? true : undefined} onChange={event => set(field.key, event.target.value)} />
        {error && <p className="inline-error">{error}</p>}</div>;
    })}
    <div className="approval-actions">{cancel}{decline}<button type="submit" className="primary-button" disabled={pending}>Отправить <ArrowRight size={15} /></button></div>
  </form>;
}
