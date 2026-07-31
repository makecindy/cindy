export const UPDATE_CHECK_NOW_CHANNELS = {
  UPDATE_CHECK_NOW: "update-check-now",
} as const;

export type UPDATE_CHECK_NOWChannel = typeof UPDATE_CHECK_NOW_CHANNELS[keyof typeof UPDATE_CHECK_NOW_CHANNELS];
