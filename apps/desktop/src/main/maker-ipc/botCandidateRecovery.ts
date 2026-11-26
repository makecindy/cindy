import { isContextOverflowErrorMessage, isNetworkishErrorMessage, isOverloadErrorMessage, UPSTREAM_STREAM_INTERRUPTED_REASON } from '@cindy/maker-core';
import {
  extractNonSecretErrorSignals,
  isAccountUsageLimitReachedText,
  isProviderSafetyRefusalError,
  matchesDeterministicUsageExhaustionText,
} from '@cindy/maker-shared/error-redaction';
import { isAcceptedTurnContinuationOnlyReason, isRemoteAgentRouteLostReason, type InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';
import { isBillingDepletionError } from '../../shared/usageLimitRecovery.js';

/** A model-specific rate limit leaves other models on the connection available. */
export function isModelGroupConnectionOutOfCredit(signals: InterruptedTurnErrorSignals): boolean {
  return signals.errorStatus === 402 || isBillingDepletionError(signals) ||
    /\binsufficient_quota\b|insufficient[_ -](?:balance|credits?|funds)|credit balance (?:is )?too low|402 payment required|余额不足|欠费/i.test(signals.message ?? '');
}

/** Host-proven stopped bootstrap, distinct from a turn or opaque startup error. */
export const BOT_SUBSCRIPTION_STARTUP_ADMISSION_REASON = 'bot-subscription-startup-admission';

const PROVIDER_TURN_FAILURE_REASONS = new Set([
  'pi-gateway-drop', 'upstream-overload', 'empty-response', 'turn-failed', 'acp-request-failed',
  'acp-agent-exited', 'acp-auth-required',
  'provider_auth_or_access', 'provider_quota_limit', 'provider_rate_limit',
  'provider_server_error', 'model_unavailable', 'user_model_access_denied', 'agent-start-failed',
  BOT_SUBSCRIPTION_STARTUP_ADMISSION_REASON,
]);

/** A failed provider may be replaced, even when retrying that provider is forbidden. */
export function isBotCandidateUnavailable(signals: InterruptedTurnErrorSignals): boolean {
  // The agent serving this route on another computer is gone; another candidate route can still run the
  // turn. An owner disconnect is `user-revoked`, not this.
  if (isRemoteAgentRouteLostReason(signals.reason)) return true;
  const reason = signals.reason ?? '';
  const tag = signals.sdkError ?? '';
  const message = signals.message ?? '';
  if (
    signals.codexErrorInfo === 'cyberPolicy' ||
    signals.codexErrorInfo === 'misalignmentPolicyViolation' ||
    tag === 'content_filter' ||
    isProviderSafetyRefusalError(message, reason)
  ) {
    return false;
  }
  // Explicit product/control failures must never be reinterpreted from their text.
  if (reason && !PROVIDER_TURN_FAILURE_REASONS.has(reason)) return false;
  // Exhaustion forbids retrying this account, not trying the user's configured
  // backups. The caller requires a successful route change before resuming.
  if (signals.codexErrorInfo === 'sessionBudgetExceeded') return false;
  if (
    signals.usageLimit === true ||
    signals.codexErrorInfo === 'usageLimitExceeded' ||
    signals.codexErrorInfo === 'rateLimitExceeded' ||
    isBillingDepletionError(signals) ||
    matchesDeterministicUsageExhaustionText(message)
  ) {
    return true;
  }
  if (reason && reason !== 'turn-failed' && reason !== 'acp-request-failed') return true;
  if (['authentication_failed', 'authentication_error', 'rate_limit', 'server_error', 'billing_error',
    'model_not_found', 'user_model_access_denied', 'agent_start_failed'].includes(tag)) return true;
  if (/user (?:denied|rejected)|approval (?:denied|required)|context.{0,20}(?:overflow|too long)|prompt too long/i.test(message)) return false;
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(signals.errorStatus ?? 0)) return true;
  if (/permission denied/i.test(message)) return false;
  // Older/statusless provider envelopes still need the candidate chain. Keep
  // local control/permission denials above this narrow provider-text fallback.
  if (extractNonSecretErrorSignals(message).errorStatus === 403
    || /\bthe caller does not have permission\b/i.test(message)) return true;
  // Some Claude session-limit envelopes omit both HTTP status and SDK classification.
  // A known input/control error must not be reclassified from this text alone.
  const sessionLimit = (!tag || tag === 'unknown') && /\byou['’]ve hit your session limit\b/i.test(message);
  return sessionLimit || isNetworkishErrorMessage(message) || isOverloadErrorMessage(message, signals.errorStatus)
    || /invalid api key|missing bearer token|no available oauth accounts|credit balance too low|rate.limit exceeded|model.{0,80}(?:not found|does not exist|unavailable)|(?:failed to (?:start|spawn)|could not start) (?:the )?(?:agent|pi|codex|claude)/i.test(message);
}

/**
 * How a model group answers a failed turn (model-groups.md §4.1):
 * - `transient`: retry on the same source first; switch only after two same-source retries failed.
 * - `model`: this model on this source can't serve; switch now, other models on the connection stay candidates.
 * - `connection`: the whole connection (account, quota, login) can't serve; switch now and skip every model on it.
 * `null`: switching would not help (or the failure is not a provider failure); leave it to the existing handling.
 */
export type ModelGroupFailureScope = 'transient' | 'model' | 'connection';

/** Same-source retries a transient failure gets before the model group switches source (model-groups.md §4.1). */
export const MODEL_GROUP_SAME_SOURCE_RETRIES = 2;

/**
 * Some engines hand the provider's reply on as text that starts with its HTTP status (Pi: `401: {"message":"Invalid
 * token"}`), with no structured status. Read it there so a dead key is not taken for an unknown failure.
 */
function leadingHttpStatus(text: string): number | undefined {
  const match = /^\s*(?:HTTP\s*)?([45]\d\d)\s*:/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

const MODEL_GROUP_AUTH_TEXT = /invalid (?:api[ _-]?key|token|x-api-key|access token)|unauthori[sz]ed|authentication (?:failed|error)|incorrect api key/i;
const MODEL_GROUP_REJECTED_REQUEST_TEXT = /user (?:denied|rejected|cancelled|canceled)|approval (?:denied|required)|prompt too long|context.{0,20}(?:overflow|too long)|content[_ -](?:filter(?:ed)?|policy[_ -]violation)|invalid[_ -]request|request[_ -]too[_ -]large/i;
const MODEL_GROUP_UNAVAILABLE_TEXT = /model.{0,80}(?:not found|does not exist|unavailable)|(?:failed to (?:start|spawn)|could not start) (?:the )?(?:agent|pi|codex|claude)/i;

/**
 * `extractNonSecretErrorSignals` sets `usageLimit: true` on transient 429 / rate-limit
 * envelopes as well as account quota exhaustion. Keep transient rate limits in the
 * model-group `transient` bucket (two same-source retries, then switch without marking
 * the whole connection unavailable) while preserving bare `{ usageLimit: true }` and
 * explicit account/session/budget exhaustion as `connection`.
 */
function isTransientRateLimitOnly(signals: InterruptedTurnErrorSignals, message: string): boolean {
  const reason = signals.reason ?? '';
  if (
    signals.codexErrorInfo === 'usageLimitExceeded' ||
    signals.usageResetAt !== undefined ||
    reason === 'acp-usage-limit' ||
    reason === 'provider_quota_limit' ||
    isModelGroupConnectionOutOfCredit(signals) ||
    matchesDeterministicUsageExhaustionText(message) ||
    isAccountUsageLimitReachedText(message) ||
    /\[SUBSCRIPTION_(?:ACCOUNT|POOL_MODEL)_LIMITED\]/i.test(message)
  ) {
    return false;
  }
  const status = signals.errorStatus ?? leadingHttpStatus(message);
  return (
    signals.codexErrorInfo === 'rateLimitExceeded' ||
    reason === 'provider_rate_limit' ||
    signals.sdkError === 'rate_limit' ||
    status === 429 ||
    /\b(?:rate[\s_-]?limit(?:ed|s|ing|_exceeded|_error)?|too\s+many\s+requests)\b/i.test(message)
  );
}

export function modelGroupFailureScope(input: InterruptedTurnErrorSignals): ModelGroupFailureScope | null {
  const reason = input.reason ?? '';
  const tag = input.sdkError ?? '';
  if (input.toolLoop || input.outputLimit ||
    ['sessionBudgetExceeded', 'contextWindowExceeded', 'cyberPolicy', 'misalignmentPolicyViolation'].includes(input.codexErrorInfo ?? '') ||
    ['invalid_request', 'invalid_request_error', 'context_length_exceeded', 'content_filter'].includes(tag) ||
    isProviderSafetyRefusalError(input.message ?? '', reason)) return null;
  if (reason === 'acp-usage-limit') return 'connection';
  if (isRemoteAgentRouteLostReason(reason)) return 'model';
  if (reason === UPSTREAM_STREAM_INTERRUPTED_REASON || isAcceptedTurnContinuationOnlyReason(reason)) return 'transient';
  // Only provider/agent failure envelopes can use the unknown-error default.
  // A distinct host/control reason (Stop, tool loop, preparation, etc.) keeps its existing owner.
  if (reason && !PROVIDER_TURN_FAILURE_REASONS.has(reason)) return null;
  const message = input.message ?? tag;
  const status = input.errorStatus ?? leadingHttpStatus(message);
  if ([400, 413, 422].includes(status ?? 0) ||
    isContextOverflowErrorMessage(message) || MODEL_GROUP_REJECTED_REQUEST_TEXT.test(message)) return null;
  const signals = status !== undefined && input.errorStatus === undefined ? { ...input, errorStatus: status } : input;
  const accountUsageLimit = signals.usageLimit === true && !isTransientRateLimitOnly(signals, message);
  if (isModelGroupConnectionOutOfCredit(signals)
    || accountUsageLimit || signals.codexErrorInfo === 'usageLimitExceeded'
    || matchesDeterministicUsageExhaustionText(message)
    || ['provider_quota_limit', 'provider_auth_or_access', 'acp-auth-required'].includes(reason)
    || ['authentication_failed', 'authentication_error', 'billing_error'].includes(tag)
    || signals.errorStatus === 401
    || MODEL_GROUP_AUTH_TEXT.test(message)
    || /missing bearer token|no available oauth accounts|\byou['’]ve hit your session limit\b/i.test(message)) {
    return 'connection';
  }
  if (['model_unavailable', 'user_model_access_denied', 'agent-start-failed', 'acp-agent-exited', 'pi-gateway-drop',
    BOT_SUBSCRIPTION_STARTUP_ADMISSION_REASON].includes(reason) ||
    ['model_not_found', 'user_model_access_denied', 'agent_start_failed'].includes(tag) ||
    status === 403 || extractNonSecretErrorSignals(message).errorStatus === 403 ||
    /\bthe caller does not have permission\b/i.test(message) || MODEL_GROUP_UNAVAILABLE_TEXT.test(message)) return 'model';
  if (tag === 'permission_error' || /\bpermission denied\b/i.test(message)) return null;
  return 'transient';
}

/**
 * A model-group task's failed turn (model-groups.md §4). `retrySameSource`: a transient failure still within its
 * same-source retries; `accountUnavailable`: the whole connection failed, so skip every model on it.
 */
export interface ModelGroupRecovery {
  retrySameSource?: boolean;
  accountUnavailable: boolean;
  hasImages: boolean;
}

/** The activity line's cause, the same words as a provider group's computer switch (agentInputQueue.ts AutoResumeAgentSwitchCause). */
export type ModelGroupSwitchCause = 'usage-limit' | 'auth' | 'unavailable' | 'overload' | 'failed';

export function modelGroupSwitchCause(signals: InterruptedTurnErrorSignals, scope: ModelGroupFailureScope | null): ModelGroupSwitchCause {
  const reason = signals.reason ?? '';
  const tag = signals.sdkError ?? '';
  const text = signals.message ?? (typeof signals.sdkError === 'string' ? signals.sdkError : '');
  const accountUsageLimit = signals.usageLimit === true && !isTransientRateLimitOnly(signals, text);
  if (accountUsageLimit || signals.codexErrorInfo === 'usageLimitExceeded' || reason === 'acp-usage-limit'
    || reason === 'provider_quota_limit' || matchesDeterministicUsageExhaustionText(signals.message ?? '')
    || isModelGroupConnectionOutOfCredit(signals)) return 'usage-limit';
  if (['provider_auth_or_access', 'acp-auth-required'].includes(reason) || ['authentication_failed', 'authentication_error'].includes(tag)
    || (signals.errorStatus ?? leadingHttpStatus(text)) === 401 || MODEL_GROUP_AUTH_TEXT.test(text)) return 'auth';
  if (scope === 'transient' &&
    (signals.codexErrorInfo === 'rateLimitExceeded' ||
      ['upstream-overload', 'provider_rate_limit', 'provider_server_error'].includes(reason) ||
      [429, 500, 502, 503, 504, 529].includes(signals.errorStatus ?? leadingHttpStatus(text) ?? 0) ||
      ['rate_limit', 'server_error'].includes(tag) || isOverloadErrorMessage(text, signals.errorStatus))) return 'overload';
  if (isRemoteAgentRouteLostReason(signals.reason) || ['model_unavailable', 'user_model_access_denied', 'agent-start-failed'].includes(reason)
    || tag === 'model_not_found') return 'unavailable';
  return 'failed';
}

/** The Session reference is only a teardown lease, never proof that a route changed. */
export interface RuntimeFallbackResult<T> {
  session: T | null;
  modelGroupTransition?: { fromModel: string; toModel: string };
  outcome: 'unchanged' | 'switched' | 'exhausted' | 'failed' | 'superseded';
  /** A model group moved the task to another source: the display names, for the activity line (model-groups.md §4.6). */
  sourceSwitch?: { from: string; to: string };
}

/**
 * `unchanged` under a required route change means no other route exists at all
 * (single-route chain or explicit routine model): an ordinarily retryable failure
 * then keeps the same-route resume an ordinary task would get. `exhausted` means
 * other routes were configured and tried, so the failed route is not retried.
 */
export function canResumeAfterRuntimeFallback(
  requireRouteChange: boolean,
  result: RuntimeFallbackResult<unknown>,
  sameRouteRetryable = false,
): boolean {
  return result.outcome !== 'superseded' && (!requireRouteChange || result.outcome === 'switched'
    || (sameRouteRetryable && result.outcome === 'unchanged'));
}
