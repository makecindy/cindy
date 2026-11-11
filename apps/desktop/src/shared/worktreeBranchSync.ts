/** Append-only desktop/device-link contract; creation never waits for branch sync. */
export interface BranchSyncRequest {
  baseRepo: string;
  branch: string;
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
}
export interface BranchSyncResult {
  status: BranchSyncStatus;
  updated: number;
}

export type BranchSyncReply = BranchSyncResult | { pending: true; operationId: string };

export const BRANCH_SYNC_ERROR_PREFIX = 'branch-sync:';
export type BranchSyncFailureReason =
  'git' | 'timeout' | 'auth' | 'network' | 'missing' | 'busy' | 'changed';
