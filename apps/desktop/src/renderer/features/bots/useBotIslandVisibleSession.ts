import { useEffect } from 'react';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';

/** Called by the route's ownership gate, never by URL-only navigation. */
export function useBotIslandVisibleSession(sessionId: string | null) {
  useEffect(() => {
    if (!isAgentIslandSupported()) return;
    const sync = () => {
      // Main accepts only a focused window or its pending notification target.
      // A DOM focus check here can drop that ack before focus has settled.
      void window.electronAPI.agentIsland?.setVisibleSession?.(sessionId);
    };
    sync();
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('focus', sync);
      void window.electronAPI.agentIsland?.setVisibleSession?.(null);
    };
  }, [sessionId]);
}
