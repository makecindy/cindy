import type { ReviewRunMeta, ReviewRunOwner } from '../../shared/reviewRun.js';
import {
  probeReviewOwnerLiveness,
  type ReviewOwnerLivenessProbeResult,
} from './reviewOwnerLiveness.js';

export type ReviewProcessAliveProbe = (processId: number) => boolean;
export type ReviewOwnerLivenessProbe = (
  owner: ReviewRunOwner,
) => ReviewOwnerLivenessProbeResult | Promise<ReviewOwnerLivenessProbeResult>;
export type ReviewRunOwnerStatus = 'alive' | 'ended' | 'unknown';

/**
 * Coalesce concurrent on-demand initialization, but forget a rejected attempt
 * so the next /review can recover from a transient failure without an app restart.
 */
export function createRetryableReviewInitialization(
  start: () => Promise<void>,
): () => Promise<void> {
  let attempt: Promise<void> | null = null;
  return () => {
    if (attempt) return attempt;
    let current: Promise<void>;
    try {
      current = Promise.resolve(start());
    } catch (error) {
      current = Promise.reject(error);
    }
    attempt = current;
    void current.catch(() => {
      if (attempt === current) attempt = null;
    });
    return current;
  };
}

export function isReviewProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Classify the exact Main-process incarnation behind a persisted Review owner.
 * Legacy PID-only owners remain unknown while that PID exists because it may
 * already belong to an unrelated process.
 */
export async function reviewRunOwnerStatus(
  owner: ReviewRunOwner,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
  ownerLivenessProbe: ReviewOwnerLivenessProbe = (candidate) =>
    candidate.liveness ? probeReviewOwnerLiveness(candidate.liveness) : 'unknown',
): Promise<ReviewRunOwnerStatus> {
  if (owner.instanceId === currentOwner.instanceId) return 'alive';
  // This process now owns the same PID, so the differently identified previous
  // owner has definitely terminated even if the OS immediately reused the PID.
  if (owner.processId === currentOwner.processId) return 'ended';
  if (owner.liveness) {
    return ownerLivenessProbe(owner);
  }
  // Compatibility for leases/cards written before exact instance probes existed.
  return processIsAlive(owner.processId) ? 'unknown' : 'ended';
}

export async function hasReviewOwnerProcessEnded(
  owner: ReviewRunOwner,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
  ownerLivenessProbe: ReviewOwnerLivenessProbe = (candidate) =>
    candidate.liveness ? probeReviewOwnerLiveness(candidate.liveness) : 'unknown',
): Promise<boolean> {
  return (
    (await reviewRunOwnerStatus(owner, currentOwner, processIsAlive, ownerLivenessProbe)) ===
    'ended'
  );
}

/**
 * A shared-userData instance may only fail a running card after proving that
 * the Main process which owns it has ended. Owner-less cards from older builds
 * remain untouched because another older instance may still be running them.
 */
export async function shouldFailInterruptedReview(
  reviewRun: ReviewRunMeta,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
  ownerLivenessProbe?: ReviewOwnerLivenessProbe,
): Promise<boolean> {
  if (reviewRun.status !== 'running' || !reviewRun.owner) return false;
  return hasReviewOwnerProcessEnded(
    reviewRun.owner,
    currentOwner,
    processIsAlive,
    ownerLivenessProbe,
  );
}
