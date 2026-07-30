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
 *
 * `skipQuery`: 远端 (SSH) 会话的 workingDir 是远端路径, 本机 fs 的项目级
 * 查询既无意义又会误拒 — 跳过项目级覆盖, 但仍查用户级/全局级 collab 开关
 * (与 main 侧 assertCollabProjectEnabled 的 remote 分支同口径): 用户全局
 * 禁用 Collab 时 UI toggle 同样置灰, 而不是放行到 enableOrca 才撞
 * PRECONDITION_FAILED。
 */
export function useCollabProjectPolicy(
  workingDir: string | null | undefined,
  eligible: boolean,
  opts?: { skipQuery?: boolean },
): CollabProjectPolicy {
  const skipQuery = opts?.skipQuery === true;
  // skipQuery 用 '' 作查询键:state 机围绕 workingDir key 构造, '' 占位表示
  // "跳过项目级、只查用户级" 那一档。
  const requestedWorkingDir =
    eligible && typeof workingDir === 'string'
      ? skipQuery
        ? ''
        : normalizeWorkingDirForProjectSettings(workingDir)
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
    // 注意用 == null 而非 falsy 判断:skipQuery 的 '' 哨兵是合法查询键
    // (跳过项目级、只查用户级), 不能落进"无 workingDir"早退。
    if (requestedWorkingDir == null) {
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
        // '' (skipQuery) → 不传 workingDir: getEnableState 跳过项目级覆盖,
        // 落用户级/全局级 — 与 main 侧 remote 分支同语义。
        const next = await window.electronAPI.maker.plugins.getState(
          'collab',
          requestedWorkingDir === '' ? undefined : requestedWorkingDir,
        );
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
