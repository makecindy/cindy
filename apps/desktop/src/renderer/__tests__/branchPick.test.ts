/**
 * branchPick.test.ts — 分支区点选语义(纯函数)回归。
 *
 * 语义契约:
 *  - checkbox 是唯一能改动 worktree 勾选状态的入口;
 *  - ON / OFF 时选分支都只改源分支,选当前源分支 no-op;
 *  - 永远不产生"checkout 用户 checkout"的效果
 */
import { describe, expect, it } from 'vitest';

import {
  resolveBranchPick,
  resolveWorktreeCreateMode,
} from '../components/new-chat/branchPick';

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

// 回归:用户在远程电脑上未勾 worktree、选了另一条分支后发送，任务静默建在当前(默认)
// 分支上。Send / Goal 先用这条判据决定建哪种 worktree；用户主目录的分支永远不切换。
describe('resolveWorktreeCreateMode', () => {
  it.each([
    ['已勾 → 从源分支新建托管分支', { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' }, 'new-branch'],
    ['未勾 + 选了另一条本地分支 → 直接检出它', { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'feat/x' }, 'checkout-source'],
    ['未勾 + 远端引用(勾选时保存的偏好)→ 无法直接工作，拦下', { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'refs/remotes/origin/main' }, 'unsupported-source'],
    ['未勾 + 选的就是当前分支 → 主目录', { worktreeEnabled: false, currentBranch: 'main', sourceBranch: 'main' }, null],
    ['当前分支未知(探测中 / detached HEAD)→ 主目录', { worktreeEnabled: false, currentBranch: null, sourceBranch: 'feat/x' }, null],
  ] as const)('%s', (_name, state, expected) => {
    expect(resolveWorktreeCreateMode(state)).toBe(expected);
  });
});
