import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { nextComposerPlaceholder, placeholderContext, type PlaceholderContext } from './composer-placeholders';

export function useComposerPlaceholder(sessionId: string, cwd: string, initialThreadId?: string) {
  const [placeholder, setPlaceholder] = useState('');
  const lifecycle = useRef<{ sessionId: string; cwd: string; threadId?: string } | null>(null);
  const selectPlaceholder = useCallback((context: PlaceholderContext) => {
    setPlaceholder(nextComposerPlaceholder(context));
  }, []);
  useLayoutEffect(() => {
    const previous = lifecycle.current;
    if (!previous || previous.sessionId !== sessionId || previous.threadId !== initialThreadId || (previous.cwd && cwd && previous.cwd !== cwd)) {
      selectPlaceholder(placeholderContext(initialThreadId));
    }
    lifecycle.current = { sessionId, cwd: cwd || previous?.cwd || '', threadId: initialThreadId };
  }, [sessionId, cwd, initialThreadId, selectPlaceholder]);
  return { placeholder, selectPlaceholder };
}
