import type { DetectCwdResp } from '@/lib/worktree.types';

/** Validate the displayed branch before an ordinary project task can consume its draft. */
export async function checkDraftBranchBeforeStart({
  workingDir,
  deviceId,
  ssh,
  worktree,
}: {
  workingDir: string | undefined;
  deviceId?: string | null;
  ssh: boolean;
  worktree: {
    enabled: boolean;
    confirmedIneligible: boolean | null;
    baseRepo: string | null;
    sourceBranch: string;
    branchPreferenceReady: boolean;
  };
}): Promise<
  | 'ccAgent.draft.deviceStillLoading'
  | 'ccAgent.draft.branchCheckFailed'
  | 'ccAgent.draft.branchRequiresWorktree'
  | null
> {
  if (!workingDir || ssh || worktree.enabled || worktree.confirmedIneligible === true) return null;
  // A new project's saved choice may still be arriving. Do not send with the
  // temporary empty value and then display a different branch after handoff.
  if (worktree.baseRepo && !worktree.branchPreferenceReady) return 'ccAgent.draft.deviceStillLoading';
  const sourceBranch = worktree.sourceBranch.trim();
  if (!sourceBranch || sourceBranch === 'HEAD') return null;

  // The page's initial probe can be stale after a checkout elsewhere. Reuse the
  // existing target-computer probe once per explicit start, under the route's
  // in-flight lock; no polling, new protocol, checkout or preference mutation.
  let current: DetectCwdResp;
  try {
    current = deviceId
      ? await window.electronAPI.deviceLink.invoke(
          deviceId, 'worktree:detect-cwd', [{ cwd: workingDir }],
        ) as DetectCwdResp
      : await window.electronAPI.worktreeDetectCwd({ cwd: workingDir });
  } catch {
    return 'ccAgent.draft.branchCheckFailed';
  }
  // Hidden branch controls do not apply to non-Git directories or existing worktrees.
  if (!current.gitInstalled || !current.isGitRepo || current.isInsideWorktree) return null;
  if (!current.currentBranch) return 'ccAgent.draft.branchCheckFailed';
  return sourceBranch === current.currentBranch ? null : 'ccAgent.draft.branchRequiresWorktree';
}
