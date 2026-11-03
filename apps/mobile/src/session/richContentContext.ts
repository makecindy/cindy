import { createContext, useContext, useEffect, useState } from 'react';
import type { RichContentRuntime } from './richContentRuntime';

export const RichContentContext = createContext<RichContentRuntime | null>(null);

/** Admission is sticky while visible: starting a drag must not blank a rendered block. */
export function useDeferredRichContent(active: boolean, identity: string, defer = true): boolean {
  const runtime = useContext(RichContentContext);
  const [admitted, setAdmitted] = useState<{ runtime: RichContentRuntime; identity: string } | null>(null);
  const ready = admitted?.runtime === runtime && admitted?.identity === identity;
  useEffect(() => {
    if (!active) { setAdmitted(null); return; }
    if (!runtime || !defer || ready) return;
    return runtime.request(() => setAdmitted({ runtime, identity }));
  }, [active, ready, defer, identity, runtime]);
  return active && (!runtime || !defer || ready);
}
