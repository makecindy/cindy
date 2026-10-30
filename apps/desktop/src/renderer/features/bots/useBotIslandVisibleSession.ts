import { useEffect } from 'react';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';

/** Report only the exact task after metadata and history load, never a URL-only landing. */
export function useBotIslandVisibleSession(sessionId: string | null, enabled = true) {
  useEffect(() => {
    if (!enabled || !isAgentIslandSupported()) return;
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
  }, [sessionId, enabled]);
}
