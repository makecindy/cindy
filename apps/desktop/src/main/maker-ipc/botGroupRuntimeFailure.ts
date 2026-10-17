import { isBotGroupRuntimeFailureCode, type BotGroupRuntimeFailureCode } from '../../shared/botGroupChat.js';
import { isPiImageInputUnsupportedError, isPiPromptRpcTimeoutError } from '../../shared/inputError.js';
import { extractNonSecretErrorSignals, matchesDeterministicUsageExhaustionText } from '@cindy/maker-shared/error-redaction';
import type { BotGroupChatService } from './botGroupChatService.js';
import { parseOverloadError, UPSTREAM_OVERLOAD_REASON } from '@cindy/maker-core';

export { BOT_GROUP_RUNTIME_FAILURE_PREFIX, botGroupRuntimeFailureDetail, readBotGroupRuntimeFailureDetail } from '../../shared/botGroupChat.js';

/** Classify on the executor. Only the fixed category is visible to other group members. */
export function botGroupRuntimeFailureCode(error: unknown): BotGroupRuntimeFailureCode {
  if (isPiImageInputUnsupportedError(error)) return 'IMAGE_INPUT_UNSUPPORTED';
  const data = error && typeof error === 'object' ? error as {
    code?: unknown; reason?: unknown; message?: unknown; sdkError?: unknown;
    errorStatus?: unknown; usageLimit?: unknown; modelAccessDenied?: unknown; codexErrorInfo?: unknown;
  } : null;
  const values = [data?.code, data?.reason, data?.sdkError, data?.message, error instanceof Error ? error.message : error];
  for (const value of values) {
    if (typeof value === 'string' && isPiImageInputUnsupportedError(value)) return 'IMAGE_INPUT_UNSUPPORTED';
    if (isBotGroupRuntimeFailureCode(value)) return value;
  }
  // Codex translators publish the stable tag even when message text is redacted.
  if (data?.codexErrorInfo === 'usageLimitExceeded' || data?.codexErrorInfo === 'sessionBudgetExceeded') return 'QUOTA_EXCEEDED';
  if (data?.codexErrorInfo === 'unauthorized') return 'AUTH_REQUIRED';
  if (data?.reason === 'pi-prompt-timeout' || isPiPromptRpcTimeoutError(data ?? { message: error })
    || (typeof data?.reason === 'string' && /^(?:bridge_)?(?:turn_no_event_timeout|upstream_response_idle_timeout)$/.test(data.reason))) return 'RUNTIME_TIMEOUT';
  const text = values.filter((value): value is string => typeof value === 'string').join('\n');
  const status = typeof data?.errorStatus === 'number' ? data.errorStatus : extractNonSecretErrorSignals(text).errorStatus;
  if (data?.modelAccessDenied === true || /\b(?:NO_MODEL|MODEL_NOT_FOUND|MODEL_UNAVAILABLE|NO_AVAILABLE_MODEL|BOT_MODEL_REQUIRED|MODEL_REQUIRED|user_model_access_denied)\b/i.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 401 || status === 403 || /\b(?:AUTH_REQUIRED|INVALID_TOKEN|TOKEN_EXPIRED|UNAUTHORIZED|invalid_api_key|authentication_error|authentication_failed|provider_auth_or_access)\b/i.test(text)) return 'AUTH_REQUIRED';
  if (data?.reason === UPSTREAM_OVERLOAD_REASON
    || parseOverloadError(text, status, typeof data?.codexErrorInfo === 'string' ? data.codexErrorInfo : undefined)) return 'UPSTREAM_OVERLOADED';
  if (status === 402 || matchesDeterministicUsageExhaustionText(text) || /\b(?:QUOTA_EXCEEDED|USAGE_LIMIT_EXCEEDED|INSUFFICIENT_BALANCE|insufficient_quota|billing_error|provider_quota_limit|usageLimitExceeded|sessionBudgetExceeded)\b/i.test(text)) return 'QUOTA_EXCEEDED';
  // usageLimit also accompanies temporary rate limits; an explicit rate signal wins.
  if (/\b(?:RATE_LIMITED|RATE_LIMIT_EXCEEDED|rate_limit_error|rate_limit|provider_rate_limit)\b|rate limit(?:ed|ing)?|too many requests/i.test(text)) return 'RATE_LIMITED';
  if (data?.usageLimit === true) return 'QUOTA_EXCEEDED';
  if (status === 429) return 'RATE_LIMITED';
  if (data?.codexErrorInfo === 'httpConnectionFailed' || data?.codexErrorInfo === 'responseStreamConnectionFailed'
    || data?.codexErrorInfo === 'responseStreamDisconnected') return 'NETWORK_ERROR';
  if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|REQUEST_TIMEOUT)\b|fetch failed|socket hang up/i.test(text)) return 'NETWORK_ERROR';
  return 'RUNTIME_ERROR';
}

/** A persisted input can fail without producing any Agent terminal event. */
export async function settleUndispatchedBotGroupTurn(
  service: Pick<BotGroupChatService, 'settleLaneTurn'> | null,
  sessionId: string,
  clientId: string,
  disposition: 'failed' | 'cancelled',
  error: unknown,
): Promise<boolean> {
  if (disposition !== 'failed' || !service) return false;
  return service.settleLaneTurn({ sessionId, activeInputClientId: clientId, outcome: 'error',
    resultText: '', failureCode: botGroupRuntimeFailureCode(error), undispatched: true });
}
