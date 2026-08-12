/** Stable request-attribution reasons shared by host presentation consumers. */
export const CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON =
  'claude-gateway-opus-plan-mismatch';
export const CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON =
  'claude-subscription-opus-plan-mismatch';

export type ClaudeOpusPlanMismatchReason =
  | typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON
  | typeof CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON;

export type ClaudeOpusPlanMismatchRoute = 'gateway' | 'subscription';

export function decodeClaudeOpusPlanMismatchReason(
  value: unknown,
): ClaudeOpusPlanMismatchRoute | null {
  if (value === CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON) return 'gateway';
  if (value === CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON) return 'subscription';
  return null;
}

export function isClaudeOpusPlanMismatchReason(
  value: unknown,
): value is ClaudeOpusPlanMismatchReason {
  return decodeClaudeOpusPlanMismatchReason(value) !== null;
}
