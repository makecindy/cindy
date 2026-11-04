/**
 * branchPick — 分支区点选语义的纯函数(与 UI 解耦,便于单测)。
 *
 * worktree 勾选状态只由 checkbox 本体和显式「改用 worktree」按钮控制；
 * 两者共用偏好写入路径。系统/环境因素无权改动勾选状态。
 * 未勾时选择分支 = 切换主目录并记住源分支；勾选时只改源分支。
 */

export interface BranchPickState {
  /** worktree 勾选框当前显示状态(工作端保存的用户偏好)。 */
  worktreeEnabled: boolean;
  /** 仓库当前 HEAD 分支;保留在决策输入中,但不得据此联动 checkbox。 */
  currentBranch: string | null;
  /** worktree 源分支(仅 worktreeEnabled 时有意义)。 */
  sourceBranch: string;
}

export type BranchPickEffect =
  { kind: 'noop' } | { kind: 'set-source'; branch: string } | { kind: 'checkout'; branch: string };

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  if (!state.worktreeEnabled && picked !== state.currentBranch)
    return { kind: 'checkout', branch: picked };
  if (picked === state.sourceBranch) return { kind: 'noop' };
  return { kind: 'set-source', branch: picked };
}
