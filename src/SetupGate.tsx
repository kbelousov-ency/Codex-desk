import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import SetupWizard from './SetupWizard';
import KuzmichSetupWizard from './KuzmichSetupWizard';
import { useProductNameGenitive } from './BuildInfo';

/** First launch waits before mounting chats; subsequent setup preserves mounted tabs and drafts. */
export default function SetupGate({ children }: { children: ReactNode }) {
  const productName = useProductNameGenitive();
  const [checking, setChecking] = useState(Boolean(window.codex?.setup));
  const [initial, setInitial] = useState(false);
  const [open, setOpen] = useState(false);
  // Experimental 3 gets the Kuzmich wizard; every other channel keeps the standard one.
  const [experimental3, setExperimental3] = useState(false);
  const read = useRef<Promise<{ show: boolean; experimental3?: boolean }> | null>(null);
  useEffect(() => {
    let current = true;
    if (window.codex?.setup) {
      read.current ??= window.codex.setup.state();
      void read.current.then(state => { if (current) { setInitial(state.show); setOpen(state.show); setExperimental3(Boolean(state.experimental3)); } }).catch(() => {}).finally(() => { if (current) setChecking(false); });
    }
    const reopen = () => { setInitial(false); setOpen(true); };
    window.addEventListener('codex-desk:open-setup', reopen);
    return () => { current = false; window.removeEventListener('codex-desk:open-setup', reopen); };
  }, []);
  if (checking) return <div className="workspace-empty" role="status"><LoaderCircle className="spin" size={24} /><p>Открываем {productName}…</p></div>;
  const Wizard = experimental3 ? KuzmichSetupWizard : SetupWizard;
  return <>{(!initial || !open) && children}{open && <Wizard initial={initial} onClose={() => { setOpen(false); setInitial(false); }} />}</>;
}
