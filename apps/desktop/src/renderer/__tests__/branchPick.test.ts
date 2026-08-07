/**
 * branchPick.test.ts — 分支区点选语义(纯函数)回归。
 *
 * 语义契约:
 *  - checkbox 是唯一能改动 worktree 勾选状态的入口;
 *  - ON / OFF 时选分支都只改源分支,选当前源分支 no-op;
 *  - 永远不产生"checkout 用户 checkout"的效果
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

  it('worktree OFF: picking a branch only changes the future worktree source', () => {
    for (const { currentBranch, picked } of [
      { currentBranch: 'main', picked: 'feat/x' },
      { currentBranch: null, picked: 'feat/y' },
    ]) {
      expect(
        resolveBranchPick(
          { worktreeEnabled: false, currentBranch, sourceBranch: '' },
          picked,
        ),
      ).toEqual({ kind: 'set-source', branch: picked });
    }
  });

  it('worktree OFF: picking the already selected source is a no-op', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/x',
      ),
    ).toEqual({ kind: 'noop' });
  });
});
