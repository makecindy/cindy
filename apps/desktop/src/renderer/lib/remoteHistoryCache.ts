import type { HistoryMessageSource, HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { historyWorkSummaries } from '@cindy/maker-shared/message-window';
import {
  decodeRemoteHistory,
  encodeRemoteHistory,
  fitsRemoteHistoryCache,
  currentRemoteHistoryDetails,
} from '../../shared/remoteHistoryCache';
import {
  readCachedMessages,
  persistCachedMessages,
  clearCachedMessages,
  sessionCacheInvalidationToken,
  invalidationAtRequestStart,
  ownerTokenAtRequestStart,
  accountCounterAtRequestStart,
} from '@/features/device-link/mirrorCacheClient';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

/** Capture before the remote read, never when the eventual snapshot is written. */
export function remoteHistoryCacheWriter(deviceId: string, sessionId: string) {
  const owner = getDataOwnerGeneration();
  const token = sessionCacheInvalidationToken(sessionId);
  const invalidation = invalidationAtRequestStart(deviceId, sessionId);
  const ownerToken = ownerTokenAtRequestStart(sessionId);
  const account = accountCounterAtRequestStart(sessionId);
  return <T extends HistoryMessageSource>(snapshot: HistoryViewSnapshot<T>) => {
    if (
      !isDataOwnerGenerationCurrent(owner) ||
      token !== sessionCacheInvalidationToken(sessionId) ||
      !snapshot.ready ||
      snapshot.loading ||
      snapshot.error
    )
      return;
    // A page can be ready while its expanded work is still refreshing. Do not
    // replace the last usable mirror with a projection whose detail is omitted.
    const currentDetails = currentRemoteHistoryDetails(snapshot);
    if (historyWorkSummaries(snapshot.items).some((summary) =>
      snapshot.expanded.has(summary.key) && !currentDetails.has(summary.key))) return;
    const text = encodeRemoteHistory(snapshot);
    if (!fitsRemoteHistoryCache(text)) {
      clearCachedMessages(deviceId, sessionId);
      return;
    }
    persistCachedMessages(deviceId, sessionId, [], invalidation, ownerToken, account, text);
  };
}

export async function readRemoteHistoryCache<T extends HistoryMessageSource>(
  deviceId: string,
  sessionId: string,
): Promise<HistoryViewSnapshot<T> | null> {
  const token = sessionCacheInvalidationToken(sessionId);
  let snapshot: HistoryViewSnapshot<T> | null = null;
  await readCachedMessages(deviceId, sessionId, (value) => {
    snapshot = decodeRemoteHistory<T>(value);
  });
  return token === sessionCacheInvalidationToken(sessionId) ? snapshot : null;
}
