import { useEffect, useState } from 'react';

/** Fast remote reads should not flash a loader. */
export const REMOTE_LOADING_DELAY_MS = 250;

/** One loading signal follows remote content from the empty viewport into the
 * title. Cached messages stay readable until fresh content has actually arrived.
 * Connection banners take precedence; local tasks never show this indicator. */
export function useRemoteSessionLoading({
  sessionId,
  remoteDeviceId,
  historyLoaded,
  contentSyncing,
  hasMessages,
  connectionNotice,
  hasTaskHeader,
}: {
  sessionId: string | undefined;
  remoteDeviceId: string | undefined;
  historyLoaded: boolean;
  contentSyncing: boolean;
  hasMessages: boolean;
  connectionNotice: boolean;
  hasTaskHeader: boolean;
}): 'hidden' | 'loading' | 'syncing' | 'inline-syncing' {
  const active =
    !!sessionId && !!remoteDeviceId && !connectionNotice && (!historyLoaded || contentSyncing);
  const [revealed, setRevealed] = useState<{ sessionId: string; deviceId: string } | null>(null);

  useEffect(() => {
    setRevealed(null);
    if (!active || !sessionId || !remoteDeviceId) return;
    const timer = setTimeout(() => {
      setRevealed({ sessionId, deviceId: remoteDeviceId });
    }, REMOTE_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, sessionId, remoteDeviceId]);

  // Cold-cache hydration also retains historyLoaded=false; it is not evidence
  // of stale content and must not bypass the ordinary anti-flash delay.
  const delayElapsed = revealed?.sessionId === sessionId && revealed?.deviceId === remoteDeviceId;
  if (!active || !delayElapsed) return 'hidden';
  if (!hasMessages) return 'loading';
  return hasTaskHeader ? 'syncing' : 'inline-syncing';
}
