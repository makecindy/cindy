/**
 * Shared context-window error vocabulary for Agent termination and provider diagnostics.
 * Only explicit context/prompt limits count: generic Invalid input, output limits and
 * token rate limits do not prove that compressing the conversation can recover it.
 * Keep this module free of runtime dependencies so all client layers can use it.
 */
export const CONTEXT_OVERFLOW_REASON = 'context-overflow';

// Azure/LiteLLM may say "input exceeds ... context window" without a structured code.
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|maximum (?:context|prompt) length|context.{0,20}(length|window).{0,40}(exceed|too)|(input|request|message).{0,20}exceeds?.{0,40}context.{0,20}(length|window)|context_length_exceeded/i;

/** 是否是上下文超限类错误。命中 = 不可原样重试，恢复动作是压缩上下文或新开会话。 */
export function isContextOverflowErrorMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(message);
}
