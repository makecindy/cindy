/**
 * Last-turn filter for git review.
 *
 * Agent messages are no longer the diff source; they only provide a set of
 * repo-relative paths touched after the latest user turn.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { collectLastTurnPaths } from '../../lib/lastTurnChangedFiles';

const EMPTY_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

export {
  absoluteToWorkdirRelative as absoluteToRepoRelative,
  collectLastTurnPaths,
} from '../../lib/lastTurnChangedFiles';

export function useLastTurnFilter(sessionId: string | null, repoRoot: string | null): Set<string> {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!sessionId) return () => undefined;
      return makerChatStore.subscribe(sessionId, onChange);
    },
    [sessionId],
  );
  const getSnapshot = useCallback((): readonly ChatMessage[] => {
    if (!sessionId) return EMPTY_MESSAGES;
    return makerChatStore.getSnapshot(sessionId).messages;
  }, [sessionId]);
  const messages = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => collectLastTurnPaths(messages, repoRoot), [messages, repoRoot]);
}
