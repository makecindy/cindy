/**
 * branchPick.test.ts — 分支区点选语义(纯函数)回归。
 *
 * 验证未勾时选择分支触发真实 checkout 意图，已勾时只改变源分支。
 * 最小失败输入是记住的源分支与当前分支不同；不改变勾选记忆。Tier: unit。
 */
import { describe, expect, it } from 'vitest';

import { resolveBranchPick } from '../components/new-chat/branchPick';

describe('resolveBranchPick', () => {
  it('worktree ON: picking a different branch changes the source branch', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/y',
      ),
    ).toEqual({ kind: 'set-source', branch: 'feat/y' });
  });

  it('worktree ON: picking the current source branch is a no-op', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/x',
      ),
    ).toEqual({ kind: 'noop' });
  });

  it('worktree OFF: picking a branch requests checkout', () => {
    for (const { currentBranch, picked } of [
      { currentBranch: 'main', picked: 'feat/x' },
      { currentBranch: null, picked: 'feat/y' },
    ]) {
      expect(
        resolveBranchPick({ worktreeEnabled: false, currentBranch, sourceBranch: '' }, picked),
      ).toEqual({ kind: 'checkout', branch: picked });
    }
  });

  it('worktree OFF: picking the current branch never writes the source preference', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'feat/x' },
        'main',
      ),
    ).toEqual({ kind: 'noop' });
  });

  it('worktree OFF: the remembered source must still switch the current checkout', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/x',
      ),
    ).toEqual({ kind: 'checkout', branch: 'feat/x' });
  });
});
