/**
 * worktree 恢复（P1，对齐 Codex Desktop 的 snapshot-restore 思路）：
 * 会话的 worktree 被回收后（删除/归档/历史误删），从保留的 `cindy/<name>`
 * 或历史 `xdt/<name>` 分支重建
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
import { readAttachedWorktreeBranch } from './attachedBranch';
import { gitExec, GitExecError } from './gitExec';
import { ensureManagedWorktreeExcluded } from './managedWorktreeExclude';
import { buildMultiboxRestoreArgs, deferCarriedMultiboxConfig, logMultiboxAddResult, shouldUseMultibox } from './multibox';
import { applyWorktreeIncludeFile } from './includePatternsEngine';
import { pathKey, type WorktreeRestoreRequester } from './liveSessionRefs';
import {
  getWorktreeRestoreMutation,
  getWorktreeRestoreMutationVersion,
  withWorktreeRestoreMutation,
} from './restoreLock';
import { copyClaudeSiviDirs } from './WorktreeManager';
import { hasRecordedRecovery, restoreRecordedWorktree } from './restoreRecovery';
import { readRecycleRecord, worktreeGeneration } from './recycleJournal';
import { withWorktreeResourceLock } from './resourceLock';
import * as store from './worktreeStore';
import { getCurrentDbClientSnapshot, getDbClient, type CurrentDbClientSnapshot } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';
import {
  getManagedWorktreeBranchCandidates,
  isManagedWorktreeBranchForName,
} from '../../shared/managedWorktreeBranches';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';

import type { WorktreeMeta } from './types';

const log = createLogger('worktreeRestore');
const restoreInFlight = new Map<string, Promise<WorktreeRestoreResult>>();
const restoreRequestsInFlight = new Map<string, Promise<WorktreeRestoreResult>>();
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
}

interface WorktreeRestorePlan {
  status: WorktreeRestoreStatus;
  parsed?: ParsedManagedPath;
  branch?: string;
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
    return { baseRepo: path.dirname(parent), name };
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

async function readSessionWorktreeBinding(
  sessionId: string,
): Promise<SessionWorktreeBinding | null> {
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

function findRegisteredWorktreeOwner(worktreePath: string, ownMeta: WorktreeMeta | null): WorktreeMeta | null {
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return null;
  if (ownMeta && pathKey(ownMeta.path) === worktreeKey) return ownMeta;
  return store.getAll().find((meta) => pathKey(meta.path) === worktreeKey) ?? null;
}

async function readJournalOwnerSessionId(worktreePath: string): Promise<string | null> {
  const record = await readRecycleRecord(worktreePath);
  return hasRecordedRecovery(record)
    && (record.phase === 'snapshotted' || record.phase === 'removing' ||
      record.phase === 'removed' || record.phase === 'restoring')
    && pathKey(record.meta.path) === pathKey(worktreePath)
    ? record.meta.sessionId
    : null;
}

async function readWorktreeOwnerSessionId(
  worktreePath: string,
  sessionId: string,
  hasWorktreeBinding: boolean,
  ownMeta: WorktreeMeta | null,
): Promise<string | null> {
  const registeredOwner = findRegisteredWorktreeOwner(worktreePath, ownMeta);
  if (registeredOwner?.sessionId === sessionId) return sessionId;

  const journalOwnerId = !registeredOwner && hasWorktreeBinding
    ? await readJournalOwnerSessionId(worktreePath)
    : null;
  const ownerId = registeredOwner?.sessionId ?? journalOwnerId;
  if (ownerId === sessionId) return sessionId;

  const db = getDbClient().drizzle;
  if (ownerId) {
    // A saved owner from another account or a deleted task is not a recovery
    // target, and its registration or recovery record cannot be claimed by a borrower.
    const [row] = await db
      .select({ status: sessions.status, worktreePath: sessions.worktreePath })
      .from(sessions)
      .where(eq(sessions.id, ownerId));
    return row && (row.status === 'active' || row.status === 'archived')
      && (registeredOwner || pathKey(row.worktreePath) === pathKey(worktreePath))
      ? ownerId : null;
  }
  if (hasWorktreeBinding) return sessionId;

  const worktreeKey = pathKey(worktreePath);
  const rows = await db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      status: sessions.status,
    })
    .from(sessions)
    .where(ne(sessions.status, 'deleted'));
  const matchingRows = rows.filter(
    (row) => row.status !== 'deleted' && pathKey(row.worktreePath) === worktreeKey,
  );
  return matchingRows.find((row) => row.status === 'active')?.id ?? matchingRows[0]?.id ?? null;
}

function makeRestoreRequester(
  sessionId: string,
  binding: SessionWorktreeBinding | null,
  worktreePath: string,
  snapshot: CurrentDbClientSnapshot | null,
): WorktreeRestoreRequester | undefined {
  if (!snapshot || !binding?.workingDir || pathKey(binding.worktreePath) !== pathKey(worktreePath)
    || pathKey(findManagedWorktreeRoot(binding.workingDir)) !== pathKey(worktreePath)) return undefined;
  return {
    sessionId,
    workingDir: binding.workingDir,
    worktreePath,
    isCurrent: () => getCurrentDbClientSnapshot() === snapshot,
  };
}

async function readWorktreeRestoreTarget(sessionId: string) {
  const snapshot = getCurrentDbClientSnapshot();
  const ownMeta = store.get(sessionId);
  const binding = ownMeta ? null : await readSessionWorktreeBinding(sessionId);
  const worktreePath = ownMeta?.path ?? binding?.worktreePath;
  if (!worktreePath || !parseManagedWorktreePath(worktreePath)) return null;
  const ownerSessionId = await readWorktreeOwnerSessionId(worktreePath, sessionId, true, ownMeta);
  if (!ownerSessionId || snapshot !== getCurrentDbClientSnapshot()) return null;
  const requester = ownerSessionId === sessionId
    ? undefined
    : makeRestoreRequester(sessionId, binding, worktreePath, snapshot);
  return ownerSessionId === sessionId || requester ? { ownerSessionId, worktreePath, requester } : null;
}

async function refExists(baseRepo: string, ref: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(['rev-parse', '--verify', '--quiet', ref], baseRepo);
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
  return (
    (await refExists(baseRepo, localBranchRef(branch))) ||
    (await refExists(baseRepo, originBranchRef(branch)))
  );
}

type RestorableBranchResolution =
  | { state: 'found'; branch: string }
  | { state: 'missing' }
  | { state: 'ambiguous'; branches: string[] };

/**
 * 目录已经回收时只允许恢复到确定的分支：Store 里的精确分支优先；否则新旧
 * 托管前缀只能唯一命中。两个候选同时存在时 fail closed，避免把快照套到错误基底。
 */
async function resolveRestorableBranch(
  baseRepo: string,
  name: string,
  storedBranch?: string,
): Promise<RestorableBranchResolution> {
  if (
    storedBranch &&
    isManagedWorktreeBranchForName(storedBranch, name) &&
    (await hasRestorableBranch(baseRepo, storedBranch))
  ) {
    return { state: 'found', branch: storedBranch };
  }

  const candidates = getManagedWorktreeBranchCandidates(name);
  const matches: string[] = [];
  for (const branch of candidates) {
    if (await hasRestorableBranch(baseRepo, branch)) matches.push(branch);
  }
  if (matches.length === 1) return { state: 'found', branch: matches[0] };
  if (matches.length === 0) return { state: 'missing' };
  return { state: 'ambiguous', branches: matches };
}

/**
 * PR cleanup may have removed the local managed branch while leaving its origin tracking ref.
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
  snapshot?: string,
): Promise<void> {
  await ensureManagedWorktreeExcluded(baseRepo, worktreePath);
  // Multibox also carries a local untracked .multibox.toml. If the pending stash holds
  // that path, defer only the just-copied base-identical config until snapshot apply.
  // Errors stay visible, never retried as a plain `git worktree add`.
  if (await shouldUseMultibox(baseRepo)) {
    const { stdout } = await gitExec(buildMultiboxRestoreArgs(worktreePath, branch), baseRepo);
    logMultiboxAddResult(worktreePath, stdout);
    if (snapshot) await deferCarriedMultiboxConfig(baseRepo, worktreePath, snapshot);
    return;
  }
  const addArgs = ['-c', 'core.longpaths=true', 'worktree', 'add', worktreePath, branch];
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
  branch: string,
): WorktreeMeta {
  return {
    sessionId,
    name: parsed.name,
    path: worktreePath,
    baseRepo: parsed.baseRepo,
    branch,
    // 原始 sourceBranch 在回收时随 store 条目丢失,恢复后以自身分支占位
    // (仅影响 UI 显示,不参与任何 git 操作)。
    sourceBranch: branch,
    createdAt: new Date().toISOString(),
  };
}

async function finishRestoredWorktree(
  sessionId: string,
  parsed: ParsedManagedPath,
  worktreePath: string,
  branch: string,
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
      `[restore] apply worktree include files failed for ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await store.set(sessionId, restoredWorktreeMeta(sessionId, parsed, worktreePath, branch));
}

async function getWorktreeRestorePlan(
  sessionId: string,
  worktreePath: string,
  registeredMeta: WorktreeMeta | null,
): Promise<WorktreeRestorePlan> {
  const parsed = parseManagedWorktreePath(worktreePath);
  if (!parsed) return { status: { state: 'no-worktree' } };
  const recovery = await readRecycleRecord(worktreePath, sessionId);
  if (recovery?.phase === 'restored' && registeredMeta
    && [recovery.generation, recovery.restoredGeneration].includes(worktreeGeneration(registeredMeta))
    && await pathExists(worktreePath)) {
    return { status: { state: 'present', worktreePath, hasSnapshot: false }, parsed };
  }
  if (hasRecordedRecovery(recovery) && ['removed', 'removing', 'restoring'].includes(recovery.phase)) {
    return { status: { state: 'restorable', worktreePath, hasSnapshot: true }, parsed };
  }

  const registeredForPath =
    registeredMeta && pathKey(registeredMeta.path) === pathKey(worktreePath)
      ? registeredMeta
      : null;
  const restoreName = registeredForPath?.name || parsed.name;
  const restoreParsed = restoreName === parsed.name ? parsed : { ...parsed, name: restoreName };

  if (await pathExists(worktreePath)) {
    const pending = await findPendingSnapshot(
      restoreParsed.baseRepo,
      sessionId,
      restoreParsed.name,
    );
    const attachedBranch = await readAttachedWorktreeBranch(worktreePath);
    const branch =
      attachedBranch && isManagedWorktreeBranchForName(attachedBranch, restoreParsed.name)
        ? attachedBranch
        : undefined;
    if (attachedBranch && !branch) {
      log.warn(
        `[restore] preserved existing worktree registration gap at ${worktreePath}: ` +
          `HEAD branch ${attachedBranch} is not managed for ${restoreParsed.name}`,
      );
    }
    return {
      status: { state: 'present', worktreePath, hasSnapshot: pending !== null },
      parsed: restoreParsed,
      ...(branch ? { branch } : {}),
    };
  }
  if (!(await pathExists(restoreParsed.baseRepo))) {
    return { status: { state: 'gone', worktreePath }, parsed: restoreParsed };
  }
  const branchResolution = await resolveRestorableBranch(
    restoreParsed.baseRepo,
    restoreParsed.name,
    registeredForPath?.branch,
  );
  if (branchResolution.state === 'ambiguous') {
    log.warn(
      `[restore] ambiguous managed branches for ${worktreePath}; refusing to guess:`,
      branchResolution.branches,
    );
    return { status: { state: 'gone', worktreePath }, parsed: restoreParsed };
  }
  if (branchResolution.state === 'missing') {
    return { status: { state: 'gone', worktreePath }, parsed: restoreParsed };
  }
  const hasSnapshot =
    (await findPendingSnapshot(restoreParsed.baseRepo, sessionId, restoreParsed.name)) !== null;
  return {
    status: { state: 'restorable', worktreePath, hasSnapshot },
    parsed: restoreParsed,
    branch: branchResolution.branch,
  };
}

/** 查询会话 worktree 的可恢复状态（restore 横幅数据源）。任何异常都归入 no-worktree/gone 保守分支。 */
export async function getWorktreeRestoreStatus(sessionId: string): Promise<WorktreeRestoreStatus> {
  let target: Awaited<ReturnType<typeof readWorktreeRestoreTarget>>;
  let registeredMeta: WorktreeMeta | null;
  try {
    target = await readWorktreeRestoreTarget(sessionId);
    if (!target) return { state: 'no-worktree' };
    registeredMeta = store.get(target.ownerSessionId);
  } catch (err) {
    log.warn(
      `[restore] status lookup failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { state: 'no-worktree' };
  }
  return (await getWorktreeRestorePlan(target.ownerSessionId, target.worktreePath, registeredMeta)).status;
}

/**
 * 一键恢复：用 Store 保存的精确分支，或唯一命中的 cindy/* / xdt/* 分支重建，
 * 然后 apply 内容快照并重新登记 store。
 * 快照 apply 失败时保留目录与快照，但移除 store 登记，避免后续回收把新编辑
 * 覆盖到同一个 snapshot ref；重试成功后才恢复本地配置并重新登记。
 */
async function restoreWorktreeForSessionOnce(
  sessionId: string,
  worktreePath: string,
  requester?: WorktreeRestoreRequester,
): Promise<WorktreeRestoreResult> {
  if (requester) {
    if (!requester.isCurrent()) return { ok: false, reason: 'no-worktree' };
    const binding = await readSessionWorktreeBinding(requester.sessionId);
    if (!requester.isCurrent() || pathKey(binding?.workingDir) !== pathKey(requester.workingDir)
      || pathKey(binding?.worktreePath) !== pathKey(worktreePath)) {
      return { ok: false, reason: 'no-worktree' };
    }
  }
  const registeredMeta = store.get(sessionId);
  const currentPath = registeredMeta?.path ?? (await readSessionWorktreeBinding(sessionId))?.worktreePath;
  if (pathKey(currentPath) !== pathKey(worktreePath)) return { ok: false, reason: 'no-worktree' };
  const registeredOwner = findRegisteredWorktreeOwner(worktreePath, registeredMeta);
  const ownerId = registeredOwner?.sessionId ?? await readJournalOwnerSessionId(worktreePath);
  if (ownerId && ownerId !== sessionId) {
    return { ok: false, reason: 'no-worktree' };
  }
  const plan = await getWorktreeRestorePlan(sessionId, worktreePath, registeredMeta);
  if (requester && !requester.isCurrent()) return { ok: false, reason: 'no-worktree' };
  const { status } = plan;
  if ('worktreePath' in status) {
    try {
      const restored = await restoreRecordedWorktree(sessionId, status.worktreePath, requester);
      if (restored !== null) return { ok: restored, snapshotApplied: restored, ...(restored ? {} : { reason: 'git-error' as const }) };
    } catch (error) {
      return { ok: false, reason: 'git-error', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (status.state === 'present') {
    const parsed = plan.parsed ?? parseManagedWorktreePath(status.worktreePath);
    if (!parsed) return { ok: true, snapshotApplied: true };
    if (!status.hasSnapshot) {
      if (!store.get(sessionId) && plan.branch) {
        await finishRestoredWorktree(sessionId, parsed, status.worktreePath, plan.branch);
      }
      return { ok: true, snapshotApplied: true };
    }
    if (!plan.branch) {
      log.warn(
        `[restore] preserved pending snapshot for ${status.worktreePath}: ` +
          'cannot confirm the expected managed HEAD branch',
      );
      return { ok: true, snapshotApplied: false };
    }
    const snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      await store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    if (!store.get(sessionId) && plan.branch) {
      await finishRestoredWorktree(sessionId, parsed, status.worktreePath, plan.branch);
    }
    return { ok: true, snapshotApplied };
  }
  if (status.state !== 'restorable') {
    return { ok: false, reason: status.state === 'gone' ? 'gone' : 'no-worktree' };
  }
  const parsed = plan.parsed!;
  const branch = plan.branch!;
  let snapshotApplied: boolean;

  try {
    // 目录被手动删过时 git 元数据可能残留，先 prune 对账再 add。
    await gitExec(['worktree', 'prune'], parsed.baseRepo).catch(() => undefined);
    await ensureLocalBranchForRestore(parsed.baseRepo, branch);
    const pending = await findPendingSnapshot(parsed.baseRepo, sessionId, parsed.name);
    await addRestoredWorktree(parsed.baseRepo, status.worktreePath, branch, pending?.sha);
    // 快照必须先于本地配置恢复：未跟踪文件可能同时命中 .claude/.sivi 或
    // .xdtworktreeinclude / .worktreeinclude，提前拷贝会让 git stash apply 因目标已存在而失败。
    snapshotApplied = await applyPendingSnapshot(
      parsed.baseRepo,
      status.worktreePath,
      sessionId,
      parsed.name,
    );
    if (!snapshotApplied) {
      await store.del(sessionId);
      return { ok: true, snapshotApplied: false };
    }
    await finishRestoredWorktree(sessionId, parsed, status.worktreePath, branch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[restore] worktree add failed for ${status.worktreePath}:`, msg);
    return { ok: false, reason: 'git-error', detail: msg };
  }

  log.info(
    `[restore] worktree restored at ${status.worktreePath} (session ${sessionId}, snapshotApplied=${snapshotApplied})`,
  );
  return { ok: true, snapshotApplied };
}

/** UI 恢复与发送期自愈按实际 owner 共享一次 git mutation。 */
function restoreOwnedWorktreeForSession(
  sessionId: string,
  worktreePath: string,
  requester?: WorktreeRestoreRequester,
): Promise<WorktreeRestoreResult> {
  const existing = restoreInFlight.get(sessionId);
  if (existing) return existing;
  const tracked = withWorktreeRestoreMutation(sessionId, () =>
    withWorktreeResourceLock(worktreePath, () => restoreWorktreeForSessionOnce(sessionId, worktreePath, requester)),
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

export function restoreWorktreeForSession(
  sessionId: string,
  notifyChanged?: (ownerSessionId: string) => void,
): Promise<WorktreeRestoreResult> {
  const existing = restoreRequestsInFlight.get(sessionId);
  if (existing) return existing;
  const owner = getCurrentDbClientSnapshot();
  const request = readWorktreeRestoreTarget(sessionId).then(async (target) => {
    if (!target) return { ok: false, reason: 'no-worktree' as const };
    const result = await restoreOwnedWorktreeForSession(target.ownerSessionId, target.worktreePath, target.requester);
    // The registry is keyed by the owner, including when a borrower requests restoration.
    if (result.ok && notifyChanged && owner && getCurrentDbClientSnapshot() === owner) {
      try {
        notifyChanged(target.ownerSessionId);
      } catch {
        log.warn('[restore] worktree change notification failed');
      }
    }
    return result;
  }).finally(() => { restoreRequestsInFlight.delete(sessionId); });
  restoreRequestsInFlight.set(sessionId, request);
  return request;
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

export type ManagedWorktreeReadiness = 'ready' | 'gone' | 'retry';

// Legacy restore status folds probe errors into `gone`. Require successful probes
// before letting a send permanently select a conversation fallback.
async function confirmedMissingWorktree(worktreePath: string): Promise<boolean> {
  try {
    await fs.stat(worktreePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  const parsed = parseManagedWorktreePath(worktreePath);
  if (!parsed) return false;
  try {
    const { stdout } = await gitExec(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], parsed.baseRepo);
    const refs = new Set(stdout.trim().split(/\r?\n/));
    return getManagedWorktreeBranchCandidates(parsed.name).every((branch) =>
      !refs.has(localBranchRef(branch)) && !refs.has(originBranchRef(branch)));
  } catch {
    return false;
  }
}

async function ensureOwnedWorktreeReady(
  ownerSessionId: string,
  worktreePath: string,
  requester?: WorktreeRestoreRequester,
): Promise<ManagedWorktreeReadiness> {
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return 'retry';
  const readinessKey = `${ownerSessionId}\0${worktreeKey}`;

  // `git worktree add` creates the directory before a pending snapshot is applied. A second
  // send in that window must join the same restore instead of treating the directory as ready.
  const restoring = restoreInFlight.get(ownerSessionId);
  if (restoring) {
    const restoreVersion =
      restoreInFlightVersions.get(ownerSessionId) ??
      getWorktreeRestoreMutationVersion(ownerSessionId);
    const result = await restoring;
    if (!result.ok || result.snapshotApplied === false) return result.reason === 'gone' && await confirmedMissingWorktree(worktreePath) ? 'gone' : 'retry';
    const ready = await markSendReadyIfMutationStable(
      ownerSessionId,
      worktreePath,
      readinessKey,
      restoreVersion,
    );
    return ready === null ? ensureOwnedWorktreeReady(ownerSessionId, worktreePath, requester) : ready ? 'ready' : 'retry';
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
    (await pathIsDirectory(worktreePath)) &&
    pathKey(store.get(ownerSessionId)?.path) === worktreeKey &&
    sendReadyWorktrees.get(readinessKey) === currentMutationVersion &&
    getWorktreeRestoreMutationVersion(ownerSessionId) === currentMutationVersion
  ) {
    return 'ready';
  }

  const restore = restoreOwnedWorktreeForSession(ownerSessionId, worktreePath, requester);
  const restoreVersion =
    restoreInFlightVersions.get(ownerSessionId) ??
    getWorktreeRestoreMutationVersion(ownerSessionId);
  const result = await restore;
  if (!result.ok || result.snapshotApplied === false) return result.reason === 'gone' && await confirmedMissingWorktree(worktreePath) ? 'gone' : 'retry';
  const ready = await markSendReadyIfMutationStable(
    ownerSessionId,
    worktreePath,
    readinessKey,
    restoreVersion,
  );
  return ready === null ? ensureOwnedWorktreeReady(ownerSessionId, worktreePath, requester) : ready ? 'ready' : 'retry';
}

/**
 * 发送期自愈入口。DB working_dir 必须与 caller cwd 精确相同；cwd 可以是托管
 * worktree 根目录或其子目录。恢复与 snapshot readiness 始终按 owning session 的
 * worktree 根目录串行；其它 session 借用该目录时也必须等待 owner 的 pending
 * snapshot。快照 apply 冲突时返回 retry，绝不带着缺失的 WIP 静默继续。
 */
export async function getManagedWorktreeReadinessForSession(
  sessionId: string,
  expectedWorkingDir: string,
): Promise<ManagedWorktreeReadiness> {
  const expectedKey = pathKey(expectedWorkingDir);
  if (!expectedKey) return 'retry';

  const snapshot = getCurrentDbClientSnapshot();
  let binding: SessionWorktreeBinding | null;
  try {
    binding = await readSessionWorktreeBinding(sessionId);
  } catch {
    return 'retry';
  }
  if (pathKey(binding?.workingDir) !== expectedKey) return 'retry';

  const worktreePath = findManagedWorktreeRoot(expectedWorkingDir);
  if (!worktreePath) return 'retry';
  const worktreeKey = pathKey(worktreePath);
  if (!worktreeKey) return 'retry';

  let ownerSessionId: string | null;
  try {
    ownerSessionId = await readWorktreeOwnerSessionId(
      worktreePath, sessionId, pathKey(binding?.worktreePath) === worktreeKey, store.get(sessionId),
    );
  } catch {
    return 'retry';
  }
  if (snapshot !== getCurrentDbClientSnapshot()) return 'retry';

  // An unowned managed directory remains usable as an ordinary cwd, but cannot be recreated.
  if (!ownerSessionId) return await pathIsDirectory(expectedWorkingDir) ? 'ready' : 'retry';

  const requester = ownerSessionId === sessionId ? undefined
    : makeRestoreRequester(sessionId, binding, worktreePath, snapshot);
  const ready = await ensureOwnedWorktreeReady(ownerSessionId, worktreePath, requester);
  if (snapshot !== getCurrentDbClientSnapshot()) return 'retry';
  return ready === 'ready' ? (await pathIsDirectory(expectedWorkingDir) ? 'ready' : 'retry') : ready;
}

/** Compatibility wrapper for callers that only need readiness. */
export async function restoreMissingManagedWorktreeForSession(sessionId: string, expectedWorkingDir: string): Promise<boolean> {
  return await getManagedWorktreeReadinessForSession(sessionId, expectedWorkingDir) === 'ready';
}
