import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { DataOwnerPushStamp } from '../../../../shared/dataOwnerPush';
import type { SidebarSettingsSnapshot } from '../../../../shared/sidebarSettings';
import { normalizeProjectKey } from '../lib/projectGrouping';

function normalizeHiddenProjectKeys(rawKeys: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const rawKey of rawKeys) {
    const projectKey = normalizeProjectKey(rawKey);
    if (projectKey != null) normalized.add(projectKey);
  }
  return normalized;
}

export interface UseHiddenProjectsReturn {
  hiddenProjectKeys: ReadonlySet<string>;
  initialSnapshot: SidebarSettingsSnapshot;
  /** Resolves true only when the latest main-process snapshot changed. */
  setProjectHidden: (projectKey: string, hidden: boolean) => Promise<boolean>;
}

/**
 * Synchronously hydrates sidebar visibility before the first paint, then keeps
 * every renderer window in sync with the main-process preference store.
 */
export function useHiddenProjects(): UseHiddenProjectsReturn {
  const [initialSnapshot] = useState<SidebarSettingsSnapshot>(() => {
    const snapshot = window.electronAPI.sidebarSettings.loadSnapshot();
    if (isDataOwnerPushStampCurrent(snapshot)) return snapshot;
    const owner = getDataOwnerGeneration();
    return {
      dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation,
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
      hiddenMainViewGhostIds: [],
    };
  });
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() =>
    normalizeHiddenProjectKeys(initialSnapshot.hiddenProjectKeys),
  );
  const ownerStamp = useMemo<DataOwnerPushStamp>(
    () => ({
      dataOwnerId: initialSnapshot.dataOwnerId,
      ownerGeneration: initialSnapshot.ownerGeneration,
    }),
    [initialSnapshot.dataOwnerId, initialSnapshot.ownerGeneration],
  );

  const isBoundOwnerStampCurrent = useCallback(
    (nextOwnerStamp: DataOwnerPushStamp) =>
      nextOwnerStamp.dataOwnerId === ownerStamp.dataOwnerId &&
      nextOwnerStamp.ownerGeneration === ownerStamp.ownerGeneration &&
      isDataOwnerPushStampCurrent(nextOwnerStamp),
    [ownerStamp],
  );

  useLayoutEffect(() => {
    const reconcile = (projectKeys: readonly string[], nextOwnerStamp: DataOwnerPushStamp) => {
      if (!isBoundOwnerStampCurrent(nextOwnerStamp)) return;
      const next = normalizeHiddenProjectKeys(projectKeys);
      setHiddenProjectKeys((current) => {
        if (current.size !== next.size) return next;
        for (const projectKey of next) {
          if (!current.has(projectKey)) return next;
        }
        return current;
      });
    };
    const unsubscribe = window.electronAPI.sidebarSettings.onHiddenProjectKeysChanged(reconcile);
    // Subscribe before the second read so a change between render and effect
    // is either delivered by the listener or recovered from this snapshot.
    const latest = window.electronAPI.sidebarSettings.loadSnapshot();
    reconcile(latest.hiddenProjectKeys, latest);
    return unsubscribe;
  }, [isBoundOwnerStampCurrent]);

  const setProjectHidden = useCallback(
    (projectKey: string, hidden: boolean) =>
      window.electronAPI.sidebarSettings.setProjectHidden(projectKey, hidden, ownerStamp),
    [ownerStamp],
  );

  return useMemo(
    () => ({ hiddenProjectKeys, initialSnapshot, setProjectHidden }),
    [hiddenProjectKeys, initialSnapshot, setProjectHidden],
  );
}
