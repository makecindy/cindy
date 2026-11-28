/** Zero-token local branch & worktree clutter summary for progressive cleanup hints. */
export type WorkspaceClutterTier = 'healthy' | 'suggest' | 'urgent';

export interface WorkspaceClutterRequest {
  baseRepo: string;
}

export interface WorkspaceClutterSummary {
  localBranchCount: number;
  cindyBranchCount: number;
  worktreeCount: number;
  idleWorktreeCount: number;
  activeWorktreeCount: number;
  failedCleanupCount: number;
  /** Physical paths of active/unarchived Cindy task worktrees to protect during AI audit. */
  protectedWorktreePaths: string[];
  tier: WorkspaceClutterTier;
}

export interface WorkspaceClutterCounts {
  localBranchCount: number;
  cindyBranchCount: number;
  idleWorktreeCount: number;
  failedCleanupCount: number;
}

/**
 * Three-tier progressive cleanup trigger:
 * - L0 'healthy': hidden (zero noise)
 * - L1 'suggest': quiet entry inside the branch popover
 * - L2 'urgent': subtle red dot on the top-right edge of the single capsule (snoozable for 7 days)
 */
export function computeWorkspaceClutterTier(counts: WorkspaceClutterCounts): WorkspaceClutterTier {
  if (
    counts.localBranchCount >= 20 ||
    counts.cindyBranchCount >= 12 ||
    counts.idleWorktreeCount >= 5 ||
    counts.failedCleanupCount >= 1
  ) {
    return 'urgent';
  }
  if (
    counts.localBranchCount >= 8 ||
    counts.cindyBranchCount >= 5 ||
    counts.idleWorktreeCount >= 2
  ) {
    return 'suggest';
  }
  return 'healthy';
}
