/**
 * Mobile binding of the shared optimistic reaction store (`@cindy/maker-shared/optimistic-reactions`):
 * intents belong to the signed-in account generation, and message rows subscribe per message.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createOptimisticReactionStore, type ReactableMessage, type ReactionCallbacks, type ReactionRequest } from '@cindy/maker-shared/optimistic-reactions';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';

const store = createOptimisticReactionStore({ current: getMobileAuthOwner, isCurrent: isMobileAuthOwnerCurrent });

/** Shows `present` for the current actor at once and saves it; taps on the same emoji are sent in order. */
export function toggleReaction(request: ReactionRequest, groupId: string, messageId: string, emoji: string, present: boolean, callbacks: ReactionCallbacks) {
  store.toggle(request, groupId, messageId, emoji, present, callbacks);
}

/** The message with this actor's pending reactions applied; server copies that agree end them. */
export function useOptimisticReactions<T extends ReactableMessage>(groupId: string | undefined, message: T): T {
  const version = useSyncExternalStore(store.subscribe, () => (groupId ? store.version(groupId, message.id) : 0));
  useEffect(() => { if (groupId) store.reconcile(groupId, message); }, [groupId, message, version]);
  return useMemo(() => store.apply(groupId, message), [groupId, message, version]);
}

/** Test-only: forget every pending reaction. */
export function resetOptimisticReactionsForTest() { store.reset(); }
