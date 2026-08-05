/**
 * branchPick — 分支 chip 点选语义的纯函数(与 UI 解耦,便于单测)。
 *
 * 语义(Codex 风格「选分支 = 从该分支启动」):
 *  - worktree 已开:选中的分支就是 worktree 源分支,选当前源分支为 no-op;
 *  - worktree 未开:选中仓库当前分支为 no-op(会话本来就跑在它上面);
 *    选其它分支 → 自动开启 worktree 并以该分支为源 —— 绝不 checkout 用户的
 *    checkout(可能有脏改动),隔离启动是唯一安全语义。
 */

export interface BranchPickState {
  /** worktree 开关当前是否开启(effective,即未被 advancedHidden 等禁用)。 */
  worktreeEnabled: boolean;
  /** 仓库当前 HEAD 分支;detached / 未知时为 null。 */
  currentBranch: string | null;
  /** worktree 源分支(仅 worktreeEnabled 时有意义)。 */
  sourceBranch: string;
}

export type BranchPickEffect =
  | { kind: 'noop' }
  | { kind: 'set-source'; branch: string }
  | { kind: 'enable-worktree'; branch: string };

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  if (state.worktreeEnabled) {
    if (picked === state.sourceBranch) return { kind: 'noop' };
    return { kind: 'set-source', branch: picked };
  }
  if (state.currentBranch !== null && picked === state.currentBranch) return { kind: 'noop' };
  return { kind: 'enable-worktree', branch: picked };
}
