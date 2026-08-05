/**
 * worktree 恢复（P1，对齐 Codex Desktop 的 snapshot-restore 思路）：
 * 会话的 worktree 被回收后（删除/归档/历史误删），从保留的分支 `xdt/<name>` 重建
 * worktree，并把回收时留下的内容快照（refs/xdt/snapshots/<sessionId>，见 dirty.ts）
 * apply 回去，一键恢复到回收前的状态。
 *
 * 数据来源：sessions.worktree_path（回收时刻意不清，见 worktreeStore.del 注释）。
 * 路径必须能解析为 `<baseRepo>/.cindy-worktrees/<name>` 或历史
 * `<baseRepo>/.xdt-worktrees/<name>` 托管形态，其它一律按 no-worktree
 * 处理——绝不对非托管路径做 git 写操作。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { eq, ne } from 'drizzle-orm';

import {
  clearSnapshotRef,
  getRestorableAutoStashSha,
  getRestorableSnapshotSha,
  markSnapshotConsumed,
} from './dirty';
import { gitExec, GitExecError } from './gitExec';
import { applyWorktreeIncludeFile } from './includePatternsEngine';
import { pathKey } from './liveSessionRefs';
import {
  getWorktreeRestoreMutation,
  getWorktreeRestoreMutationVersion,
  withWorktreeRestoreMutation,
} from './restoreLock';
import { copyClaudeSiviDirs } from './WorktreeManager';
import * as store from './worktreeStore';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';

import type { WorktreeMeta } from './types';

const log = createLogger('worktreeRestore');
const restoreInFlight = new Map<string, Promise<WorktreeRestoreResult>>();
const restoreInFlightVersions = new Map<string, number>();
const sendReadyWorktrees = new Map<string, number>();

export type WorktreeRestoreStatus =
  /** worktree 目录还在，无需恢复。 */
  | { state: 'present'; worktreePath: string; hasSnapshot?: boolean }
  /** 会话从没有托管 worktree（或路径无法安全解析），无恢复语义。 */
  | { state: 'no-worktree' }
  /** 目录没了但本地或 origin tracking 分支还在，可重建；hasSnapshot = 是否留了脏内容快照。 */
  | { state: 'restorable'; worktreePath: string; hasSnapshot: boolean }
  /** 本地与 origin tracking 分支都没了（或 baseRepo 不存在），产品内无法恢复。 */
  | { state: 'gone'; worktreePath: string };

export interface WorktreeRestoreResult {
  ok: boolean;
  /** ok=true 时：脏内容快照是否成功 apply（无快照时为 true）。 */
  snapshotApplied?: boolean;
  /** ok=false 时的稳定原因；renderer 侧负责 i18n 映射。 */
  reason?: 'gone' | 'no-worktree' | 'git-error';
  /** 诊断细节，不直接展示为用户文案。 */
  detail?: string;
}

interface ParsedManagedPath {
  baseRepo: string;
  name: string;
  branch: string;
}

interface SessionWorktreeBinding {
  workingDir: string | null;
  worktreePath: string | null;
}

/** 只认 Cindy 当前或历史托管 worktree 形态；解析失败返回 null。 */
function parseManagedWorktreePath(worktreePath: string): ParsedManagedPath | null {
  try {
    const resolved = path.resolve(worktreePath);
    const parent = path.dirname(resolved);
    if (!isManagedWorktreeDirectoryName(path.basename(parent))) return null;
    const name = path.basename(resolved);
    if (!name) return null;
    return { baseRepo: path.dirname(parent), name, branch: `xdt/${name}` };
  } catch {
    return null;
  }
}

/** Resolves the managed worktree root for either the root itself or one of its descendants. */
function findManagedWorktreeRoot(candidatePath: string): string | null {
  try {
    let current = path.resolve(candidatePath);
    for (;;) {
      if (parseManagedWorktreePath(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readSessionWorktreeBinding(sessionId: string): Promise<SessionWorktreeBinding | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      workingDir: sessions.workingDir,
      worktreePath: sessions.worktreePath,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return rows[0] ?? null;
}

async function readWorktreeOwnerSessionId(worktreePath: string): Promise<string | null> {
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return null;

  const registeredOwner = store.getAll().find((meta) => pathKey(meta.path) === worktreeKey);
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      status: sessions.status,
    })
    .from(sessions)
    .where(ne(sessions.status, 'deleted'));
  if (registeredOwner && rows.some((row) => (
    row.id === registeredOwner.sessionId && row.status !== 'deleted'
  ))) {
    return registeredOwner.sessionId;
  }
  const matchingRows = rows.filter((row) => (
    row.status !== 'deleted' && pathKey(row.worktreePath) === worktreeKey
  ));
  return matchingRows.find((row) => row.status === 'active')?.id
    ?? matchingRows[0]?.id
    ?? null;
}

async function refExists(baseRepo: string, ref: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(
      ['rev-parse', '--verify', '--quiet', ref],
      baseRepo,
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function localBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function originBranchRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

async function hasRestorableBranch(baseRepo: string, branch: string): Promise<boolean> {
  return await refExists(baseRepo, localBranchRef(branch))
    || await refExists(baseRepo, originBranchRef(branch));
}

/**
 * PR cleanup may have removed the local xdt/* branch while leaving origin/xdt/*.
 * Recreate only that exact local branch from the already-fetched tracking ref; restore never
 * performs network I/O, changes the primary checkout, or guesses a different commit.
 */
async function ensureLocalBranchForRestore(baseRepo: string, branch: string): Promise<void> {
  if (await refExists(baseRepo, localBranchRef(branch))) return;
  const remoteRef = originBranchRef(branch);
  if (!(await refExists(baseRepo, remoteRef))) {
    throw new Error(`restorable branch not found: ${branch}`);
  }
  try {
    await gitExec(['branch', branch, remoteRef], baseRepo);
  } catch (err) {
    // Another Cindy instance or manual recovery may have created it after our first probe.
    if (await refExists(baseRepo, localBranchRef(branch))) return;
    throw err;
  }
}

async function addRestoredWorktree(
  baseRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const addArgs = [
    '-c',
    'core.longpaths=true',
    'worktree',
    'add',
    worktreePath,
    branch,
  ];
  try {
    await gitExec(addArgs, baseRepo);
  } catch (err) {
    if (!(err instanceof GitExecError) || !/filename too long|core\.longpaths/i.test(err.stderr)) {
      throw err;
    }
    await gitExec(['config', '--global', 'core.longpaths', 'true']);
    await gitExec(addArgs, baseRepo);
  }
}

async function findPendingSnapshot(
  baseRepo: string,
  sessionId: string,
  worktreeName: string,
): Promise<{ sha: string; source: 'snapshot' | 'stash' } | null> {
  const snapshotSha = await getRestorableSnapshotSha(baseRepo, sessionId);
  if (snapshotSha) return { sha: snapshotSha, source: 'snapshot' };
  const fallbackStashSha = await getRestorableAutoStashSha(baseRepo, sessionId, worktreeName);
  if (fallbackStashSha) return { sha: fallbackStashSha, source: 'stash' };
  return null;
}

async function applyPendingSnapshot(
  baseRepo: string,
  worktreePath: string,
  sessionId: string,
  worktreeName: string,
): Promise<boolean> {
  const pending = await findPendingSnapshot(baseRepo, sessionId, worktreeName);
  if (!pending) return true;
  try {
    // stash-form commit 可直接 apply，不依赖 stash 栈。ref 在成功 apply 后清理：
    // 内容已回到 worktree，后续再次回收如果仍 dirty 会生成新的 snapshot。
    await gitExec(['stash', 'apply', pending.sha], worktreePath);
    if (pending.source === 'snapshot') {
      await clearSnapshotRef(baseRepo, sessionId);
    }
    await markSnapshotConsumed(baseRepo, sessionId, pending.sha);
    return true;
  } catch (err) {
    log.warn(
      `[restore] snapshot apply failed for ${worktreePath} (${pending.sha.slice(0, 12)}):`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function restoredWorktreeMeta(
  sessionId: string,
  parsed: ParsedManagedPath,
  worktreePath: string,
): WorktreeMeta {
  return {
    sessionId,
    name: parsed.name,
    path: worktreePath,
    baseRepo: parsed.baseRepo,
    branch: parsed.branch,
    // 原始 sourceBranch 在回收时随 store 条目丢失,恢复后以自身分支占位
    // (仅影响 UI 显示,不参与任何 git 操作)。
    sourceBranch: parsed.branch,
    createdAt: new Date().toISOString(),
  };
}

async function finishRestoredWorktree(
  sessionId: string,
  parsed: ParsedManagedPath,
  worktreePath: string,
): Promise<void> {
  await copyClaudeSiviDirs(parsed.baseRepo, worktreePath, {
    overwriteExisting: false,
  }).catch((err) => {
    log.warn(
      `[restore] copy .claude/.sivi failed for ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await applyWorktreeIncludeFile(parsed.baseRepo, worktreePath, {
    overwriteExisting: false,
  }).catch((err) => {
    log.warn(
      `[restore] apply .xdtworktreeinclude failed for ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await store.set(sessionId, restoredWorktreeMeta(sessionId, parsed, worktreePath));
}

/** 查询会话 worktree 的可恢复状态（restore 横幅数据源）。任何异常都归入 no-worktree/gone 保守分支。 */
export async function getWorktreeRestoreStatus(sessionId: string): Promise<WorktreeRestoreStatus> {
  let worktreePath: string | null = null;
  try {
    worktreePath = store.get(sessionId)?.path
      ?? (await readSessionWorktreeBinding(sessionId))?.worktreePath
      ?? null;
  } catch (err) {
    log.warn(`[restore] session lookup failed for ${sessionId}:`, err instanceof Error ? err.message : String(err));
    return { state: 'no-worktree' };
  }
  if (!worktreePath) return { state: 'no-worktree' };
  const parsed = parseManagedWorktreePath(worktreePath);
  if (!parsed) return { state: 'no-worktree' };

  if (await pathExists(worktreePath)) {
    const pending = await findPendingSnapshot(parsed.baseRepo, sessionId, parsed.name);
    return { state: 'present', worktreePath, hasSnapshot: pending !== null };
  }
  if (!(await pathExists(parsed.baseRepo))) return { state: 'gone', worktreePath };
  if (!(await hasRestorableBranch(parsed.baseRepo, parsed.branch))) {
    return { state: 'gone', worktreePath };
  }
  const hasSnapshot = (await findPendingSnapshot(parsed.baseRepo, sessionId, parsed.name)) !== null;
  return { state: 'restorable', worktreePath, hasSnapshot };
}

/**
 * 一键恢复：`git worktree add <path> xdt/<name>` 重建 + apply 内容快照 + 重新登记 store。
 * 快照 apply 失败时保留目录与快照，但移除 store 登记，避免后续回收把新编辑
 * 覆盖到同一个 snapshot ref；重试成功后才恢复本地配置并重新登记。
 */
async function restoreWorktreeForSessionOnce(sessionId: string): Promise<WorktreeRestoreResult> {
  const status = await getWorktreeRestoreStatus(sessionId);
  if (status.state === 'present') {
    const parsed = parseManagedWorktreePath(status.worktreePath);
    if (!parsed) return { ok: true, snapshotApplied: true };
    if (!status.hasSnapshot) {
      if (!store.get(sessionId)) {
        await finishRestoredWorktree(sessionId, parsed, status.worktreePath);
      }
      return { ok: true, snapshotApplied: true };
    }
    const snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    if (!store.get(sessionId)) {
      await finishRestoredWorktree(sessionId, parsed, status.worktreePath);
    }
    return { ok: true, snapshotApplied };
  }
  if (status.state !== 'restorable') {
    return { ok: false, reason: status.state === 'gone' ? 'gone' : 'no-worktree' };
  }
  const parsed = parseManagedWorktreePath(status.worktreePath)!;
  let snapshotApplied: boolean;

  try {
    // 目录被手动删过时 git 元数据可能残留，先 prune 对账再 add。
    await gitExec(['worktree', 'prune'], parsed.baseRepo).catch(() => undefined);
    await ensureLocalBranchForRestore(parsed.baseRepo, parsed.branch);
    await addRestoredWorktree(parsed.baseRepo, status.worktreePath, parsed.branch);
    // 快照必须先于本地配置恢复：未跟踪文件可能同时命中 .claude/.sivi 或
    // .xdtworktreeinclude，提前拷贝会让 git stash apply 因目标已存在而失败。
    snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    await finishRestoredWorktree(sessionId, parsed, status.worktreePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[restore] worktree add failed for ${status.worktreePath}:`, msg);
    return { ok: false, reason: 'git-error', detail: msg };
  }

  log.info(`[restore] worktree restored at ${status.worktreePath} (session ${sessionId}, snapshotApplied=${snapshotApplied})`);
  return { ok: true, snapshotApplied };
}

/** 同一 session 的 UI 恢复与发送期自愈共享一次 git mutation，避免并发 worktree add。 */
export function restoreWorktreeForSession(sessionId: string): Promise<WorktreeRestoreResult> {
  const existing = restoreInFlight.get(sessionId);
  if (existing) return existing;
  const tracked = withWorktreeRestoreMutation(
    sessionId,
    () => restoreWorktreeForSessionOnce(sessionId),
  ).finally(() => {
    if (restoreInFlight.get(sessionId) === tracked) {
      restoreInFlight.delete(sessionId);
      restoreInFlightVersions.delete(sessionId);
    }
  });
  restoreInFlight.set(sessionId, tracked);
  restoreInFlightVersions.set(sessionId, getWorktreeRestoreMutationVersion(sessionId));
  return tracked;
}

async function markSendReadyIfMutationStable(
  ownerSessionId: string,
  worktreePath: string,
  readinessKey: string,
  restoreVersion: number,
): Promise<boolean | null> {
  const ready = await pathIsDirectory(worktreePath);
  if (getWorktreeRestoreMutationVersion(ownerSessionId) !== restoreVersion) {
    const laterMutation = getWorktreeRestoreMutation(ownerSessionId);
    if (laterMutation) await laterMutation;
    return null;
  }
  if (ready) sendReadyWorktrees.set(readinessKey, restoreVersion);
  return ready;
}

async function ensureOwnedWorktreeReady(
  ownerSessionId: string,
  worktreePath: string,
): Promise<boolean> {
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return false;
  const readinessKey = `${ownerSessionId}\0${worktreeKey}`;

  // `git worktree add` creates the directory before a pending snapshot is applied. A second
  // send in that window must join the same restore instead of treating the directory as ready.
  const restoring = restoreInFlight.get(ownerSessionId);
  if (restoring) {
    const restoreVersion = restoreInFlightVersions.get(ownerSessionId)
      ?? getWorktreeRestoreMutationVersion(ownerSessionId);
    const result = await restoring;
    if (!result.ok || result.snapshotApplied === false) return false;
    const ready = await markSendReadyIfMutationStable(
      ownerSessionId,
      worktreePath,
      readinessKey,
      restoreVersion,
    );
    return ready ?? ensureOwnedWorktreeReady(ownerSessionId, worktreePath);
  }

  // Recycle cancellation/removal also owns this lock while the snapshot is detached from the
  // clean worktree. Wait for it, then re-check the store/snapshot state below.
  const mutating = getWorktreeRestoreMutation(ownerSessionId);
  if (mutating) await mutating;

  const currentMutationVersion = getWorktreeRestoreMutationVersion(ownerSessionId);

  // The first send in this process reconciles legacy states where a pending snapshot and store
  // registration both survived an interrupted cleanup. WorktreeManager now unregisters as soon
  // as it snapshots, so later sends use this zero-Git fast path until a later restore mutation
  // invalidates the versioned readiness entry.
  if (
    await pathIsDirectory(worktreePath)
    && store.get(ownerSessionId)
    && sendReadyWorktrees.get(readinessKey) === currentMutationVersion
    && getWorktreeRestoreMutationVersion(ownerSessionId) === currentMutationVersion
  ) {
    return true;
  }

  const restore = restoreWorktreeForSession(ownerSessionId);
  const restoreVersion = restoreInFlightVersions.get(ownerSessionId)
    ?? getWorktreeRestoreMutationVersion(ownerSessionId);
  const result = await restore;
  if (!result.ok || result.snapshotApplied === false) return false;
  const ready = await markSendReadyIfMutationStable(
    ownerSessionId,
    worktreePath,
    readinessKey,
    restoreVersion,
  );
  return ready ?? ensureOwnedWorktreeReady(ownerSessionId, worktreePath);
}

/**
 * 发送期自愈入口。DB working_dir 必须与 caller cwd 精确相同；cwd 可以是托管
 * worktree 根目录或其子目录。恢复与 snapshot readiness 始终按 owning session 的
 * worktree 根目录串行；其它 session 借用该目录时也必须等待 owner 的 pending
 * snapshot。快照 apply 冲突时返回 false，绝不带着缺失的 WIP 静默继续。
 */
export async function restoreMissingManagedWorktreeForSession(
  sessionId: string,
  expectedWorkingDir: string,
): Promise<boolean> {
  const expectedKey = pathKey(expectedWorkingDir);
  if (!expectedKey) return false;

  let binding: SessionWorktreeBinding | null;
  try {
    binding = await readSessionWorktreeBinding(sessionId);
  } catch {
    return false;
  }
  if (pathKey(binding?.workingDir) !== expectedKey) return false;

  const worktreePath = findManagedWorktreeRoot(expectedWorkingDir);
  if (!worktreePath) return false;
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return false;

  let ownerSessionId: string | null;
  if (pathKey(binding?.worktreePath) === worktreeKey) {
    ownerSessionId = sessionId;
  } else {
    try {
      ownerSessionId = await readWorktreeOwnerSessionId(worktreePath);
    } catch {
      return false;
    }
  }

  // An unowned managed directory remains usable as an ordinary cwd, but cannot be recreated.
  if (!ownerSessionId) return await pathIsDirectory(expectedWorkingDir);

  const ready = await ensureOwnedWorktreeReady(ownerSessionId, worktreePath);
  return ready && await pathIsDirectory(expectedWorkingDir);
}
