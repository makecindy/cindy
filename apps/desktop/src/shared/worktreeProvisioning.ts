/**
 * Shared contract for two-phase asynchronous worktree provisioning
 * (send_to_session with use_worktree=true, local & remote).
 */

/** Main-owned interaction lock id held while worktree provisioning is pending or failed. */
export const WORKTREE_PROVISIONING_LOCK_ID = 'worktree-provisioning';

/** IPC channels between Desktop main and renderer for host-driven worktree provisioning. */
export const WORKTREE_PROVISIONING_CHANNELS = {
  LIST: 'worktree:provisioning:list',
  RETRY: 'worktree:provisioning:retry',
  CHANGED: 'worktree:provisioning:changed',
} as const;

export type WorktreeProvisioningStage = 'queued' | 'creating';

export interface WorktreeProvisioningSnapshot {
  sessionId: string;
  status: 'provisioning' | 'failed';
  stage?: WorktreeProvisioningStage;
  /** Generated worktree name (e.g. `eager-turing`) once selected. */
  name?: string;
  startedAt: number;
  /** Redacted, bounded user-facing failure reason when `status === 'failed'`. */
  error?: string;
  /** True when the failure came from an interrupted provisioning across an app restart. */
  interruptedOnRestart?: boolean;
}
