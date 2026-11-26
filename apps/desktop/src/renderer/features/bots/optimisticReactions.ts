/**
 * Desktop binding of the shared optimistic reaction store (`@cindy/maker-shared/optimistic-reactions`):
 * intents belong to the renderer's data owner, and timeline rows subscribe per message.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createOptimisticReactionStore, type ReactionCallbacks, type ReactionRequest } from '@cindy/maker-shared/optimistic-reactions';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';

const store = createOptimisticReactionStore({ current: getDataOwnerGeneration, isCurrent: isDataOwnerGenerationCurrent });

/** Shows `present` for the current actor at once and saves it; taps on the same emoji are sent in order. */
export function toggleReaction(request: ReactionRequest, groupId: string, messageId: string, emoji: string, present: boolean, callbacks: ReactionCallbacks) {
  store.toggle(request, groupId, messageId, emoji, present, callbacks);
}

/** The message with this actor's pending reactions applied; server copies that agree end them. */
export function useOptimisticReactions<T extends BotGroupMessageView>(groupId: string | undefined, message: T): T {
  const version = useSyncExternalStore(store.subscribe, () => (groupId ? store.version(groupId, message.id) : 0));
  useEffect(() => { if (groupId) store.reconcile(groupId, message); }, [groupId, message, version]);
  return useMemo(() => store.apply(groupId, message), [groupId, message, version]);
}

/** Test-only: forget every pending reaction. */
export function resetOptimisticReactionsForTest() { store.reset(); }
