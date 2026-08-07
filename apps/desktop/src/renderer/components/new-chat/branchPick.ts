/**
 * branchPick — 分支区点选语义的纯函数(与 UI 解耦,便于单测)。
 *
 * worktree 勾选状态只由 checkbox 本体控制:
 *  - 分支菜单始终只选择未来 worktree 的源分支,选当前源分支为 no-op;
 *  - worktree 未勾时也允许先选源分支,但绝不能因此开启或关闭 worktree;
 *  - 系统/环境因素(切项目、探测结果、播种)同样无权改动勾选状态。
 *  - 永远不产生"checkout 用户 checkout"的效果(effect 种类里根本没有这个选项)。
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
  | { kind: 'noop' }
  | { kind: 'set-source'; branch: string };

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  // ON / OFF 都只改源分支。effect union 刻意没有 enable / disable,从类型层保证
  // 分支选择无法联动 checkbox。
  if (picked === state.sourceBranch) return { kind: 'noop' };
  return { kind: 'set-source', branch: picked };
}
