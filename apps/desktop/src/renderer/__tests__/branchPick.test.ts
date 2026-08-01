/**
 * branchPick.test.ts — 分支区点选语义(纯函数)回归。
 *
 * 语义契约(2026-07-29 用户裁决第二版,实测后定稿):
 *  - 分支菜单永远可点;勾选框**跟随用户的分支选择**双向联动(本次草稿内生效,
 *    持久化档位由调用方 source 分档控制,不在本函数职责内)
 *  - OFF + 选非当前分支 → enable-worktree(从别的分支启动必须隔离)
 *  - ON + 选回当前 HEAD → disable-worktree(回到当前 checkout 直接启动,对称)
 *  - ON + 选其它分支 = 改源分支;选当前源分支(非 HEAD)= no-op
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

  it('worktree ON: picking the repo HEAD branch leaves worktree (symmetric follow)', () => {
    // 用户最初的吐槽点:从 worktree 切回 main 时勾选仍亮着。定稿语义:选回当前
    // HEAD = 不再需要隔离,勾选跟随熄灭(仅本次草稿,不写记忆)。
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' },
        'main',
      ),
    ).toEqual({ kind: 'disable-worktree' });
    // source 恰好等于 HEAD 时同理:选它 = 回当前 checkout。
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'main' },
        'main',
      ),
    ).toEqual({ kind: 'disable-worktree' });
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

  it('detached HEAD (currentBranch=null): no "current branch" special cases fire', () => {
    // OFF:任何选择都按隔离启动;ON:任何选择都只是改源,绝不因 null 误触发退出。
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: null, sourceBranch: '' },
        'main',
      ),
    ).toEqual({ kind: 'enable-worktree', branch: 'main' });
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: null, sourceBranch: 'feat/x' },
        'main',
      ),
    ).toEqual({ kind: 'set-source', branch: 'main' });
  });
});
