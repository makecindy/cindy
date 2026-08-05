import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { gitExec } from './gitExec';
import { createLogger } from '../logger';

const log = createLogger('worktree:dirty');

/** git status --porcelain 非空 = dirty。git 执行失败时保守视为 dirty（不删）。 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(['status', '--porcelain'], worktreePath);
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * 会话快照 ref 命名（P1）：脏 worktree 回收前的内容快照存放点。
 *
 * 命名空间 ref 按会话隔离、不会冲突；stash-form commit 本身可以直接
 * `git stash apply <sha>` 恢复。转存成功后仍保留原 stash 条目作为冗余备份：
 * 自动 drop 需要按 stash reflog index 操作，进程外 stash 竞争下存在误删风险。
 *
 * 同一会话多次快照只保留最新一份（update-ref 覆盖）。
 */
export function snapshotRefForSession(sessionId: string): string {
  return `refs/xdt/snapshots/${sessionId}`;
}

function consumedSnapshotRefForSession(sessionId: string): string {
  return `refs/xdt/snapshots-consumed/${sessionId}`;
}

/** 读取会话快照 commit sha；无快照返回 null。repoPath 传 baseRepo 或 worktree 均可（refs 共享）。 */
export async function getSnapshotSha(
  repoPath: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const { stdout } = await gitExec(
      ['rev-parse', '--verify', '--quiet', snapshotRefForSession(sessionId)],
      repoPath,
    );
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** 读取尚未恢复过的会话快照；残留但已消费的 ref 不得再次 apply。 */
export async function getRestorableSnapshotSha(
  repoPath: string,
  sessionId: string,
): Promise<string | null> {
  const sha = await getSnapshotSha(repoPath, sessionId);
  if (!sha) return null;
  const consumedSha = await getConsumedSnapshotSha(repoPath, sessionId);
  return consumedSha === sha ? null : sha;
}

/**
 * 删除会话快照 ref（best-effort，ref 不存在 / git 失败都静默）。
 *
 * 快照 ref 的语义是「该会话**最近一次**回收时的脏内容」，两处必须主动清：
 * 1. clean 回收：本轮没有脏内容，上一轮回收留下的旧 ref 已过期——不清的话
 *    恢复流程会把早已 commit / 丢弃过的旧改动重新 apply 回来；
 * 2. dirty 回收但转存失败：新内容留在 stash 栈，旧 ref 同样过期。
 */
export async function clearSnapshotRef(repoPath: string, sessionId: string): Promise<void> {
  try {
    await gitExec(['update-ref', '-d', snapshotRefForSession(sessionId)], repoPath);
    log.info(`[dirty] cleared stale snapshot ref for session ${sessionId}`);
  } catch {
    // ref 本就不存在（最常见）或 git 不可用——两种情况都无需处理
  }
}

// 快照转存涉及共享 stash 栈。用模块级 promise 链把本进程内的 auto-stash 全程
// 串行化（操作低频，全局单锁足够）；进程外的手工 git stash 竞争通过“不自动
// drop stash 条目”规避 index 漂移误删。
let stashOpChain: Promise<void> = Promise.resolve();

function withStashLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stashOpChain.then(fn, fn);
  stashOpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** `git stash list` 解析为 [{sha, subject}]。 */
async function listStashEntries(
  worktreePath: string,
): Promise<Array<{ sha: string; subject: string }>> {
  const { stdout } = await gitExec(['stash', 'list', '--format=%H%x09%gs'], worktreePath);
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha: (sha ?? '').trim(), subject: rest.join('\t') };
    });
}

export async function getAutoStashSha(
  repoPath: string,
  sessionId: string,
  worktreeName?: string,
): Promise<string | null> {
  try {
    const entries = await listStashEntries(repoPath);
    if (worktreeName) {
      const marker = `xdt-auto-stash: session ${sessionId} worktree=${worktreeName}`;
      return entries.find((e) => e.subject.endsWith(marker))?.sha ?? null;
    }
    const marker = `xdt-auto-stash: session ${sessionId} worktree=`;
    return entries.find((e) => e.subject.includes(marker))?.sha ?? null;
  } catch (err) {
    log.warn(
      `[dirty] stash fallback lookup failed for session ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export async function getRestorableAutoStashSha(
  repoPath: string,
  sessionId: string,
  worktreeName?: string,
): Promise<string | null> {
  const sha = await getAutoStashSha(repoPath, sessionId, worktreeName);
  if (!sha) return null;
  const consumedSha = await getConsumedSnapshotSha(repoPath, sessionId);
  return consumedSha === sha ? null : sha;
}

async function getConsumedSnapshotSha(
  repoPath: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const { stdout } = await gitExec(
      ['rev-parse', '--verify', '--quiet', consumedSnapshotRefForSession(sessionId)],
      repoPath,
    );
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function markSnapshotConsumed(
  repoPath: string,
  sessionId: string,
  sha: string,
): Promise<void> {
  try {
    await gitExec(['update-ref', consumedSnapshotRefForSession(sessionId), sha], repoPath);
  } catch (err) {
    log.warn(
      `[dirty] failed to mark snapshot consumed for session ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function clearConsumedSnapshotRef(repoPath: string, sessionId: string): Promise<void> {
  try {
    await gitExec(['update-ref', '-d', consumedSnapshotRefForSession(sessionId)], repoPath);
  } catch {
    // best effort
  }
}

/**
 * 对 dirty worktree 执行内容快照，成功后 worktree 变为 clean 状态，返回 true。
 * 失败（无改动、git 错误、快照后仍 dirty 等）返回 false，调用方应保留 worktree 不删除。
 *
 * 实现：`git stash push -u` 生成 stash-form commit（含 untracked）并清空工作树，
 * 随后把该 commit 转存到 `refs/xdt/snapshots/<sessionId>`。stash 条目保留在
 * stash 栈（`git stash list | grep xdt-auto-stash` 可找回）作为冗余备份；
 * 判定标准是「工作树已 clean 且内容已持久化在某处」。
 *
 * 恢复：`git stash apply <snapshot-sha>`（stash-form commit 不依赖 stash 栈也能 apply）。
 */
export async function autoStashDirtyWorktree(
  worktreePath: string,
  sessionId: string,
): Promise<boolean> {
  // 全程持锁:进程内并发的多路回收不允许穿插操作同一 stash 栈
  return withStashLock(() => autoStashDirtyWorktreeLocked(worktreePath, sessionId));
}

async function autoStashDirtyWorktreeLocked(
  worktreePath: string,
  sessionId: string,
): Promise<boolean> {
  const worktreeName = path.basename(worktreePath);
  const stashMarker = `xdt-auto-stash: session ${sessionId} worktree=${worktreeName}`;
  // 每轮加唯一标记，同时保留稳定 marker 作为恢复兜底的 suffix。
  // `git stash push` 在 dirty submodule 等场景可能成功退出却不创建新条目；
  // 唯一 message 确保后续只会定位/回放本轮真正创建的 stash，不会误用旧条目。
  const stashMsg = `xdt-auto-stash op=${randomUUID()}: ${stashMarker}`;
  try {
    // --include-untracked: 把 untracked 文件也 stash 进去，避免遗漏 agent 新建的文件
    await gitExec(
      ['stash', 'push', '--include-untracked', '-m', stashMsg],
      worktreePath,
    );
    // stash 后再检查是否真的 clean 了（edge case: submodule dirty 等 stash 不覆盖的场景）
    if (await isWorktreeDirty(worktreePath)) {
      await reapplyCreatedAutoStash(worktreePath, sessionId, stashMsg);
      log.warn(`[dirty] worktree at ${worktreePath} still dirty after stash, preserving`);
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no local changes to save/i.test(msg)) {
      log.info(`[dirty] no stashable changes in ${worktreePath}, preserving`);
    } else {
      log.warn(`[dirty] auto-stash failed for ${worktreePath}:`, msg);
    }
    return false;
  }

  // 内容已进 stash 栈、工作树已 clean；只有 ref 转存成功才允许继续删除。
  // 转存失败时返回 false，并先把 auto-stash apply 回调用方将保留的 worktree。
  const transferred = await moveStashEntryToSnapshotRef(worktreePath, sessionId, stashMsg);
  if (!transferred) {
    // stash push 已清空工作树；转存失败时必须把内容重新放回保留目录。
    await reapplyCreatedAutoStash(worktreePath, sessionId, stashMsg);
  }
  return transferred;
}

async function reapplyCreatedAutoStash(
  worktreePath: string,
  sessionId: string,
  stashMsg: string,
): Promise<void> {
  let sha: string | undefined;
  try {
    const entries = await listStashEntries(worktreePath);
    sha = entries.find((entry) => entry.subject.endsWith(stashMsg))?.sha;
  } catch (err) {
    log.warn(
      `[dirty] created auto-stash lookup failed for session ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!sha) {
    log.info(
      `[dirty] this auto-stash invocation created no recoverable entry for session ${sessionId}; preserving without reapply`,
    );
    return;
  }
  try {
    await gitExec(['stash', 'apply', sha], worktreePath);
    await markSnapshotConsumed(worktreePath, sessionId, sha);
  } catch (err) {
    log.warn(
      `[dirty] partial auto-stash reapply failed for session ${sessionId} (${sha.slice(0, 12)}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 回收在 auto-stash 成功后被状态守卫取消时，把内容恢复到仍保留的 worktree。
 * apply 成功后清掉 snapshot ref，并标记冗余 stash 已消费，避免重复提示同一份快照。
 */
export async function restoreAutoStashToPreservedWorktree(
  worktreePath: string,
  sessionId: string,
): Promise<boolean> {
  return withStashLock(async () => {
    const snapshotSha = await getSnapshotSha(worktreePath, sessionId);
    const sha = snapshotSha ?? (
      await getAutoStashSha(worktreePath, sessionId, path.basename(worktreePath))
    );
    if (!sha) {
      log.warn(`[dirty] preserved worktree snapshot not found for session ${sessionId}`);
      return false;
    }
    try {
      await gitExec(['stash', 'apply', sha], worktreePath);
      if (snapshotSha) {
        await clearSnapshotRef(worktreePath, sessionId);
      }
      await markSnapshotConsumed(worktreePath, sessionId, sha);
      return true;
    } catch (err) {
      log.warn(
        `[dirty] preserved worktree snapshot reapply failed for session ${sessionId} (${sha.slice(0, 12)}):`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  });
}

/**
 * 把刚 push 的 stash 条目转存到会话快照 ref。按 message 精确定位自己的条目拿 sha；
 * 不自动 drop stash 条目，因为 `stash@{n}` 是共享 reflog index，进程外 stash 操作
 * 可能在 list 与 drop 之间改变 index，误删别人的条目。
 *
 * 转存失败（定位不到 / update-ref 失败）时本轮内容留在 stash 栈，同时**清掉
 * 上一轮遗留的旧快照 ref**——否则恢复流程会 apply 过期内容。转存成功后 ref
 * 已指向本轮内容，stash 条目残留只是冗余备份。
 */
async function moveStashEntryToSnapshotRef(
  worktreePath: string,
  sessionId: string,
  stashMsg: string,
): Promise<boolean> {
  const ref = snapshotRefForSession(sessionId);

  // 1. 按 message 定位自己的条目,拿 stash-form commit 的 sha。
  //    必须 endsWith 精确匹配(与 getAutoStashSha 一致):includes 会让
  //    `worktree=wt1` 误命中栈里更新的 `worktree=wt1-extra` 条目,把别的
  //    worktree 的 sha 写进本会话快照 ref(review 反馈:快照串号)。
  let sha: string | undefined;
  let listFailed = false;
  try {
    const entries = await listStashEntries(worktreePath);
    sha = entries.find((e) => e.subject.endsWith(stashMsg))?.sha;
  } catch (err) {
    listFailed = true;
    log.warn(
      `[dirty] stash list failed for session ${sessionId}; entry left in stash list:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!sha) {
    if (!listFailed) {
      log.warn(`[dirty] stash entry not found for snapshot transfer (session ${sessionId}); left in stash list`);
    }
    await clearSnapshotRef(worktreePath, sessionId);
    return false;
  }

  // 2. 写快照 ref;失败则本轮内容只在 stash 栈,旧 ref 已过期 → 清掉
  try {
    await gitExec(['update-ref', ref, sha], worktreePath);
    await clearConsumedSnapshotRef(worktreePath, sessionId);
  } catch (err) {
    log.warn(
      `[dirty] update-ref failed for session ${sessionId}; entry left in stash list:`,
      err instanceof Error ? err.message : String(err),
    );
    await clearSnapshotRef(worktreePath, sessionId);
    return false;
  }

  log.info(
    `[dirty] snapshotted dirty worktree at ${worktreePath} → ${ref} (${sha.slice(0, 12)}). ` +
    `Recover with: git stash apply ${sha.slice(0, 12)}`,
  );
  return true;
}
