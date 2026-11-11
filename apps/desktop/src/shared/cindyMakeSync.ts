/**
 * One Sync for every personal version: bring in changes saved on the user's
 * GitHub (when shared there), move to the official version, and upload. Without
 * GitHub the same pipeline runs with the sharing steps skipped.
 */

export const CINDY_MAKE_SYNC_STEPS = [
  /** Finishing an earlier conflict before anything else. */
  'resuming',
  /** Fetching and taking over changes saved by other computers. */
  'github',
  /** Combining both sides' changes in an isolated folder. */
  'combine',
  /** Moving to the official version. */
  'official',
  /** Uploading the result to the user's GitHub. */
  'upload',
] as const;
export type CindyMakeSyncStep = (typeof CINDY_MAKE_SYNC_STEPS)[number];

export const CINDY_MAKE_SYNC_ERRORS = [
  'busy',
  /** The managed source is missing or not ready. */
  'source',
  /** The GitHub connection or upload failed; the local result is kept. */
  'github',
  'network',
  /** The two personal versions follow unrelated official lines. */
  'diverged',
  /** The official version could not be looked up. */
  'unavailable',
  /** The conflict task was cancelled; nothing was adopted. */
  'cancelled',
  /** GitHub received a newer version from another computer during Sync. */
  'changed',
  /** A change in the change history is being added or undone; Sync waits for it. */
  'featurePending',
  /** This computer's Git is too old for sharing through GitHub. */
  'gitOutdated',
  /** The saved GitHub repository no longer exists or cannot be written. */
  'forkMissing',
  /** The saved GitHub repository is archived: GitHub accepts no uploads. */
  'forkArchived',
  'failed',
] as const;
export type CindyMakeSyncError = (typeof CINDY_MAKE_SYNC_ERRORS)[number];

/** Why Sync stopped at a source operation, from the user's point of view. */
export type CindyMakeSyncWaitReason =
  /** Its task is resolving the conflict; Sync continues by itself once it is adopted. */
  | 'working'
  /** The task asked the user something and waits for the answer. */
  | 'input'
  /** The app stopped while it was being handled. */
  | 'interrupted'
  /** The result lost some of the user's changes: use it anyway, or abandon. */
  | 'missing'
  /** The personal version changed meanwhile; the work has to start over. */
  | 'stale'
  /** Its task is not there (never opened, or removed): Continue opens one for the same work. */
  | 'paused'
  /** It belongs to the account signed in when it started; switching back continues it. */
  | 'otherAccount'
  | 'failed';

export interface CindyMakeSyncWaiting {
  kind: 'combine' | 'official';
  reason: CindyMakeSyncWaitReason;
  sessionId?: string;
  /** For `missing`: how many changes are not in the result. */
  missing?: number;
  /** Abandon was requested and is being carried out. */
  abandoning?: boolean;
}

export interface CindyMakeSyncDone {
  at: number;
  /** Official version the personal version is on now. */
  ref?: string;
  /** Already on a newer official version than this computer's Cindy can follow. */
  ahead?: boolean;
  /** A newer official release that needs this computer's Cindy updated first. */
  held?: string;
  /** This computer's changes reach GitHub once they are generated. */
  uploadAfterBuild?: boolean;
  /** Both computers changed it and this computer's changes are not generated yet. */
  buildFirst?: boolean;
  /** The official version (ref) waits until this computer's changes are generated. */
  generateFirst?: string;
}

export interface CindyMakeSyncState {
  running?: boolean;
  step?: CindyMakeSyncStep;
  /** A source operation Sync waits for (a conflict being resolved, or a decision). */
  waiting?: CindyMakeSyncWaiting;
  error?: CindyMakeSyncError;
  /**
   * With `cancelled`: what was given up. After a combine (or with `diverged`) the user
   * can keep one side instead.
   */
  abandoned?: 'combine' | 'official';
  /** The last completed Sync (also kept when its GitHub step failed). */
  done?: CindyMakeSyncDone;
}

export interface CindyMakeSyncRequest {
  /**
   * `abandon` gives up the operation Sync waits for (nothing is adopted); `accept` uses
   * a result that lost changes the user agreed to leave out.
   */
  action: 'sync' | 'status' | 'abandon' | 'accept' | 'keep';
  /** For `keep`: which personal version stays when the two cannot be combined. */
  side?: 'github' | 'local';
  /** Agent preferences for a conflict task, chosen like a new Cindy Make task. */
  createOptions?: import('./cindyMakeDoctor').CindyMakeTaskOptions;
}
