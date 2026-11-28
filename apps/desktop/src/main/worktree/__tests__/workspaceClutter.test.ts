/**
 * Test value: verifies zero-token workspace clutter tier boundaries (L0/L1/L2) and
 * readWorkspaceClutterSummary aggregation (branch prefixes, active worktree protection,
 * failed recycle records). Tier: unit; no real Git processes or DB access.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeWorkspaceClutterTier } from '../../../shared/worktreeWorkspaceClutter';
import { parseLinkedWorktreePaths, readWorkspaceClutterSummary } from '../workspaceClutter';

describe('computeWorkspaceClutterTier', () => {
  it('stays healthy below L1 thresholds', () => {
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 7,
        cindyBranchCount: 4,
        idleWorktreeCount: 1,
        failedCleanupCount: 0,
      }),
    ).toBe('healthy');
  });

  it('escalates to suggest (L1) on moderate branch or idle worktree buildup', () => {
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 8,
        cindyBranchCount: 0,
        idleWorktreeCount: 0,
        failedCleanupCount: 0,
      }),
    ).toBe('suggest');
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 5,
        cindyBranchCount: 5,
        idleWorktreeCount: 0,
        failedCleanupCount: 0,
      }),
    ).toBe('suggest');
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 2,
        cindyBranchCount: 0,
        idleWorktreeCount: 2,
        failedCleanupCount: 0,
      }),
    ).toBe('suggest');
  });

  it('escalates to urgent (L2) on heavy sprawl or any failed cleanup residual', () => {
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 20,
        cindyBranchCount: 0,
        idleWorktreeCount: 0,
        failedCleanupCount: 0,
      }),
    ).toBe('urgent');
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 12,
        cindyBranchCount: 12,
        idleWorktreeCount: 0,
        failedCleanupCount: 0,
      }),
    ).toBe('urgent');
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 3,
        cindyBranchCount: 0,
        idleWorktreeCount: 5,
        failedCleanupCount: 0,
      }),
    ).toBe('urgent');
    expect(
      computeWorkspaceClutterTier({
        localBranchCount: 1,
        cindyBranchCount: 0,
        idleWorktreeCount: 0,
        failedCleanupCount: 1,
      }),
    ).toBe('urgent');
  });
});

describe('readWorkspaceClutterSummary', () => {
  it('counts branches, separates active vs idle worktrees, and attributes failed recycle items', async () => {
    const gitExec = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'for-each-ref') {
        return {
          stdout: [
            'main',
            'feat/a',
            'cindy/alpha',
            'cindy/beta',
            'cindy/gamma',
            'xdt/legacy',
            'cindy/delta',
            'cindy/epsilon',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'worktree') {
        return {
          stdout: [
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /repo/.cindy-worktrees/active-one',
            'HEAD bbb',
            'branch refs/heads/cindy/alpha',
            '',
            'worktree /repo/.cindy-worktrees/idle-one',
            'HEAD ccc',
            'branch refs/heads/cindy/beta',
            '',
            'worktree /repo/.cindy-worktrees/idle-two',
            'HEAD ddd',
            'branch refs/heads/cindy/gamma',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const summary = await readWorkspaceClutterSummary('/repo', {
      gitExec: gitExec as never,
      realpath: async (p) => p,
      readActiveWorktreePaths: async () => ['/repo/.cindy-worktrees/active-one'],
      listFailedRecyclePaths: async () => [
        '/repo/.cindy-worktrees/stale-failed',
        '/other-repo/.cindy-worktrees/unrelated',
      ],
    });

    expect(summary).toEqual({
      localBranchCount: 8,
      cindyBranchCount: 6,
      worktreeCount: 3,
      activeWorktreeCount: 1,
      idleWorktreeCount: 2,
      failedCleanupCount: 1,
      protectedWorktreePaths: ['/repo/.cindy-worktrees/active-one'],
      tier: 'urgent',
    });
  });

  it('ignores the primary checkout path when parsing porcelain output', () => {
    const linked = parseLinkedWorktreePaths(
      'worktree /repo\nHEAD 111\n\nworktree /repo/.cindy-worktrees/wt-1\nHEAD 222\n',
      '/repo',
    );
    expect(linked).toEqual(['/repo/.cindy-worktrees/wt-1']);
  });
});
