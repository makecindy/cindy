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
 *     sessionId 增量更新；启动和窗口聚焦时才做全量存活校验
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
  type ReactNode,
} from 'react';

import type { WorktreeMeta } from '@/lib/worktree.types';
import { createLogger } from '@/lib/logger';

const log = createLogger('WorktreeContext');

/** store 仍可能留着已被 `git worktree remove` 的路径；探测失败不摘标，避免 IPC 抖动清空侧栏。 */
async function isLiveOfficialPath(cwd: string): Promise<boolean> {
  const detect = window.electronAPI?.worktreeDetectCwd;
  if (!detect) return true;
  try {
    const result = await detect({ cwd });
    return Boolean(result?.isInsideWorktree);
  } catch {
    return true;
  }
}

interface WorktreeContextValue {
  /** sessionId → meta；非 null 即代表此 session 正绑定一个 worktree。 */
  metas: Record<string, WorktreeMeta>;
  /** 从 main 查询并更新单个 session 的 worktree 缓存。 */
  refreshSession: (sessionId: string) => Promise<void>;
}

const WorktreeContext = createContext<WorktreeContextValue | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [metas, setMetas] = useState<Record<string, WorktreeMeta>>({});
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
      const next: Record<string, WorktreeMeta> = {};
      await Promise.all(
        (list ?? []).map(async (meta) => {
          if (!meta?.sessionId || !meta.path) return;
          if (!(await isLiveOfficialPath(meta.path))) return;
          if (myTurn !== fullRefreshGenerationRef.current) return;
          next[meta.sessionId] = meta;
        }),
      );
      if (myTurn !== fullRefreshGenerationRef.current) return;
      setMetas((current) => {
        const merged = { ...next };
        // 全量探测期间若某个 session 收到更晚的权威事件，只保留该 session 当前
        // 的增量结果；未完成的增量请求随后会再落一次，不能让旧全量快照回写。
        for (const [sessionId, generation] of sessionEventGenerationsRef.current) {
          if (generation <= eventGenerationAtStart) continue;
          if (current[sessionId]) merged[sessionId] = current[sessionId];
          else delete merged[sessionId];
        }
        return merged;
      });
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
      const next =
        meta?.sessionId === sessionId && meta.path && (await isLiveOfficialPath(meta.path))
          ? meta
          : null;
      if (!isCurrent()) return;
      setMetas((current) => {
        if (next) return { ...current, [sessionId]: next };
        if (!current[sessionId]) return current;
        const updated = { ...current };
        delete updated[sessionId];
        return updated;
      });
    } catch (err) {
      log.warn('session refresh failed:', { sessionId, err });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 权威时机在这条推送上：main 侧的 worktree 回收是 fire-and-forget 的异步链
  // （关子进程 → git worktree remove → 文件系统清理），store 条目被移除的时刻
  // 远晚于归档/删除的状态 IPC 返回。main 只为实际涉及 worktree 的 session 广播，
  // 这里也只查询、校验并更新这一条，不再扫描其它 worktree。
  useEffect(() => {
    const subscribe = window.electronAPI?.onWorktreeChanged;
    if (!subscribe) return;
    return subscribe(({ sessionId }) => {
      if (!sessionId) return;
      void refreshSession(sessionId);
    });
  }, [refreshSession]);

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
    () => ({ metas, refreshSession }),
    [metas, refreshSession],
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
export function useWorktreeForSession(sessionId: string | null | undefined): WorktreeMeta | null {
  const { metas } = useCtx();
  if (!sessionId) return null;
  return metas[sessionId] ?? null;
}

/** 让创建/恢复等明确知道 sessionId 的调用方只刷新对应 worktree。 */
export function useRefreshWorktreeForSession(): (sessionId: string) => Promise<void> {
  return useCtx().refreshSession;
}
