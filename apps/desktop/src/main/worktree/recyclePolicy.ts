import type { WorktreeRecycleRecord } from './recycleJournal';

export const MAX_RECYCLE_FAILURES = 3;
export const MAX_RECYCLE_FAILED_WORK_MS = 30 * 60_000;
export interface WorktreeRecyclePolicy {
  state: 'retrying' | 'waiting' | 'paused' | 'kept';
  failures: number;
  failedWorkMs: number;
}

const waitingReasons = new Set([
  'referenced-or-runtime-unavailable', 'referenced-before-removal', 'referenced-before-fallback',
  'files-changed', 'files-changed-before-removal', 'git-baseline-changed',
  'git-baseline-changed-before-removal', 'residual-files-changed',
]);
const permanentReasons = new Set([
  'legacy-quarantine-needs-review', 'directory-replaced', 'unmanaged-path',
  'redirected-worktree-parent', 'recovery-evidence-missing', 'archive-integrity',
  'ENOSPC', 'EACCES', 'EPERM',
]);
const integrityMessages = new Set([
  'archive content does not match worktree inventory',
  'restored worktree files do not match recovery archive',
  'unsafe worktree archive entry', 'duplicate worktree archive entry',
  'invalid archive hard link', 'invalid archive symbolic link',
  'unsupported worktree archive entry',
]);

export function recycleFailureReason(error: unknown): string {
  if (error instanceof Error && integrityMessages.has(error.message)) return 'archive-integrity';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'recycle-failed';
}

/** Upgrade old counters conservatively, without charging live-reference waits as failures. */
export function recyclePolicy(record: WorktreeRecycleRecord): WorktreeRecyclePolicy {
  if (record.retryPolicy) return record.retryPolicy;
  if (record.reason === 'keep-sentinel') return { state: 'kept', failures: 0, failedWorkMs: 0 };
  if (record.reason && waitingReasons.has(record.reason)) return { state: 'waiting', failures: 0, failedWorkMs: 0 };
  const failures = record.reason ? Math.min(record.attempts, MAX_RECYCLE_FAILURES) : 0;
  return {
    state: (record.reason && permanentReasons.has(record.reason)) || failures >= MAX_RECYCLE_FAILURES ? 'paused' : 'retrying',
    failures, failedWorkMs: 0,
  };
}

export function deferRecycle(record: WorktreeRecycleRecord, reason: string, elapsedMs: number, now = Date.now()): void {
  const previous = recyclePolicy(record);
  record.reason = reason;
  record.attempts += 1;
  if (reason === 'keep-sentinel' || waitingReasons.has(reason)) {
    record.retryPolicy = { ...previous, state: reason === 'keep-sentinel' ? 'kept' : 'waiting' };
    record.nextAttemptAt = 0;
    return;
  }
  const failures = previous.failures + 1;
  const failedWorkMs = previous.failedWorkMs + Math.max(0, elapsedMs);
  const paused = permanentReasons.has(reason) || failures >= MAX_RECYCLE_FAILURES || failedWorkMs >= MAX_RECYCLE_FAILED_WORK_MS;
  record.retryPolicy = { state: paused ? 'paused' : 'retrying', failures, failedWorkMs };
  record.nextAttemptAt = paused ? 0 : now + Math.min(30 * 60_000, 5_000 * 2 ** failures);
}
