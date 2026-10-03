import type { CindyMakeTaskOptions } from './cindyMakeDoctor';
import type { MakeFeatureAction } from './cindyMakeHistory';

export interface MakeFeatureMergePlan {
  runId: string;
  taskSessionId: string;
  action: MakeFeatureAction;
  taskTree: string;
  completionId?: string;
  mergeCommit?: string;
  steps: Array<{ before: string; after: string }>;
  nextStep: number;
  awaitingResolution?: boolean;
}

/** Upstream integration is a separate task purpose, never a personal-feature build task. */
export const CINDY_MAKE_MERGE_SESSION_SOURCE = 'cindy-make-merge' as const;
export function isCindyMakeFamilySource(source: unknown): boolean {
  return source === 'cindy-make' || source === CINDY_MAKE_MERGE_SESSION_SOURCE;
}
export type CindyMakeMergeError =
  | 'busy'
  | 'dirty'
  | 'localMain'
  | 'localMainAhead'
  | 'unavailable'
  | 'gitFailed'
  | 'baselineChanged'
  | 'checksFailed'
  | 'interrupted'
  | 'startFailed'
  | 'cancelFailed';
export interface CindyMakeMergeState {
  id: string;
  status:
    | 'fetching'
    | 'merging'
    | 'conflict'
    | 'resolving'
    | 'checking'
    | 'merged'
    | 'failed'
    | 'cancelled';
  ref: string;
  upstreamCommit: string;
  baselineCommit?: string;
  baselineTree?: string;
  /**
   * Missing on retained file-only operations from older clients. `combine` is the
   * same rebase lifecycle for combining with the GitHub version; older clients
   * reject it instead of finishing it as an official update.
   */
  strategy?: 'rebase' | 'combine';
  rebaseBase?: string;
  /** Merge-only resolutions need an explicit content review before a flattened rebase is adopted. */
  rebaseReview?: boolean;
  /** Native feature integration/undo shares the same retained conflict lifecycle. */
  feature?: MakeFeatureMergePlan;
  /**
   * Combining the personal version saved on the user's GitHub (`commit`) with this
   * computer's. The other side's own changes are replayed onto `upstreamCommit`
   * (GitHub's version, or this computer's when it is on the newer official version);
   * the result's official base is `base`. The same rebase lifecycle applies.
   */
  remote?: { base: string; commit?: string };
  /** Source sync started while preparing a task; stopping preparation owns its candidate. */
  taskOwned?: boolean;
  /** The resolver ended its turn with conflicts left: it waits for the user's answer in its task. */
  needsInput?: boolean;
  /**
   * Personal changes the result does not carry (named ones first, at most 50). The task is
   * reminded once; then the user decides between using the result anyway and Abandon.
   */
  missing?: { count: number; commits: string[]; result?: string };
  /** The resolver was already asked to put the missing changes back. */
  reminded?: boolean;
  tree?: string;
  commit?: string;
  sessionId?: string;
  /** A retained candidate must not be removed by source preparation/reset. */
  hasWorkspace?: boolean;
  /** Adoption succeeded; disposable files/ref still need cleanup before another operation. */
  cleanupPending?: boolean;
  /** Persisted before cleanup so interruption retries cancellation, never starts a resolution task. */
  cancellationRequested?: boolean;
  ownedByAnotherAccount?: boolean;
  error?: CindyMakeMergeError;
}
export type CindyMakeMergeAction = 'update' | 'resolve' | 'cancel' | 'status';
export interface CindyMakeMergeRequest {
  action: CindyMakeMergeAction;
  /** Required for cancellation; binds a conflict decision to the operation the user saw. */
  operationId?: string;
  createOptions?: CindyMakeTaskOptions;
}
