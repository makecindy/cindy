/**
 * WorktreeContext — 全局缓存 worktreeListAll 的快照，供 sidebar 徽标
 * (M4) / 各 session 视图按 sessionId 反查 worktree 元数据共享读。
 *
 * worktree-parallel-sessions 前端方案 M2：
 *   - mount 时拉一次 listAll
 *   - create / restore 成功后由调用方按 sessionId 主动增量更新
 *   - Scheduler / hook 等 main 侧后台创建完成后，复用 sessions:created 按
 *     sessionId 增量发现 worktree
 *   - 归档/删除的 worktree 回收跑完后，由 main 的 `worktree:changed` 推送按
 *     sessionId 增量更新；启动只读取快照，外部删除由打开中的任务按需校验
 *
 * 与项目内 AuthContext / EnvCheckContext 同
 * Provider+hooks 范式，不引入新状态库。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { WorktreeMeta } from '@/lib/worktree.types';
import { createLogger } from '@/lib/logger';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from './dataOwnerGeneration';

interface ObservedWorktree {
  owner: DataOwnerGeneration;
  info: { workdir: string; branch: string | null } | null;
}

// Like PrRefsContext, keep a stable store in Context; an observed update must
// not broadcast a new provider value to every task row.
function createObservedStore() {
  const entries = new Map<string, ObservedWorktree>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    has(sessionId: string) {
      const entry = entries.get(sessionId);
      return Boolean(entry && isDataOwnerIdCurrent(entry.owner));
    },
    get(sessionId: string) {
      const entry = entries.get(sessionId);
      return entry && isDataOwnerIdCurrent(entry.owner) ? entry.info : null;
    },
    set(sessionId: string, owner: DataOwnerGeneration, info: ObservedWorktree['info'] | null) {
      const previous = entries.get(sessionId);
      if (
        previous &&
        isDataOwnerIdCurrent(previous.owner) &&
        previous.info?.workdir === info?.workdir &&
        previous.info?.branch === info?.branch
      )
        return;
      // A completed empty backfill is also a snapshot. Tool traffic must not
      // rescan all history just because this task has never used a worktree.
      entries.set(sessionId, { owner, info });
      listeners.get(sessionId)?.forEach((listener) => listener());
    },
    subscribe(sessionId: string, listener: () => void) {
      const group = listeners.get(sessionId) ?? new Set<() => void>();
      listeners.set(sessionId, group);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (group.size === 0) listeners.delete(sessionId);
      };
    },
  };
}

const log = createLogger('WorktreeContext');
interface WorktreeContextValue {
  /** sessionId → meta；非 null 即代表此 session 正绑定一个 worktree。 */
  metas: Record<string, WorktreeMeta>;
  /** 保留失效目录的登记信息，供打开中的任务在聚焦/恢复时重新探测。 */
  rawMetas: Record<string, WorktreeMeta>;
  reportLiveness: (meta: WorktreeMeta, live: boolean) => void;
  observed: ReturnType<typeof createObservedStore>;
  refreshObserved: (sessionId: string, mode?: 'recent' | 'history') => Promise<void>;
  /** 从 main 查询并更新单个 session 的 worktree 缓存。 */
  refreshSession: (sessionId: string) => Promise<void>;
}

const WorktreeContext = createContext<WorktreeContextValue | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [observed] = useState(createObservedStore);
  // Sidebar and composer share one in-flight query per session. A tool result arriving
  // during discovery requires one more pass over the newly committed messages.
  const observedRequests = useRef(
    new Map<
      string,
      { owner: DataOwnerGeneration; queued: boolean; history: boolean; promise: Promise<void> }
    >(),
  );
  const refreshObserved = useCallback(
    (sessionId: string, mode: 'recent' | 'history' = 'history'): Promise<void> => {
      const pending = observedRequests.current.get(sessionId);
      if (pending && isDataOwnerGenerationCurrent(pending.owner)) {
        pending.queued = true;
        pending.history ||= mode === 'history';
        return pending.promise;
      }
      const owner = getDataOwnerGeneration();
      const request = {
        owner,
        queued: false,
        history: mode === 'history',
        promise: Promise.resolve(),
      };
      const isCurrent = () =>
        observedRequests.current.get(sessionId) === request && isDataOwnerGenerationCurrent(owner);
      observedRequests.current.set(sessionId, request);
      request.promise = (async () => {
        do {
          request.queued = false;
          try {
            const session = await window.electronAPI.localDb.sessions.get(sessionId);
            if (!isCurrent()) return;
            if (!session || session.remoteHostId || session.deviceLinkDeviceId) return;
            let found: ObservedWorktree['info'] = null;
            if (request.history || !observed.has(sessionId)) {
              found = await window.electronAPI.gitContext.findLinkedWorktree({ sessionId });
            } else {
              // The existing resolver reads only the latest bounded telemetry
              // window and probes one candidate, rather than walking 2000 rows.
              const recent = await window.electronAPI.gitContext.getForSession({
                sessionId,
                workingDir: null,
                worktreePath: null,
              });
              if (!isCurrent()) return;
              const previous = observed.get(sessionId);
              const candidate = recent.source === 'telemetry' ? recent.workdir : null;
              const paths = new Set(
                [candidate, previous?.workdir].filter((p): p is string => Boolean(p)),
              );
              for (const cwd of paths) {
                const detected = await window.electronAPI.worktreeDetectCwd({ cwd });
                if (!isCurrent()) return;
                if (detected.isInsideWorktree) {
                  found = {
                    workdir: detected.repoRoot ?? cwd,
                    branch: detected.currentBranch ?? null,
                  };
                  break;
                }
              }
              // A known worktree disappeared: recover an older surviving one.
              // Empty tasks do not repeat this full backfill on each tool call.
              if (!found && previous) {
                found = await window.electronAPI.gitContext.findLinkedWorktree({ sessionId });
              }
            }
            if (!isCurrent()) return;
            if (request.queued) continue;
            observed.set(sessionId, owner, found?.workdir ? found : null);
          } catch {
            // Transport failure is not evidence that a previously found path vanished.
          }
        } while (request.queued && isCurrent());
      })().finally(() => {
        if (observedRequests.current.get(sessionId) === request)
          observedRequests.current.delete(sessionId);
      });
      return request.promise;
    },
    [observed],
  );
  useEffect(
    () => () => {
      observedRequests.current.clear();
    },
    [],
  );
  const [snapshot, setSnapshot] = useState<{
    metas: Record<string, WorktreeMeta>;
    invalid: Set<string>;
  }>({ metas: {}, invalid: new Set() });
  useEffect(() => {
    // Discovery belongs to the provider, not a visible row or display preference.
    // Query only the task named by a durable tool-message push.
    return window.electronAPI?.localDb?.messages?.onCreated?.(
      ({ sessionId, message }, ownerStamp) => {
        if (!sessionId || !isDataOwnerPushCurrent(ownerStamp)) return;
        if (message.role !== 'tool_use' && message.role !== 'tool_result') return;
        if (snapshot.metas[sessionId] && !snapshot.invalid.has(sessionId)) return;
        void refreshObserved(sessionId, 'recent');
      },
    );
  }, [snapshot, refreshObserved]);
  // 全量刷新彼此只接收最后一次；单条事件另按 sessionId 记代次，避免连续回收时
  // 一个 session 的迟到响应覆盖另一个 session 的新状态。
  const fullRefreshGenerationRef = useRef(0);
  const eventGenerationRef = useRef(0);
  const sessionEventGenerationsRef = useRef(new Map<string, number>());
  const refresh = useCallback(async () => {
    const myTurn = ++fullRefreshGenerationRef.current;
    const eventGenerationAtStart = eventGenerationRef.current;
    try {
      const list = await window.electronAPI.worktreeListAll();
      // 中间发生了更新的 refresh，丢弃本次结果
      if (myTurn !== fullRefreshGenerationRef.current) return;
      const entries = (list ?? []).filter((meta) => meta?.sessionId && meta.path);
      const mergeSnapshot = (next: Record<string, WorktreeMeta>) =>
        setSnapshot((current) => {
          if (myTurn !== fullRefreshGenerationRef.current) return current;
          const merged = { ...next };
          // 快照读取期间若某个 session 收到更晚的权威事件，只保留该 session 当前
          // 的增量结果；未完成的增量请求随后会再落一次，不能让旧全量快照回写。
          for (const [sessionId, generation] of sessionEventGenerationsRef.current) {
            if (generation <= eventGenerationAtStart) continue;
            if (current.metas[sessionId]) merged[sessionId] = current.metas[sessionId];
            else delete merged[sessionId];
          }
          return { ...current, metas: merged };
        });
      mergeSnapshot(Object.fromEntries(entries.map((meta) => [meta.sessionId, meta])));
    } catch (err) {
      log.warn('refresh failed:', err);
    }
  }, []);

  const refreshSession = useCallback(async (sessionId: string) => {
    const getForSession = window.electronAPI?.worktreeGetForSession;
    if (!getForSession) return;
    const generation = ++eventGenerationRef.current;
    sessionEventGenerationsRef.current.set(sessionId, generation);
    const fullRefreshGenerationAtStart = fullRefreshGenerationRef.current;
    const isCurrent = () =>
      sessionEventGenerationsRef.current.get(sessionId) === generation &&
      fullRefreshGenerationRef.current === fullRefreshGenerationAtStart;
    try {
      const meta = await getForSession(sessionId);
      if (!isCurrent()) return;
      const next = meta?.sessionId === sessionId && meta.path ? meta : null;
      if (!isCurrent()) return;
      setSnapshot((current) => {
        if (!isCurrent()) return current;
        const metas = { ...current.metas };
        if (next) metas[sessionId] = next;
        else delete metas[sessionId];
        const invalid = new Set(current.invalid);
        invalid.delete(sessionId);
        return { metas, invalid };
      });
    } catch (err) {
      log.warn('session refresh failed:', { sessionId, err });
    }
  }, []);

  const reportLiveness = useCallback((meta: WorktreeMeta, live: boolean) => {
    setSnapshot((current) => {
      // 同路径恢复也会换一份元数据；旧探测不能覆盖新一代创建/恢复/回收结果。
      if (current.metas[meta.sessionId] !== meta) return current;
      if (current.invalid.has(meta.sessionId) === !live) return current;
      const invalid = new Set(current.invalid);
      if (live) invalid.delete(meta.sessionId);
      else invalid.add(meta.sessionId);
      return { ...current, invalid };
    });
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      fullRefreshGenerationRef.current++;
    };
  }, [refresh]);

  // 权威时机在这条推送上：main 侧的 worktree 回收是 fire-and-forget 的异步链
  // （关子进程 → git worktree remove → 文件系统清理），store 条目被移除的时刻
  // 远晚于归档/删除的状态 IPC 返回。main 只为实际涉及 worktree 的 session 广播，
  // 这里也只查询并更新这一条，不再扫描其它 worktree；存活校验由打开中的任务负责。
  useEffect(() => {
    const subscribe = window.electronAPI?.onWorktreeChanged;
    if (!subscribe) return;
    return subscribe(({ sessionId }) => {
      if (!sessionId) return;
      void refreshSession(sessionId);
      // An observed path may subsequently have become managed. Recycling must
      // invalidate that old display snapshot even when its task is not open.
      if (observed.get(sessionId)) void refreshObserved(sessionId);
    });
  }, [refreshSession, observed, refreshObserved]);

  // Renderer 主动创建/恢复时调用方会直接 refreshSession；Scheduler、hook-control
  // 等后台入口只会在 session 建成后广播 sessions:created。这里同样只查该 session，
  // 没有 worktree 时 getForSession 返回 null，不会进入路径探测，更不会扫描全表。
  // 本机 emitSessionCreated 不带 ownerStamp；带 stamp 的是 device-link 转发，远端
  // worktree 元数据不归本机 WorktreeContext，必须忽略以防相同 sessionId 误贴。
  useEffect(() => {
    const subscribe = window.electronAPI?.localDb?.sessionsPush?.onCreated;
    if (!subscribe) return;
    return subscribe(({ sessionId }, ownerStamp) => {
      if (ownerStamp !== undefined || !sessionId) return;
      void refreshSession(sessionId);
    });
  }, [refreshSession]);

  const value = useMemo<WorktreeContextValue>(
    () => ({
      metas: Object.fromEntries(
        Object.entries(snapshot.metas).filter(([sessionId]) => !snapshot.invalid.has(sessionId)),
      ),
      rawMetas: snapshot.metas,
      reportLiveness,
      observed,
      refreshObserved,
      refreshSession,
    }),
    [snapshot, reportLiveness, observed, refreshObserved, refreshSession],
  );

  return <WorktreeContext.Provider value={value}>{children}</WorktreeContext.Provider>;
}

function useCtx(): WorktreeContextValue {
  const ctx = useContext(WorktreeContext);
  if (!ctx) {
    throw new Error('[WorktreeContext] missing provider — wrap your tree in <WorktreeProvider>');
  }
  return ctx;
}

/** 完整 metas map（按 sessionId 索引）。 */
export function useWorktrees(): Record<string, WorktreeMeta> {
  return useCtx().metas;
}

/** 单条快捷查询；徽标 (M4) / 各 session 视图都用它。 */
export function useWorktreeForSession(
  sessionId: string | null | undefined,
  opts?: { includeInvalid?: boolean },
): WorktreeMeta | null {
  const { metas, rawMetas } = useCtx();
  if (!sessionId) return null;
  return (opts?.includeInvalid ? rawMetas : metas)[sessionId] ?? null;
}

/** 仅同步当前任务已有探测的结果，不额外启动 Git，也不修改 main store。 */
export function useReportWorktreeLiveness(): WorktreeContextValue['reportLiveness'] {
  return useCtx().reportLiveness;
}

export function useObservedWorktreeForSession(sessionId: string): ObservedWorktree['info'] | null {
  const { observed } = useCtx();
  const subscribe = useCallback(
    (listener: () => void) => observed.subscribe(sessionId, listener),
    [observed, sessionId],
  );
  return useSyncExternalStore(subscribe, () => observed.get(sessionId));
}

export function useRefreshObservedWorktree(): WorktreeContextValue['refreshObserved'] {
  return useCtx().refreshObserved;
}

/** 让创建/恢复等明确知道 sessionId 的调用方只刷新对应 worktree。 */
export function useRefreshWorktreeForSession(): (sessionId: string) => Promise<void> {
  return useCtx().refreshSession;
}
