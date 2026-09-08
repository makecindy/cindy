import { useEffect } from 'react';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';

/** Called by the route's ownership gate, never by URL-only navigation. */
export function useBotIslandVisibleSession(sessionId: string | null) {
  useEffect(() => {
    if (!isAgentIslandSupported()) return;
    const sync = () => {
      if (document.hasFocus()) {
        void window.electronAPI.agentIsland?.setVisibleSession?.(sessionId);
      }
    };
    sync();
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('focus', sync);
      void window.electronAPI.agentIsland?.setVisibleSession?.(null);
    };
  }, [sessionId]);
}
