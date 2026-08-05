import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

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
  /** Resolves true only when the latest main-process snapshot changed. */
  setProjectHidden: (projectKey: string, hidden: boolean) => Promise<boolean>;
}

/**
 * Synchronously hydrates sidebar visibility before the first paint, then keeps
 * every renderer window in sync with the main-process preference store.
 */
export function useHiddenProjects(): UseHiddenProjectsReturn {
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() =>
    normalizeHiddenProjectKeys(window.electronAPI.sidebarSettings.loadHiddenProjectKeys()),
  );

  useLayoutEffect(() => {
    const reconcile = (projectKeys: readonly string[]) => {
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
    reconcile(window.electronAPI.sidebarSettings.loadHiddenProjectKeys());
    return unsubscribe;
  }, []);

  const setProjectHidden = useCallback(
    (projectKey: string, hidden: boolean) =>
      window.electronAPI.sidebarSettings.setProjectHidden(projectKey, hidden),
    [],
  );

  return useMemo(
    () => ({ hiddenProjectKeys, setProjectHidden }),
    [hiddenProjectKeys, setProjectHidden],
  );
}
