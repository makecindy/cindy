import os from "node:os";
import path from "node:path";
import type { WorktreeMeta } from "./types.js";

export interface WorktreeJsonStore<T> {
  get<K extends keyof T>(key: K, fallback: T[K]): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}
export interface WorktreeStorePorts {
  getStore(): WorktreeJsonStore<{ worktrees: Record<string, WorktreeMeta> }>;
  getCleanupStore(): WorktreeJsonStore<{ pending: string[] }>;
  setWorktreePathInDb(sessionId: string, path: string): Promise<void>;
  log: { warn(message: string, detail?: string): void };
  withCrossProcessLock<T>(
    path: string,
    options: { label: string; waitMs?: number },
    task: (status: { held: boolean }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Canonical registry mutations and cleanup journal. Storage and owner scope
 * belong to each host; lock identity and compare-and-swap behavior are shared. */
export function createWorktreeStore(ports: WorktreeStorePorts) {
  const {
    getStore,
    getCleanupStore,
    setWorktreePathInDb,
    log,
    withCrossProcessLock,
  } = ports;
  function readMap(): Record<string, WorktreeMeta> {
    const raw = getStore().get("worktrees", {});
    // 防御: 历史/损坏数据可能不是 object
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid worktree registry");
    return raw as Record<string, WorktreeMeta>;
  }

  function writeMap(map: Record<string, WorktreeMeta>): void {
    getStore().set("worktrees", map);
  }

  function getAll(): WorktreeMeta[] {
    return Object.values(readMap());
  }

  function get(sessionId: string): WorktreeMeta | null {
    if (!sessionId) return null;
    return readMap()[sessionId] ?? null;
  }

  /**
   * 读取所有已记录的 worktree 路径(供 isManagedWorktreePath 三条校验用)。
   */
  function getAllPaths(): string[] {
    return getAll().flatMap((m) =>
      m.quarantinePath ? [m.path, m.quarantinePath] : [m.path],
    );
  }

  function readPendingSafeDirectoryCleanups(): string[] {
    const raw = getCleanupStore().get("pending", []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
  }

  /**
   * pendingSafeDirectoryCleanups 队列「读改写」的专用跨进程锁。
   *
   * 与 gitExec 的 safe.directory 锁分开: 这里只保护 electron-store 上「读列表 → 合并
   * → 写回」这微秒级的一步;若与 --add/--unset-all 共用同一把锁, 删除侧拿不到锁时连
   * 落盘兜底都做不了, 反而复现「两个进程各读同一份列表、后写覆盖先写」的丢路径窗口。
   */
  function pendingSafeDirectoryCleanupLockPath(): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return path.join(
      os.tmpdir(),
      `cindy-git-safe-directory-cleanup-${uid}.lock`,
    );
  }

  /**
   * 读取当前推迟清理的 safe.directory 路径(供启动期 reconcile 补清)。
   */
  function getPendingSafeDirectoryCleanups(): string[] {
    return readPendingSafeDirectoryCleanups();
  }

  /**
   * 追加推迟清理的路径(去重)。读改写全程持队列锁, 避免并发实例丢更新。
   */
  async function addPendingSafeDirectoryCleanups(
    paths: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(paths)].filter((p) => p && p.length > 0);
    if (unique.length === 0) return;
    await withCrossProcessLock(
      pendingSafeDirectoryCleanupLockPath(),
      { label: "git-safe-directory-cleanup", waitMs: 1_000 },
      async (status) => {
        if (!status.held) {
          throw new Error(
            "could not acquire the safe.directory cleanup queue lock",
          );
        }
        const existing = new Set(readPendingSafeDirectoryCleanups());
        let changed = false;
        for (const p of unique) {
          if (!existing.has(p)) {
            existing.add(p);
            changed = true;
          }
        }
        if (changed) getCleanupStore().set("pending", [...existing]);
      },
    );
  }

  /**
   * 移除已成功清理的路径。读改写全程持队列锁, 与 add 串行化避免覆盖。
   */
  async function removePendingSafeDirectoryCleanups(
    paths: readonly string[],
  ): Promise<void> {
    const toRemove = new Set(paths);
    if (toRemove.size === 0) return;
    await withCrossProcessLock(
      pendingSafeDirectoryCleanupLockPath(),
      { label: "git-safe-directory-cleanup", waitMs: 1_000 },
      async (status) => {
        if (!status.held) {
          throw new Error(
            "could not acquire the safe.directory cleanup queue lock",
          );
        }
        const current = readPendingSafeDirectoryCleanups();
        const next = current.filter((p) => !toRemove.has(p));
        if (next.length !== current.length)
          getCleanupStore().set("pending", next);
      },
    );
  }

  /**
   * 写入 / 覆盖一条 meta, 同时同步 DB sessions.worktree_path。
   * DB 写失败仅日志告警, 不抛(store 是 source of truth)。
   */
  async function set(sessionId: string, meta: WorktreeMeta): Promise<void> {
    if (!sessionId) throw new Error("worktreeStore.set: sessionId is required");
    await mutateRegistry((map) => {
      map[sessionId] = meta;
    });
    try {
      await setWorktreePathInDb(sessionId, meta.path);
    } catch (err) {
      log.warn(
        `[worktreeStore] DB sync failed for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * 删除 store 条目。**不**清 sessions.worktree_path(保留历史值, 徽标按 store 判)。
   */
  async function del(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await mutateRegistry((map) => {
      delete map[sessionId];
    });
  }

  /** Atomically replace a pooled registration under the registry lock. */
  async function replace(
    previousSessionId: string,
    sessionId: string,
    meta: WorktreeMeta,
    expected?: WorktreeMeta,
    beforeMutation?: () => Promise<void>,
  ): Promise<void> {
    if (!sessionId)
      throw new Error("worktreeStore.replace: sessionId is required");
    await mutateRegistry((map) => {
      if (
        expected &&
        (JSON.stringify(map[previousSessionId]) !== JSON.stringify(expected) ||
          (previousSessionId !== sessionId && map[sessionId]))
      ) {
        throw new Error("Worktree ownership changed during transfer");
      }
      if (previousSessionId && previousSessionId !== sessionId)
        delete map[previousSessionId];
      map[sessionId] = meta;
    }, beforeMutation);
    try {
      await setWorktreePathInDb(sessionId, meta.path);
    } catch (err) {
      log.warn(
        `[worktreeStore] DB sync failed for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function mutateRegistry(
    mutate: (map: Record<string, WorktreeMeta>) => void,
    beforeMutation?: () => Promise<void>,
  ): Promise<void> {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    await withCrossProcessLock(
      path.join(os.tmpdir(), `cindy-worktree-registry-${uid}.lock`),
      { label: "worktree-registry" },
      async (status) => {
        if (!status.held) throw new Error("worktree registry is busy");
        if (beforeMutation) await beforeMutation();
        const map = readMap();
        mutate(map);
        writeMap(map);
      },
    );
  }

  return {
    getAll,
    get,
    getAllPaths,
    getPendingSafeDirectoryCleanups,
    addPendingSafeDirectoryCleanups,
    removePendingSafeDirectoryCleanups,
    set,
    del,
    replace,
  };
}
