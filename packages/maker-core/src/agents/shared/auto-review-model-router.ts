import type { AutoReviewDecision } from './auto-review-decision.js';

import type { UtilityTextResult } from '@cindy/model-providers/utilityTextResult';
import {
  DEDICATED_AUTO_REVIEW_CANDIDATES,
  type AutoReviewAuxiliaryFallback,
  type DedicatedAutoReviewCandidate,
} from '@cindy/model-providers/utility-model/runtime';
import { requestUtilityTextWithinTimeout } from '@cindy/model-providers/utility-model/utilityTextTimeout';
import { parseAutoPermissionReviewDecision } from './auto-permission-reviewer.js';

export const AUTO_REVIEW_CANDIDATE_TIMEOUT_MS = 12_000;
/**
 * 内置链的预算 = 每个候选一次完整超时 + 4s 余量。按候选数推导:一个候选整段超时后先让给
 * 下一个,而不是在原位重试吃掉后续候选的时间;兜底候选本机不可用(立即 no_candidate)时,
 * 省下的预算留给超时候选在所有兜底之后再试一次。
 */
export const AUTO_REVIEW_CHAIN_TIMEOUT_MS =
  DEDICATED_AUTO_REVIEW_CANDIDATES.length * AUTO_REVIEW_CANDIDATE_TIMEOUT_MS + 4_000;
export const AUTO_REVIEW_AUXILIARY_TIMEOUT_MS = 40_000;
export const AUTO_REVIEW_TOTAL_TIMEOUT_MS = AUTO_REVIEW_CHAIN_TIMEOUT_MS + AUTO_REVIEW_AUXILIARY_TIMEOUT_MS;
export const AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS = AUTO_REVIEW_TOTAL_TIMEOUT_MS + 1_000;
const AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS = 2;
const AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS = 100;

interface AutoReviewModelRouterLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface AutoReviewModelRouterDeps {
  logger: AutoReviewModelRouterLogger;
  candidates?: readonly DedicatedAutoReviewCandidate[];
  requestCandidate: (
    prompt: string,
    candidate: DedicatedAutoReviewCandidate,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<UtilityTextResult>;
  createAuxiliaryFallback?: () => AutoReviewAuxiliaryFallback | undefined;
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

function safeFailureReason(result: UtilityTextResult): string {
  if (result.ok) return 'none';
  const failed = result.attempts.find((attempt) => attempt.status === 'failed');
  return failed?.reason ?? result.reason;
}

interface PendingCandidateAttempt {
  candidate: DedicatedAutoReviewCandidate;
  attempt: number;
}

/**
 * Runs the dedicated Auto-review chain, then an explicitly customized auxiliary chain.
 *
 * Each candidate owns its HTTP timeout and receives the chain AbortSignal, and gets at most
 * AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS attempts. A transient failure is retried in place only
 * when the budget still covers one full timeout per pending attempt (untried candidates and
 * earlier deferred retries); otherwise the retry joins the end of the queue. A full timeout
 * therefore cannot starve fallback or an earlier, higher-priority retry, and fallbacks that
 * are unavailable locally (`no_candidate` returns immediately) do not waste the budget
 * reserved for them.
 * The auxiliary phase has its own bounded budget, shares parent cancellation, and
 * cannot replace any valid dedicated decision (including block and ask).
 */
export function createAutoReviewModelRouter(
  deps: AutoReviewModelRouterDeps,
): (prompt: string, signal?: AbortSignal) => Promise<string | null> {
  const candidates = deps.candidates ?? DEDICATED_AUTO_REVIEW_CANDIDATES;
  const requestCandidate = deps.requestCandidate;
  const parseDecision = deps.parseDecision ?? parseAutoPermissionReviewDecision;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepWithSignal;

  return async (prompt, parentSignal) => {
    const startedAt = now();
    let auxiliaryFallback: AutoReviewAuxiliaryFallback | undefined;
    try {
      auxiliaryFallback = deps.createAuxiliaryFallback?.();
    } catch {
      deps.logger.warn('auto-review auxiliary fallback unavailable', { reason: 'configuration_unavailable' });
    }
    const deadlineAt = startedAt + AUTO_REVIEW_CHAIN_TIMEOUT_MS;
    const totalTimeoutMs = auxiliaryFallback ? AUTO_REVIEW_TOTAL_TIMEOUT_MS : AUTO_REVIEW_CHAIN_TIMEOUT_MS;
    const totalDeadlineAt = startedAt + totalTimeoutMs;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const deadline = setTimeout(() => controller.abort(), totalTimeoutMs);

    try {
      const queue: PendingCandidateAttempt[] = candidates.map((candidate) => ({ candidate, attempt: 1 }));
      while (queue.length > 0 && !controller.signal.aborted) {
        const { candidate, attempt } = queue.shift()!;
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) break;
        // A retry always gets a full candidate timeout; a truncated one mostly just delays
        // the confirmation card.
        if (attempt > 1 && remainingMs < AUTO_REVIEW_CANDIDATE_TIMEOUT_MS) {
          deps.logger.warn('auto-review model candidate retry skipped', {
            candidateId: candidate.id,
            providerId: candidate.providerId,
            model: candidate.model,
            attempt,
            reason: 'insufficient_budget',
            remainingMs,
          });
          continue;
        }
        const attemptStartedAt = now();
        let result: UtilityTextResult;
        try {
          const timeoutMs = Math.min(AUTO_REVIEW_CANDIDATE_TIMEOUT_MS, remainingMs);
          result = await requestUtilityTextWithinTimeout(
            (signal) => requestCandidate(prompt, candidate, { timeoutMs, signal }),
            timeoutMs,
            controller.signal,
            () => candidateTimeoutFailure(candidate),
          );
        } catch {
          // Credential refresh and catalog probes are runtime boundaries too. A thrown
          // candidate must not skip the remaining controlled providers or leak details.
          result = candidateRequestFailure(candidate);
        }
        const durationMs = now() - attemptStartedAt;
        if (controller.signal.aborted) break;

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
          continue;
        }

        // Queued work keeps its order: a retry may only jump ahead when the budget still covers
        // one full timeout for every pending attempt, including earlier deferred retries.
        const pendingAttempts = queue.length;
        const retriable = attempt < AUTO_REVIEW_TRANSIENT_RETRY_ATTEMPTS
          && transientCandidateFailure(result)
          && !controller.signal.aborted;
        const retryInPlace = retriable && deadlineAt - now() >= (
          AUTO_REVIEW_CANDIDATE_TIMEOUT_MS
          + AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS
          + pendingAttempts * AUTO_REVIEW_CANDIDATE_TIMEOUT_MS
        );
        const retryDeferred = retriable && !retryInPlace && pendingAttempts > 0;
        deps.logger.warn('auto-review model candidate failed', {
          candidateId: candidate.id,
          providerId: candidate.providerId,
          model: candidate.model,
          attempt,
          reason: safeFailureReason(result),
          retrying: retryInPlace ? 'in_place' : retryDeferred ? 'deferred' : false,
          durationMs,
        });
        if (retryInPlace) {
          await sleep(AUTO_REVIEW_TRANSIENT_RETRY_BACKOFF_MS, controller.signal);
          queue.unshift({ candidate, attempt: attempt + 1 });
        } else if (retryDeferred) {
          queue.push({ candidate, attempt: attempt + 1 });
        }
      }

      if (auxiliaryFallback && !controller.signal.aborted) {
        const timeoutMs = Math.min(AUTO_REVIEW_AUXILIARY_TIMEOUT_MS, totalDeadlineAt - now());
        if (timeoutMs > 0) {
          try {
            const result = await requestUtilityTextWithinTimeout(
              (signal) => auxiliaryFallback(prompt, {
                timeoutMs: AUTO_REVIEW_CANDIDATE_TIMEOUT_MS,
                signal,
                validateResponse: (text) => parseDecision(text) !== null,
              }),
              timeoutMs,
              controller.signal,
              () => ({ ok: false, reason: 'timeout', attempts: [] }),
            );
            const decision = result.ok ? parseDecision(result.text) : null;
            if (decision && !controller.signal.aborted) {
              deps.logger.debug('auto-review auxiliary fallback completed', {
                providerId: result.ok ? result.providerId : undefined,
                model: result.ok ? result.model : undefined,
                verdict: decision.verdict,
                durationMs: now() - startedAt,
              });
              return JSON.stringify(decision);
            }
            deps.logger.warn('auto-review auxiliary fallback failed', {
              reason: result.ok ? 'malformed_decision' : safeFailureReason(result),
            });
          } catch {
            deps.logger.warn('auto-review auxiliary fallback failed', { reason: 'request_failed' });
          }
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
