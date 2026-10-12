import { useState } from 'react';
import { Bot, Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBridge } from './BridgeContext';
import { copyText } from './clipboard';

function codeText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(codeText).join('');
  if (value?.props?.children !== undefined) return codeText(value.props.children);
  return '';
}

function CodeBlock({ children, onSendToExecutor }: { children: any; onSendToExecutor?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const text = codeText(children);
  const sendButton = onSendToExecutor && <button type="button" className="markdown-code-copy" aria-label="Отправить агенту" onClick={() => onSendToExecutor(text)}><Bot size={12} />Отправить агенту</button>;
  return <div className="markdown-code-block"><div className="markdown-code-header"><span>Код</span><span className="markdown-code-actions">{sendButton}<button type="button" className="markdown-code-copy" aria-label={copied ? 'Код скопирован' : 'Скопировать код'} onClick={() => { void copyText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <><Check size={12} />Скопировано</> : <><Copy size={12} />Копировать</>}</button></span></div><pre tabIndex={0}>{children}</pre></div>;
}

function linkKind(value: string): 'web' | 'file' | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return 'web';
  if (/^file:\/\//i.test(value)) return 'file';
  if (/^[\\/]{2}/.test(value)) return null;
  if (/^\/?[a-z]:[\\/]/i.test(value)) return 'file';
  const withoutLine = value.replace(/:\d+(?::\d+)?$/, '');
  const rootFileLocation = withoutLine !== value && /^[^:/\\]+\.[^:/\\]+$/.test(withoutLine);
  if ((/^[a-z][a-z\d+.-]*:/i.test(value) && !rootFileLocation) || value.startsWith('#')) return null;
  return 'file';
}

export default function Markdown({ children, onSendToExecutor }: { children: string; onSendToExecutor?: (text: string) => void }) {
  const bridge = useBridge();
  const [linkError, setLinkError] = useState('');
  const open = async (href: string, contextMenu = false) => {
    setLinkError('');
    try {
      if (contextMenu) await bridge.showPathMenu(href);
      else await bridge.openPath(href);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    }
  };
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'href' && linkKind(url.trim()) ? url.trim() : ''} components={{
    a: ({ href, children: label }) => {
      const kind = href ? linkKind(href) : null;
      if (!href || !kind) return <span>{label}</span>;
      return <a className="markdown-link" href={href} data-tooltip={href} onClick={event => {
        event.preventDefault(); void open(href);
      }} onContextMenu={event => {
        event.preventDefault(); void open(href, true);
      }} onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); void open(href, true);
        }
      }}>{label}</a>;
    },
    img: ({ alt }) => <span className="muted">[Изображение{alt ? `: ${alt}` : ''}]</span>,
    pre: ({ children: content }) => <CodeBlock onSendToExecutor={onSendToExecutor}>{content}</CodeBlock>,
  }}>{children}</ReactMarkdown>{linkError && <div className="link-error" role="alert"><span>{linkError}</span><button type="button" aria-label="Скрыть ошибку открытия ссылки" onClick={() => setLinkError('')}>×</button></div>}</div>;
}
