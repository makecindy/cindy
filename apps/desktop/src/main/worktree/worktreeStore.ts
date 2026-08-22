/**
 * worktree-parallel-sessions: electron-store 单例 + DB 同步层。
 *
 * source of truth: electron-store userData/worktrees.json
 *   {
 *     "worktrees": {
 *       "<sessionId>": WorktreeMeta,
 *       ...
 *     }
 *   }
 *
 * set/delete 操作:
 *   - set(sid, meta): 写 store + 同步写 sessions.worktree_path = meta.path(反范式快照)
 *   - delete(sid):    清 store 条目, **不**清 sessions.worktree_path(保留历史值, 徽标按 store 判)
 *
 * pendingSafeDirectoryCleanups 队列**刻意放在独立 store 文件**(worktree-safe-directory-cleanup.json):
 * electron-store 每次 set 都整体重写整个文件, 若队列与 worktrees 同文件, 一个进程写
 * worktrees(set/del)、另一个写队列时, 两个读改写周期从同一份文件快照出发, 后写的会把
 * 先写的新增整个抹掉(丢待办路径 → 启动补清永远看不到)。分文件后两类写互不重叠。
 *
 * v8 是 ESM-only(项目 main 用 CJS 输出), 所以锁 v7 — CJS 兼容, API 完全一致。
 */

import os from 'node:os';
import path from 'node:path';

import Store from 'electron-store';

import type { WorktreeMeta } from './types';
import { setWorktreePathInDb } from '../localDb/ipc/sessions';
import { createLogger } from '../logger';
import { withCrossProcessLock } from '../device-link/crossProcessLock';

const log = createLogger('worktreeStore');

interface WorktreesStoreShape {
  worktrees: Record<string, WorktreeMeta>;
}

interface SafeDirectoryCleanupStoreShape {
  /** 删除 worktree 时因拿不到全局 safe.directory 锁而推迟到下次启动补清的路径。 */
  pending: string[];
}

let storeInstance: Store<WorktreesStoreShape> | null = null;
let cleanupStoreInstance: Store<SafeDirectoryCleanupStoreShape> | null = null;

/**
 * 懒加载单例。在 main 进程 app.whenReady 之后第一次调用时构造;
 * electron-store v7 的构造函数依赖 app.getPath('userData') (Electron app must be ready).
 */
function getStore(): Store<WorktreesStoreShape> {
  if (storeInstance) return storeInstance;
  storeInstance = new Store<WorktreesStoreShape>({
    name: 'worktrees',
    defaults: { worktrees: {} },
    // 简单 schema: worktrees 是 object, 其余字段在 TS 层兜底
    schema: {
      worktrees: { type: 'object' },
    },
    // 文件被外部破坏时 reset 为 defaults, 避免反复抛 SyntaxError
    clearInvalidConfig: true,
  });
  return storeInstance;
}

/** 队列专用 store 单例(独立文件, 见文件头注释)。 */
function getCleanupStore(): Store<SafeDirectoryCleanupStoreShape> {
  if (cleanupStoreInstance) return cleanupStoreInstance;
  cleanupStoreInstance = new Store<SafeDirectoryCleanupStoreShape>({
    name: 'worktree-safe-directory-cleanup',
    defaults: { pending: [] },
    schema: {
      pending: { type: 'array', items: { type: 'string' } },
    },
    clearInvalidConfig: true,
  });
  return cleanupStoreInstance;
}

/** 测试钩子: 注入自定义 store(单测里用 mock)。 */
export function _setStoreForTests(s: Store<WorktreesStoreShape> | null): void {
  storeInstance = s;
}

function readMap(): Record<string, WorktreeMeta> {
  const raw = getStore().get('worktrees', {});
  // 防御: 历史/损坏数据可能不是 object
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, WorktreeMeta>;
}

function writeMap(map: Record<string, WorktreeMeta>): void {
  getStore().set('worktrees', map);
}

export function getAll(): WorktreeMeta[] {
  return Object.values(readMap());
}

export function get(sessionId: string): WorktreeMeta | null {
  if (!sessionId) return null;
  return readMap()[sessionId] ?? null;
}

/**
 * 读取所有已记录的 worktree 路径(供 isManagedWorktreePath 三条校验用)。
 */
export function getAllPaths(): string[] {
  return getAll().flatMap((m) => (
    m.quarantinePath ? [m.path, m.quarantinePath] : [m.path]
  ));
}

function readPendingSafeDirectoryCleanups(): string[] {
  const raw = getCleanupStore().get('pending', []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * pendingSafeDirectoryCleanups 队列「读改写」的专用跨进程锁。
 *
 * 与 gitExec 的 safe.directory 锁分开: 这里只保护 electron-store 上「读列表 → 合并
 * → 写回」这微秒级的一步;若与 --add/--unset-all 共用同一把锁, 删除侧拿不到锁时连
 * 落盘兜底都做不了, 反而复现「两个进程各读同一份列表、后写覆盖先写」的丢路径窗口。
 */
function pendingSafeDirectoryCleanupLockPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cindy-git-safe-directory-cleanup-${uid}.lock`);
}

/**
 * 读取当前推迟清理的 safe.directory 路径(供启动期 reconcile 补清)。
 */
export function getPendingSafeDirectoryCleanups(): string[] {
  return readPendingSafeDirectoryCleanups();
}

/**
 * 追加推迟清理的路径(去重)。读改写全程持队列锁, 避免并发实例丢更新。
 */
export async function addPendingSafeDirectoryCleanups(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].filter((p) => p && p.length > 0);
  if (unique.length === 0) return;
  await withCrossProcessLock(
    pendingSafeDirectoryCleanupLockPath(),
    { label: 'git-safe-directory-cleanup', waitMs: 1_000 },
    async (status) => {
      if (!status.held) {
        throw new Error('could not acquire the safe.directory cleanup queue lock');
      }
      const existing = new Set(readPendingSafeDirectoryCleanups());
      let changed = false;
      for (const p of unique) {
        if (!existing.has(p)) {
          existing.add(p);
          changed = true;
        }
      }
      if (changed) getCleanupStore().set('pending', [...existing]);
    },
  );
}

/**
 * 移除已成功清理的路径。读改写全程持队列锁, 与 add 串行化避免覆盖。
 */
export async function removePendingSafeDirectoryCleanups(paths: readonly string[]): Promise<void> {
  const toRemove = new Set(paths);
  if (toRemove.size === 0) return;
  await withCrossProcessLock(
    pendingSafeDirectoryCleanupLockPath(),
    { label: 'git-safe-directory-cleanup', waitMs: 1_000 },
    async (status) => {
      if (!status.held) {
        throw new Error('could not acquire the safe.directory cleanup queue lock');
      }
      const current = readPendingSafeDirectoryCleanups();
      const next = current.filter((p) => !toRemove.has(p));
      if (next.length !== current.length) getCleanupStore().set('pending', next);
    },
  );
}

/**
 * 写入 / 覆盖一条 meta, 同时同步 DB sessions.worktree_path。
 * DB 写失败仅日志告警, 不抛(store 是 source of truth)。
 */
export async function set(sessionId: string, meta: WorktreeMeta): Promise<void> {
  if (!sessionId) throw new Error('worktreeStore.set: sessionId is required');
  const map = readMap();
  map[sessionId] = meta;
  writeMap(map);
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
export function del(sessionId: string): void {
  if (!sessionId) return;
  const map = readMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeMap(map);
}
