import { useEffect, useRef } from 'react';

const FOREGROUND_REFRESH_THROTTLE_MS = 30_000;

/**
 * Refreshes market presentation after Cindy returns to the foreground.
 *
 * Electron can emit focus and visibilitychange as a pair. Claiming the throttle
 * window before dispatch and sharing one in-flight request keeps that pair, and
 * repeated foreground events during an outage, from creating request storms.
 */
export function usePluginMarketForegroundRefresh(
  refresh: () => void | Promise<void>,
  lastRefreshAtRef: { current: number },
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inFlightRef = useRef(false);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || inFlightRef.current) return;
      const now = Date.now();
      if (now - lastRefreshAtRef.current < FOREGROUND_REFRESH_THROTTLE_MS) return;

      lastRefreshAtRef.current = now;
      inFlightRef.current = true;
      void Promise.resolve()
        .then(() => refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [lastRefreshAtRef]);
}
