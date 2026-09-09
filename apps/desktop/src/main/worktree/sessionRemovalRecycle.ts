/**
 * 会话显式删除/归档后的 worktree 回收入口(P0 重构:回收的唯一驱动点)。
 *
 * 背景:原实现把 removeWorktreeForSession 挂在 Maker lifecycleHooks.onClose
 * (SDK 子进程退出)上——但 close 是进程生命周期事件,不是"用户不要这个工作区了"
 * 的意图信号:/clear、鉴权重连、app 退出、CLI 崩溃都会触发,导致活会话的 worktree
 * 被静默 stash+删除(2026-07 实报)。重构后:
 *   - onClose 只做 ephemeral worktree 的池化归还(scheduler 生命周期,不变);
 *   - 非 ephemeral worktree 的回收只由本模块驱动,触发点是 localDb 会话
 *     status → 'deleted' / 'archived' 的显式状态变更(见 localDb/ipc/sessions.ts)。
 *
 * 回收意图在状态写库前持久化；数据库和关闭运行时的服务都就绪后恢复重试。
 * 历史登记仅分类审计，查不到当前账号的任务不构成删除依据。
 */

import { eq } from 'drizzle-orm';
import { auditRegisteredWorktrees } from './recycleMaintenance';

import { hasLiveSessionReference, pathKey } from './liveSessionRefs';
import { removeWorktreeForSession } from './WorktreeManager';
import * as store from './worktreeStore';
import { getDbClient } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';

const log = createLogger('sessionRemovalRecycle');

/**
 * 会话被显式删除/归档后回收其 worktree。
 *
 * - ephemeral(scheduler 池)worktree 直接跳过:它的生命周期归 WorktreePool
 *   (onClose 池化、recoverPool、数量上限淘汰),这里删会与池内条目打架。
 * - 非 ephemeral 走 removeWorktreeForSession，保存可恢复内容后通过删除安全门。
 *
 * 调用方约定:先确保该会话的 CLI 子进程已关闭(Windows 下子进程 cwd 在
 * worktree 内会锁目录,git worktree remove 必败),再调本函数。
 */
export interface RecycleWorktreeForRemovedSessionOptions {
  db?: DbClient['drizzle'];
  isOwnerCurrent?: () => boolean;
  /** Internal guard: owner retries reuse this entry point without starting another owner scan. */
  scanOwners?: boolean;
  /** Runtime truth used by the live-reference guard for archived/deleted borrowers. */
  isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
  /**
   * Owner retries must go back through the caller's route lock + CLI close chain before
   * entering this low-level remover. Omitted callers preserve the owner rather than
   * deleting it without the required runtime shutdown.
   */
  recycleOwner?: (sessionId: string) => Promise<void>;
}

/**
 * 回收通知只关心 store 中实际登记过 worktree 的 session。这个窄查询由状态回收链
 * 在真正进入低层回收前调用，避免无 worktree 的普通任务也广播 worktree 变化。
 */
export function hasRegisteredWorktreeForSession(sessionId: string): boolean {
  return store.get(sessionId) !== null;
}

export async function recycleWorktreeForRemovedSession(
  sessionId: string,
  options: RecycleWorktreeForRemovedSessionOptions = {},
): Promise<void> {
  try {
    await recycleOwnWorktreeForRemovedSession(sessionId, options);
  } finally {
    if (options.scanOwners !== false) {
      const ownerSessionIds = await findOwningWorktreeSessionIds(sessionId);
      for (const ownerSessionId of ownerSessionIds) {
        if (options.recycleOwner) {
          await options.recycleOwner(ownerSessionId);
        } else {
          log.warn(
            `[sessionRemovalRecycle] preserving owner ${ownerSessionId}: no runtime-close callback`,
          );
        }
      }
    }
  }
}

/**
 * 只处理 session 自身登记的 worktree。是否存在自身 meta、是否为 ephemeral，均不影响
 * 顶层入口随后扫描共享 owner。
 */
async function recycleOwnWorktreeForRemovedSession(
  sessionId: string,
  options: Pick<RecycleWorktreeForRemovedSessionOptions, 'db' | 'isOwnerCurrent' | 'isSessionRuntimeAlive'>,
): Promise<void> {
  const meta = store.get(sessionId);
  if (!meta) return;
  if (meta.ephemeral) {
    log.debug(
      `[sessionRemovalRecycle] skip ephemeral worktree for session ${sessionId} (pool-managed)`,
    );
    return;
  }
  const db = options.db ?? getDbClient().drizzle;
  const isOwnerCurrent = options.isOwnerCurrent ?? (() => true);
  if (!isOwnerCurrent()) return;
  const status = await readCurrentSessionStatus(sessionId, db);
  if (status !== 'deleted' && status !== 'archived') {
    log.info(
      `[sessionRemovalRecycle] skip worktree recycle for session ${sessionId}: current status=${status ?? 'missing'}`,
    );
    return;
  }
  await removeWorktreeForSession(sessionId, {
    isSessionRuntimeAlive: options.isSessionRuntimeAlive,
    canRemove: async () => {
      if (!isOwnerCurrent()) return false;
      const currentStatus = await readCurrentSessionStatus(sessionId, db);
      return currentStatus === 'deleted' || currentStatus === 'archived';
    },
  });
}

/**
 * 读取终态共享 session 的路径，并从 store 中找精确匹配或安全父子路径关系的 owner。
 * 这个 helper 只负责一次扫描，不递归触发其它 session 的扫描；owner 回收由调用方
 * 重新经过 recycleWorktreeForRemovedSession 与 removeWorktreeForSession 安全门。
 */
async function findOwningWorktreeSessionIds(sessionId: string): Promise<string[]> {
  const row = await readSessionRecycleSnapshot(sessionId);
  if (
    !row ||
    row.source === 'bot' ||
    (row.status !== 'deleted' && row.status !== 'archived')
  )
    return [];

  const sharedPathKeys = new Set<string>();
  const workingDirKey = pathKey(row.workingDir);
  const worktreePathKey = pathKey(row.worktreePath);
  if (workingDirKey) sharedPathKeys.add(workingDirKey);
  if (worktreePathKey) sharedPathKeys.add(worktreePathKey);
  if (sharedPathKeys.size === 0) return [];

  return store
    .getAll()
    .filter(
      (owner) =>
        !owner.ephemeral &&
        owner.sessionId !== sessionId &&
        hasLiveSessionReference(owner, sharedPathKeys),
    )
    .map((owner) => owner.sessionId);
}

interface SessionRecycleSnapshot {
  status: string | null | undefined;
  source: string | null | undefined;
  workingDir: string | null;
  worktreePath: string | null;
}

async function readSessionRecycleSnapshot(
  sessionId: string,
): Promise<SessionRecycleSnapshot | null> {
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        status: sessions.status,
        source: sessions.source,
        workingDir: sessions.workingDir,
        worktreePath: sessions.worktreePath,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row ?? null;
  } catch (err) {
    log.warn(
      `[sessionRemovalRecycle] session recycle snapshot lookup failed for ${sessionId}; preserving worktree`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 动态回收任务在关闭 CLI / 删除 worktree 前共用的实时状态守卫。
 * 查询失败按不可回收处理，宁可保留也不误关已恢复为 active 的会话。
 */
export async function isSessionStillRemovable(
  sessionId: string,
  db: DbClient['drizzle'] = getDbClient().drizzle,
): Promise<boolean> {
  const status = await readCurrentSessionStatus(sessionId, db);
  return status === 'deleted' || status === 'archived';
}

async function readCurrentSessionStatus(
  sessionId: string,
  db: DbClient['drizzle'],
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ status: sessions.status, source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (row?.source === 'bot') return null;
    return row?.status ?? null;
  } catch (err) {
    log.warn(
      `[sessionRemovalRecycle] session status lookup failed for ${sessionId}; preserving worktree`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 兼容旧启动入口：仅生成登记分类，不把历史状态或缺失任务推断成回收意图。
 */
export async function reconcileWorktreesForDeletedSessions(): Promise<void> {
  // Historical rows are evidence, not a deletion request. Durable retries are
  // dispatched by recycleMaintenance after DB and runtime-close services are ready.
  await auditRegisteredWorktrees();
}
