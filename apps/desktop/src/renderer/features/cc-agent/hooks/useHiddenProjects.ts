import { useCallback, useEffect, useMemo, useState } from 'react';

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

  useEffect(
    () =>
      window.electronAPI.sidebarSettings.onHiddenProjectKeysChanged((projectKeys) => {
        setHiddenProjectKeys(normalizeHiddenProjectKeys(projectKeys));
      }),
    [],
  );

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
