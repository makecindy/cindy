/** Append-only desktop/device-link contract; creation never waits for branch sync. */
export interface BranchSyncRequest {
  baseRepo: string;
  branch: string;
  /**
   * Sync strategy for diverged local branches.
   * - omitted / 'ff-only': fast-forward only (default, backward compatible with older hosts).
   * - 'rebase': explicitly rebase unpushed local commits onto remote when clean and conflict-free.
   */
  strategy?: 'ff-only' | 'rebase';
  /** Opt-in bounded replies. Omitted by old clients, which receive the final result. */
  waitForResult?: boolean;
  /** Continue waiting for an existing operation; never starts another fetch. */
  operationId?: string;
}
export interface BranchSyncStatus {
  branch: string;
  remote?: string;
  remoteBranch?: string;
  remoteRef?: string;
  remoteOnly: boolean;
  ahead: number;
  behind: number;
  dirtyFiles: number;
  checkoutPath?: string;
  blocked?:
    | 'no-remote'
    | 'missing-remote'
    | 'diverged'
    | 'conflict'
    | 'not-local'
    | 'multiple-checkouts'
    | 'changed';
  /** Present when blocked === 'diverged': true if read-only merge-tree detected conflicts or could not prove conflict-free. */
  divergedConflict?: boolean;
  /** Up to 6 repo-relative conflicting paths reported by merge-tree when divergedConflict is true. */
  divergedConflictFiles?: string[];
  /** Present when a Git merge/rebase/cherry-pick/revert is already in progress in checkoutPath. */
  inProgressOp?: boolean;
}
export interface BranchSyncResult {
  status: BranchSyncStatus;
  updated: number;
  /** Strategy that actually updated the branch; absent when unchanged or from older hosts. */
  syncedMode?: 'ff-only' | 'rebase';
}

export type BranchSyncReply = BranchSyncResult | { pending: true; operationId: string };

export const BRANCH_SYNC_ERROR_PREFIX = 'branch-sync:';
export type BranchSyncFailureReason =
  'git' | 'timeout' | 'auth' | 'network' | 'missing' | 'busy' | 'changed';
