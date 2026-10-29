import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';

import {
  expireQueue, nextDeadline, syncQueue, type LiveRequest, type QueueEntry,
} from './queueModel';
import { useApprovalSessionIds } from './useApprovalSessionIds';

const FIELD = '\u0000';
const ROW = '\u0001';

/** (session, request) pairs the store currently holds, in the store's order. */
function useLiveRequests(): LiveRequest[] {
  const ids = useApprovalSessionIds();
  const idsKey = ids.join(ROW);
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribers = ids.map((id) => makerChatStore.subscribeLight(id, notify));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
    // The id list is the dependency; `ids` is re-derived from the same key.
  }, [idsKey]);
  const getSnapshot = () => ids
    .map((id) => id + FIELD + (makerChatStore.getLightSnapshot(id)?.pendingPermission?.requestId ?? ''))
    .join(ROW);
  const signature = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => signature.split(ROW).filter(Boolean).flatMap((pair) => {
    const [sessionId, requestId] = pair.split(FIELD);
    return requestId ? [{ sessionId, requestId }] : [];
  }), [signature]);
}

/**
 * Rows in the order THIS window first saw them. A request that leaves stays as a placeholder for a
 * few seconds (`held` freezes that while the pointer or focus is in the list), then collapses.
 */
export function useApprovalQueue(held: boolean): QueueEntry[] {
  const live = useLiveRequests();
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  // Derive during render (React's supported "adjust state on change" pattern) so a vanished request
  // is never rendered one frame as still pending.
  const synced = syncQueue(entries, live, Date.now());
  if (synced !== entries) setEntries(synced);

  useEffect(() => {
    if (held) return undefined;
    const deadline = nextDeadline(synced);
    if (deadline === null) return undefined;
    const timer = setTimeout(
      () => setEntries((current) => expireQueue(current, Date.now())),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [synced, held]);

  return synced;
}
