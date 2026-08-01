export const USAGE_CHANNELS = {
  CLAUDE_ACCOUNT_CHANGED: "usage:claude-account-changed",
  CLAUDE_SUBSCRIPTION_CHANGED: "usage:claude-subscription-changed",
  CODEX_ACCOUNT_CHANGED: "usage:codex-account-changed",
  MESSAGE_MODEL_MISMATCH: "usage:message-model-mismatch",
  MESSAGE_TURN_COST: "usage:message-turn-cost",
  MODEL_PRICING_CHANGED: "usage:model-pricing-changed",
  REFERENCE_MODEL_PRICING_CHANGED: "usage:reference-model-pricing-changed",
  SESSION_SPEND_CHANGED: "usage:session-spend-changed",
  SESSION_CONTEXT_CHANGED: "usage:session-context-changed",
  SESSION_TOKENS_CHANGED: "usage:session-tokens-changed",
  TODAY_SPEND_CHANGED: "usage:today-spend-changed",
  TODAY_TOKENS_CHANGED: "usage:today-tokens-changed",
  XAI_RATE_LIMIT_CHANGED: "usage:xai-rate-limit-changed",
} as const;

export type USAGEChannel = typeof USAGE_CHANNELS[keyof typeof USAGE_CHANNELS];
