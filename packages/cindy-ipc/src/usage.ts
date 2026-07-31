export const USAGE_CHANNELS = {
  MESSAGE_MODEL_MISMATCH: "usage:message-model-mismatch",
  MESSAGE_TURN_COST: "usage:message-turn-cost",
  SESSION_SPEND_CHANGED: "usage:session-spend-changed",
  SESSION_TOKENS_CHANGED: "usage:session-tokens-changed",
} as const;

export type USAGEChannel = typeof USAGE_CHANNELS[keyof typeof USAGE_CHANNELS];
