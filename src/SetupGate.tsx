import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import SetupWizard from './SetupWizard';

/** First launch waits before mounting chats; subsequent setup preserves mounted tabs and drafts. */
export default function SetupGate({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(Boolean(window.codex?.setup));
  const [initial, setInitial] = useState(false);
  const [open, setOpen] = useState(false);
  const read = useRef<Promise<{ show: boolean }> | null>(null);
  useEffect(() => {
    let current = true;
    if (window.codex?.setup) {
      read.current ??= window.codex.setup.state();
      void read.current.then(state => { if (current) { setInitial(state.show); setOpen(state.show); } }).catch(() => {}).finally(() => { if (current) setChecking(false); });
    }
    const reopen = () => { setInitial(false); setOpen(true); };
    window.addEventListener('codex-desk:open-setup', reopen);
    return () => { current = false; window.removeEventListener('codex-desk:open-setup', reopen); };
  }, []);
  if (checking) return <div className="workspace-empty" role="status"><LoaderCircle className="spin" size={24} /><p>Открываем Codex Desk…</p></div>;
  return <>{(!initial || !open) && children}{open && <SetupWizard initial={initial} onClose={() => { setOpen(false); setInitial(false); }} />}</>;
}
