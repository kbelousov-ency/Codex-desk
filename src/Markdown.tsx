import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBridge } from './BridgeContext';

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

export default function Markdown({ children }: { children: string }) {
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
    pre: ({ children: content }) => <pre tabIndex={0}>{content}</pre>,
  }}>{children}</ReactMarkdown>{linkError && <div className="link-error" role="alert"><span>{linkError}</span><button type="button" aria-label="Скрыть ошибку открытия ссылки" onClick={() => setLinkError('')}>×</button></div>}</div>;
}
