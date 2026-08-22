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
 * v8 是 ESM-only(项目 main 用 CJS 输出), 所以锁 v7 — CJS 兼容, API 完全一致。
 */

import Store from 'electron-store';

import type { WorktreeMeta } from './types';
import { setWorktreePathInDb } from '../localDb/ipc/sessions';
import { createLogger } from '../logger';

const log = createLogger('worktreeStore');

interface WorktreesStoreShape {
  worktrees: Record<string, WorktreeMeta>;
  /**
   * 删除 worktree 时因拿不到全局 safe.directory 锁而推迟到下次启动补清的路径。
   * 只存自动生成的托管路径, 供 reconcilePendingSafeDirectoryCleanups 逐条精确 --unset-all。
   */
  pendingSafeDirectoryCleanups: string[];
}

let storeInstance: Store<WorktreesStoreShape> | null = null;

/**
 * 懒加载单例。在 main 进程 app.whenReady 之后第一次调用时构造;
 * electron-store v7 的构造函数依赖 app.getPath('userData') (Electron app must be ready).
 */
function getStore(): Store<WorktreesStoreShape> {
  if (storeInstance) return storeInstance;
  storeInstance = new Store<WorktreesStoreShape>({
    name: 'worktrees',
    defaults: { worktrees: {}, pendingSafeDirectoryCleanups: [] },
    // 简单 schema: worktrees 是 object, 其余字段在 TS 层兜底
    schema: {
      worktrees: { type: 'object' },
      pendingSafeDirectoryCleanups: { type: 'array', items: { type: 'string' } },
    },
    // 文件被外部破坏时 reset 为 defaults, 避免反复抛 SyntaxError
    clearInvalidConfig: true,
  });
  return storeInstance;
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
  const raw = getStore().get('pendingSafeDirectoryCleanups', []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * 读取当前推迟清理的 safe.directory 路径(供启动期 reconcile 补清)。
 */
export function getPendingSafeDirectoryCleanups(): string[] {
  return readPendingSafeDirectoryCleanups();
}

/**
 * 追加推迟清理的路径(去重)。删除 worktree 时拿不到锁才走到这里。
 */
export function addPendingSafeDirectoryCleanups(paths: readonly string[]): void {
  const unique = new Set(readPendingSafeDirectoryCleanups());
  let changed = false;
  for (const p of paths) {
    if (p && !unique.has(p)) {
      unique.add(p);
      changed = true;
    }
  }
  if (changed) getStore().set('pendingSafeDirectoryCleanups', [...unique]);
}

/**
 * 移除已成功清理的路径。
 */
export function removePendingSafeDirectoryCleanups(paths: readonly string[]): void {
  const current = readPendingSafeDirectoryCleanups();
  const toRemove = new Set(paths);
  const next = current.filter((p) => !toRemove.has(p));
  if (next.length !== current.length) getStore().set('pendingSafeDirectoryCleanups', next);
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
