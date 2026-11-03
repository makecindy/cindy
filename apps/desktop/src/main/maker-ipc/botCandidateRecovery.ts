import { isNetworkishErrorMessage, isOverloadErrorMessage } from '@cindy/maker-core';
import {
  codexLimitBucketKey,
  matchCodexBucketForModel,
  type BucketSnapshotLike,
} from '@cindy/maker-shared/codex-usage-buckets';
import { matchesDeterministicUsageExhaustionText } from '@cindy/maker-shared/error-redaction';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';

export type UsageExhaustionScope = 'account' | 'bucket';

/**
 * Distinguish between account-wide exhaustion (billing/budget/account payment) and
 * bucket-level quota limits (e.g. Codex app-server model-scoped limits, model quota pools).
 */
export function usageExhaustionScope(signals: InterruptedTurnErrorSignals): UsageExhaustionScope | null {
  // Structured tags are authoritative:
  // - Model-scoped rate limits on Codex app-server:
  if (signals.codexErrorInfo === 'usageLimitExceeded') return 'bucket';
  // - Explicit account/budget-level exhaustion: every candidate on the same account fails the same way.
  if (signals.codexErrorInfo === 'sessionBudgetExceeded' || signals.sdkError === 'billing_error') return 'account';
  if (signals.errorStatus === 402) return 'account';
  if (signals.sdkError === 'rate_limit' && typeof signals.usageResetAt === 'number') return 'account';
  if (signals.sdkError && ['invalid_request', 'max_output_tokens'].includes(signals.sdkError)) return null;

  // Text is only the fallback for untagged envelopes:
  const message = signals.message ?? '';
  const untagged = !signals.sdkError || signals.sdkError === 'unknown';

  // Explicit account/billing balance exhaustion:
  const isAccountWideText =
    /\b(?:exceeded[-_]?budget|budget[-_]?exceeded)\b/i.test(message) ||
    /\b(?:account|session)\s+budget\b.{0,16}\b(?:exhausted|exceeded)\b/i.test(message) ||
    /\binsufficient.{0,12}\b(?:balance|credit|funds)\b/i.test(message) ||
    /\bspend(?:ing)?[-_ ]?cap\b/i.test(message) ||
    /余额不足|欠费/i.test(message) ||
    (untagged && /\byou['’]ve hit your session limit\b/i.test(message));

  if (isAccountWideText) return 'account';

  // Ambiguous quota/usage limit text (model-level or pool-level limits, e.g. "quota exceeded"):
  if (matchesDeterministicUsageExhaustionText(message)) {
    return 'bucket';
  }

  return null;
}

/**
 * Account/budget exhaustion: every candidate on the same account fails the same way,
 * so only a candidate on another account may take over (#5266). Structured tags are
 * authoritative; the shared deterministic text is the fallback for untagged envelopes.
 */
export function isAccountUsageExhausted(signals: InterruptedTurnErrorSignals): boolean {
  return usageExhaustionScope(signals) !== null;
}

export type AccountRoute = {
  harness: string;
  model?: string | null;
  providerId?: string | null;
  agentDeviceId?: string | null;
};

/** Resolve implicit aliases (e.g. Pi null / xd / cindy gateway; Codex null / openai under ChatGPT) to their canonical provider identity. */
export function canonicalAccountProvider(
  route: AccountRoute,
  resolveDefault?: (route: AccountRoute) => string | null,
): string | null {
  const provider = route.providerId ?? resolveDefault?.(route) ?? null;
  if (route.harness === 'pi' && (provider === null || provider === 'xd' || provider === 'cindy')) {
    return 'xd';
  }
  if (route.harness === 'codex' && (provider === null || provider === 'openai')) {
    return 'openai';
  }
  if (route.harness === 'claude' && provider === null) {
    return resolveDefault ? (resolveDefault(route) ?? 'anthropic') : 'anthropic';
  }
  return provider;
}

/** Same harness, source and device: an exhausted account cannot be recovered by this route. */
export function isSameAccountRoute(
  candidate: AccountRoute,
  current: AccountRoute,
  resolveDefault?: (route: AccountRoute) => string | null,
): boolean {
  if ((candidate.agentDeviceId ?? null) !== (current.agentDeviceId ?? null)) {
    return false;
  }
  const candidateProvider = canonicalAccountProvider(candidate, resolveDefault);
  const currentProvider = canonicalAccountProvider(current, resolveDefault);
  if (candidateProvider !== null || currentProvider !== null) {
    return candidateProvider === currentProvider;
  }
  return candidate.harness === current.harness;
}

/**
 * Check whether two Codex models belong to the same quota bucket.
 * If live bucket snapshots are provided, compares authoritative limit IDs.
 * When the snapshot is incomplete (e.g. only generic 'codex' bucket is cached because Spark
 * has not run yet), retains the known rule that Spark runs in an independent promotional bucket.
 */
export function areCodexModelsInSameQuotaBucket(
  currentModel: string | null | undefined,
  candidateModel: string | null | undefined,
  buckets?: Record<string, BucketSnapshotLike> | null,
): boolean {
  if (currentModel && candidateModel && currentModel === candidateModel) return true;
  const isSpark = (m: string | null | undefined) => Boolean(m && m.toLowerCase().includes('spark'));
  const currentSpark = isSpark(currentModel);
  const candidateSpark = isSpark(candidateModel);
  if (currentSpark !== candidateSpark) {
    // One model is Spark and one is standard:
    // Only when the cached snapshot contains explicit evidence of a dedicated Spark bucket
    // do we compare bucket keys; otherwise, the absence of an explicit Spark bucket in the snapshot
    // simply means Spark hasn't run yet (app-server pushes one bucket at a time per usageBroadcaster:352-357).
    if (buckets && Object.keys(buckets).length > 0) {
      const sparkModel = currentSpark ? currentModel : candidateModel;
      const otherModel = currentSpark ? candidateModel : currentModel;
      const sparkBucket = matchCodexBucketForModel(buckets, sparkModel);
      const otherBucket = matchCodexBucketForModel(buckets, otherModel);
      const isSparkBucket = (b: BucketSnapshotLike | null) => Boolean(
        b && (isSpark(b.limitName) || isSpark(b.limitId))
      );
      if (sparkBucket && otherBucket && isSparkBucket(sparkBucket)) {
        return codexLimitBucketKey(sparkBucket) === codexLimitBucketKey(otherBucket);
      }
    }
    return false;
  }
  if (buckets && Object.keys(buckets).length > 0) {
    const currentBucket = matchCodexBucketForModel(buckets, currentModel);
    const candidateBucket = matchCodexBucketForModel(buckets, candidateModel);
    if (currentBucket && candidateBucket) {
      return codexLimitBucketKey(currentBucket) === codexLimitBucketKey(candidateBucket);
    }
  }
  return true;
}

/**
 * Determine if a candidate route is exhausted given the failure scope of the current route.
 * - Account-wide exhaustion (billing, session budget, 402, Claude subscription rate limit):
 *   every candidate on the same account/device is exhausted.
 * - Bucket-level exhaustion (Codex usageLimitExceeded):
 *   1. Cross-harness routes on the same account (e.g. Codex app-server vs Pi / Claude Code WHAM bridge)
 *      use independent quota pools (accountUsageLimit:44-63), so the bridge candidate remains eligible.
 *   2. Same-harness routes on the same Codex account running in an independent quota bucket (e.g. Spark)
 *      are preserved; only candidates sharing the same bucket are excluded.
 */
export function isRouteExhaustedForCandidate(
  candidate: AccountRoute,
  current: AccountRoute,
  scope: UsageExhaustionScope | null,
  buckets?: Record<string, BucketSnapshotLike> | null,
  resolveDefaultProvider?: (route: AccountRoute) => string | null,
): boolean {
  if (!scope) return false;
  if (!isSameAccountRoute(candidate, current, resolveDefaultProvider)) return false;
  if (scope === 'account') return true;
  if (candidate.harness !== current.harness) {
    return false;
  }
  if (candidate.harness === 'codex' && current.harness === 'codex') {
    return areCodexModelsInSameQuotaBucket(current.model, candidate.model, buckets);
  }
  return true;
}

/**
 * Live per-model usage checks candidate eligibility without overriding established failure scopes:
 * 1. Account-wide exhaustion (billing_error, 402, session budget) strictly excludes all candidates
 *    on that same account; live quota snapshots cannot revive an account with payment/budget failures.
 * 2. If the current failure already exhausts the candidate's route (same bucket, same account),
 *    the candidate is blocked.
 * 3. A candidate on any provider known to be limited by its own live quota is blocked, EXCEPT when
 *    a Codex candidate in an independent promotional bucket (Spark) only has inherited/generic bucket
 *    data in the cached snapshot (which falsely marks it limited).
 * 4. Otherwise, falls back to static route exhaustion rules.
 */
export function isCandidateQuotaBlocked(
  candidate: AccountRoute,
  current: AccountRoute,
  scope: UsageExhaustionScope | null,
  liveLimit: { limited: boolean } | null | undefined,
  buckets?: Record<string, BucketSnapshotLike> | null,
  resolveDefaultProvider?: (route: AccountRoute) => string | null,
  candidateBuckets?: Record<string, BucketSnapshotLike> | null,
): boolean {
  // 1. Account-wide exhaustion (402, billing_error, session budget) strictly excludes all
  //    candidates on that same account; live quota snapshots cannot revive an account with payment failures.
  if (scope === 'account' && isSameAccountRoute(candidate, current, resolveDefaultProvider)) {
    return true;
  }
  // 2. If a live quota snapshot is available for this candidate:
  if (liveLimit) {
    if (liveLimit.limited) {
      // Check whether this limited result is a false positive from an incomplete generic bucket table:
      // Only waive when candidate is on the same account as the current failure AND has no dedicated bucket in targetBuckets.
      // A candidate on a separate account (or with proven dedicated Spark bucket) must not have its limit waived by another account's incomplete snapshot.
      const isSpark = (m: string | null | undefined) => Boolean(m && m.toLowerCase().includes('spark'));
      if (candidate.harness === 'codex' && isSpark(candidate.model)) {
        const isSameAccount = isSameAccountRoute(candidate, current, resolveDefaultProvider);
        if (isSameAccount) {
          const targetBuckets = candidateBuckets ?? buckets;
          const hasDedicatedSparkBucket = Boolean(
            targetBuckets && Object.values(targetBuckets).some((b) => isSpark(b.limitName) || isSpark(b.limitId)),
          );
          if (!hasDedicatedSparkBucket) {
            return false;
          }
        }
      }
      return true;
    }
    // liveLimit is { limited: false }:
    // For bucket-scope failures on the same provider (e.g. separate model buckets on Anthropic/Gemini/Argon),
    // a model whose own live quota is free is eligible, unless static rules prove it shares the same Codex bucket:
    if (candidate.harness === 'codex' && current.harness === 'codex' && isSameAccountRoute(candidate, current, resolveDefaultProvider)) {
      if (areCodexModelsInSameQuotaBucket(current.model, candidate.model, buckets)) {
        return true;
      }
    }
    return false;
  }
  // 3. Without live quota data, fall back to static route exhaustion rules:
  return isRouteExhaustedForCandidate(candidate, current, scope, buckets, resolveDefaultProvider);
}

/** A failed provider may be replaced, even when retrying that provider is forbidden. */
export function isBotCandidateUnavailable(signals: InterruptedTurnErrorSignals): boolean {
  const reason = signals.reason ?? '';
  // Explicit product/control failures must never be reinterpreted from their text.
  if (reason && ![
    'pi-gateway-drop', 'upstream-overload', 'empty-response', 'turn-failed',
    'provider_auth_or_access', 'provider_quota_limit', 'provider_rate_limit',
    'provider_server_error', 'model_unavailable', 'user_model_access_denied', 'agent-start-failed',
  ].includes(reason)) return false;
  if (reason && reason !== 'turn-failed') return true;
  if (isAccountUsageExhausted(signals)) return true;
  const tag = signals.sdkError ?? '';
  if (['authentication_failed', 'authentication_error', 'rate_limit', 'server_error', 'billing_error',
    'model_not_found', 'user_model_access_denied', 'agent_start_failed'].includes(tag)) return true;
  const message = signals.message ?? '';
  if (/user (?:denied|rejected)|approval (?:denied|required)|context.{0,20}(?:overflow|too long)|prompt too long/i.test(message)) return false;
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(signals.errorStatus ?? 0)) return true;
  if (/permission denied/i.test(message)) return false;
  // Some Claude session-limit envelopes omit both HTTP status and SDK classification.
  // A known input/control error must not be reclassified from this text alone.
  const sessionLimit = (!tag || tag === 'unknown') && /\byou['’]ve hit your session limit\b/i.test(message);
  return sessionLimit || isNetworkishErrorMessage(message) || isOverloadErrorMessage(message, signals.errorStatus)
    || /invalid api key|missing bearer token|no available oauth accounts|credit balance too low|rate.limit exceeded|model.{0,80}(?:not found|does not exist|unavailable)|(?:failed to (?:start|spawn)|could not start) (?:the )?(?:agent|pi|codex|claude)/i.test(message);
}

/** The Session reference is only a teardown lease, never proof that a route changed. */
export interface RuntimeFallbackResult<T> {
  session: T | null;
  outcome: 'unchanged' | 'switched' | 'exhausted' | 'failed' | 'superseded';
}

export function canResumeAfterRuntimeFallback(
  requireRouteChange: boolean,
  result: RuntimeFallbackResult<unknown>,
): boolean {
  return result.outcome !== 'superseded' && (!requireRouteChange || result.outcome === 'switched');
}
