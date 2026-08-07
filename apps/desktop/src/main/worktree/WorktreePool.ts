/**
 * Worktree 池化复用：为 scheduler 场景缓存已创建的 ephemeral worktree，
 * 避免每次 session 都走完整的 createWorktree 10 步 pipeline。
 *
 * 池按 baseRepo 索引，容量 1（scheduler 串行，不需要更多）。
 * store（electron-store JSON）持久化 meta，app 重启时 recoverPool() 恢复池状态。
 *
 * 核心原则：pool 只持有 clean worktree，dirty worktree 永远不自动删除。
 * 淘汰策略：不使用 idle timeout，改为全局数量上限（MAX_WORKTREES）按 createdAt 淘汰 clean 条目。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { gitExec } from './gitExec';
import { boundedNetworkGitOpts, NET_TOTAL_BUDGET_MS } from './freshBase';
import { isWorktreeDirty } from './dirty';
import { copyClaudeSiviDirs } from './WorktreeManager';
import * as WorktreeManager from './WorktreeManager';
import { applyWorktreeIncludeFile } from './includePatternsEngine';
import {
  hasLiveSessionReference,
  loadLiveSessionPathKeys,
  type LiveSessionPathKeys,
} from './liveSessionRefs';
import { getBranchName } from './nameGenerator';
import { hasKeepSentinel, isManagedWorktreePath } from './safety';
import * as store from './worktreeStore';
import { createLogger } from '../logger';

import type { CreateWorktreeReq, CreateWorktreeResp, WorktreeMeta } from './types';

const log = createLogger('WorktreePool');

const MAX_WORKTREES = 5;

interface PoolEntry {
  meta: WorktreeMeta;
}

// 按 baseRepo 绝对路径索引，容量 1
const pool = new Map<string, PoolEntry>();
// 防 acquire/release 跨 await 竞态：正在 acquire 的 key 不允许 release 入池
const inflight = new Set<string>();

function repoKey(baseRepo: string): string {
  return path.resolve(baseRepo);
}

// ── acquire ──────────────────────────────────────────────────────────────────

/**
 * 从池中获取或新建 worktree。
 * 池命中时走 resetWorktree（~1-2s），未命中时走 createWorktree（完整 pipeline）。
 */
export async function acquireWorktree(
  req: CreateWorktreeReq,
  opts?: {
    /** 调用方已在本次创建流程内完成对 sourceBranch 的网络刷新尝试(成功、失败或
     * 预算耗尽放弃都算,如 scheduler 路径的 resolveFreshSourceBranch):池复用重置
     * 时一律不再二次 fetch——离线时首次尝试已耗掉整份网络预算,这里再开一份新预算
     * 就把总等待翻倍了。 */
    sourceFetchAlreadyAttempted?: boolean;
  },
): Promise<CreateWorktreeResp> {
  const key = repoKey(req.baseRepo);
  inflight.add(key);
  try {
    const entry = pool.get(key);

    if (entry) {
      pool.delete(key);

      try {
        const resolvedName = await WorktreeManager.resolveAvailableWorktreeName(
          entry.meta.baseRepo,
          req.name,
        );
        const newBranch = getBranchName(resolvedName);
        await resetWorktree(
          entry.meta.path,
          entry.meta.baseRepo,
          req.sourceBranch,
          newBranch,
          opts,
        );

        const meta: WorktreeMeta = {
          ...entry.meta,
          sessionId: req.sessionId,
          name: resolvedName,
          branch: newBranch,
          sourceBranch: req.sourceBranch,
          createdAt: new Date().toISOString(),
        };
        await store.set(req.sessionId, meta);

        log.info(
          `[WorktreePool] reusing pooled worktree at ${meta.path} for session ${req.sessionId}`,
        );
        return { ok: true, meta };
      } catch (err) {
        log.warn(
          '[WorktreePool] resetWorktree failed, falling back to fresh creation:',
          err instanceof Error ? err.message : String(err),
        );
        if (await isWorktreeDirty(entry.meta.path)) {
          log.warn(`[WorktreePool] dirty worktree preserved at ${entry.meta.path}`);
        } else {
          const drained = await drainEntry(entry.meta)
            .then(() => true)
            .catch(async () => {
              await gitExec(['worktree', 'prune'], entry.meta.baseRepo).catch(() => {});
              return false;
            });
          if (drained) store.del(entry.meta.sessionId);
        }
      }
    }

    return WorktreeManager.createWorktree(req);
  } finally {
    inflight.delete(key);
  }
}

// ── reset ────────────────────────────────────────────────────────────────────

/**
 * 将已有 worktree 重置到新分支 + 干净状态。
 * 比全 createWorktree 快 10x+（跳过 worktree add、stageCheckout、background checkout）。
 */
async function resetWorktree(
  worktreePath: string,
  baseRepo: string,
  sourceBranch: string,
  newBranch: string,
  opts?: { sourceFetchAlreadyAttempted?: boolean },
): Promise<void> {
  // 防御性断言：池中 worktree 理论上必定 clean
  if (await isWorktreeDirty(worktreePath)) {
    throw new Error(`[WorktreePool] BUG: attempted to reset dirty worktree at ${worktreePath}`);
  }

  // 1. 如果 sourceBranch 引用远端（如 origin/main），先 fetch 确保本地有最新。
  //    调用方声明本次创建已做过网络刷新尝试时跳过——成功则二次 fetch 纯浪费,失败
  //    (离线)则重试也会再挂满一份预算,把承诺的总等待上限翻倍;仅对未声明的调用方
  //    保留该 fetch,且受限(真超时 + 禁终端凭证提问),失败非致命退 stale ref——池化
  //    复用不允许被网络或凭证 helper 无限卡住。
  // sourceBranch 可能是完整远端跟踪引用(refs/remotes/origin/x,freshBase 为消除
  // 与同名本地分支的歧义所产出)或历史短名(origin/x),两种形态都要识别。
  const remoteBranch = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(sourceBranch)?.[1];
  if (!opts?.sourceFetchAlreadyAttempted && remoteBranch !== undefined) {
    try {
      await gitExec(
        ['fetch', 'origin', remoteBranch],
        baseRepo,
        boundedNetworkGitOpts(NET_TOTAL_BUDGET_MS),
      );
    } catch (err) {
      log.warn(
        `[WorktreePool] git fetch failed (non-fatal, using stale ref):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 2. 非覆盖式创建并切换分支。查重后的 TOCTOU 竞态会让 -b 安全失败，
  //    绝不能用 -B 重置一个不属于池条目的已有分支。
  await gitExec(['checkout', '--no-track', '-b', newBranch, sourceBranch], worktreePath);

  // 3. 确保 index 与 HEAD 一致（上次 agent 可能 git add 了文件但未 commit）
  await gitExec(['reset', '--hard', sourceBranch], worktreePath);

  // 4. 清理上次 agent 的残留文件（untracked + ignored）
  await gitExec(['clean', '-fdx'], worktreePath);

  // 5. 重新拷贝 .claude/.sivi（被 git clean 删掉了，池化路径跳过 stageCheckout 所以必须成功）
  await copyClaudeSiviDirs(baseRepo, worktreePath);

  // 6. 重新拷贝 .xdtworktreeinclude 文件
  try {
    await applyWorktreeIncludeFile(baseRepo, worktreePath);
  } catch (err) {
    log.warn(
      '[WorktreePool] applyWorktreeIncludeFile failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── release ──────────────────────────────────────────────────────────────────

/**
 * 将 ephemeral worktree 归还池中（仅 clean 的才入池）。
 *
 * 返回值：
 * - 'pooled'    — clean 且未被 live session 引用，已入池
 * - 'preserved' — dirty 或 inflight 冲突，保留在磁盘和 store 中，不入池也不删除
 * - false       — 前置条件不满足（非 ephemeral / meta 不存在 / 路径无效）
 */
export async function releaseWorktree(sessionId: string): Promise<'pooled' | 'preserved' | false> {
  const meta = store.get(sessionId);
  if (!meta?.ephemeral) return false;

  try {
    await fs.access(meta.path);
  } catch {
    return false;
  }

  const key = repoKey(meta.baseRepo);

  // 正在 acquire 中（跨 await），不入池，保留在 store 中等下次恢复
  if (inflight.has(key)) return 'preserved';

  // 哨兵: 用户声明"目录在用"，不入池不重置，原样留在磁盘。
  if (hasKeepSentinel(meta.path)) {
    log.info(`[WorktreePool] worktree at ${meta.path} has .worktree-keep sentinel, preserving`);
    return 'preserved';
  }

  // dirty worktree: pool 不自动 stash；一旦 agent 写过文件，就不应再把它转成可淘汰资源。
  if (await isWorktreeDirty(meta.path)) {
    log.warn(`[WorktreePool] worktree at ${meta.path} has uncommitted changes, preserving`);
    return 'preserved';
  }

  const liveSessionPathKeys = await loadLiveSessionPathKeys({ contextPath: meta.path });
  if (hasLiveSessionReference(meta, liveSessionPathKeys)) {
    logPreservedLiveSessionWorktree(meta);
    return 'preserved';
  }

  // 池中已有同 repo 条目（理论上不会发生，防御性处理）
  const existing = pool.get(key);
  if (existing) {
    pool.delete(key);
    if (hasLiveSessionReference(existing.meta, liveSessionPathKeys)) {
      logPreservedLiveSessionWorktree(existing.meta);
    } else {
      const drained = await drainEntry(existing.meta)
        .then(() => true)
        .catch(() => false);
      if (drained) {
        store.del(existing.meta.sessionId);
      }
    }
  }

  // 保留 store 条目（不调 store.del）——app 崩溃后重启时 store 中仍可追踪这条 worktree，
  // removeWorktreeForSession 可正常清理。acquire 时会用新 sessionId 覆盖 store.set。

  pool.set(key, { meta });
  log.info(`[WorktreePool] pooled worktree at ${meta.path}`);

  // 入池后检查数量上限
  await evictIfOverLimit(liveSessionPathKeys);

  return 'pooled';
}

// ── evict ────────────────────────────────────────────────────────────────────

/**
 * store 中 worktree 总数超过 MAX_WORKTREES 时，
 * 按 createdAt 从旧到新淘汰 clean 条目，dirty 条目永远不淘汰。
 * 允许因全部 dirty 而超限（不能因历史残留拒绝新工作）。
 */
async function evictIfOverLimit(liveSessionPathKeys?: LiveSessionPathKeys): Promise<void> {
  if (store.getAll().length <= MAX_WORKTREES) return;

  const liveRefs =
    liveSessionPathKeys === undefined ? await loadLiveSessionPathKeys() : liveSessionPathKeys;

  // 每轮重新读 store 取最旧的 clean 候选，避免 stale snapshot 问题
  while (store.getAll().length > MAX_WORKTREES) {
    const candidate = await findOldestCleanCandidate(liveRefs);
    if (!candidate) break; // 剩余全是 dirty / 池中在用，允许超限

    const drained = await drainEntry(candidate)
      .then(() => true)
      .catch(() => false);
    if (drained) store.del(candidate.sessionId);
    else break;
  }
}

/** 从 store 中找到最旧的、可淘汰的 clean 条目。 */
async function findOldestCleanCandidate(
  liveSessionPathKeys: LiveSessionPathKeys,
): Promise<WorktreeMeta | null> {
  const sorted = store.getAll().sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const meta of sorted) {
    // 非 ephemeral 条目是用户自己的 session，归正常 session 生命周期管理，
    // 不是池资源，永远不作为数量淘汰候选。
    if (!meta.ephemeral) continue;

    // 跳过当前池中正在使用的条目
    const key = repoKey(meta.baseRepo);
    if (pool.has(key) && pool.get(key)!.meta.sessionId === meta.sessionId) continue;

    // 仍被未删除 session 引用的 worktree 不是池资源，不能淘汰。
    if (hasLiveSessionReference(meta, liveSessionPathKeys)) continue;

    // 路径不存在直接清 store，视为本轮淘汰成功
    try {
      await fs.access(meta.path);
    } catch {
      store.del(meta.sessionId);
      return null; // store 已缩减，让外层 while 重新检查
    }

    // 哨兵: 用户声明保留，永不淘汰
    if (hasKeepSentinel(meta.path)) continue;

    // 只淘汰 clean 的
    if (await isWorktreeDirty(meta.path)) continue;

    return meta;
  }
  return null;
}

// ── drain ────────────────────────────────────────────────────────────────────

async function drainEntry(meta: WorktreeMeta): Promise<void> {
  try {
    await gitExec(['worktree', 'remove', '--force', meta.path], meta.baseRepo);
    log.info(`[WorktreePool] drained worktree at ${meta.path}`);
  } catch (err) {
    log.warn(
      `[WorktreePool] git worktree remove failed for ${meta.path}:`,
      err instanceof Error ? err.message : String(err),
    );
    if (!isManagedWorktreePath(meta.path, meta.baseRepo, store.getAllPaths())) {
      log.warn(`[WorktreePool] fs.rm fallback skipped for unmanaged path: ${meta.path}`);
      throw err;
    }

    // 兜底：只允许删除 Cindy 已登记的托管 worktree 目录
    try {
      await fs.rm(meta.path, { recursive: true, force: true });
      await gitExec(['worktree', 'prune'], meta.baseRepo).catch(() => {});
      log.info(`[WorktreePool] drained worktree via fs.rm at ${meta.path}`);
    } catch (rmErr) {
      log.error(
        `[WorktreePool] fs.rm fallback failed for ${meta.path}:`,
        rmErr instanceof Error ? rmErr.message : String(rmErr),
      );
      throw rmErr;
    }
  }
}

// pathKey / loadLiveSessionPathKeys / hasLiveSessionReference 已抽到 liveSessionRefs.ts
// (P0 重构:removeWorktreeForSession 的删除守卫复用同一套判定)。

function logPreservedLiveSessionWorktree(meta: WorktreeMeta): void {
  // MR1 安全策略：在 MR2 收敛生命周期事实源之前，live session 引用会阻止入池和淘汰，
  // 因此 ephemeral worktree 的池复用率会显著下降。
  log.info(`[WorktreePool] preserved live session worktree at ${meta.path}`);
}

/** 清空指定 repo 的池条目。 */
export async function drainOne(baseRepo: string): Promise<void> {
  const key = repoKey(baseRepo);
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  await drainEntry(entry.meta);
  store.del(entry.meta.sessionId);
}

// ── park / recover ──────────────────────────────────────────────────────────

/** app 退出时调用：清除内存状态，磁盘和 store 条目保留供下次启动恢复。 */
export function parkAll(): void {
  pool.clear();
}

/**
 * app 启动时调用：扫描 store 中残留的 worktree 条目，
 * 有效、clean 且未被 live session 引用的 ephemeral worktree 重新加入池，
 * dirty 的保留在 store 中记录日志，
 * 路径已不存在的清除 store 条目。
 * 最后执行数量上限淘汰。
 */
export async function recoverPool(): Promise<void> {
  const all = store.getAll();
  const liveSessionPathKeys = await loadLiveSessionPathKeys();

  // 按 createdAt 降序（最新在前），确保同 repo 冲突时保留最新的
  const sorted = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const meta of sorted) {
    // 1. 路径是否还存在
    try {
      await fs.access(meta.path);
    } catch {
      log.info(`[WorktreePool] stale store entry removed: ${meta.path}`);
      store.del(meta.sessionId);
      continue;
    }

    // 2. 哨兵: 用户声明保留，不入池不清理
    if (hasKeepSentinel(meta.path)) {
      log.info(
        `[WorktreePool] preserved sentinel worktree at ${meta.path} (session ${meta.sessionId})`,
      );
      continue;
    }

    // 3. 检查 dirty
    const dirty = await isWorktreeDirty(meta.path);
    if (dirty) {
      log.warn(
        `[WorktreePool] preserved dirty worktree at ${meta.path} (session ${meta.sessionId})`,
      );
      continue;
    }

    // 4. clean + ephemeral → 入池（最新的先入池，后续同 repo 的被 drain）
    if (meta.ephemeral) {
      const key = repoKey(meta.baseRepo);
      if (!pool.has(key)) {
        if (hasLiveSessionReference(meta, liveSessionPathKeys)) {
          logPreservedLiveSessionWorktree(meta);
        } else {
          pool.set(key, { meta });
          log.info(`[WorktreePool] recovered pooled worktree at ${meta.path}`);
        }
      } else {
        if (hasLiveSessionReference(meta, liveSessionPathKeys)) {
          logPreservedLiveSessionWorktree(meta);
        } else {
          const drained = await drainEntry(meta)
            .then(() => true)
            .catch(() => false);
          if (drained) store.del(meta.sessionId);
        }
      }
    }
    // clean + non-ephemeral: 保留在 store 中，不主动清除
    // （可能属于仍有效的用户 session，由正常 session 生命周期管理）
  }

  await evictIfOverLimit(liveSessionPathKeys);
}
