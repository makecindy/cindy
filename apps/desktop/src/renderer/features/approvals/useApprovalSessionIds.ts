import { useMemo, useSyncExternalStore } from 'react';
import { makerChatStore } from '@/lib/makerChatStore';

/** Status snapshot is cached by the store; stream text does not rerender the inbox. */
export function useApprovalSessionIds(): string[] {
  const statuses = useSyncExternalStore(
    makerChatStore.subscribeAll, makerChatStore.getRunningSnapshot, makerChatStore.getRunningSnapshot,
  );
  return useMemo(() => [...statuses].filter(([, value]) => value.hasPendingPermission).map(([id]) => id), [statuses]);
}
