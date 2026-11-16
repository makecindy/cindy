import type { DetectCwdResp } from '@/lib/worktree.types';

/** Validate the displayed branch before an ordinary project task can consume its draft. */
export async function checkDraftBranchBeforeStart({
  workingDir,
  deviceId,
  ssh,
  worktree,
  displayedBranch,
}: {
  workingDir: string | undefined;
  deviceId?: string | null;
  ssh: boolean;
  displayedBranch: string | undefined;
  worktree: {
    enabled: boolean;
    confirmedIneligible: boolean | null;
    baseRepo: string | null;
    branchPreferenceReady: boolean;
  };
}): Promise<
  | 'ccAgent.draft.deviceStillLoading'
  | 'ccAgent.draft.branchCheckFailed'
  | { code: 'ccAgent.draft.branchChanged'; branch: string }
  | null
> {
  if (!workingDir || ssh || worktree.enabled || worktree.confirmedIneligible === true) return null;
  // Wait until the project's preferences have resolved before consuming its draft.
  // Source memory is deliberately not the OFF branch comparison.
  if (worktree.baseRepo && !worktree.branchPreferenceReady)
    return 'ccAgent.draft.deviceStillLoading';
  if (displayedBranch === undefined) return 'ccAgent.draft.deviceStillLoading';

  // The page's initial probe can be stale after a checkout elsewhere. Reuse the
  // existing target-computer probe once per explicit start, under the route's
  // in-flight lock; no polling, new protocol, checkout or preference mutation.
  let current: DetectCwdResp;
  try {
    current = deviceId
      ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'worktree:detect-cwd', [
          { cwd: workingDir },
        ])) as DetectCwdResp)
      : await window.electronAPI.worktreeDetectCwd({ cwd: workingDir });
  } catch {
    return 'ccAgent.draft.branchCheckFailed';
  }
  // Hidden branch controls do not apply to non-Git directories or existing worktrees.
  if (!current.gitInstalled) return 'ccAgent.draft.branchCheckFailed';
  if (!current.isGitRepo || current.isInsideWorktree) return null;
  const normalize = (branch?: string) =>
    !branch?.trim() || branch.trim() === 'HEAD' ? 'HEAD' : branch.trim();
  return normalize(displayedBranch) === normalize(current.currentBranch)
    ? null
    : { code: 'ccAgent.draft.branchChanged', branch: normalize(current.currentBranch) };
}
