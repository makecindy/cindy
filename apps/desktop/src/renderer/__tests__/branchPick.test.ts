/**
 * branchPick.test.ts — 分支 chip 点选语义(纯函数)回归。
 *
 * 语义契约(与 WorktreeChipsRow 的 BranchChip 配合):
 *  - worktree ON:选分支 = 改源分支;选当前源分支 no-op
 *  - worktree OFF:选当前 HEAD 分支 no-op;选其它分支 = 自动开 worktree 从该分支启动
 *  - 永远不产生"checkout 用户 checkout"的效果(effect 种类里根本没有这个选项)
 */
import { describe, expect, it } from 'vitest';

import { resolveBranchPick } from '../components/new-chat/branchPick';

describe('resolveBranchPick', () => {
  it('worktree ON: picking a different branch changes the source branch', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'main' },
        'feat/x',
      ),
    ).toEqual({ kind: 'set-source', branch: 'feat/x' });
  });

  it('worktree ON: picking the current source branch is a no-op', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/x',
      ),
    ).toEqual({ kind: 'noop' });
  });

  it('worktree OFF: picking the repo HEAD branch is a no-op', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: '' },
        'main',
      ),
    ).toEqual({ kind: 'noop' });
  });

  it('worktree OFF: picking another branch enables worktree from it', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: '' },
        'feat/x',
      ),
    ).toEqual({ kind: 'enable-worktree', branch: 'feat/x' });
  });

  it('worktree OFF with unknown HEAD (detached): any pick enables worktree', () => {
    // detached HEAD 时 currentBranch 为 null,没有"就是当前分支"可言,
    // 任何选择都按隔离启动处理。
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: null, sourceBranch: '' },
        'main',
      ),
    ).toEqual({ kind: 'enable-worktree', branch: 'main' });
  });
});
