/**
 * Builds the file-rewind part of Codex message rewind plans.
 *
 * The planner is deliberately pure: callers provide the live user-message
 * timeline and the already parsed savepoint history. It never shells out to
 * Git and never mutates repository or conversation state.
 */

import type { SnapshotKind } from './snapshotTrailers';

/** A visible user message in ascending conversation order. */
export interface CodexRewindUserMessage {
  clientId: string;
  createdAt: number;
}

/** A parsed savepoint, newest first within its own source bucket. */
export interface CodexRewindSavepoint {
  commit: string;
  sessionId: string;
  kind: SnapshotKind;
  /**
   * `legacy`: old-format savepoint committed onto the user's branch (X-XDT
   * trailers, rewound via git revert). `shadow`: savepoint on the hidden
   * refs/cindy/savepoints chain (rewound via worktree file restore).
   */
  source: 'legacy' | 'shadow';
  branch: string;
  parentCount: number;
  anchor?: string;
  label?: string;
  /** Shadow after-edit only: turn-start savepoint the delta is based on. */
  baselineCommit?: string;
}

/** Repository context known before planning file rewind. */
export type CodexFileRewindRepoContext =
  | {
      kind: 'local-git';
      repoRoot: string;
      currentHead: string;
      currentBranch: string;
      savepointsNewestFirst: readonly CodexRewindSavepoint[];
      /**
       * The shadow chain read hit its traversal window: history beyond the
       * window is unknown and any file plan built on it could silently skip
       * truncated-away turns.
       */
      shadowSavepointsTruncated?: boolean;
    }
  | { kind: 'remote-session' }
  | { kind: 'non-git-workdir' };

/** Why file rewind falls back to conversation-only rollback. */
export type CodexFileRewindFallbackReason =
  | 'remote-session'
  | 'non-git-workdir'
  | 'no-savepoints'
  | 'blocked-by-dirty-start'
  | 'savepoint-gap'
  | 'mixed-savepoint-formats'
  | 'missing-turn-start-baseline'
  | 'savepoint-history-truncated';

export interface BuildCodexFileRewindPlanInput {
  sessionId: string;
  targetMessageClientId: string;
  repo: CodexFileRewindRepoContext;
  userMessages: readonly CodexRewindUserMessage[];
}

export interface CodexFileRewindPlanCommit {
  commit: string;
  sessionId: string;
  kind: SnapshotKind;
  branch: string;
  anchor?: string;
  label?: string;
  action: 'revert' | 'keep';
}

interface CodexFileRewindPlanBase {
  sessionId: string;
  targetMessageClientId: string;
  targetMessageCreatedAt: number;
  tailTurnsToDrop: number;
  conversationWillRewind: true;
}

/** Plan with legacy file savepoints selected for revert by the later executor. */
export interface CodexFileRewindPlan extends CodexFileRewindPlanBase {
  mode: 'file-rewind';
  repoRoot: string;
  currentHead: string;
  currentBranch: string;
  revertCommitsNewestFirst: string[];
  commits: CodexFileRewindPlanCommit[];
}

/** One shadow after-edit savepoint whose turn will be undone by file restore. */
export interface CodexShadowRestoreCommit {
  commit: string;
  /** Turn-start savepoint the after-edit delta is based on. */
  baselineCommit: string;
  anchor?: string;
  label?: string;
}

/** Plan that restores affected files to the target turn's baseline tree. */
export interface CodexFileRestorePlan extends CodexFileRewindPlanBase {
  mode: 'file-restore';
  repoRoot: string;
  currentHead: string;
  /** Turn-start tree of the oldest turn being undone; files return to it. */
  baselineCommit: string;
  restoreCommitsNewestFirst: CodexShadowRestoreCommit[];
}

/** Plan used when file rewind is unavailable but Codex conversation rewind can proceed. */
export interface CodexConversationOnlyRewindPlan extends CodexFileRewindPlanBase {
  mode: 'conversation-only';
  fallbackReason: CodexFileRewindFallbackReason;
}

export type CodexRewindPlan =
  | CodexFileRewindPlan
  | CodexFileRestorePlan
  | CodexConversationOnlyRewindPlan;

export type CodexFileRewindPlanErrorCode =
  | 'MESSAGE_NOT_FOUND'
  | 'MALFORMED_SAVEPOINT'
  | 'UNSUPPORTED_MERGE_COMMIT';

/** Deterministic planner error for callers to map at the IPC boundary. */
export class CodexFileRewindPlanError extends Error {
  constructor(
    readonly code: CodexFileRewindPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexFileRewindPlanError';
  }
}

const REVERTIBLE_KINDS: ReadonlySet<SnapshotKind> = new Set(['after-edit']);
const BLOCKING_KINDS: ReadonlySet<SnapshotKind> = new Set(['rewind-blocked']);

interface BucketScanResult {
  /** Selected after-edit savepoints in the target range, newest first. */
  selected: CodexRewindSavepoint[];
  /** A blocking marker landed inside the target range. */
  blocked: boolean;
}

/** Builds a Codex message rewind plan without executing Git operations. */
export function buildCodexFileRewindPlan(
  input: BuildCodexFileRewindPlanInput,
): CodexRewindPlan {
  const targetIdx = input.userMessages.findIndex(
    (message) => message.clientId === input.targetMessageClientId,
  );
  if (targetIdx === -1) {
    throw new CodexFileRewindPlanError(
      'MESSAGE_NOT_FOUND',
      `Message ${input.targetMessageClientId} is not in the live timeline`,
    );
  }

  const targetMessage = input.userMessages[targetIdx];
  const base = {
    sessionId: input.sessionId,
    targetMessageClientId: input.targetMessageClientId,
    targetMessageCreatedAt: targetMessage.createdAt,
    tailTurnsToDrop: input.userMessages.length - targetIdx,
    conversationWillRewind: true as const,
  };

  if (input.repo.kind === 'remote-session') {
    return { ...base, mode: 'conversation-only', fallbackReason: 'remote-session' };
  }
  if (input.repo.kind === 'non-git-workdir') {
    return { ...base, mode: 'conversation-only', fallbackReason: 'non-git-workdir' };
  }
  if (input.repo.shadowSavepointsTruncated) {
    // The chain window is not the full history: turns beyond it may carry
    // file changes we cannot see, so a partial restore would be silent data
    // loss. Conversation rewind still proceeds.
    return { ...base, mode: 'conversation-only', fallbackReason: 'savepoint-history-truncated' };
  }

  const repo = input.repo;
  const anchorsToRevert = new Set(
    input.userMessages.slice(targetIdx).map((message) => message.clientId),
  );
  const userMessageIndexByClientId = new Map(
    input.userMessages.map((message, index) => [message.clientId, index]),
  );

  // The two savepoint generations are scanned independently: each bucket is
  // newest-first on its own timeline (branch history vs hidden ref chain),
  // and blocking-marker position math must not mix the two.
  const shadow = scanBucket(
    repo.savepointsNewestFirst.filter(
      (savepoint) => savepoint.source === 'shadow' && savepoint.sessionId === input.sessionId,
    ),
    anchorsToRevert,
    targetIdx,
    userMessageIndexByClientId,
  );
  if (shadow.blocked) {
    return { ...base, mode: 'conversation-only', fallbackReason: 'savepoint-gap' };
  }

  const legacy = scanBucket(
    repo.savepointsNewestFirst.filter(
      (savepoint) =>
        savepoint.source === 'legacy' &&
        isCurrentSessionBranch(savepoint, input.sessionId, repo.currentBranch),
    ),
    anchorsToRevert,
    targetIdx,
    userMessageIndexByClientId,
  );
  if (legacy.blocked) {
    return { ...base, mode: 'conversation-only', fallbackReason: 'blocked-by-dirty-start' };
  }

  if (shadow.selected.length > 0 && legacy.selected.length > 0) {
    // Upgrade window: part of the range predates the shadow chain. Reverting
    // one half with git revert and restoring the other from trees cannot be
    // made atomic, so fall back to conversation-only.
    return { ...base, mode: 'conversation-only', fallbackReason: 'mixed-savepoint-formats' };
  }

  if (shadow.selected.length > 0) {
    return buildRestorePlan(base, repo, shadow.selected);
  }

  if (legacy.selected.length === 0) {
    return { ...base, mode: 'conversation-only', fallbackReason: 'no-savepoints' };
  }

  const revertSet = new Set(legacy.selected.map((savepoint) => savepoint.commit));
  const commits = repo.savepointsNewestFirst
    .filter((savepoint) => savepoint.source === 'legacy')
    .map((savepoint) => ({
      commit: savepoint.commit,
      sessionId: savepoint.sessionId,
      kind: savepoint.kind,
      branch: savepoint.branch,
      ...(savepoint.anchor ? { anchor: savepoint.anchor } : {}),
      ...(savepoint.label ? { label: savepoint.label } : {}),
      action: revertSet.has(savepoint.commit) ? 'revert' as const : 'keep' as const,
    }));

  return {
    ...base,
    mode: 'file-rewind',
    repoRoot: repo.repoRoot,
    currentHead: repo.currentHead,
    currentBranch: repo.currentBranch,
    revertCommitsNewestFirst: commits
      .filter((commit) => commit.action === 'revert')
      .map((commit) => commit.commit),
    commits,
  };
}

function scanBucket(
  savepointsNewestFirst: readonly CodexRewindSavepoint[],
  anchorsToRevert: ReadonlySet<string>,
  targetIdx: number,
  userMessageIndexByClientId: ReadonlyMap<string, number>,
): BucketScanResult {
  const selected: CodexRewindSavepoint[] = [];
  let nearestNewerAnchorIndex: number | undefined;

  for (const savepoint of savepointsNewestFirst) {
    if (
      BLOCKING_KINDS.has(savepoint.kind) &&
      isBlockingSavepointInTargetRange(savepoint, anchorsToRevert, targetIdx, nearestNewerAnchorIndex)
    ) {
      return { selected, blocked: true };
    }
    if (savepoint.anchor) {
      nearestNewerAnchorIndex =
        userMessageIndexByClientId.get(savepoint.anchor) ?? nearestNewerAnchorIndex;
    }
    if (!REVERTIBLE_KINDS.has(savepoint.kind)) continue;
    if (!savepoint.anchor || !anchorsToRevert.has(savepoint.anchor)) continue;
    assertRevertibleSavepoint(savepoint);
    selected.push(savepoint);
  }
  return { selected, blocked: false };
}

function buildRestorePlan(
  base: CodexFileRewindPlanBase,
  repo: Extract<CodexFileRewindRepoContext, { kind: 'local-git' }>,
  selectedNewestFirst: readonly CodexRewindSavepoint[],
): CodexRewindPlan {
  const restoreCommits: CodexShadowRestoreCommit[] = [];
  for (const savepoint of selectedNewestFirst) {
    if (!savepoint.baselineCommit) {
      // A shadow after-edit without its turn-start pointer cannot express
      // "state before this turn"; treat the whole range as non-restorable.
      return {
        ...base,
        mode: 'conversation-only',
        fallbackReason: 'missing-turn-start-baseline',
      };
    }
    restoreCommits.push({
      commit: savepoint.commit,
      baselineCommit: savepoint.baselineCommit,
      ...(savepoint.anchor ? { anchor: savepoint.anchor } : {}),
      ...(savepoint.label ? { label: savepoint.label } : {}),
    });
  }

  // Files return to the turn-start tree of the oldest turn being undone.
  const baselineCommit = restoreCommits[restoreCommits.length - 1].baselineCommit;
  return {
    ...base,
    mode: 'file-restore',
    repoRoot: repo.repoRoot,
    currentHead: repo.currentHead,
    baselineCommit,
    restoreCommitsNewestFirst: restoreCommits,
  };
}

function isBlockingSavepointInTargetRange(
  savepoint: CodexRewindSavepoint,
  anchorsToRevert: ReadonlySet<string>,
  targetIdx: number,
  nearestNewerAnchorIndex: number | undefined,
): boolean {
  if (savepoint.anchor) {
    return anchorsToRevert.has(savepoint.anchor);
  }

  return nearestNewerAnchorIndex === undefined || targetIdx < nearestNewerAnchorIndex;
}

function isCurrentSessionBranch(
  savepoint: CodexRewindSavepoint,
  sessionId: string,
  currentBranch: string,
): boolean {
  return (
    savepoint.sessionId === sessionId &&
    savepoint.branch === currentBranch
  );
}

function assertRevertibleSavepoint(savepoint: CodexRewindSavepoint): void {
  if (!savepoint.commit.trim()) {
    throw new CodexFileRewindPlanError(
      'MALFORMED_SAVEPOINT',
      'Cannot rewind a savepoint without a commit hash',
    );
  }
  if (
    !Number.isInteger(savepoint.parentCount) ||
    savepoint.parentCount < 0
  ) {
    throw new CodexFileRewindPlanError(
      'MALFORMED_SAVEPOINT',
      `Savepoint ${savepoint.commit} has invalid parent metadata`,
    );
  }
  if (savepoint.parentCount > 1) {
    throw new CodexFileRewindPlanError(
      'UNSUPPORTED_MERGE_COMMIT',
      `Savepoint ${savepoint.commit} is a merge commit`,
    );
  }
}
