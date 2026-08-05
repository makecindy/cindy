/**
 * branchPick — 分支区点选语义的纯函数(与 UI 解耦,便于单测)。
 *
 * 2026-08-05 用户裁决(worktree 勾选状态只属于用户,分支选择不得隐式改动):
 *  - worktree 已勾:分支菜单 = worktree 源分支选择器,选当前源分支为 no-op;
 *  - worktree 未勾:分支区只读展示当前 HEAD,菜单不打开——选分支不能替用户
 *    自动开启 worktree。想从别的分支启动 = 先勾 worktree、再选源分支(全部显式)。
 *  - 永远不产生"checkout 用户 checkout"的效果(effect 种类里根本没有这个选项)。
 */

export interface BranchPickState {
  /** worktree 勾选状态(用户记忆原样直出;未勾时分支区只读,不应触达本函数)。 */
  worktreeEnabled: boolean;
  /** worktree 源分支(仅 worktreeEnabled 时有意义)。 */
  sourceBranch: string;
}

export type BranchPickEffect = { kind: 'noop' } | { kind: 'set-source'; branch: string };

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  // 未勾时分支区只读(UI 不开菜单);防御性兜底:即使被触达也绝不改勾选状态。
  if (!state.worktreeEnabled) return { kind: 'noop' };
  if (picked === state.sourceBranch) return { kind: 'noop' };
  return { kind: 'set-source', branch: picked };
}
