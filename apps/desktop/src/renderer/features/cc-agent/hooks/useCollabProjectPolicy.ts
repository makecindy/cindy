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
 * `skipQuery`(尚无运行目录的 dialogue 草稿 / SSH 远端):草稿没有可查目录,远端 workingDir
 * 则不属于执行查询的本机 fs;两者都跳过项目级覆盖,但仍查用户级/全局级 collab 开关。
 * 已创建的本地 dialogue 把 workspaceKind + workingDir 交给查询:Main 会用与最终授权相同
 * 的可信判据把 app 托管 dialogue 目录强制收敛到全局级,显式真实目录继续尊重项目覆盖。
 * 即使托管 cwd 里意外出现 `.cindy/plugins.json`,入口状态也不会与 mutation 判定漂移。
 */
export function useCollabProjectPolicy(
  workingDir: string | null | undefined,
  eligible: boolean,
  opts?: { skipQuery?: boolean; deviceId?: string | null; workspaceKind?: string | null },
): CollabProjectPolicy {
  const skipQuery = opts?.skipQuery === true;
  // skipQuery 用 '' 作查询参数:'' 占位表示 "跳过项目级、只查用户级" 那一档。
  const requestedWorkingDir =
    !eligible
      ? null
      : skipQuery
        ? ''
        : typeof workingDir === 'string'
          ? normalizeWorkingDirForProjectSettings(workingDir)
          : null;
  const requestedDeviceId =
    eligible && typeof opts?.deviceId === 'string' && opts.deviceId.trim() !== ''
      ? opts.deviceId
      : null;
  const requestedWorkspaceKind =
    eligible && (opts?.workspaceKind === 'project' || opts?.workspaceKind === 'dialogue')
      ? opts.workspaceKind
      : undefined;
  // 键含 deviceId:两台被控设备完全可能出现同一个路径串(`/Users/me/proj`),只按路径
  // 做键会让 A 设备的答案被当成 B 设备的,入口据此置灰/放行都是错的。
  const requestKey =
    requestedWorkingDir == null
      ? null
      : `${requestedDeviceId ?? ''}\u0000${requestedWorkspaceKind ?? ''}\u0000${requestedWorkingDir}`;
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
          requestedWorkspaceKind,
        );
        // 旧被控端虽然已有 get-state channel，却会忽略 workspaceKind，最终授权也不接受
        // dialogue。只有被控端显式回显已接受 dialogue，远端 dialogue 入口才可放行。
        const unsupported =
          requestedDeviceId !== null &&
          requestedWorkspaceKind === 'dialogue' &&
          next.collabWorkspaceKind !== 'dialogue';
        if (unsupported) {
          log.info('remote device does not support dialogue collaboration policy', {
            deviceId: requestedDeviceId,
          });
        }
        const result = {
          enabled: unsupported ? false : next.effectiveEnabled,
          unavailable: false,
          unsupported,
        };
        if (requestId !== requestIdRef.current) {
          const latest = refreshTrackersByKeyRef.current.get(requestKey)?.latestPromise;
          return latest && latest !== requestPromise ? latest : result;
        }
        setState({
          queryKey: requestKey,
          enabled: unsupported ? null : result.enabled,
          unavailable: false,
          unsupported,
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
  }, [requestKey, requestedDeviceId, requestedWorkingDir, requestedWorkspaceKind]);

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
