import type { PluginIconMetadata } from '@cindy/plugin-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ICON_REFRESH_LEAD_MS = 30_000;
const ICON_REFRESH_MIN_DELAY_MS = 1_000;
const ICON_ERROR_RECOVERY_COOLDOWN_MS = 30_000;
const ICON_REFRESH_RETRY_DELAY_MS = 30_000;

type ExpiringPluginIcon = Pick<PluginIconMetadata, 'expiresAt'> | null | undefined;

/**
 * Finds the first time at which any visible signed icon should be renewed.
 * Invalid timestamps are ignored defensively; protocol parsing normally rejects them earlier.
 */
export function earliestPluginIconRefreshAtMs(icons: readonly ExpiringPluginIcon[]): number | null {
  let earliestRefreshAt = Number.POSITIVE_INFINITY;
  for (const icon of icons) {
    if (!icon) continue;
    const expiresAt = Date.parse(icon.expiresAt);
    if (!Number.isFinite(expiresAt)) continue;
    earliestRefreshAt = Math.min(earliestRefreshAt, expiresAt - ICON_REFRESH_LEAD_MS);
  }
  return Number.isFinite(earliestRefreshAt) ? earliestRefreshAt : null;
}

/**
 * Keeps short-lived market icon URLs renewed with one page-level timer.
 * The returned error handler shares the same in-flight request and applies a cooldown so a
 * missing OSS object cannot create a refresh loop when each response has a new signature.
 */
export function usePluginIconRefresh(
  icons: readonly ExpiringPluginIcon[],
  refresh: () => void | Promise<void>,
): () => void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastErrorRecoveryAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [retryAtMs, setRetryAtMs] = useState<number | null>(null);
  const refreshAtMs = useMemo(() => earliestPluginIconRefreshAtMs(icons), [icons]);

  const requestRefresh = useCallback(() => {
    if (inFlightRef.current) return;
    const request = Promise.resolve().then(() => refreshRef.current());
    inFlightRef.current = request;
    void request
      .then(
        () => setRetryAtMs(null),
        () => setRetryAtMs(Date.now() + ICON_REFRESH_RETRY_DELAY_MS),
      )
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
  }, []);

  useEffect(() => {
    if (refreshAtMs === null) return;
    const scheduledAtMs = retryAtMs ?? refreshAtMs;
    const delayMs = Math.max(ICON_REFRESH_MIN_DELAY_MS, scheduledAtMs - Date.now());
    const timer = window.setTimeout(requestRefresh, delayMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && scheduledAtMs <= Date.now()) {
        requestRefresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshAtMs, requestRefresh, retryAtMs]);

  return useCallback(() => {
    const now = Date.now();
    if (now - lastErrorRecoveryAtRef.current < ICON_ERROR_RECOVERY_COOLDOWN_MS) return;
    lastErrorRecoveryAtRef.current = now;
    requestRefresh();
  }, [requestRefresh]);
}
