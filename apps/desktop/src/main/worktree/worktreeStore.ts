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

import { createWorktreeStore } from '@cindy/worktree-core/store';

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
    // 损坏记录必须保留，不能重置为空后把未知资源当作无引用目录。
    clearInvalidConfig: false,
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

const registry = createWorktreeStore({
  getStore,
  getCleanupStore,
  setWorktreePathInDb,
  log,
  withCrossProcessLock,
});
export const {
  getAll,
  get,
  getAllPaths,
  getPendingSafeDirectoryCleanups,
  addPendingSafeDirectoryCleanups,
  removePendingSafeDirectoryCleanups,
  set,
  del,
  replace,
} = registry;
