import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { normalizeWorkingDirForProjectSettings } from '../../../../shared/workingDir';

const log = createLogger('useCollabProjectPolicy');

interface PolicyState {
  workingDir: string | null;
  enabled: boolean | null;
  unavailable: boolean;
}

export interface CollabProjectPolicy {
  enabled: boolean;
  loading: boolean;
  unavailable: boolean;
  refresh: () => Promise<{
    enabled: boolean;
    unavailable: boolean;
  }>;
}

type PolicyResult = {
  enabled: boolean;
  unavailable: boolean;
};

type ProjectRefreshTracker = {
  latestPromise: Promise<PolicyResult>;
  inFlight: number;
};

/**
 * Reads the effective project-scoped collab plugin state for renderer gating.
 * Main IPC authorization remains authoritative for every create request.
 */
export function useCollabProjectPolicy(
  workingDir: string | null | undefined,
  eligible: boolean,
): CollabProjectPolicy {
  const requestedWorkingDir =
    eligible && typeof workingDir === 'string'
      ? normalizeWorkingDirForProjectSettings(workingDir)
      : null;
  const [state, setState] = useState<PolicyState>({
    workingDir: null,
    enabled: requestedWorkingDir == null ? false : null,
    unavailable: false,
  });
  const requestIdRef = useRef(0);
  const refreshTrackersByWorkingDirRef = useRef(
    new Map<string, ProjectRefreshTracker>(),
  );
  const refresh = useCallback((): Promise<PolicyResult> => {
    const requestId = ++requestIdRef.current;
    if (!requestedWorkingDir) {
      setState({ workingDir: null, enabled: false, unavailable: false });
      return Promise.resolve({ enabled: false, unavailable: false });
    }

    let requestPromise!: Promise<PolicyResult>;
    requestPromise = (async () => {
      setState((previous) =>
        previous.workingDir === requestedWorkingDir
          ? { ...previous, unavailable: false }
          : { workingDir: requestedWorkingDir, enabled: null, unavailable: false },
      );
      try {
        const next = await window.electronAPI.maker.plugins.getState('collab', requestedWorkingDir);
        const result = { enabled: next.effectiveEnabled, unavailable: false };
        if (requestId !== requestIdRef.current) {
          const latest =
            refreshTrackersByWorkingDirRef.current.get(requestedWorkingDir)?.latestPromise;
          return latest && latest !== requestPromise ? latest : result;
        }
        setState({
          workingDir: requestedWorkingDir,
          enabled: result.enabled,
          unavailable: false,
        });
        return result;
      } catch (err) {
        log.warn('failed to read project collab policy', {
          workingDir: requestedWorkingDir,
          err,
        });
        const result = { enabled: false, unavailable: true };
        if (requestId !== requestIdRef.current) {
          const latest =
            refreshTrackersByWorkingDirRef.current.get(requestedWorkingDir)?.latestPromise;
          return latest && latest !== requestPromise ? latest : result;
        }
        setState({ workingDir: requestedWorkingDir, enabled: null, unavailable: true });
        return result;
      }
    })();
    const tracker = refreshTrackersByWorkingDirRef.current.get(requestedWorkingDir) ?? {
      latestPromise: requestPromise,
      inFlight: 0,
    };
    tracker.latestPromise = requestPromise;
    tracker.inFlight += 1;
    refreshTrackersByWorkingDirRef.current.set(requestedWorkingDir, tracker);
    void requestPromise.finally(() => {
      tracker.inFlight -= 1;
      if (
        tracker.inFlight === 0 &&
        refreshTrackersByWorkingDirRef.current.get(requestedWorkingDir) === tracker
      ) {
        refreshTrackersByWorkingDirRef.current.delete(requestedWorkingDir);
      }
    });
    return requestPromise;
  }, [requestedWorkingDir]);

  useEffect(() => {
    if (!eligible) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('cindy:project-plugin-state-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('cindy:project-plugin-state-changed', refresh);
    };
  }, [eligible, refresh]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const current =
    requestedWorkingDir == null
      ? false
      : state.workingDir === requestedWorkingDir
        ? state.enabled
        : null;
  const unavailable =
    requestedWorkingDir != null &&
    state.workingDir === requestedWorkingDir &&
    current === null &&
    state.unavailable;
  return {
    enabled: current === true,
    loading: current === null && !unavailable,
    unavailable,
    refresh,
  };
}
