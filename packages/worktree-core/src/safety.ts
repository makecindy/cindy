/**
 * worktree-parallel-sessions: 删除前的安全闸门。
 *
 * `WorktreeManager.removeWorktreeForSession` 和 `WorktreePool.drainEntry` 在
 * `git worktree remove --force` 失败后,会 fallback 到 `fs.rm -rf`。
 * 这是 destructive 操作,必须三条校验全过才允许调用,任一失败 → 仅清 store
 * 条目, 不删文件。
 *
 * 三条校验:
 *   1. 路径在 baseRepo/.cindy-worktrees/ 或历史 .xdt-worktrees/ 下
 *      (绝对路径前缀比对, 抗 ../ 越权)
 *   2. 路径在 worktreeStore 已记录的 known paths 列表里(双向校验, 抗 store 与文件系统不一致)
 *   3. 路径不能是 symbolic link(软链可能指向 baseRepo 之外, fs.rm 会跟着删源)
 */

import path from "node:path";
import fs from "node:fs";
import { MANAGED_WORKTREE_DIR_NAMES } from "@cindy/maker-shared/worktree-paths";

/**
 * 用户手动保留哨兵（P1，对齐 Claude Desktop 的 `.worktree-keep` 语义）：
 * worktree 根目录放置该文件后，所有自动回收路径一律跳过——删除、池化归还、
 * 数量淘汰、启动对账都不动它。dogfooding 用户在 worktree 里手动干活时用它
 * 声明"目录在用"，防止会话删除/归档把正在使用的目录抽走（快照保得住数据，
 * 保不住目录里跑着的进程 / 开着的编辑器）。
 */
export const WORKTREE_KEEP_SENTINEL = ".worktree-keep";

/** worktree 根目录存在 `.worktree-keep` 哨兵 ⇒ 一切自动回收跳过。IO 失败按无哨兵处理。 */
export function hasKeepSentinel(worktreePath: string): boolean {
  try {
    fs.statSync(path.join(worktreePath, WORKTREE_KEEP_SENTINEL));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param targetPath  待删除的 worktree 路径(可以是相对或绝对)
 * @param baseRepo    git repo 根目录(已通过 git rev-parse --show-toplevel 校验)
 * @param knownPathsInStore  worktreeStore 中所有已记录的 worktree.path 列表
 *
 * 返回 true ⇒ 安全, 调用方可以执行 fs.rm。
 * 返回 false ⇒ 任一条件未满足, 不应执行 fs.rm。
 */
export function isManagedWorktreePath(
  targetPath: string,
  baseRepo: string,
  knownPathsInStore: readonly string[],
): boolean {
  // 统一规范化为绝对路径 + 平台原生分隔符。Windows 上 path.normalize 会
  // 把 / 转成 \, 这是必须的——后面 startsWith 的 expectedParent 也走同一道。
  let normalized: string;
  let normalizedBase: string;
  try {
    normalized = path.resolve(targetPath);
    normalizedBase = path.resolve(baseRepo);
  } catch {
    return false;
  }

  // 1. 必须在 Cindy 当前或历史托管 worktree 根目录下
  // 用 path.sep 后缀防止 ".../my-repo-evil" 误匹配 ".../my-repo"
  const isUnderManagedParent = MANAGED_WORKTREE_DIR_NAMES.some(
    (directoryName) => {
      const expectedParent =
        path.join(normalizedBase, directoryName) + path.sep;
      return normalized.startsWith(expectedParent);
    },
  );
  if (!isUnderManagedParent) return false;

  // 2. 必须在 store 已记录的 path 列表中(将 known paths 也做一次 resolve 兜底大小写/分隔符差异)
  const knownNormalized = knownPathsInStore.map((p) => {
    try {
      return path.resolve(p);
    } catch {
      return p;
    }
  });
  if (!knownNormalized.includes(normalized)) return false;

  // 3. 不能是软链
  try {
    const stat = fs.lstatSync(normalized);
    if (stat.isSymbolicLink()) return false;
  } catch {
    // lstat 失败(不存在/权限)→ 拒绝, 让上层做最稳妥的"不删"
    return false;
  }

  return true;
}
