import type { WorktreeMeta } from "./types.js";
import type { WorktreeRecyclePolicy } from "./recyclePolicy.js";
import type { WorktreeRecoveryArchive } from "./recoveryArchiveIO.js";

/** Durable deletion intent and recovery evidence, independent of the active task ledger. */
export interface WorktreeRecycleRecord {
  version: 1;
  id: string;
  generation: string;
  meta: WorktreeMeta;
  requestedAt: string;
  phase:
    | "pending"
    | "snapshotted"
    | "removing"
    | "removed"
    | "restoring"
    | "restored";
  attempts: number;
  nextAttemptAt: number;
  reason?: string;
  retryPolicy?: WorktreeRecyclePolicy;
  /** null is a durable marker that recovery has reserved a previously absent directory. */
  directoryIdentity?: string | null;
  snapshot?: {
    head: string;
    headRef?: string | null;
    tree: string;
    indexTree: string;
    commit: string;
    ref: string;
    indexHash: string;
    /** True when the snapshot also contains non-ignored untracked content. */
    untracked?: true;
  };
  restoredGeneration?: string;
  /** Removal boundary used to distinguish pre-existing ignored bytes from late writes. */
  removingSince?: number;
  /** Paths intentionally omitted from the snapshot (ignored files and nested repositories). */
  removalDiscardable?: string[];
  /** Temporary checkout used to repair a partially removed worktree. */
  restoreCheckoutPath?: string;
  archive?: WorktreeRecoveryArchive;
  /** One fresh retry budget for an older client’s archive failure. */
  legacyArchiveRetry?: true;
}
