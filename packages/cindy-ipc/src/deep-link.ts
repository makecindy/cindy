export const DEEP_LINK_CHANNELS = {
  NAVIGATE: "deep-link:navigate",
  TAKE_PENDING: "deep-link:take-pending",
} as const;

export type DEEP_LINKChannel = typeof DEEP_LINK_CHANNELS[keyof typeof DEEP_LINK_CHANNELS];
