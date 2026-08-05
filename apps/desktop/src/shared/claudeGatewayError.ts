/**
 * Claude Code 会把部分上游 400 统一翻译成 Claude.ai 套餐提示。Cindy 必须按实际
 * 请求路由归因：Gateway 路由的 Pro 判断不属于用户的 Claude.ai 账号，而订阅
 * 直连路由则确实反映 Claude.ai 账号的套餐限制。
 */

export const CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON = 'claude-gateway-opus-plan-mismatch';
export const CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON =
  'claude-subscription-opus-plan-mismatch';

export type ClaudeOpusPlanMismatchReason =
  | typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON
  | typeof CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON;

const CLAUDE_PRO_OPUS_ERROR = /Claude Opus is not available with the Claude Pro plan/i;

export interface ClaudeGatewayErrorContext {
  modelId: string;
  requestRoute: 'gateway' | 'subscription';
  status: number;
  error: string;
}

function isClaudeProOpusPlanMismatch(context: ClaudeGatewayErrorContext): boolean {
  return (
    context.status === 400 &&
    context.modelId.startsWith('claude-opus-') &&
    CLAUDE_PRO_OPUS_ERROR.test(context.error)
  );
}

/**
 * 只按同一个 proxy 请求的精确路由与上游响应归因。会话 provider、最近路由或
 * terminal event 到达时的活性状态都不是请求级证据，不能参与这个判定。
 */
export function classifyClaudeGatewayError(
  context: ClaudeGatewayErrorContext,
): typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON | null {
  return context.requestRoute === 'gateway' && isClaudeProOpusPlanMismatch(context)
    ? CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON
    : null;
}

/** 直连 Claude.ai 订阅时，错误确实代表当前账号的套餐不支持 Opus。 */
export function classifyClaudeSubscriptionError(
  context: ClaudeGatewayErrorContext,
): typeof CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON | null {
  return context.requestRoute === 'subscription' && isClaudeProOpusPlanMismatch(context)
    ? CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON
    : null;
}
