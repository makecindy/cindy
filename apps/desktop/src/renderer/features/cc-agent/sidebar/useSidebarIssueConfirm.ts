import { useCallback, useSyncExternalStore } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';

const subscribeNever = () => () => {};

export function useSidebarIssueConfirm(localSessionId: string | undefined): boolean {
  const getSnapshot = useCallback(
    () => localSessionId !== undefined && makerChatStore.hasPendingIssueConfirm(localSessionId),
    [localSessionId],
  );
  // The chat cache can purge per-session listeners. The global subscription
  // survives eviction and a boolean snapshot keeps unrelated updates inert.
  return useSyncExternalStore(
    localSessionId === undefined ? subscribeNever : makerChatStore.subscribeAll,
    getSnapshot,
  );
}
