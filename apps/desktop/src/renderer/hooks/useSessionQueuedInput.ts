/**
 * useSessionQueuedInput — reactive "does this session still have queued input?"
 * ---------------------------------------------------------------------------
 * A queued message is rendered with a「排队中」label on its bubble, but until the
 * agent consumes it the session has not done anything yet. Rendering the session
 * as idle makes the bubble and the session row contradict each other: the user
 * cannot tell whether the queued message will still run (#11299).
 *
 * Subscription source and cache semantics are the same as `useSessionPausedQueue`:
 * `subscribeAll` (not per-session `subscribe`) because `makerChatStore` is an LRU
 * cache — a purged session drops its per-session listeners, while the global
 * listener survives and re-reads the (now false) value. `hasQueuedInput` is a
 * NON-creating read, so querying it for every listed session never materializes
 * phantom state, and it returns a boolean primitive so React bails out of
 * re-rendering when the value did not change.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { makerChatStore } from '@/lib/makerChatStore';

/**
 * @returns `true` when `sessionId` still holds undispatched queued input that the
 *          user has not paused with Stop, `false` otherwise.
 */
export function useSessionQueuedInput(sessionId: string): boolean {
  const getSnapshot = useCallback(
    () => makerChatStore.hasQueuedInput(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(makerChatStore.subscribeAll, getSnapshot);
}
