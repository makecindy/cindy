export const LEARN_CHANNELS = {
  APPLY: "learn:apply",
  CANCEL: "learn:cancel",
  DISCARD: "learn:discard",
  EVENT: "learn:event",
  GET_PROPOSAL_DIFF: "learn:get-proposal-diff",
  LIST_RUNS: "learn:list-runs",
  START: "learn:start",
} as const;

export type LEARNChannel = typeof LEARN_CHANNELS[keyof typeof LEARN_CHANNELS];
