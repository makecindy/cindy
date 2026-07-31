import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { pluginEnableStateFor } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';
import { normalizeWorkingDirForProjectSettings } from '../../../../shared/workingDir';

const log = createLogger('useCollabProjectPolicy');

interface PolicyState {
  /** 本次结果对应的查询键(设备 + 目录);换设备或换目录都换键,不复用上一格的答案。 */
  queryKey: string | null;
  enabled: boolean | null;
  unavailable: boolean;
  unsupported: boolean;
}

export interface CollabProjectPolicy {
  enabled: boolean;
  loading: boolean;
  /** 查询失败(瞬时):入口置灰,但值得给一次重试。 */
  unavailable: boolean;
  /** 被控端根本不支持该查询(老版本):入口置灰且**不该**给重试,重试永远不会成功。 */
  unsupported: boolean;
  refresh: () => Promise<PolicyResult>;
}

type PolicyResult = {
  enabled: boolean;
  unavailable: boolean;
  unsupported: boolean;
};

type ProjectRefreshTracker = {
  latestPromise: Promise<PolicyResult>;
  inFlight: number;
};

/**
 * Reads the effective collab plugin state for renderer gating.
 * Main IPC authorization remains authoritative for every create request.
 *
 * 两个「查哪台机器、查到哪一层」的维度由 `resolveCollabEntryPolicy` 决定,这里只执行:
 *
 * `deviceId`(device-link):项目级开关的真相在**被控端**。控制端拿被控端的路径查自己本机
 * 只会读到自己的用户级开关,可能与被控端 main 的 assertCollabProjectEnabled 相反 ——
 * 那正是 #1170 里「草稿没入口 / 会话有入口但走不完」的第二层来源。
 *
 * `skipQuery`(SSH 远端):workingDir 是远端主机上的路径, 在执行查询的那台机器的 fs 上查
 * 项目级既无意义又会误判 — 跳过项目级覆盖, 但仍查用户级/全局级 collab 开关
 * (与 main 侧 assertCollabProjectEnabled 的 remote 分支同口径): 用户全局禁用 Collab 时
 * UI toggle 同样置灰, 而不是放行到 enableOrca 才撞 PRECONDITION_FAILED。
 */
export function useCollabProjectPolicy(
  workingDir: string | null | undefined,
  eligible: boolean,
  opts?: { skipQuery?: boolean; deviceId?: string | null },
): CollabProjectPolicy {
  const skipQuery = opts?.skipQuery === true;
  // skipQuery 用 '' 作查询参数:'' 占位表示 "跳过项目级、只查用户级" 那一档。
  const requestedWorkingDir =
    eligible && typeof workingDir === 'string'
      ? skipQuery
        ? ''
        : normalizeWorkingDirForProjectSettings(workingDir)
      : null;
  const requestedDeviceId =
    eligible && typeof opts?.deviceId === 'string' && opts.deviceId.trim() !== ''
      ? opts.deviceId
      : null;
  // 键含 deviceId:两台被控设备完全可能出现同一个路径串(`/Users/me/proj`),只按路径
  // 做键会让 A 设备的答案被当成 B 设备的,入口据此置灰/放行都是错的。
  const requestKey =
    requestedWorkingDir == null ? null : `${requestedDeviceId ?? ''}\u0000${requestedWorkingDir}`;
  const [state, setState] = useState<PolicyState>({
    queryKey: null,
    enabled: requestKey == null ? false : null,
    unavailable: false,
    unsupported: false,
  });
  const requestIdRef = useRef(0);
  const refreshTrackersByKeyRef = useRef(new Map<string, ProjectRefreshTracker>());
  const refresh = useCallback((): Promise<PolicyResult> => {
    const requestId = ++requestIdRef.current;
    // 注意用 == null 而非 falsy 判断:skipQuery 的 '' 哨兵是合法查询参数
    // (跳过项目级、只查用户级), 不能落进"无 workingDir"早退。
    if (requestKey == null || requestedWorkingDir == null) {
      setState({ queryKey: null, enabled: false, unavailable: false, unsupported: false });
      return Promise.resolve({ enabled: false, unavailable: false, unsupported: false });
    }

    let requestPromise!: Promise<PolicyResult>;
    requestPromise = (async () => {
      setState((previous) =>
        previous.queryKey === requestKey
          ? { ...previous, unavailable: false, unsupported: false }
          : { queryKey: requestKey, enabled: null, unavailable: false, unsupported: false },
      );
      try {
        // '' (skipQuery) → 不传 workingDir: getEnableState 跳过项目级覆盖,
        // 落用户级/全局级 — 与 main 侧 remote 分支同语义。
        // deviceId 非空 → 隧道到被控端读它自己的项目级真相(见 pluginEnableStateFor)。
        const next = await pluginEnableStateFor(
          requestedDeviceId,
          'collab',
          requestedWorkingDir === '' ? undefined : requestedWorkingDir,
        );
        const result = { enabled: next.effectiveEnabled, unavailable: false, unsupported: false };
        if (requestId !== requestIdRef.current) {
          const latest = refreshTrackersByKeyRef.current.get(requestKey)?.latestPromise;
          return latest && latest !== requestPromise ? latest : result;
        }
        setState({
          queryKey: requestKey,
          enabled: result.enabled,
          unavailable: false,
          unsupported: false,
        });
        return result;
      } catch (err) {
        // 老被控端没收录 maker:plugins:get-state → 隧道回 CHANNEL_NOT_ALLOWED。这是
        // **确定性**的不支持,不是瞬时故障:同 getWorkflowProgressFor 的判别方式,单独
        // 分类,让 UI 不去挂一个永远不会成功的重试。
        const unsupported = extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
        log[unsupported ? 'info' : 'warn']('failed to read collab policy', {
          workingDir: requestedWorkingDir,
          deviceId: requestedDeviceId,
          unsupported,
          err,
        });
        const result = { enabled: false, unavailable: !unsupported, unsupported };
        if (requestId !== requestIdRef.current) {
          const latest = refreshTrackersByKeyRef.current.get(requestKey)?.latestPromise;
          return latest && latest !== requestPromise ? latest : result;
        }
        setState({
          queryKey: requestKey,
          enabled: null,
          unavailable: result.unavailable,
          unsupported,
        });
        return result;
      }
    })();
    const tracker = refreshTrackersByKeyRef.current.get(requestKey) ?? {
      latestPromise: requestPromise,
      inFlight: 0,
    };
    tracker.latestPromise = requestPromise;
    tracker.inFlight += 1;
    refreshTrackersByKeyRef.current.set(requestKey, tracker);
    void requestPromise.finally(() => {
      tracker.inFlight -= 1;
      if (tracker.inFlight === 0 && refreshTrackersByKeyRef.current.get(requestKey) === tracker) {
        refreshTrackersByKeyRef.current.delete(requestKey);
      }
    });
    return requestPromise;
  }, [requestKey, requestedDeviceId, requestedWorkingDir]);

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
    requestKey == null ? false : state.queryKey === requestKey ? state.enabled : null;
  const settledForKey = requestKey != null && state.queryKey === requestKey && current === null;
  const unavailable = settledForKey && state.unavailable;
  const unsupported = settledForKey && state.unsupported;
  return {
    enabled: current === true,
    loading: current === null && !unavailable && !unsupported,
    unavailable,
    unsupported,
    refresh,
  };
}
