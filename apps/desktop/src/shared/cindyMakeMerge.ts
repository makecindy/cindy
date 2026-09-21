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
  /** Missing on retained file-only operations from older clients. */
  strategy?: 'rebase';
  rebaseBase?: string;
  /** Merge-only resolutions need an explicit content review before a flattened rebase is adopted. */
  rebaseReview?: boolean;
  /** Native feature integration/undo shares the same retained conflict lifecycle. */
  feature?: MakeFeatureMergePlan;
  tree?: string;
  commit?: string;
  sessionId?: string;
  /** A retained candidate must not be removed by source preparation/reset. */
  hasWorkspace?: boolean;
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
