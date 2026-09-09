import type { AutoReviewDecision } from '@cindy/maker-core';

import type { UtilityTextResult } from '../../shared/utilityTextResult.js';
import {
  DEDICATED_AUTO_REVIEW_CANDIDATES,
  requestDedicatedAutoReviewCandidateText,
  type DedicatedAutoReviewCandidate,
} from '../utility-model/oneShotCandidates.js';
import { parseAutoPermissionReviewDecision } from './auto-permission-reviewer.js';

export const AUTO_REVIEW_CANDIDATE_TIMEOUT_MS = 12_000;
export const AUTO_REVIEW_CHAIN_TIMEOUT_MS = 52_000;
export const AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS = AUTO_REVIEW_CHAIN_TIMEOUT_MS + 1_000;
const AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS = 2;
const AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS = 100;
const AUTO_REVIEW_CANDIDATE_TIMEOUT = Symbol('auto-review-candidate-timeout');

interface AutoReviewModelRouterLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

interface AutoReviewModelRouterDeps {
  logger: AutoReviewModelRouterLogger;
  candidates?: readonly DedicatedAutoReviewCandidate[];
  requestCandidate?: (
    prompt: string,
    candidate: DedicatedAutoReviewCandidate,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<UtilityTextResult>;
  parseDecision?: (text: string) => AutoReviewDecision | null;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function transientCandidateFailure(result: UtilityTextResult): boolean {
  if (result.ok) return false;
  return result.attempts.some((attempt) => {
    if (attempt.status !== 'failed') return false;
    if (
      attempt.reason === 'timeout'
      || attempt.reason === 'empty_response'
      || attempt.reason === 'request_failed'
    ) {
      return true;
    }
    return attempt.reason === 'http_error'
      && (attempt.httpStatus === 408 || attempt.httpStatus === 429 || attempt.httpStatus >= 500);
  });
}

function candidateRequestFailure(
  candidate: DedicatedAutoReviewCandidate,
): UtilityTextResult {
  return {
    ok: false,
    reason: 'all_candidates_failed',
    attempts: [{
      providerId: candidate.providerId,
      model: candidate.model,
      transport: candidate.transport,
      status: 'failed',
      reason: 'request_failed',
    }],
  };
}

function candidateTimeoutFailure(
  candidate: DedicatedAutoReviewCandidate,
): UtilityTextResult {
  return {
    ok: false,
    reason: 'timeout',
    attempts: [{
      providerId: candidate.providerId,
      model: candidate.model,
      transport: candidate.transport,
      status: 'failed',
      reason: 'timeout',
    }],
  };
}

async function requestCandidateWithinTimeout(
  requestCandidate: NonNullable<AutoReviewModelRouterDeps['requestCandidate']>,
  prompt: string,
  candidate: DedicatedAutoReviewCandidate,
  timeoutMs: number,
  chainSignal: AbortSignal,
): Promise<UtilityTextResult> {
  if (chainSignal.aborted) return candidateTimeoutFailure(candidate);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortFromChain: (() => void) | undefined;
  const cutoff = new Promise<typeof AUTO_REVIEW_CANDIDATE_TIMEOUT>((resolve) => {
    const abort = () => {
      controller.abort();
      resolve(AUTO_REVIEW_CANDIDATE_TIMEOUT);
    };
    abortFromChain = abort;
    if (chainSignal.aborted) abort();
    else chainSignal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(abort, timeoutMs);
  });

  try {
    const result = await Promise.race([
      requestCandidate(prompt, candidate, { timeoutMs, signal: controller.signal }),
      cutoff,
    ]);
    return result === AUTO_REVIEW_CANDIDATE_TIMEOUT
      ? candidateTimeoutFailure(candidate)
      : result;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortFromChain) chainSignal.removeEventListener('abort', abortFromChain);
  }
}

function safeFailureReason(result: UtilityTextResult): string {
  if (result.ok) return 'none';
  const failed = result.attempts.find((attempt) => attempt.status === 'failed');
  return failed?.reason ?? result.reason;
}

/**
 * Runs the dedicated Auto-review model chain once.
 *
 * Each candidate owns its HTTP timeout and receives the chain AbortSignal. Only a quick,
 * infrastructure-shaped failure is retried in place; a full timeout immediately yields to
 * the next provider so one outage cannot consume the entire fallback budget.
 */
export function createAutoReviewModelRouter(
  deps: AutoReviewModelRouterDeps,
): (prompt: string, signal?: AbortSignal) => Promise<string | null> {
  const candidates = deps.candidates ?? DEDICATED_AUTO_REVIEW_CANDIDATES;
  const requestCandidate = deps.requestCandidate ?? requestDedicatedAutoReviewCandidateText;
  const parseDecision = deps.parseDecision ?? parseAutoPermissionReviewDecision;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepWithSignal;

  return async (prompt, parentSignal) => {
    const startedAt = now();
    const deadlineAt = startedAt + AUTO_REVIEW_CHAIN_TIMEOUT_MS;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const deadline = setTimeout(() => controller.abort(), AUTO_REVIEW_CHAIN_TIMEOUT_MS);

    try {
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (controller.signal.aborted) break;

        for (let attempt = 1; attempt <= AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
          const remainingMs = deadlineAt - now();
          if (remainingMs <= 0 || controller.signal.aborted) break;
          const attemptStartedAt = now();
          let result: UtilityTextResult;
          try {
            result = await requestCandidateWithinTimeout(
              requestCandidate,
              prompt,
              candidate,
              Math.min(AUTO_REVIEW_CANDIDATE_TIMEOUT_MS, remainingMs),
              controller.signal,
            );
          } catch {
            // Credential refresh and catalog probes are runtime boundaries too. A thrown
            // candidate must not skip the remaining controlled providers or leak details.
            result = candidateRequestFailure(candidate);
          }
          const durationMs = now() - attemptStartedAt;

          if (result.ok) {
            const decision = parseDecision(result.text);
            if (decision) {
              deps.logger.debug('auto-review model candidate completed', {
                candidateId: candidate.id,
                providerId: candidate.providerId,
                model: candidate.model,
                attempt,
                verdict: decision.verdict,
                durationMs: now() - startedAt,
              });
              return JSON.stringify(decision);
            }
            deps.logger.warn('auto-review model candidate returned malformed decision', {
              candidateId: candidate.id,
              providerId: candidate.providerId,
              model: candidate.model,
              attempt,
              durationMs,
            });
            break;
          }

          const remainingAfterAttemptMs = deadlineAt - now();
          const laterCandidateReserveMs =
            (candidates.length - candidateIndex - 1) * AUTO_REVIEW_CANDIDATE_TIMEOUT_MS;
          const canRetry = attempt < AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS
            && transientCandidateFailure(result)
            && remainingAfterAttemptMs >= (
              AUTO_REVIEW_CANDIDATE_TIMEOUT_MS
              + AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS
              + laterCandidateReserveMs
            )
            && !controller.signal.aborted;
          deps.logger.warn('auto-review model candidate failed', {
            candidateId: candidate.id,
            providerId: candidate.providerId,
            model: candidate.model,
            attempt,
            reason: safeFailureReason(result),
            retrying: canRetry,
            durationMs,
          });
          if (!canRetry) break;
          await sleep(AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS, controller.signal);
        }
      }
    } finally {
      clearTimeout(deadline);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }

    deps.logger.warn('auto-review model chain exhausted', {
      candidates: candidates.length,
      aborted: controller.signal.aborted,
      durationMs: now() - startedAt,
    });
    return null;
  };
}
