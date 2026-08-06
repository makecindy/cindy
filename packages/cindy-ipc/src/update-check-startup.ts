export const UPDATE_CHECK_STARTUP_CHANNELS = {
  UPDATE_CHECK_STARTUP: "update-check-startup",
} as const;

export type UPDATE_CHECK_STARTUPChannel = typeof UPDATE_CHECK_STARTUP_CHANNELS[keyof typeof UPDATE_CHECK_STARTUP_CHANNELS];
