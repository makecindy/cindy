/**
 * Last-turn filter for git review.
 *
 * Agent messages are no longer the diff source; they only provide a set of
 * repo-relative paths touched after the latest user turn.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import { collectLastTurnPaths } from '../../lib/lastTurnChangedFiles';

const EMPTY_PATH_SNAPSHOT = '[]';

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
  const getSnapshot = useCallback((): string => {
    if (!sessionId) return EMPTY_PATH_SNAPSHOT;
    const paths = collectLastTurnPaths(makerChatStore.getSnapshot(sessionId).messages, repoRoot);
    return JSON.stringify([...paths].sort());
  }, [repoRoot, sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(
    () => new Set<string>(JSON.parse(snapshot) as string[]),
    [snapshot],
  );
}
