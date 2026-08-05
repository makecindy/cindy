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

/** A parsed savepoint from current branch history, newest first. */
export interface CodexRewindSavepoint {
  commit: string;
  sessionId: string;
  kind: SnapshotKind;
  branch: string;
  parentCount: number;
  anchor?: string;
  label?: string;
}

/** Repository context known before planning file rewind. */
export type CodexFileRewindRepoContext =
  | {
      kind: 'local-git';
      repoRoot: string;
      currentHead: string;
      currentBranch: string;
      savepointsNewestFirst: readonly CodexRewindSavepoint[];
    }
  | { kind: 'remote-session' }
  | { kind: 'non-git-workdir' };

/** Why file rewind falls back to conversation-only rollback. */
export type CodexFileRewindFallbackReason =
  | 'remote-session'
  | 'non-git-workdir'
  | 'no-savepoints'
  | 'blocked-by-dirty-start';

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

/** Plan with file savepoints selected for revert by the later executor. */
export interface CodexFileRewindPlan extends CodexFileRewindPlanBase {
  mode: 'file-rewind';
  repoRoot: string;
  currentHead: string;
  currentBranch: string;
  revertCommitsNewestFirst: string[];
  commits: CodexFileRewindPlanCommit[];
}

/** Plan used when file rewind is unavailable but Codex conversation rewind can proceed. */
export interface CodexConversationOnlyRewindPlan extends CodexFileRewindPlanBase {
  mode: 'conversation-only';
  fallbackReason: CodexFileRewindFallbackReason;
}

export type CodexRewindPlan = CodexFileRewindPlan | CodexConversationOnlyRewindPlan;

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

  const anchorsToRevert = new Set(
    input.userMessages.slice(targetIdx).map((message) => message.clientId),
  );
  const userMessageIndexByClientId = new Map(
    input.userMessages.map((message, index) => [message.clientId, index]),
  );
  const revertSet = new Set<string>();
  let nearestNewerAnchorIndex: number | undefined;

  for (const savepoint of input.repo.savepointsNewestFirst) {
    if (!isCurrentSessionBranch(savepoint, input.sessionId, input.repo.currentBranch)) {
      continue;
    }
    if (
      BLOCKING_KINDS.has(savepoint.kind) &&
      isBlockingSavepointInTargetRange(savepoint, anchorsToRevert, targetIdx, nearestNewerAnchorIndex)
    ) {
      return { ...base, mode: 'conversation-only', fallbackReason: 'blocked-by-dirty-start' };
    }
    if (savepoint.anchor) {
      nearestNewerAnchorIndex = userMessageIndexByClientId.get(savepoint.anchor) ?? nearestNewerAnchorIndex;
    }
    if (!REVERTIBLE_KINDS.has(savepoint.kind)) continue;
    if (!savepoint.anchor || !anchorsToRevert.has(savepoint.anchor)) continue;
    assertRevertibleSavepoint(savepoint);
    revertSet.add(savepoint.commit);
  }

  if (revertSet.size === 0) {
    return { ...base, mode: 'conversation-only', fallbackReason: 'no-savepoints' };
  }

  const commits = input.repo.savepointsNewestFirst.map((savepoint) => ({
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
    repoRoot: input.repo.repoRoot,
    currentHead: input.repo.currentHead,
    currentBranch: input.repo.currentBranch,
    revertCommitsNewestFirst: commits
      .filter((commit) => commit.action === 'revert')
      .map((commit) => commit.commit),
    commits,
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
