export type ReviewRunStatus = 'running' | 'completed' | 'failed';

export type ReviewTargetKind = 'changes' | 'artifacts' | 'task' | 'mixed';

export const REVIEW_FAILURE_CODES = [
  'no-visible-result',
  'reviewer-closed',
  'cancelled-before-start',
  'interrupted',
  'source-workspace-changed',
  'source-conversation-changed',
  'source-files-changed',
  'artifact-changed',
  'artifact-unavailable',
  'provider-failed',
] as const;

export type ReviewFailureCode = (typeof REVIEW_FAILURE_CODES)[number];

const REVIEW_FAILURE_CODE_SET = new Set<string>(REVIEW_FAILURE_CODES);

const STALE_REVIEW_FAILURE_CODE_SET = new Set<ReviewFailureCode>([
  'source-workspace-changed',
  'source-conversation-changed',
  'source-files-changed',
  'artifact-changed',
]);

export function readReviewFailureCode(value: unknown): ReviewFailureCode | null {
  return typeof value === 'string' && REVIEW_FAILURE_CODE_SET.has(value)
    ? (value as ReviewFailureCode)
    : null;
}

export function isStaleReviewFailureCode(
  value: ReviewFailureCode | null,
): value is ReviewFailureCode {
  return value !== null && STALE_REVIEW_FAILURE_CODE_SET.has(value);
}

const LEGACY_REVIEW_FAILURE_CODE_BY_ERROR = new Map<string, ReviewFailureCode>([
  ['Reviewer returned no visible conclusion', 'no-visible-result'],
  ['Reviewer task was closed before it finished', 'reviewer-closed'],
  ['Reviewer was cancelled before it started', 'cancelled-before-start'],
  ['Review was interrupted when Cindy closed. Run /review again.', 'interrupted'],
  [
    'The source task workspace changed while Review was running. Run /review again in the current workspace.',
    'source-workspace-changed',
  ],
  [
    'The task conversation changed before Review started. Run /review again for the current context.',
    'source-conversation-changed',
  ],
  [
    'The task conversation changed while Review was running. Run /review again for the current context.',
    'source-conversation-changed',
  ],
  [
    'The task files changed before Review started. Run /review again for the current result.',
    'source-files-changed',
  ],
  [
    'The task files changed while Review was running. Run /review again for the current result.',
    'source-files-changed',
  ],
  [
    'A review artifact changed before Review started. Run /review again for the current result.',
    'artifact-changed',
  ],
  [
    'A review artifact changed while Review was running. Run /review again for the current result.',
    'artifact-changed',
  ],
  ['Review refused a multiply linked file in its artifact workspace', 'artifact-unavailable'],
  ['Reviewer task failed', 'provider-failed'],
]);

/** Keep cards persisted by pre-code clients localized without rewriting history. */
export function reviewFailureCodeFromLegacyError(value: unknown): ReviewFailureCode | null {
  return typeof value === 'string'
    ? (LEGACY_REVIEW_FAILURE_CODE_BY_ERROR.get(value) ?? null)
    : null;
}

export interface ReviewRunOwnerLiveness {
  version: 1;
  /** Loopback-only port owned by this exact Desktop Main instance. */
  port: number;
  /** Random challenge returned by the owner; prevents an unrelated port reuse from matching. */
  token: string;
}

export interface ReviewRunOwner {
  /** Random per-Main-process identity; distinguishes PID reuse from the original owner. */
  instanceId: string;
  processId: number;
  /**
   * Exact cross-process liveness proof for owners created by current builds.
   * Optional only for leases/cards written by older clients.
   */
  liveness?: ReviewRunOwnerLiveness;
}

export function readReviewRunOwner(value: unknown): ReviewRunOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.instanceId !== 'string' ||
    !owner.instanceId ||
    !Number.isSafeInteger(owner.processId) ||
    (owner.processId as number) <= 0
  ) {
    return null;
  }
  if (owner.liveness !== undefined) {
    if (!owner.liveness || typeof owner.liveness !== 'object' || Array.isArray(owner.liveness)) {
      return null;
    }
    const liveness = owner.liveness as Record<string, unknown>;
    if (
      liveness.version !== 1 ||
      !Number.isSafeInteger(liveness.port) ||
      (liveness.port as number) <= 0 ||
      (liveness.port as number) > 65_535 ||
      typeof liveness.token !== 'string' ||
      liveness.token.length < 16 ||
      liveness.token.length > 256
    ) {
      return null;
    }
  }
  return value as ReviewRunOwner;
}

/**
 * Host-owned link between a source task and its isolated reviewer task.
 *
 * The full review stays in the reviewer task and in the source message content.
 * This compact record is persisted in messages.agent_meta so the source card can
 * be reconstructed after a restart without a new database table.
 */
export interface ReviewRunMeta {
  version: 1;
  runId: string;
  sourceSessionId: string;
  /** Published only after the isolated reviewer task has actually been created. */
  reviewerSessionId?: string;
  status: ReviewRunStatus;
  targetKind: ReviewTargetKind;
  startedAt: number;
  /**
   * Present on runs created by owner-aware clients. Optional only so cards
   * written by an older client remain readable after an upgrade.
   */
  owner?: ReviewRunOwner;
  completedAt?: number;
  /** Stable product reason translated by Renderer. Unknown provider details stay in error. */
  failureCode?: ReviewFailureCode;
  error?: string;
}

export function readReviewRunMeta(value: unknown): ReviewRunMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.runId !== 'string' ||
    typeof record.sourceSessionId !== 'string' ||
    (record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed') ||
    (record.targetKind !== 'changes' &&
      record.targetKind !== 'artifacts' &&
      record.targetKind !== 'task' &&
      record.targetKind !== 'mixed') ||
    typeof record.startedAt !== 'number'
  ) {
    return null;
  }
  if (
    record.reviewerSessionId !== undefined &&
    (typeof record.reviewerSessionId !== 'string' || !record.reviewerSessionId)
  ) {
    return null;
  }
  if (record.owner !== undefined) {
    if (!readReviewRunOwner(record.owner)) return null;
  }
  if (record.failureCode !== undefined && !readReviewFailureCode(record.failureCode)) return null;
  return record as unknown as ReviewRunMeta;
}

/** Parse the persisted messages.agent_meta envelope and return its Review link. */
export function readReviewRunFromAgentMeta(value: unknown): ReviewRunMeta | null {
  let record = value;
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record) as unknown;
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return readReviewRunMeta((record as Record<string, unknown>).reviewRun);
}
