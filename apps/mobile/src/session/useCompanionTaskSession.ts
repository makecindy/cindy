import { useSyncExternalStore } from 'react';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';

/** The same original task and live signals as the task list, scoped to its transcript's host. */
export function useCompanionTaskSession(deviceId: string, sessionId: string | null | undefined) {
  const cached = useSyncExternalStore(remoteSessionStore.subscribe, () =>
    remoteSessionStore.getSessions().find((session) => session.id === sessionId) ?? null,
  );
  const origin = useSyncExternalStore(remoteSessionStore.subscribe, () =>
    sessionId ? remoteSessionStore.getSessionDeviceId(sessionId) : undefined,
  );
  const originConflict = Boolean(origin && origin !== deviceId && cached?.canonicalDeviceId !== deviceId);
  const readable = Boolean(deviceId && sessionId && !originConflict);
  // Reuse the ordinary list's snapshot. A card outside that list can still read its task,
  // without waiting for the parent delegation list or adding another list-wide fetch.
  const query = useRemoteCompanionQuery<RemoteSession>(deviceId, 'local-db:sessions:get', [sessionId], {
    enabled: readable && !cached,
    // Off-list rows do not receive the list store's title patches. Keep their
    // fallback fresh while focused; the shared query pauses reads in background.
    refreshIntervalMs: 30_000,
  });
  const session = readable
    ? cached ?? (query.value?.id === sessionId ? query.value : null)
    : null;
  const activity = useSyncExternalStore(remoteSessionStore.subscribeHomeStatus, () =>
    readable ? remoteSessionStore.getSessionLiveActivity(sessionId!, deviceId) : null,
  );
  const running = useSyncExternalStore(remoteSessionStore.subscribeHomeStatus, () =>
    readable && remoteSessionStore.isSessionRunning(sessionId!, deviceId),
  );
  const waiting = useSyncExternalStore(remoteSessionStore.subscribeHomeStatus, () =>
    readable && remoteSessionStore.getPendingInteractions(sessionId!, deviceId).length > 0,
  );
  return { session, activity, running, waiting, originConflict, refresh: query.refresh };
}
