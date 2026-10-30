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

/**
 * 发送 / Goal 时建哪种 worktree(从不切换用户主目录的分支):
 *  - 'new-branch'：勾选 → 从源分支新建 `cindy/<name>`，隔离着改；
 *  - 'checkout-source'：未勾选但选了与当前 checkout 不同的本地分支 → 新 worktree 直接检出
 *    该分支，改动落在它本身；
 *  - 'unsupported-source'：未勾选但源分支是远端引用(只可能来自勾选时保存的偏好)，无法
 *    直接在上面工作 → 保留草稿并提示，不能静默建在当前分支上；
 *  - null：不建，任务跑在主目录当前分支。当前分支未知(探测中、detached HEAD)时也不建。
 */
export type WorktreeCreateMode = 'new-branch' | 'checkout-source' | 'unsupported-source' | null;

export function resolveWorktreeCreateMode(
  state: Pick<BranchPickState, 'worktreeEnabled' | 'currentBranch' | 'sourceBranch'>,
): WorktreeCreateMode {
  if (state.worktreeEnabled) return 'new-branch';
  if (!state.currentBranch) return null;
  const picked = state.sourceBranch.trim();
  if (!picked || picked === state.currentBranch) return null;
  return picked.startsWith('refs/') ? 'unsupported-source' : 'checkout-source';
}

/**
 * 把创建方式折叠进发送快照：'checkout-source' 与勾选共用同一条创建流程和全部前置门
 * (baseRepo、分支偏好就绪、远端回收能力)，只多带 checkoutSourceBranch。
 */
export function applyWorktreeCreateMode<
  T extends { enabled: boolean; currentBranch: string | null; sourceBranch: string },
>(wt: T): T & { checkoutSourceBranch: boolean; sourceBranchUnsupported: boolean } {
  const mode = resolveWorktreeCreateMode({
    worktreeEnabled: wt.enabled,
    currentBranch: wt.currentBranch,
    sourceBranch: wt.sourceBranch,
  });
  return {
    ...wt,
    enabled: mode === 'new-branch' || mode === 'checkout-source',
    checkoutSourceBranch: mode === 'checkout-source',
    sourceBranchUnsupported: mode === 'unsupported-source',
  };
}

export function resolveBranchPick(state: BranchPickState, picked: string): BranchPickEffect {
  // ON / OFF 都只改源分支。effect union 刻意没有 enable / disable,从类型层保证
  // 分支选择无法联动 checkbox。
  if (picked === state.sourceBranch) return { kind: 'noop' };
  return { kind: 'set-source', branch: picked };
}
