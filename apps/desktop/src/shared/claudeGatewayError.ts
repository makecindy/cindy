/**
 * Claude Code 会把部分上游 400 统一翻译成 Claude.ai 套餐提示。若请求实际走的是
 * XD Gateway，这段提示里的 Pro/Max 判断并不属于用户的 Claude.ai 账号，不能原样
 * 展示成“重新登录 Claude.ai”建议。
 */

export const CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON = 'claude-gateway-opus-plan-mismatch';

const CLAUDE_PRO_OPUS_ERROR = /Claude Opus is not available with the Claude Pro plan/i;

export interface ClaudeGatewayErrorContext {
  modelId: string;
  requestRoute: 'gateway' | 'subscription';
  status: number;
  error: string;
}

/**
 * 只按同一个 proxy 请求的精确路由与上游响应归因。会话 provider、最近路由或
 * terminal event 到达时的活性状态都不是请求级证据，不能参与这个判定。
 */
export function classifyClaudeGatewayError(
  context: ClaudeGatewayErrorContext,
): typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON | null {
  if (
    context.requestRoute !== 'gateway' ||
    context.status !== 400 ||
    !context.modelId.startsWith('claude-opus-') ||
    !CLAUDE_PRO_OPUS_ERROR.test(context.error)
  ) {
    return null;
  }
  return CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON;
}
