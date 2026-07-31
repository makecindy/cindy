export const CC_CHANNELS = {
  SET_DEBUG_NET: "cc:set-debug-net",
} as const;

export type CCChannel = typeof CC_CHANNELS[keyof typeof CC_CHANNELS];
