/**
 * branchPick — 分支区点选语义的纯函数(与 UI 解耦,便于单测)。
 *
 * 2026-07-29 用户裁决(第二版,实测后定稿):分支菜单永远可点,勾选框**跟随用户的
 * 分支选择**双向联动——这是用户亲手的动作,不算系统擅改;但联动只对本次草稿生效,
 * **不写工作端勾选记忆**(记忆只在用户点 checkbox 本体时保存,见调用方 source 分档):
 *  - 选非当前分支 → 开 worktree 并以其为源(从别的分支启动必须隔离,
 *    绝不 checkout 用户的 checkout);
 *  - 选回当前 HEAD 分支 → 关 worktree(回到当前 checkout 直接启动,对称);
 *  - worktree 已勾时选其它分支 = 改源分支;选当前源分支(非 HEAD)= no-op。
 *  - 系统/环境因素(切项目、探测结果、播种)永远无权触达本函数之外的开关路径。
 *  - 永远不产生"checkout 用户 checkout"的效果(effect 种类里根本没有这个选项)。
 */

export interface BranchPickState {
  /** worktree 勾选框当前显示状态(用户记忆或本次草稿内联动后的值)。 */
  worktreeEnabled: boolean;
  /** 仓库当前 HEAD 分支;detached / 未知时为 null。 */
  currentBranch: string | null;
  /** worktree 源分支(仅 worktreeEnabled 时有意义)。 */
  sourceBranch: string;
}

export type BranchPickEffect =
  | { kind: 'noop' }
  | { kind: 'set-source'; branch: string }
  | { kind: 'enable-worktree'; branch: string }
  | { kind: 'disable-worktree' };

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  if (state.worktreeEnabled) {
    // 选回当前 HEAD = 不再需要隔离,勾选跟随熄灭(解决「从 worktree 切回 main
    // 仍勾着」的不对称);detached(currentBranch=null)时无"当前分支"可言,不触发。
    if (state.currentBranch !== null && picked === state.currentBranch) {
      return { kind: 'disable-worktree' };
    }
    if (picked === state.sourceBranch) return { kind: 'noop' };
    return { kind: 'set-source', branch: picked };
  }
  if (state.currentBranch !== null && picked === state.currentBranch) return { kind: 'noop' };
  return { kind: 'enable-worktree', branch: picked };
}
