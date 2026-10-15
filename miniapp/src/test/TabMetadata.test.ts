import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabMetadata } from '../TabMetadata';

describe('per-tab queue and activity', () => {
  it('renders the paused queue and bridge activity timestamp', () => {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(createElement(TabMetadata, {
      queueLength: 3, queuePaused: true, updatedAt: '2026-10-14T09:58:00.000Z'
    }));
    expect(root.textContent).toContain('В очереди: 3');
    expect(root.textContent).toContain('Очередь приостановлена');
    expect(root.querySelector('time')?.dateTime).toBe('2026-10-14T09:58:00.000Z');
  });

  it('shows a zero-length queue without inventing a paused state', () => {
    const html = renderToStaticMarkup(createElement(TabMetadata, {
      queueLength: 0, queuePaused: false, updatedAt: '2026-10-14T10:00:00.000Z'
    }));
    expect(html).toContain('В очереди: 0');
    expect(html).not.toContain('Очередь приостановлена');
  });

  it('does not present a malformed timestamp as current activity', () => {
    const html = renderToStaticMarkup(createElement(TabMetadata, { queueLength: 0, queuePaused: false, updatedAt: 'invalid' }));
    expect(html).toContain('Нет данных об активности вкладки');
    expect(html).not.toContain('<time');
  });
});
