/**
 * useCCSessions — CC Agent 会话列表数据 hook
 * ---------------------------------------------------------------------------
 * 薄订阅 wrapper：所有数据所有权下沉到 lib/sessionsStore（模块级单例）。
 * 本 hook 只负责"订阅 store + 暴露同样的返回签名"，组件接入零改动。
 *
 * 与旧版（每个 mount 各自 useState/fetch/订阅 bus）的关键差异：
 *   - mount 时优先返回 store 缓存快照 → 命中即 isLoading=false，
 *     解决 tab 切换 sidebar skeleton 闪烁问题。
 *   - sessionsBus / electronAPI.sessionsPush 由 store 在模块加载时统一订阅一次，
 *     避免每个 hook 实例重复订阅。
 *   - 多个 hook 实例共享同一份 cache，一处 patch 多处同步。
 *
 * 对外暴露（与旧版 100% 一致）：
 *   sessions        — Session[]，按 updatedAt desc
 *   isLoading       — 当前 filter 桶尚未加载时为 true；命中 cache 直接 false
 *   error           — 最近一次 fetch 的错误，null 表示正常
 *   createSession() — 创建新 session 并本地 prepend，返回新 session
 *   refreshSessions — 强制重拉当前 filter 桶
 *   patchLocal      — 局部合并某条 session 字段（不重排序）
 *
 * 入参：
 *   includeArchived — 'active' | 'archived' | 'all'，默认 'active'。
 *     变化时自动切到对应桶，已加载桶立即出列表，未加载桶走一次 ensure。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentKind, Session, WorkspaceKind } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import type { ListStatusFilter } from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';

interface UseCCSessionsOptions {
  /** Session status filter — F-PJ-10 V0.5.1。默认 'active'。 */
  includeArchived?: ListStatusFilter;
}

interface UseCCSessionsReturn {
  sessions: Session[];
  isLoading: boolean;
  error: Error | null;
  /**
   * 当前 `sessions` 数组实际所属的 IPC 桶 —— 不一定等于 caller 传入的
   * `options.includeArchived`：caller 切桶后到新数据回来前, 这里仍是旧桶,
   * 配合 caller 端「按桶决定是否做 status 客户端二次过滤」可消除切桶空白帧。
   */
  effectiveIncludeArchived: ListStatusFilter;
  createSession: (opts?: {
    id?: string;
    model?: string;
    effort?: string;
    workingDir?: string;
    workspaceKind?: WorkspaceKind;
    permissionMode?: string;
    fastMode?: boolean;
    /** 计划模式一级开关(与 permissionMode 正交); 草稿开着时随建会话落库。 */
    planModeEnabled?: boolean;
    agentKind?: AgentKind;
    extraDirs?: string[];
    writableDirs?: string[];
    remoteHostId?: string;
    /** per-session 来源(供应商)显式选择; null/undefined = 跟随默认路由。透传到 sessionService.create。 */
    providerId?: string | null;
  }) => Promise<Session | null>;
  refreshSessions: () => Promise<Session[]>;
  patchLocal: (id: string, patch: Partial<Session>) => void;
}

/** snapshot + 它实际所属的 filter 桶, 必须 atomically 一起更新, 否则上层
 *  「按桶决定是否过滤」的逻辑会出现一帧错位。 */
interface SnapshotState {
  data: Session[] | null;
  filter: ListStatusFilter;
}

export function useCCSessions(options?: UseCCSessionsOptions): UseCCSessionsReturn {
  const filter: ListStatusFilter = options?.includeArchived ?? 'active';

  // 关键：初始 snapshot 来自 store —— remount 命中 cache 即非 null，无 skeleton 闪烁。
  const [snapshotState, setSnapshotState] = useState<SnapshotState>(() => ({
    data: sessionsStore.getByFilter(filter),
    filter,
  }));
  const [isLoading, setIsLoading] = useState<boolean>(snapshotState.data === null);
  const [error, setError] = useState<Error | null>(null);

  // 跨 effect 周期记忆"是否曾经加载过任何一桶":
  // 切 filter 时若新桶 cache miss, 我们要决定是「显骨架」还是「保留旧 snapshot」。
  // 不读 snapshot 闭包(避免依赖 + 闭包陈旧), 用 ref 跟当前 snapshot 同步。
  const hasAnySnapshotRef = useRef(snapshotState.data !== null);
  hasAnySnapshotRef.current = snapshotState.data !== null;

  useEffect(() => {
    // 命中 cache: 立刻 swap, 关 loading。
    const cached = sessionsStore.getByFilter(filter);
    if (cached !== null) {
      setSnapshotState({ data: cached, filter });
      setIsLoading(false);
      setError(null);
    } else if (!hasAnySnapshotRef.current) {
      // 完全没数据(首次挂载) → 真正的骨架帧。
      setIsLoading(true);
    }
    // else: 切桶但旧桶有数据 → 保留旧 snapshotState (含旧 filter), 不动 isLoading,
    //       等新桶 IPC 回来再由下面 subscribe 一次性 swap, 杜绝中间空白帧。

    const unsub = sessionsStore.subscribe((change) => {
      const next = sessionsStore.getByFilter(filter);
      if (change === 'reset') {
        hasAnySnapshotRef.current = false;
        setSnapshotState({ data: null, filter });
        setIsLoading(true);
        setError(null);
        void sessionsStore
          .ensureByFilter(filter)
          .then(() => setError(null))
          .catch((e: unknown) => {
            setError(e instanceof Error ? e : new Error(String(e)));
            setIsLoading(false);
          });
        return;
      }
      // 只在新桶有确切数据时才覆盖, 否则其它桶的变化不应擦掉当前视图。
      if (next !== null) {
        setSnapshotState({ data: next, filter });
        setIsLoading(false);
      }
    });

    if (sessionsStore.getByFilter(filter) === null) {
      sessionsStore
        .ensureByFilter(filter)
        .then(() => setError(null))
        .catch((e: unknown) => {
          setError(e instanceof Error ? e : new Error(String(e)));
          // 失败兜底: 防止首次挂载场景骨架卡死。
          setIsLoading(false);
        });
    }
    return unsub;
  }, [filter]);

  const createSession = useCallback(
    async (opts?: {
      id?: string;
      model?: string;
      effort?: string;
      workingDir?: string;
      workspaceKind?: WorkspaceKind;
      permissionMode?: string;
      fastMode?: boolean;
      planModeEnabled?: boolean;
      agentKind?: AgentKind;
      /** 附加只读引用目录列表 (绝对路径); 透传到 sessionService.create → mapper 写库。 */
      extraDirs?: string[];
      writableDirs?: string[];
      /** 远端 host alias (Codex P2)。设置后 session.workingDir 必须是远端绝对路径,
       *  agent 跑在远端 SSH 机器上, 本地不 spawn codex 子进程。 */
      remoteHostId?: string;
      /** per-session 来源(供应商)显式选择; null/undefined = 跟随默认路由。透传到 sessionService.create → mapper 落盘。 */
      providerId?: string | null;
    }): Promise<Session | null> => {
      try {
        const newSession = await sessionService.create({
          permissionMode: 'auto',
          fastMode: false,
          ...opts,
        });
        // 本地 prepend：新建必然是 active 且 _count.messages=0，
        // projectGrouping 自动把它落到"未分类区"。省掉一次全量 IPC。
        sessionsStore.prependCreated(newSession);
        return newSession;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return null;
      }
    },
    [],
  );

  const refreshSessions = useCallback(
    () => sessionsStore.forceRefresh(filter),
    [filter],
  );

  /** Update a session's fields without re-fetching. Preserves list order — useful
   *  for renames that shouldn't re-sort. 实际转发给 store 让所有 subscriber 同步。 */
  const patchLocal = useCallback(
    (id: string, patch: Partial<Session>) => sessionsStore.patchLocal(id, patch),
    [],
  );

  return {
    sessions: snapshotState.data ?? [],
    effectiveIncludeArchived: snapshotState.filter,
    isLoading,
    error,
    createSession,
    refreshSessions,
    patchLocal,
  };
}
