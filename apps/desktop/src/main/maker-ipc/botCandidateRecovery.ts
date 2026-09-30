import { isNetworkishErrorMessage, isOverloadErrorMessage } from '@cindy/maker-core';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';

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
  const tag = signals.sdkError ?? '';
  if (['authentication_failed', 'authentication_error', 'rate_limit', 'server_error', 'billing_error',
    'model_not_found', 'user_model_access_denied', 'agent_start_failed'].includes(tag)) return true;
  const message = signals.message ?? '';
  if (/user (?:denied|rejected)|approval (?:denied|required)|context.{0,20}(?:overflow|too long)|prompt too long/i.test(message)) return false;
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(signals.errorStatus ?? 0)) return true;
  if (/permission denied/i.test(message)) return false;
  return isNetworkishErrorMessage(message) || isOverloadErrorMessage(message, signals.errorStatus)
    || /invalid api key|missing bearer token|no available oauth accounts|credit balance too low|insufficient_quota|quota exceeded|rate.limit exceeded|model.{0,80}(?:not found|does not exist|unavailable)|(?:failed to (?:start|spawn)|could not start) (?:the )?(?:agent|pi|codex|claude)/i.test(message);
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
